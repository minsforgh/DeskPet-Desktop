import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import { E2E_TIMINGS_PATH } from "./e2e-run-lock.js";

type Phase = "launch" | "waitReady" | "quit" | "forceStop";
export type ProcessRow = { pid: number; ppid: number; startedAt: number; name: string };
type ChildLike = { pid?: number };

const execFileAsync = promisify(execFile);
const maxima = new Map<string, number>();
let summaryEnabled = false;

export function registerControlSummary(): void {
  summaryEnabled = true;
}

export class DesktopDiagnostics {
  private readonly phaseMs = new Map<Phase, number>();
  private readonly activePhases = new Map<Phase, number>();
  private lastControl: { name: string; elapsedMs: number; ok: boolean } | undefined;
  private descendants: number[] = [];

  constructor(readonly child: ChildLike, readonly startedAt = Date.now()) {}

  async measure<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.activePhases.set(phase, started);
    try { return await work(); }
    finally {
      this.activePhases.delete(phase);
      this.phaseMs.set(phase, Math.round((this.phaseMs.get(phase) ?? 0) + performance.now() - started));
    }
  }

  markLaunch(elapsedMs: number): void { this.phaseMs.set("launch", Math.round(elapsedMs)); }

  control(name: string, elapsedMs: number, ok: boolean): void {
    const elapsed = Math.round(elapsedMs);
    this.lastControl = { name, elapsedMs: elapsed, ok };
    if (ok && elapsed > (maxima.get(name) ?? -1)) {
      maxima.set(name, elapsed);
      if (summaryEnabled) appendFileSync(E2E_TIMINGS_PATH, `${JSON.stringify({ [name]: elapsed })}\n`);
    }
  }

  setDescendants(pids: readonly number[]): void { this.descendants = [...new Set([...this.descendants, ...pids])]; }

  /** Keeps the original error reachable (cause) and its errno fields, so tests can still branch on error.code. */
  failure(message: string, cause?: unknown): Error {
    const phases = (["launch", "waitReady", "quit", "forceStop"] as const)
      .map((phase) => {
        const active = this.activePhases.get(phase);
        return `${phase}=${active === undefined ? this.phaseMs.get(phase) ?? "-" : Math.round((this.phaseMs.get(phase) ?? 0) + performance.now() - active)}ms`;
      }).join(", ");
    const control = this.lastControl
      ? `${this.lastControl.name}=${this.lastControl.elapsedMs}ms (${this.lastControl.ok ? "ok" : "failed"})`
      : "none";
    const error = new Error(`${message}; main PID=${this.child.pid ?? "?"}; descendant PIDs=${this.descendants.join(",") || "none"}; phases: ${phases}; last control: ${control}`, cause === undefined ? undefined : { cause });
    if (cause instanceof Error) {
      const source = cause as NodeJS.ErrnoException;
      Object.assign(error, { code: source.code, errno: source.errno, syscall: source.syscall });
    }
    return error;
  }
}

/** ParentProcessId keeps the launch parent on Windows after main exits; creation time rejects older PID reuse. */
export function descendantsOf(rows: readonly ProcessRow[], rootPid: number, startedAt: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (const parent of queue) {
    for (const row of rows) {
      if (row.ppid !== parent || seen.has(row.pid) || row.startedAt < startedAt) continue;
      seen.add(row.pid);
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform !== "win32") return [];
  // Five Windows CIM snapshots with a live user DeskPet took 380–898 ms; the existing idle CPU probe's 5 s bound covers them.
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout);
  const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value): ProcessRow[] => {
    if (typeof value !== "object" || value === null) return [];
    const row = value as Record<string, unknown>;
    const date = row.CreationDate;
    const startedAt = typeof date === "string" && date.startsWith("/Date(") && date.endsWith(")/")
      ? Number(date.slice(6, -2)) : NaN;
    const pid = Number(row.ProcessId);
    const ppid = Number(row.ParentProcessId);
    return Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(startedAt) && typeof row.Name === "string"
      ? [{ pid, ppid, startedAt, name: row.Name }] : [];
  });
}

export function cleanupDescendants(rows: readonly ProcessRow[], rootPid: number | undefined,
  startedAt: number, diagnostics: DesktopDiagnostics): void {
  if (rootPid === undefined) return;
  try {
    const remaining = descendantsOf(rows, rootPid, startedAt);
    diagnostics.setDescendants(remaining.map((row) => row.pid));
    if (remaining.length === 0) return;
    const skipped: number[] = [];
    for (const row of remaining.reverse()) {
      // An Orca CLI can be a short-lived app child; never terminate Orca itself.
      if (row.name.toLowerCase().startsWith("orca")) { skipped.push(row.pid); continue; }
      try { process.kill(row.pid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    console.warn(`[e2e cleanup] Electron main PID ${rootPid} left descendants ${remaining.map((row) => `${row.pid}(${row.name})`).join(", ")}; terminated only this tree${skipped.length ? `; skipped Orca PIDs ${skipped.join(", ")}` : ""}`);
  } catch (error) {
    console.warn(`[e2e cleanup] Could not inspect descendants of Electron main PID ${rootPid}: ${String(error)}`);
    throw error;
  }
}
