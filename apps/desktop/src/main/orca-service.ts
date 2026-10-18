import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OrcaReader, orcaRetryDelayMs, type OrcaRun, type OrcaLedgerStore, type OrcaGateResult } from "@deskpet/plugin-host";
import type { OrcaSnapshot } from "@deskpet/plugin-sdk/v2";

const LEDGER_FILE = "orca-notification-ledger.json";
type OrcaLedger = NonNullable<Awaited<ReturnType<OrcaLedgerStore["load"]>>>;
// ADR-0012 measured 280 ms maximum for one command with 17 runs on this PC (2026-10-13).
// Five seconds leaves room for loaded machines; the M11 high-load measurement remains to be recorded.
const COMMAND_TIMEOUT_MS = 5_000;
// Match the existing plugin exec cap while CLI output sizes await the M11 high-load measurement.
const MAX_OUTPUT_BYTES = 1024 * 1024;
// M12: a 250 ms sample saw WAL mtime change within 0.1 s; a snapshot took at most 1.1 s
// on the 17-run reference machine. Poll at 1 s, leave 3 s between successful starts,
// and retain the 30 s CLI safety check pending the M12 load measurement.
const WAL_STAT_MS = 1_000;
const MIN_SNAPSHOT_MS = 3_000;
const SAFETY_MS = 30_000;
const WAL_FILE = "orchestration.db-wal";

function validArgs(args: readonly string[]): boolean {
  const [group, command, ...rest] = args;
  if (group === "terminal") return command === "show" && rest.length === 3 && rest[0] === "--terminal" && rest[2] === "--json" ||
    command === "switch" && rest.length === 3 && rest[0] === "--terminal" && rest[2] === "--json";
  if (group !== "orchestration") return false;
  if (command === "run-list" || command === "worker-list") {
    const base = command === "run-list" ? rest : rest.slice(2);
    return (command === "run-list" || rest[0] === "--run" && !!rest[1]) &&
      (base.length === 1 && base[0] === "--json" || base.length === 3 &&
       base[0] === "--json" && base[1] === "--cursor" && !!base[2]);
  }
  if (command === "inbox") return rest.length === 2 && rest[0] === "--full" && rest[1] === "--json";
  if (["task-list", "gate-list"].includes(command ?? ""))
    return rest.length === 3 && rest[0] === "--run" && !!rest[1] && rest[2] === "--json";
  if (command === "worker-show") return rest.length === 3 && rest[0] === "--dispatch" && !!rest[1] && rest[2] === "--json";
  if (command === "gate-resolve") return rest.length === 5 && rest[0] === "--id" && !!rest[1] &&
    rest[2] === "--resolution" && !!rest[3] && rest[4] === "--json";
  return false;
}

async function installedExecutable(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
  for (const directory of path?.split(delimiter) ?? []) {
    if (!directory) continue;
    try {
      const candidate = await realpath(join(directory, "orca.exe"));
      if ((await lstat(candidate)).isFile() && extname(candidate).toLowerCase() === ".exe") return candidate;
    } catch { /* Search the next PATH directory. */ }
  }
  return null;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel);
}

export interface OrcaService {
  snapshot(pluginId: string): Promise<OrcaSnapshot>;
  resolveGate(pluginId: string, gateId: string, resolution: string): Promise<OrcaGateResult>;
  muteGate(pluginId: string, gateId: string): Promise<void>;
  openTerminal(pluginId: string, handle: string): Promise<void>;
  setExecutableForTest(path: string | null): Promise<void>;
  setTimeForTest(atMs: number): void;
  setWalDirectoryForTest(path: string): Promise<void>;
  fastDetectionStatus(): { enabled: boolean; message?: string };
}

export function createOrcaService(userDataDir: string, env: NodeJS.ProcessEnv, now: () => number = Date.now,
  statWal: (path: string) => Promise<Stats> = stat): OrcaService {
  const installed = installedExecutable(env);
  const root = realpath(userDataDir);
  const path = join(userDataDir, LEDGER_FILE);
  const readers = new Map<string, OrcaReader>();
  const pending = new Map<string, Promise<OrcaSnapshot>>();
  const retry = new Map<string, { until: number; failures: number; result: OrcaSnapshot }>();
  let testTime: number | null = null;
  const clock = () => testTime ?? now();
  let testScript: string | null | undefined;
  let ledgerQueue: Promise<unknown> = Promise.resolve();
  let walDirectory: string | undefined;
  let fastEnabled = false;
  let walStamp: string | null = null;
  let walGeneration = 0;
  let lastProbeAt = -Infinity;
  // fullAt is the start time of the last read that re-read every run; quick reads keep it.
  // seq orders reads by start so a slow older read cannot replace a newer state.
  const cache = new Map<string, { snapshot: OrcaSnapshot; generation: number; startedAt: number; fullAt: number; seq: number }>();
  let startSeq = 0;
  const emptyNotifications = (snapshot: OrcaSnapshot): OrcaSnapshot => ({ ...snapshot, notifications: [] });

  async function probeWal(at: number, force = false): Promise<void> {
    if (!force && at - lastProbeAt < (fastEnabled ? WAL_STAT_MS : SAFETY_MS)) return;
    lastProbeAt = at;
    const directory = walDirectory ?? (env.APPDATA ? join(env.APPDATA, "orca") : null);
    if (!directory) { fastEnabled = false; walStamp = null; return; }
    try {
      const appData = dirname(directory);
      const appDataActual = await realpath(appData);
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("wal-directory-link");
      const directoryActual = await realpath(directory);
      if (!within(appDataActual, directoryActual)) throw new Error("wal-directory-outside-appdata");
      const file = join(directory, WAL_FILE);
      const linkInfo = await lstat(file);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("wal-not-regular-file");
      const actual = await realpath(file);
      if (!within(directoryActual, actual)) throw new Error("wal-outside-directory");
      const info = await statWal(file);
      if (!info.isFile()) throw new Error("wal-not-regular-file");
      const next = `${directoryActual}:${info.dev}:${info.ino}:${info.mtimeMs}`;
      if (walStamp !== next) { walStamp = next; walGeneration++; }
      fastEnabled = true;
    } catch {
      fastEnabled = false;
      walStamp = null;
    }
  }

  async function readLedger(): Promise<OrcaLedger | null> {
    const actualRoot = await root;
    if (!within(actualRoot, resolve(path))) return null;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !within(actualRoot, await realpath(path))) return null;
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const value = parsed as Record<string, unknown>;
      if (!Array.isArray(value.keys) || value.keys.length > 20_000 ||
        !value.keys.every((key: unknown) => typeof key === "string" && key.length <= 1_300)) return null;
      if (value.version === 1) return { version: 1, keys: value.keys };
      if (value.version !== 2 || !Array.isArray(value.gates) || value.gates.length > 20_000 ||
        !value.gates.every((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
          const gate = entry as Record<string, unknown>;
          return Object.keys(gate).length === 5 && typeof gate.runId === "string" && gate.runId.length > 0 && gate.runId.length <= 512 &&
            typeof gate.gateId === "string" && gate.gateId.length > 0 && gate.gateId.length <= 256 &&
            typeof gate.lastAlertedAt === "number" && Number.isSafeInteger(gate.lastAlertedAt) && gate.lastAlertedAt >= 0 &&
            typeof gate.repeatCount === "number" && Number.isInteger(gate.repeatCount) && gate.repeatCount >= 0 && gate.repeatCount <= 3 &&
            typeof gate.muted === "boolean";
        })) return null;
      return { version: 2, keys: value.keys, gates: value.gates } as OrcaLedger;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { version: 2, keys: [], gates: [] };
      return null;
    }
  }

  function ledger(pluginId: string): OrcaLedgerStore {
    const prefix = `${pluginId}|`;
    return {
      async load() {
        const current = await ledgerQueue.then(readLedger);
        return current && { version: current.version,
          keys: current.keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
          gates: current.gates?.filter((gate) => gate.runId.startsWith(prefix)).map((gate) => ({ ...gate, runId: gate.runId.slice(prefix.length) })) };
      },
      async save(value) {
        const job = ledgerQueue.then(async () => {
          const old = await readLedger();
          if (old === null) throw new Error("ledger-corrupt");
          const actualRoot = await root;
          if (!within(actualRoot, resolve(path))) throw new Error("ledger-outside-user-data");
          const keys = [...old.keys.filter((key) => !key.startsWith(prefix)), ...value.keys.map((key) => `${prefix}${key}`)];
          const gates = [...(old.gates ?? []).filter((gate) => !gate.runId.startsWith(prefix)),
            ...(value.gates ?? []).map((gate) => ({ ...gate, runId: `${prefix}${gate.runId}` }))];
          const temporary = join(actualRoot, `.${LEDGER_FILE}.${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify({ version: 2, keys, gates }), { flag: "wx" });
            await rename(temporary, path);
          } finally {
            // A failed rename leaves only the temporary file; it is safe to remove.
            const { unlink } = await import("node:fs/promises");
            await unlink(temporary).catch(() => {});
          }
        });
        ledgerQueue = job.catch(() => {});
        await job;
      },
    };
  }

  const run: OrcaRun = async (args) => {
    if (!validArgs(args)) throw new Error("Orca command is outside the allowlist");
    const executable = testScript === undefined ? await installed : testScript;
    if (!executable) throw Object.assign(new Error("Orca CLI missing"), { code: "ENOENT" });
    return new Promise((resolveResult) => {
      execFile(testScript ? process.execPath : executable, testScript ? [testScript, ...args] : [...args], {
        shell: false, windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8", env: testScript ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      }, (error, stdout, stderr) => {
        const timedOut = !!error && ("killed" in error && error.killed === true || "code" in error && error.code === "ETIMEDOUT");
        resolveResult({ code: error ? typeof error.code === "number" ? error.code : null : 0,
          stdout, stderr, timedOut: timedOut || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES });
      });
    });
  };

  const reader = (pluginId: string): OrcaReader => {
    let value = readers.get(pluginId);
    if (!value) { value = new OrcaReader(run, ledger(pluginId), clock); readers.set(pluginId, value); }
    return value;
  };
  return {
    async snapshot(pluginId) {
      const current = pending.get(pluginId);
      if (current) return current;
      const operation = (async () => {
        const at = clock();
        await probeWal(at);
        const held = retry.get(pluginId);
        if (held && at < held.until) return emptyNotifications(held.result);
        const previous = cache.get(pluginId);
        if (previous && at - previous.startedAt < SAFETY_MS &&
          (!fastEnabled || previous.generation === walGeneration)) return emptyNotifications(previous.snapshot);
        if (previous && at - previous.startedAt < MIN_SNAPSHOT_MS) return emptyNotifications(previous.snapshot);
        const generation = walGeneration;
        const seq = ++startSeq;
        // A WAL change inside the safety window reads only runs that can still change; the safety
        // check, the first read and the first read after a failure re-read every run.
        const quick = !!previous && fastEnabled && previous.generation !== walGeneration && at - previous.fullAt < SAFETY_MS;
        const { snapshot, reason } = await reader(pluginId).read({ mode: quick ? "quick" : "full" });
        if (reason) {
          const failures = (retry.get(pluginId)?.failures ?? 0) + 1;
          retry.set(pluginId, { failures, until: clock() + orcaRetryDelayMs(failures), result: snapshot });
          cache.delete(pluginId);
        } else {
          retry.delete(pluginId);
          const newer = cache.get(pluginId);
          if (newer && newer.seq > seq) {
            // A read that started later already landed: keep its state, hand over only this read's alerts.
            await probeWal(clock(), true);
            return { ...newer.snapshot, notifications: snapshot.notifications };
          }
          cache.set(pluginId, { snapshot, generation, startedAt: at, fullAt: quick ? previous.fullAt : at, seq });
        }
        // A write during the CLI read must remain pending for the next request.
        await probeWal(clock(), true);
        return snapshot;
      })().finally(() => { pending.delete(pluginId); });
      pending.set(pluginId, operation);
      return operation;
    },
    async resolveGate(pluginId, gateId, resolution) {
      return await reader(pluginId).resolveGate(gateId, resolution, true);
    },
    async muteGate(pluginId, gateId) {
      await pending.get(pluginId);
      await reader(pluginId).muteGate(gateId, true);
    },
    openTerminal(pluginId, handle) { return reader(pluginId).openTerminal(handle, true); },
    setTimeForTest(atMs) {
      if (atMs < lastProbeAt) { lastProbeAt = -Infinity; cache.clear(); retry.clear(); }
      testTime = atMs;
    },
    fastDetectionStatus() { return fastEnabled ? { enabled: true } : { enabled: false, message: "빠른 감지 꺼짐" }; },
    async setWalDirectoryForTest(value) {
      let lexical: string;
      try {
        const parent = await realpath(dirname(userDataDir));
        lexical = resolve(value);
        if (value.split(/[\\/]/).includes("..") || !within(parent, lexical) ||
          relative(parent, lexical) !== "orca" || (await lstat(lexical)).isSymbolicLink() ||
          await realpath(lexical) !== lexical || !(await lstat(lexical)).isDirectory())
          throw new Error("wal-test-path-invalid");
      } catch { throw new Error("가짜 Orca 저장 경로가 올바르지 않습니다"); }
      walDirectory = lexical;
      fastEnabled = false;
      walStamp = null;
      lastProbeAt = -Infinity;
      cache.clear();
      retry.clear();
    },
    async setExecutableForTest(value) {
      if (value === null) { testScript = null; readers.clear(); retry.clear(); cache.clear(); return; }
      const actualRoot = await realpath(dirname(userDataDir));
      const lexical = resolve(value);
      if (value.split(/[\\/]/).includes("..") || !within(actualRoot, lexical))
        throw new Error("가짜 Orca CLI 경로가 올바르지 않습니다");
      let segment = actualRoot;
      for (const part of relative(actualRoot, lexical).split(sep)) {
        segment = join(segment, part);
        if ((await lstat(segment)).isSymbolicLink()) throw new Error("가짜 Orca CLI 경로가 올바르지 않습니다");
      }
      const candidate = await realpath(value);
      if (!within(actualRoot, candidate) || extname(candidate) !== ".mjs" || !(await lstat(candidate)).isFile())
        throw new Error("가짜 Orca CLI 경로가 올바르지 않습니다");
      testScript = candidate;
      readers.clear(); retry.clear(); cache.clear();
    },
  };
}
