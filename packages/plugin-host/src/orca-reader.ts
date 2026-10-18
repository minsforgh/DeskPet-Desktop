import type { OrcaSnapshot } from "@deskpet/plugin-sdk/v2";

export interface OrcaCommandResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type OrcaRun = (args: readonly string[]) => Promise<OrcaCommandResult>;
export interface OrcaGateLedger { runId: string; gateId: string; lastAlertedAt: number; repeatCount: number; muted: boolean }
export interface OrcaLedger { version: 1 | 2; keys: string[]; gates?: OrcaGateLedger[] }
export interface OrcaLedgerStore { load(): Promise<OrcaLedger | null>; save(ledger: OrcaLedger): Promise<void> }
export type OrcaFailureReason = "cli-missing" | "cli-error" | "timeout" | "invalid-json" | "invalid-shape" | "ledger-corrupt";
export interface OrcaReadResult { snapshot: OrcaSnapshot; reason: OrcaFailureReason | null }
export interface OrcaReadOptions { mode?: "full" | "quick" }
export type OrcaGateResult = "resolved" | "already-resolved" | "unconfirmed";

type Run = OrcaSnapshot["runs"][number];
type Notification = OrcaSnapshot["notifications"][number];
const MAX_TITLE = 80;
const MAX_LEDGER_KEYS = 2_000;
// D-070 sets five minutes after the first alert and at most three additional alerts.
// M11 observed about 20 s UI latency; the 30 s poll adds at most one poll interval
// plus snapshot time after this boundary under the ADR-0012 measured 17-run condition.
export const GATE_REPEAT_MS = 300_000;
const MAX_GATE_REPEATS = 3;
// Run-level reads are independent CLI processes. On the 18-run reference PC one command took
// 0.35-0.40 s, so a sequential full read took about 22 s. Four at a time cuts that by roughly
// the same factor without launching a burst of orca.exe processes next to a busy Orca.
export const MAX_PARALLEL_RUNS = 4;
interface RunState { run: Run; terminals: Set<string>; live: boolean }
interface RunOutcome { id: string; state: RunState; candidates: { key: string; notification: Notification }[]; gates: Map<string, { runId: string; taskId: string; options: readonly string[] }> }
// ADR-0012 measured a 280 ms maximum per CLI command on one PC with 17 runs.
// This is a retry schedule, not a timeout or a worker inactivity threshold.
export function orcaRetryDelayMs(failures: number): number {
  return Math.min(300_000, 30_000 * 2 ** Math.min(20, Math.max(0, Math.floor(failures) - 1)));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new OrcaReadError("invalid-shape");
  return value;
}
function field(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (!result) throw new OrcaReadError("invalid-shape");
  return result;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_:.@][A-Za-z0-9_:.@-]*$/.test(value)) throw new OrcaReadError("invalid-shape");
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string") throw new OrcaReadError("invalid-shape");
  return Array.from(value, (character) => control(character) ? " " : character).join("").slice(0, MAX_TITLE);
}
function control(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || (code >= 127 && code <= 159);
}
function optionalId(value: unknown): string | null { return value == null ? null : id(value); }
function activity(value: unknown): string | null { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null; }
function options(value: unknown): string[] {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { return []; }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => typeof item === "string" && item.length > 0 && item.length <= 40 && !Array.from(item).some(control)) || parsed[0] === parsed[1]) return [];
  return parsed;
}
function payload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return object(value);
  try { return object(JSON.parse(value)); }
  catch { throw new OrcaReadError("invalid-shape"); }
}
function key(...parts: string[]): string { return JSON.stringify(parts); }
function errorReason(error: unknown): OrcaFailureReason {
  if (error instanceof OrcaReadError) return error.reason;
  if (object(error)?.code === "ENOENT") return "cli-missing";
  return "cli-error";
}
class OrcaReadError extends Error {
  constructor(readonly reason: OrcaFailureReason) { super(reason); }
}
function envelope(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { throw new OrcaReadError("invalid-json"); }
  const entry = field(parsed);
  if (entry.ok !== true) throw new OrcaReadError("cli-error");
  return field(entry.result);
}

export class OrcaReader {
  private readonly pending = new Map<string, Promise<OrcaGateResult>>();
  private knownGates = new Map<string, { runId: string; taskId: string; options: readonly string[] }>();
  private knownTerminals = new Set<string>();
  private unavailableReported = false;
  private hasSucceeded = false;
  private recoveryBaseline = false;
  // Last successful read, by run id. A quick read reuses entries whose run had nothing left to watch.
  private lastRuns = new Map<string, RunState>();

  constructor(private readonly run: OrcaRun, private readonly ledger: OrcaLedgerStore, private readonly now: () => number = Date.now) {}

  private async call(args: readonly string[]): Promise<Record<string, unknown>> {
    let result: OrcaCommandResult;
    try { result = await this.run(args); }
    catch (error) { throw new OrcaReadError(errorReason(error)); }
    if (result.timedOut) throw new OrcaReadError("timeout");
    if (result.code !== 0) throw new OrcaReadError("cli-error");
    return envelope(result.stdout);
  }

  async read(request: OrcaReadOptions = {}): Promise<OrcaReadResult> {
    try {
      const quick = request.mode === "quick" && this.hasSucceeded && !this.recoveryBaseline;
      const ledger = await this.ledger.load();
      const corrupted = ledger === null || !Array.isArray(ledger.keys) || !ledger.keys.every((value) => typeof value === "string" && value.length <= 1_024);
      const seen = new Set(corrupted ? [] : ledger.keys);
      const gateStates = new Map<string, OrcaGateLedger>();
      for (const gate of ledger?.gates ?? []) gateStates.set(key(gate.runId, gate.gateId), gate);
      const baselineKey = key("orca-reader", "baseline");
      const baseline = corrupted || !seen.has(baselineKey) || this.recoveryBaseline;
      seen.add(baselineKey);
      const runRows: unknown[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      // The mailbox does not depend on the run list, so it is requested alongside it.
      const inboxCall = this.call(["orchestration", "inbox", "--full", "--json"]);
      inboxCall.catch(() => {});
      do {
        const result = await this.call(["orchestration", "run-list", "--json", ...(cursor ? ["--cursor", cursor] : [])]);
        runRows.push(...array(result.runs));
        cursor = optionalId(result.nextCursor);
        if (cursor && cursors.has(cursor)) throw new OrcaReadError("invalid-shape");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const inbox = await inboxCall;
      const messages = array(inbox.messages).map(field);
      const runs: Run[] = [];
      const candidates: { key: string; notification: Notification }[] = [];
      const nextGates = new Map<string, { runId: string; taskId: string; options: readonly string[] }>();
      const nextTerminals = new Set<string>();
      const nextRuns = new Map<string, RunState>();
      const mailFor = (runId: string): Run["messages"][number][] => messages.filter((value) => value.run_id === runId && (value.type === "question" || value.type === "escalation")).map((value) => {
        const body = payload(value.payload);
        return { id: id(value.id), taskId: optionalId(body?.taskId ?? body?.task_id), type: value.type as "question" | "escalation" };
      });
      const readRun = async (value: unknown): Promise<RunOutcome | null> => {
        const candidates: { key: string; notification: Notification }[] = [];
        try {
          const row = field(value);
          const runId = id(row.id);
          const coordinatorHandle = optionalId(row.coordinator_handle);
          const previous = this.lastRuns.get(runId);
          if (quick && previous && !previous.live) {
            // Nothing was left to watch, so no candidate can come from this run; only the mail list is fresh.
            const reusedMessages = mailFor(runId);
            return { id: runId, state: { run: { ...previous.run, coordinatorHandle, messages: reusedMessages }, terminals: previous.terminals, live: false },
              candidates, gates: new Map() };
          }
          const runGates = new Map<string, { runId: string; taskId: string; options: readonly string[] }>();
          const runTerminals = new Set<string>();
          const tasksResult = await this.call(["orchestration", "task-list", "--run", runId, "--json"]);
          if (tasksResult.runId !== runId) throw new OrcaReadError("invalid-shape");
          const tasks: Run["tasks"][number][] = array(tasksResult.tasks).map((value) => {
            const task = field(value);
            const status = task.status;
            return { id: id(task.id), title: title(task.task_title ?? ""), status: status === "ready" || status === "pending" ? "pending" :
              status === "dispatched" || status === "running" ? "running" : status === "completed" || status === "succeeded" ? "succeeded" :
                status === "failed" ? "failed" : "unknown" };
          });
          const workerRows: Record<string, unknown>[] = [];
          cursor = null;
          cursors.clear();
          do {
            const result = await this.call(["orchestration", "worker-list", "--run", runId, "--json", ...(cursor ? ["--cursor", cursor] : [])]);
            workerRows.push(...array(result.workers).map(field));
            const page = field(result.page);
            cursor = page.hasMore === true ? id(page.nextCursor) : null;
            if (cursor && cursors.has(cursor)) throw new OrcaReadError("invalid-shape");
            if (cursor) cursors.add(cursor);
          } while (cursor);
          const gatesResult = await this.call(["orchestration", "gate-list", "--run", runId, "--json"]);
          if (gatesResult.runId !== runId) throw new OrcaReadError("invalid-shape");
          const gates: Run["gates"][number][] = array(gatesResult.gates).map((value) => {
            const gate = field(value);
            const status = gate.status;
            if (status !== "pending" && status !== "resolved") throw new OrcaReadError("invalid-shape");
            const parsed: Run["gates"][number] = { id: id(gate.id), taskId: optionalId(gate.task_id), status, options: options(gate.options) };
            if (parsed.taskId !== null && parsed.status === "pending") runGates.set(parsed.id, { runId, taskId: parsed.taskId, options: parsed.options });
            return parsed;
          });
          const workers: Run["workers"][number][] = workerRows.map((value) => {
            const projection = field(value.projection);
            const livenessValue = field(projection.liveness).verdict;
            const liveness = livenessValue === "live" || livenessValue === "exited" || livenessValue === "unverifiable" ? livenessValue : "unknown";
            const stateValue = value.workerState;
            const stage = object(projection.stage);
            const state = stateValue === "succeeded" || stateValue === "failed" ? stateValue : liveness === "exited" ? "exited" : stateValue === "working" || stage?.activity === "working" ? "working" : "unknown";
            const terminalHandle = optionalId(value.agentTerminalHandle);
            if (terminalHandle) runTerminals.add(terminalHandle);
            const evidence = object(projection.evidence);
            return { dispatchId: id(value.dispatchId), taskId: id(value.taskId), terminalHandle, state, liveness,
              lastActivityAt: activity(field(projection.liveness).observedAt) ?? activity(evidence?.lastObservedAt) };
          });
          const runMessages = mailFor(runId);
          // A worker that already reported succeeded or failed cannot raise a new alert even if its terminal is unverifiable.
          const live = workers.some((worker) => (worker.liveness === "live" || worker.liveness === "unverifiable") && worker.state !== "succeeded" && worker.state !== "failed");
          const active = tasks.some((task) => task.status === "pending" || task.status === "running" || task.status === "unknown") ||
            gates.some((gate) => gate.status === "pending") || workers.some((worker) => worker.state === "working");
          let coordinatorWaiting: boolean | null = null;
          if (active && coordinatorHandle) {
            const terminal = await this.call(["terminal", "show", "--terminal", coordinatorHandle, "--json"]);
            const terminalValue = object(terminal.terminal) ?? terminal;
            if (terminalValue.agentWait === null) coordinatorWaiting = false;
            else if (terminalValue.agentWait !== undefined) coordinatorWaiting = terminalValue.agentWait === true || object(terminalValue.agentWait)?.status === "waiting";
            runTerminals.add(coordinatorHandle);
          }
          const taskTitle = (taskId: string | null) => tasks.find((task) => task.id === taskId)?.title ?? "Orca 작업";
          const add = (kind: Notification["kind"], parts: string[], taskId: string | null, dispatchId: string | null, gateId: string | null, terminalHandle: string | null,
            messageId: string | null = null, messageType: Notification["messageType"] = null) => {
            candidates.push({ key: key(runId, ...parts), notification: { kind, runId, taskId, dispatchId, gateId,
              messageId, messageType, terminalHandle, title: taskTitle(taskId) } });
          };
          for (const worker of workers) {
            if (!active) break;
            const done = messages.filter((entry) => entry.run_id === runId && entry.type === "worker_done").find((entry) => {
              const body = payload(entry.payload);
              return body?.dispatchId === worker.dispatchId || body?.dispatch_id === worker.dispatchId;
            });
            const body = done && payload(done.payload);
            const outcome = body?.outcome === "succeeded" || body?.outcome === "failed" ? body.outcome : null;
            let confirmed = worker.state === "succeeded" || worker.state === "failed" ? worker.state : outcome;
            if (outcome && confirmed !== outcome) {
              const shown = await this.call(["orchestration", "worker-show", "--dispatch", worker.dispatchId, "--json"]);
              const actual = field(shown.dispatch).status;
              confirmed = actual === "succeeded" || actual === "failed" ? actual : null;
            }
            if (active && confirmed) add(confirmed === "succeeded" ? "worker-succeeded" : "worker-failed", [worker.dispatchId, "worker-outcome"], worker.taskId, worker.dispatchId, null, worker.terminalHandle);
            else if (active && worker.liveness === "exited") add("worker-exited", [worker.dispatchId, "exited"], worker.taskId, worker.dispatchId, null, worker.terminalHandle);
          }
          if (active) {
            for (const gate of gates) if (gate.status === "pending") add("attention", [gate.id, "gate"], gate.taskId, null, gate.id, coordinatorHandle);
            for (const message of runMessages) {
              const raw = messages.find((entry) => entry.id === message.id);
              const body = raw && payload(raw.payload);
              const gateId = optionalId(body?.gateId ?? body?.gate_id);
              if (gateId && gates.some((gate) => gate.id === gateId && gate.status === "pending")) continue;
              add("attention", [message.id, "message"], message.taskId, null, null, coordinatorHandle, message.id, message.type);
            }
            if (coordinatorHandle && coordinatorWaiting !== null) {
              const waitKey = key(runId, coordinatorHandle, "wait-active");
              if (coordinatorWaiting && !seen.has(waitKey)) {
                if (!baseline) candidates.push({ key: waitKey, notification: { kind: "coordinator-waiting", runId, taskId: null, dispatchId: null, gateId: null,
                  messageId: null, messageType: null, terminalHandle: coordinatorHandle, title: "Orca 작업" } });
                else seen.add(waitKey);
              }
              if (!coordinatorWaiting) seen.delete(waitKey);
            }
          }
          const run: Run = { id: runId, coordinatorHandle, coordinatorWaiting, tasks, workers, gates, messages: runMessages };
          return { id: runId, state: { run, terminals: runTerminals, live: active || live }, candidates, gates: runGates };
        } catch {
          console.warn("orca:run-invalid-shape");
          return null;
        }
      };
      const outcomes: (RunOutcome | null)[] = new Array(runRows.length).fill(null);
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_RUNS, runRows.length) }, async () => {
        while (nextIndex < runRows.length) {
          const index = nextIndex++;
          outcomes[index] = await readRun(runRows[index]);
        }
      }));
      for (const outcome of outcomes) {
        if (!outcome) continue;
        runs.push(outcome.state.run);
        candidates.push(...outcome.candidates);
        nextRuns.set(outcome.id, outcome.state);
        for (const [gateId, gate] of outcome.gates) nextGates.set(gateId, gate);
        for (const handle of outcome.state.terminals) nextTerminals.add(handle);
      }
      if (runRows.length > 0 && runs.length === 0) throw new OrcaReadError("invalid-shape");
      const notifications: Notification[] = [];
      const pendingGateKeys = new Set<string>();
      for (const run of runs) for (const gate of run.gates) if (gate.status === "pending") pendingGateKeys.add(key(run.id, gate.id));
      for (const candidate of candidates) {
        if (!seen.has(candidate.key)) {
          seen.add(candidate.key);
          if (candidate.notification.gateId) gateStates.set(key(candidate.notification.runId, candidate.notification.gateId), {
            runId: candidate.notification.runId, gateId: candidate.notification.gateId,
            lastAlertedAt: this.now(), repeatCount: 0, muted: false,
          });
          if (!baseline) {
            notifications.push(candidate.notification);
          }
        } else if (candidate.notification.gateId) {
          const gateKey = key(candidate.notification.runId, candidate.notification.gateId);
          let state = gateStates.get(gateKey);
          if (!state) {
            state = { runId: candidate.notification.runId, gateId: candidate.notification.gateId,
              lastAlertedAt: this.now(), repeatCount: 0, muted: false };
            gateStates.set(gateKey, state);
          } else if (!baseline && !state.muted && state.repeatCount < MAX_GATE_REPEATS && this.now() - state.lastAlertedAt >= GATE_REPEAT_MS) {
            state = { ...state, lastAlertedAt: this.now(), repeatCount: state.repeatCount + 1 };
            gateStates.set(gateKey, state);
            notifications.push(candidate.notification);
          }
        }
      }
      await this.ledger.save({ version: 2, keys: [...seen].slice(-MAX_LEDGER_KEYS),
        gates: [...gateStates.values()].filter((gate) => pendingGateKeys.has(key(gate.runId, gate.gateId))) });
      this.knownGates = nextGates;
      this.knownTerminals = nextTerminals;
      this.lastRuns = nextRuns;
      this.hasSucceeded = true;
      this.recoveryBaseline = false;
      if (corrupted && !this.unavailableReported) notifications.push({ kind: "unavailable", runId: "", taskId: null, dispatchId: null, gateId: null,
        messageId: null, messageType: null, terminalHandle: null, title: "Orca 상태를 확인할 수 없어" });
      this.unavailableReported = corrupted;
      return { snapshot: { availability: "ready", runs, notifications }, reason: corrupted ? "ledger-corrupt" : null };
    } catch (error) {
      if (this.hasSucceeded) this.recoveryBaseline = true;
      const reason = errorReason(error);
      const notifications: Notification[] = this.unavailableReported ? [] : [{ kind: "unavailable", runId: "", taskId: null, dispatchId: null, gateId: null,
        messageId: null, messageType: null, terminalHandle: null, title: "Orca 상태를 확인할 수 없어" }];
      this.unavailableReported = true;
      return { snapshot: { availability: "unavailable", runs: [], notifications }, reason };
    }
  }

  async snapshot(): Promise<OrcaSnapshot> { return (await this.read()).snapshot; }

  async muteGate(gateId: string, userAction: boolean): Promise<void> {
    if (!userAction) throw new Error("user-action-required");
    const gate = this.knownGates.get(id(gateId));
    if (!gate) throw new Error("gate-invalid");
    const current = await this.ledger.load();
    if (!current || current.version !== 2 || !current.gates) throw new Error("ledger-corrupt");
    const entry = current.gates.find((item) => item.runId === gate.runId && item.gateId === gateId);
    if (!entry) throw new Error("gate-invalid");
    await this.ledger.save({ ...current, gates: current.gates.map((item) => item === entry ? { ...item, muted: true } : item) });
  }

  async resolveGate(gateId: string, resolution: string, userAction: boolean): Promise<OrcaGateResult> {
    if (!userAction) throw new Error("user-action-required");
    const gate = this.knownGates.get(id(gateId));
    if (!gate || !gate.options.includes(resolution)) throw new Error("gate-option-invalid");
    const existing = this.pending.get(gateId);
    if (existing) return existing;
    const operation = this.resolveKnownGate(gateId, resolution, gate);
    this.pending.set(gateId, operation);
    try { return await operation; }
    finally { this.pending.delete(gateId); }
  }

  private async resolveKnownGate(gateId: string, resolution: string, known: { runId: string; taskId: string; options: readonly string[] }): Promise<OrcaGateResult> {
    const current = await this.call(["orchestration", "gate-list", "--run", known.runId, "--json"]);
    const row = array(current.gates).map(field).find((gate) => gate.id === gateId);
    if (!row || id(row.task_id) !== known.taskId) throw new Error("gate-changed");
    if (row.status === "resolved") return "already-resolved";
    if (row.status !== "pending" || JSON.stringify(options(row.options)) !== JSON.stringify(known.options)) throw new Error("gate-changed");
    try {
      const result = await this.call(["orchestration", "gate-resolve", "--id", gateId, "--resolution", resolution, "--json"]);
      const resolved = object(result.gate) ?? result;
      if (resolved.id !== gateId || (resolved.run_id !== undefined && resolved.run_id !== known.runId) ||
        (resolved.resolution !== undefined && resolved.resolution !== resolution) ||
        (resolved.status !== undefined && resolved.status !== "resolved")) throw new OrcaReadError("invalid-shape");
      return "resolved";
    } catch {
      const retry = await this.call(["orchestration", "gate-list", "--run", known.runId, "--json"]);
      const latest = array(retry.gates).map(field).find((gate) => gate.id === gateId);
      return latest?.status === "resolved" ? "already-resolved" : "unconfirmed";
    }
  }

  async openTerminal(handle: string, userAction: boolean): Promise<void> {
    if (!userAction) throw new Error("user-action-required");
    if (!this.knownTerminals.has(id(handle))) throw new Error("terminal-invalid");
    await this.call(["terminal", "switch", "--terminal", handle, "--json"]);
  }
}
