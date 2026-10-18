import { app, utilityProcess, type UtilityProcess } from "electron";
import { discoverPlugins, isEnvelope, resolvePluginEntry, type Envelope, type PluginChannel } from "@deskpet/plugin-host";

export type OutputStream = "stdout" | "stderr";

// Only what a plugin needs to start; app tokens and settings paths are never passed (ADR-0005 §1).
const ENV_KEYS = ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR"] as const;
// A plugin that prints without newlines must not grow the buffer without bound.
const MAX_LINE_CHARS = 8192;

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** PluginChannel over utilityProcess.postMessage (structured clone). Also collects stdout/stderr lines. */
export class UtilityPluginChannel implements PluginChannel {
  private readonly child: UtilityProcess;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly outputListeners = new Set<(stream: OutputStream, line: string) => void>();
  private exitCode: number | null | undefined;
  private readonly outputEnds: Promise<void>[] = [];

  /** `entryPath` must already be resolved by resolvePluginEntry; the runner imports it as given. */
  constructor(runnerPath: string, entryPath: string, serviceName: string, args: readonly string[] = []) {
    this.child = utilityProcess.fork(runnerPath, [...args], { env: minimalEnv(), stdio: "pipe", serviceName });
    this.child.on("message", (message: unknown) => {
      for (const listener of this.messageListeners) listener(message);
    });
    this.child.on("exit", (code) => {
      if (this.exitCode !== undefined) return;
      this.exitCode = code;
      for (const listener of this.exitListeners) listener(code);
    });
    this.collect("stdout", this.child.stdout);
    this.collect("stderr", this.child.stderr);
    // Not an envelope: the runner reads the entry from this first message before it creates its channel.
    this.child.postMessage({ kind: "start", entry: entryPath });
  }

  get pid(): number | undefined { return this.child.pid; }

  post(message: Envelope): void {
    if (this.exitCode !== undefined) return;
    this.child.postMessage(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onOutput(listener: (stream: OutputStream, line: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Settles once stdout and stderr have delivered everything; the exit event can arrive before their last lines. */
  outputEnded(): Promise<void> {
    return Promise.all(this.outputEnds).then(() => undefined);
  }

  kill(): void {
    if (this.exitCode === undefined) this.child.kill();
  }

  private collect(stream: OutputStream, source: NodeJS.ReadableStream | null | undefined): void {
    if (!source) return;
    let pending = "";
    const emit = (line: string): void => { for (const listener of this.outputListeners) listener(stream, line); };
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emit(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_CHARS) { emit(pending.slice(0, MAX_LINE_CHARS)); pending = ""; }
    });
    source.on("end", () => { if (pending) emit(pending); pending = ""; });
    // Registered after the flush above, so the last partial line is already emitted when this settles.
    this.outputEnds.push(new Promise<void>((resolve) => {
      source.once("end", resolve);
      source.once("close", resolve);
      source.once("error", () => resolve());
    }));
  }
}

export interface PluginProbeResult {
  pid: number | undefined;
  /** Milliseconds from fork to the runner's `hello`; null if it never arrived. */
  helloMs: number | null;
  hello: unknown;
  activated: boolean;
  activateError: string | null;
  /** Exit code once the process ended; undefined while it is still running. */
  exit: { code: number | null } | undefined;
  stdout: string[];
  stderr: string[];
  idle?: { workingSetKb: number; privateKb: number; cpuPercent: number };
}

export interface PluginProbeOptions {
  runnerPath: string;
  scanRoot: string;
  id: string;
  /** Kill the process after activation and report the exit instead of waiting for a self exit. */
  kill: boolean;
  /** Sample memory and CPU of the activated process after this many milliseconds of idling. */
  idleMs: number;
  /** Time allowed for each step (hello, init, activate, exit). */
  stepTimeoutMs: number;
}

/**
 * Dev/test driver for one plugin process: the minimum hello -> init -> activate exchange without a
 * SessionHost, so the real runner and channel can be observed. Permission checks belong to PluginSession.
 */
export async function probePlugin(options: PluginProbeOptions): Promise<PluginProbeResult> {
  const found = (await discoverPlugins(options.scanRoot)).find((item) => item.id === options.id);
  if (found?.state !== "valid") throw new Error(`plugin ${options.id} is not a valid plugin`);
  const entry = await resolvePluginEntry(found.folder, found.manifest.entry);
  const startedAt = performance.now();
  const channel = new UtilityPluginChannel(options.runnerPath, entry, `probe-${options.id}`);
  const result: PluginProbeResult = { pid: channel.pid, helloMs: null, hello: undefined, activated: false,
    activateError: null, exit: undefined, stdout: [], stderr: [] };
  channel.onOutput((stream, line) => result[stream].push(line));
  const exited = new Promise<void>((resolve) => channel.onExit((code) => { result.exit = { code }; resolve(); }));
  const waiters = new Map<number, (response: Extract<Envelope, { kind: "res" }>) => void>();
  const hello = new Promise<void>((resolve) => {
    channel.onMessage((message) => {
      if (!isEnvelope(message)) return;
      if (message.kind === "res") { waiters.get(message.id)?.(message); return; }
      const answer = (value: unknown): void => channel.post({ v: 1, kind: "res", id: message.id, ok: true, value });
      if (message.method === "hello") {
        result.helloMs = Math.round(performance.now() - startedAt);
        result.hello = message.params;
        answer(null);
        resolve();
      } else if (message.method === "log") answer(null);
      else channel.post({ v: 1, kind: "res", id: message.id, ok: false,
        error: { code: "E_UNAVAILABLE", message: "probe has no host for this request" } });
    });
  });
  const within = async <T>(work: Promise<T>): Promise<T | "timeout"> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), options.stepTimeoutMs); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  };
  let nextId = 1;
  const request = (method: string, params: unknown): Promise<Extract<Envelope, { kind: "res" }>> => {
    const id = nextId++;
    const response = new Promise<Extract<Envelope, { kind: "res" }>>((resolve) => waiters.set(id, resolve));
    channel.post({ v: 1, kind: "req", id, method, params });
    return response;
  };

  try {
    // Ending early (throw, process.exit) settles `exited`, so a dead process never waits out the timeout.
    if (await within(Promise.race([hello, exited])) === "timeout") throw new Error("hello timed out");
    if (result.exit === undefined) {
      const manifest = found.manifest;
      const outcome = await within(Promise.race([
        request("init", { config: {}, permissions: manifest.permissions })
          .then(() => request("activate", {})),
        exited.then(() => undefined),
      ]));
      if (outcome === "timeout") result.activateError = "E_TIMEOUT";
      else if (outcome === undefined) result.activateError = "exited";
      else if (outcome.ok) result.activated = true;
      else result.activateError = outcome.error.code;
    }
    if (result.activated && options.idleMs > 0) {
      const pid = channel.pid;
      app.getAppMetrics();
      await new Promise<void>((resolve) => setTimeout(resolve, options.idleMs));
      const metric = app.getAppMetrics().find((item) => item.pid === pid);
      if (metric) result.idle = { workingSetKb: metric.memory.workingSetSize, privateKb: metric.memory.privateBytes ?? 0,
        cpuPercent: metric.cpu.percentCPUUsage };
    }
    if (options.kill) channel.kill();
    await within(exited);
    // Under load the exit event beat the crash text on stderr (plugin-runner e2e, 3 of ~75 full runs on 2026-10-09).
    if (result.exit !== undefined) await within(channel.outputEnded());
  } finally {
    channel.kill();
  }
  return result;
}
