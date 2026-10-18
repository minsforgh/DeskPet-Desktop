import { describe, expect, it, vi } from "vitest";
import { MAX_PARALLEL_RUNS, OrcaReader, orcaRetryDelayMs, type OrcaCommandResult, type OrcaLedger, type OrcaLedgerStore } from "./orca-reader.js";

const run = { id: "run_1", objective: "private objective", coordinator_handle: "term_1", updated_at: "2026-10-13T00:00:00Z" };
const completedRun = { id: "run_completed", coordinator_handle: null, updated_at: "2026-10-12T00:00:00Z" };
const task = { id: "task_1", run_id: "run_1", task_title: "Safe\n title", status: "running", spec: "private spec", result: "private body" };
const worker = { dispatchId: "ctx_1", taskId: "task_1", runId: "run_1", workerState: "working", agentTerminalHandle: "term_2", projection: { stage: { activity: "working" }, liveness: { verdict: "live", observedAt: "2026-10-13T00:00:00Z" }, evidence: { lastObservedAt: "2026-10-13T00:00:00Z" } }, worktreePath: "C:/private/path" };
const gate = { id: "gate_1", run_id: "run_1", task_id: "task_1", question: "private question", options: '["yes","no"]', status: "pending" };
const message = { id: "msg_1", run_id: "run_1", type: "question", payload: JSON.stringify({ taskId: "task_1", gateId: "gate_1", body: "private message" }) };
type Fixture = { runs: Record<string, unknown>[]; tasks: Record<string, unknown>[]; workers: Record<string, unknown>[]; gates: Record<string, unknown>[]; messages: Record<string, unknown>[]; agentWait: unknown };

function setup(changes: Partial<Fixture> = {}, initial: string[] = []) {
  const fixture: Fixture = { runs: [run], tasks: [task], workers: [worker], gates: [gate], messages: [message], agentWait: null, ...changes };
  const calls: string[][] = [];
  let state: OrcaLedger = { version: 1, keys: initial };
  const ledger: OrcaLedgerStore = { load: async () => state, save: async (value) => { state = value; } };
  const response = (result: unknown): OrcaCommandResult => ({ code: 0, stdout: JSON.stringify({ id: "reply", ok: true, result }), stderr: "", timedOut: false });
  const execute = async (args: readonly string[]): Promise<OrcaCommandResult> => {
    calls.push([...args]);
    const command = args.slice(0, 2).join(" ");
    if (command === "orchestration run-list") return response({ runs: fixture.runs, nextCursor: null });
    if (command === "orchestration inbox") return response({ messages: fixture.messages });
    if (command === "orchestration task-list") return args.includes("run_completed")
      ? response({ runId: "run_completed", tasks: [{ id: "task_completed", task_title: null, status: "completed" }] })
      : response({ runId: "run_1", tasks: fixture.tasks });
    if (command === "orchestration worker-list") return response({ workers: args.includes("run_completed") ? [] : fixture.workers, page: { hasMore: false, nextCursor: null } });
    if (command === "orchestration gate-list") return args.includes("run_completed")
      ? response({ runId: "run_completed", gates: [] }) : response({ runId: "run_1", gates: fixture.gates });
    if (command === "terminal show") return response({ terminal: { agentWait: fixture.agentWait, worktreePath: "C:/private/path" } });
    if (command === "orchestration worker-show") return response({ dispatch: { status: "failed" } });
    if (command === "orchestration gate-resolve") return response({ id: "gate_1", status: "resolved" });
    if (command === "terminal switch") return response({ terminal: "term_2" });
    throw new Error(`Unexpected command: ${command}`);
  };
  return { fixture, calls, ledger, execute, reader: new OrcaReader(execute, ledger), get keys() { return state.keys; }, get gates() { return state.gates ?? []; } };
}

describe("OrcaReader", () => {
  it("uses only the read allowlist and omits private fields", async () => {
    const test = setup();
    const result = await test.reader.read();
    expect(result.snapshot.availability).toBe("ready");
    expect(result.snapshot.runs[0]?.tasks[0]?.title).toBe("Safe  title");
    expect(JSON.stringify(result.snapshot)).not.toMatch(/private|C:\/|objective|spec/);
    expect(test.calls).toEqual([
      ["orchestration", "inbox", "--full", "--json"], ["orchestration", "run-list", "--json"],
      ["orchestration", "task-list", "--run", "run_1", "--json"], ["orchestration", "worker-list", "--run", "run_1", "--json"],
      ["orchestration", "gate-list", "--run", "run_1", "--json"], ["terminal", "show", "--terminal", "term_1", "--json"],
    ]);
    expect(test.calls.filter((args) => args.includes("check"))).toHaveLength(0);
  });

  it("uses returned cursors for both paged commands", async () => {
    const test = setup();
    const original = test.execute;
    let runs = 0;
    let workers = 0;
    const reader = new OrcaReader(async (args) => {
      if (args[1] === "run-list") {
        runs++;
        return { code: 0, stdout: JSON.stringify({ ok: true, result: runs === 1 ? { runs: [], nextCursor: "cursor_1" } : { runs: [run], nextCursor: null } }), stderr: "", timedOut: false };
      }
      if (args[1] === "worker-list") {
        workers++;
        return { code: 0, stdout: JSON.stringify({ ok: true, result: workers === 1 ? { workers: [], page: { hasMore: true, nextCursor: "cursor_2" } } : { workers: [worker], page: { hasMore: false } } }), stderr: "", timedOut: false };
      }
      return original(args);
    }, test.ledger);
    expect((await reader.read()).snapshot.availability).toBe("ready");
    expect(runs).toBe(2);
    expect(workers).toBe(2);
  });

  it("baselines existing events and avoids duplicates after restart", async () => {
    const test = setup();
    expect((await test.reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.workers = [{ ...worker, dispatchId: "ctx_2", workerState: "succeeded" }];
    expect((await test.reader.read()).snapshot.notifications.map((item) => item.kind)).toEqual(["worker-succeeded"]);
    const restarted = new OrcaReader(test.execute, test.ledger);
    expect((await restarted.read()).snapshot.notifications).toEqual([]);
    test.fixture.workers = [{ ...worker, dispatchId: "ctx_3", workerState: "succeeded" }];
    expect((await restarted.read()).snapshot.notifications).toMatchObject([{ kind: "worker-succeeded", dispatchId: "ctx_3" }]);
    expect(test.keys.join(" ")).not.toMatch(/private|Safe/);
  });

  it("repeats a pending gate three times on the injected five-minute clock and preserves the count across restart", async () => {
    const test = setup({ gates: [], messages: [] });
    let time = 1_000;
    const reader = new OrcaReader(test.execute, test.ledger, () => time);
    await reader.read();
    test.fixture.gates = [gate];
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_1" }]);
    expect(test.gates).toEqual([{ runId: "run_1", gateId: "gate_1", lastAlertedAt: 1_000, repeatCount: 0, muted: false }]);
    time += 299_999;
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    time++;
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_1" }]);
    expect(test.gates[0]?.repeatCount).toBe(1);
    const restarted = new OrcaReader(test.execute, test.ledger, () => time);
    for (let repeat = 2; repeat <= 3; repeat++) {
      time += 300_000;
      expect((await restarted.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_1" }]);
      expect(test.gates[0]?.repeatCount).toBe(repeat);
    }
    time += 300_000;
    expect((await restarted.read()).snapshot.notifications).toEqual([]);
    expect(test.gates).toHaveLength(1);
  });

  it("migrates an alerted v1 gate without immediately repeating it and removes resolved gates", async () => {
    const gateKey = JSON.stringify(["run_1", "gate_1", "gate"]);
    const test = setup({ messages: [] }, [JSON.stringify(["orca-reader", "baseline"]), gateKey]);
    const reader = new OrcaReader(test.execute, test.ledger, () => 50_000);
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    expect(test.gates[0]).toMatchObject({ lastAlertedAt: 50_000, repeatCount: 0 });
    test.fixture.gates = [{ ...gate, status: "resolved" }];
    await reader.read();
    expect(test.gates).toEqual([]);
    test.fixture.gates = [];
    await reader.read();
    expect(test.gates).toEqual([]);
  });

  it("mutes only the clicked pending gate without sending an Orca command", async () => {
    const test = setup({ gates: [], messages: [] });
    let time = 0;
    const reader = new OrcaReader(test.execute, test.ledger, () => time);
    await reader.read();
    test.fixture.gates = [gate, { ...gate, id: "gate_2" }];
    await reader.read();
    await expect(reader.muteGate("gate_1", false)).rejects.toThrow("user-action-required");
    await expect(reader.muteGate("gate_unknown", true)).rejects.toThrow("gate-invalid");
    const before = test.calls.length;
    await reader.muteGate("gate_1", true);
    expect(test.calls).toHaveLength(before);
    expect(test.gates.map(({ muted }) => muted)).toEqual([true, false]);
    time = 300_000;
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_2" }]);
    expect(test.gates.map(({ repeatCount }) => repeatCount)).toEqual([0, 1]);
    test.fixture.gates = [gate];
    await reader.read();
    expect(test.gates.map(({ gateId }) => gateId)).toEqual(["gate_1"]);
  });

  it("holds repeat state through unavailable reads and the recovery baseline", async () => {
    const test = setup({ gates: [], messages: [] });
    let time = 0;
    let failing = false;
    const reader = new OrcaReader(async (args) => failing
      ? { code: 1, stdout: "", stderr: "offline", timedOut: false }
      : test.execute(args), test.ledger, () => time);
    await reader.read();
    test.fixture.gates = [gate];
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_1" }]);
    time = 300_000;
    failing = true;
    expect((await reader.read()).snapshot.availability).toBe("unavailable");
    expect(test.gates[0]?.repeatCount).toBe(0);
    failing = false;
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    expect(test.gates[0]?.repeatCount).toBe(0);
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ gateId: "gate_1" }]);
    expect(test.gates[0]?.repeatCount).toBe(1);
  });

  it("baselines the first successful snapshot after an outage, then alerts only new items", async () => {
    const test = setup({ gates: [], messages: [] });
    let failing = false;
    const reader = new OrcaReader(async (args) => failing
      ? { code: 1, stdout: "", stderr: "offline", timedOut: false }
      : test.execute(args), test.ledger);
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    failing = true;
    expect((await reader.read()).snapshot.availability).toBe("unavailable");
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.gates = [gate];
    test.fixture.messages = [{ ...message, payload: JSON.stringify({ taskId: "task_1" }) }];
    failing = false;
    const recovered = await reader.read();
    expect(recovered.snapshot.availability).toBe("ready");
    expect(recovered.snapshot.runs[0]).toMatchObject({ gates: [{ id: "gate_1", status: "pending" }], messages: [{ id: "msg_1" }] });
    expect(recovered.snapshot.notifications).toEqual([]);
    expect(test.keys).toContain(JSON.stringify(["run_1", "gate_1", "gate"]));
    expect(test.keys).toContain(JSON.stringify(["run_1", "msg_1", "message"]));
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.gates.push({ ...gate, id: "gate_2" });
    test.fixture.messages.push({ ...message, id: "msg_2", payload: JSON.stringify({ taskId: "task_1" }) });
    expect((await reader.read()).snapshot.notifications).toMatchObject([
      { kind: "attention", gateId: "gate_2" },
      { kind: "attention", messageId: "msg_2" },
    ]);
    expect((await reader.read()).snapshot.notifications).toEqual([]);
  });

  it("baselines recovery even when the ledger disappeared during the outage", async () => {
    const test = setup({ gates: [], messages: [] });
    let state: OrcaLedger = { version: 1, keys: [] };
    let failing = false;
    const ledger: OrcaLedgerStore = { load: async () => state, save: async (value) => { state = value; } };
    const reader = new OrcaReader(async (args) => failing
      ? { code: 1, stdout: "", stderr: "offline", timedOut: false }
      : test.execute(args), ledger);
    await reader.read();
    failing = true;
    expect((await reader.read()).snapshot.availability).toBe("unavailable");
    state = { version: 1, keys: [] };
    test.fixture.gates = [gate];
    failing = false;
    expect((await reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.gates.push({ ...gate, id: "gate_2" });
    expect((await reader.read()).snapshot.notifications).toMatchObject([{ kind: "attention", gateId: "gate_2" }]);
  });

  it("recognizes attention once per gate and then a separate escalation", async () => {
    const test = setup({ gates: [], messages: [] });
    await test.reader.read();
    test.fixture.gates = [gate];
    test.fixture.messages = [message];
    expect((await test.reader.read()).snapshot.notifications).toMatchObject([
      { kind: "attention", gateId: "gate_1", messageId: null, messageType: null },
    ]);
    test.fixture.messages = [{ ...message, id: "msg_2", type: "escalation", payload: JSON.stringify({ taskId: "task_1" }) }];
    expect((await test.reader.read()).snapshot.notifications).toMatchObject([
      { kind: "attention", gateId: null, messageId: "msg_2", messageType: "escalation" },
    ]);
    test.fixture.messages.push({ ...message, id: "msg_3", payload: JSON.stringify({ taskId: "task_1" }) });
    expect((await test.reader.read()).snapshot.notifications).toMatchObject([
      { kind: "attention", gateId: null, messageId: "msg_3", messageType: "question" },
    ]);
  });

  it("requires positive coordinator wait and positive worker exit", async () => {
    const test = setup({ gates: [], messages: [] });
    await test.reader.read();
    test.fixture.agentWait = true;
    test.fixture.workers = [{ ...worker, projection: { ...worker.projection, liveness: { verdict: "exited" } } }];
    expect((await test.reader.read()).snapshot.notifications.map((item) => item.kind).sort()).toEqual(["coordinator-waiting", "worker-exited"]);
    expect((await test.reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.agentWait = null;
    test.fixture.workers = [{ ...worker, projection: { ...worker.projection, liveness: { verdict: "unverifiable" } } }];
    expect((await test.reader.read()).snapshot.notifications).toEqual([]);
  });

  it("uses worker_done outcome but ignores heartbeat and status", async () => {
    const test = setup({ gates: [], messages: [] });
    await test.reader.read();
    test.fixture.workers = [{ ...worker, dispatchId: "ctx_2" }];
    test.fixture.messages = [
      { id: "msg_2", run_id: "run_1", type: "heartbeat", payload: JSON.stringify({ dispatchId: "ctx_2" }) },
      { id: "msg_3", run_id: "run_1", type: "status", payload: JSON.stringify({ dispatchId: "ctx_2" }) },
    ];
    expect((await test.reader.read()).snapshot.notifications).toEqual([]);
    test.fixture.messages.push({ id: "msg_4", run_id: "run_1", type: "worker_done", payload: JSON.stringify({ dispatchId: "ctx_2", outcome: "failed" }) });
    expect((await test.reader.read()).snapshot.notifications.map((item) => item.kind)).toEqual(["worker-failed"]);
  });

  it("rechecks conflicting worker evidence with worker-show", async () => {
    const test = setup({ gates: [], messages: [] });
    await test.reader.read();
    test.fixture.workers = [{ ...worker, dispatchId: "ctx_3", workerState: "succeeded" }];
    test.fixture.messages = [{ id: "msg_5", run_id: "run_1", type: "worker_done", payload: JSON.stringify({ dispatchId: "ctx_3", outcome: "failed" }) }];
    expect((await test.reader.read()).snapshot.notifications.map((item) => item.kind)).toEqual(["worker-failed"]);
    expect(test.calls.filter((args) => args[1] === "worker-show")).toEqual([["orchestration", "worker-show", "--dispatch", "ctx_3", "--json"]]);
  });

  it("does not alert from a completed run or unverifiable worker", async () => {
    const test = setup({ tasks: [{ ...task, status: "succeeded" }], workers: [{ ...worker, workerState: "unknown", projection: { ...worker.projection, stage: { activity: "unknown" }, liveness: { verdict: "unverifiable" } } }], gates: [], messages: [] });
    await test.reader.read();
    test.fixture.messages = [{ id: "msg_6", run_id: "run_1", type: "question", payload: JSON.stringify({ taskId: "task_1" }) }];
    expect((await test.reader.read()).snapshot.notifications).toEqual([]);
    expect(test.calls.some((args) => args[0] === "terminal")).toBe(false);
  });

  it("keeps a completed null-handle run alongside an active run and alerts from the active run", async () => {
    const test = setup({ runs: [completedRun, run], gates: [], messages: [] });
    expect((await test.reader.read()).snapshot.availability).toBe("ready");
    test.fixture.gates = [gate];
    const result = await test.reader.read();
    expect(result.snapshot.availability).toBe("ready");
    expect(result.snapshot.runs).toMatchObject([
      { id: "run_completed", coordinatorHandle: null, coordinatorWaiting: null, tasks: [{ title: "", status: "succeeded" }] },
      { id: "run_1", coordinatorHandle: "term_1", tasks: [{ status: "running" }] },
    ]);
    expect(result.snapshot.notifications).toMatchObject([{ kind: "attention", runId: "run_1", gateId: "gate_1" }]);
    expect(test.calls.filter((args) => args[0] === "terminal" && args.includes("run_completed"))).toEqual([]);
    expect(test.calls.filter((args) => args[0] === "terminal" && args[1] === "show")).toHaveLength(2);
  });

  it("keeps valid runs when a malformed run is mixed in and logs a fixed code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const test = setup({ runs: [{ id: "../invalid", coordinator_handle: "term_bad" }, run], gates: [], messages: [] });
      await test.reader.read();
      test.fixture.messages = [{ ...message, id: "msg_new", payload: { taskId: "task_1" } }];
      const result = await test.reader.read();
      expect(result.snapshot.availability).toBe("ready");
      expect(result.snapshot.runs.map((entry) => entry.id)).toEqual(["run_1"]);
      expect(result.snapshot.notifications).toMatchObject([{ kind: "attention", runId: "run_1", messageId: "msg_new" }]);
      expect(warn).toHaveBeenCalledWith("orca:run-invalid-shape");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("../invalid");
    } finally { warn.mockRestore(); }
  });

  it("keeps active null-handle runs without a terminal lookup or gate write capability", async () => {
    const test = setup({ runs: [{ ...run, coordinator_handle: null }], gates: [{ ...gate, task_id: null }] });
    const result = await test.reader.read();
    expect(result.snapshot.availability).toBe("ready");
    expect(result.snapshot.runs[0]).toMatchObject({ coordinatorHandle: null, coordinatorWaiting: null,
      gates: [{ taskId: null, status: "pending" }] });
    expect(test.calls.some((args) => args[0] === "terminal" && args[1] === "show")).toBe(false);
    await expect(test.reader.resolveGate("gate_1", "yes", true)).rejects.toThrow("gate-option-invalid");
  });

  it("maps the task states returned by the installed CLI", async () => {
    const test = setup({ tasks: [{ ...task, status: "ready" }, { ...task, id: "task_2", status: "dispatched" },
      { ...task, id: "task_3", status: "completed" }] });
    const result = await test.reader.read();
    expect(result.snapshot.runs[0]?.tasks.map((entry) => entry.status)).toEqual(["pending", "running", "succeeded"]);
  });

  it("reports fixed failures without leaking command output", async () => {
    for (const [result, reason] of [
      [{ code: 0, stdout: "not-json private", stderr: "", timedOut: false }, "invalid-json"],
      [{ code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "", timedOut: false }, "invalid-shape"],
      [{ code: 1, stdout: "private", stderr: "private", timedOut: false }, "cli-error"],
      [{ code: null, stdout: "private", stderr: "", timedOut: true }, "timeout"],
    ] as const) {
      const reader = new OrcaReader(async () => result, { load: async () => ({ version: 1, keys: [] }), save: async () => {} });
      const read = await reader.read();
      expect(read.reason).toBe(reason);
      expect(read.snapshot.availability).toBe("unavailable");
      expect(JSON.stringify(read)).not.toContain("private");
    }
    const missing = new OrcaReader(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, { load: async () => ({ version: 1, keys: [] }), save: async () => {} });
    expect((await missing.read()).reason).toBe("cli-missing");
  });

  it("treats damaged ledger as a new baseline and reports it once", async () => {
    const test = setup();
    const reader = new OrcaReader(test.execute, { load: async () => null, save: async () => {} });
    expect((await reader.read()).snapshot.notifications.map((item) => item.kind)).toEqual(["unavailable"]);
  });

  it("rechecks the gate, refuses stale options and requires a user action", async () => {
    const test = setup();
    await test.reader.read();
    await expect(test.reader.resolveGate("gate_1", "yes", false)).rejects.toThrow();
    expect(test.calls.filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
    test.fixture.gates = [{ ...gate, options: '["new","no"]' }];
    await expect(test.reader.resolveGate("gate_1", "yes", true)).rejects.toThrow();
    expect(test.calls.filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
    test.fixture.gates = [{ ...gate, status: "resolved" }];
    expect(await test.reader.resolveGate("gate_1", "yes", true)).toBe("already-resolved");
    test.fixture.gates = [gate];
    expect(await test.reader.resolveGate("gate_1", "yes", true)).toBe("resolved");
    expect(test.calls.filter((args) => args[1] === "gate-resolve")).toEqual([["orchestration", "gate-resolve", "--id", "gate_1", "--resolution", "yes", "--json"]]);
  });

  it.each(['["yes"]', '["yes","yes"]', '["yes","bad\\n"]', "bad-json"])('rejects malformed gate options %s', async (value) => {
    const test = setup({ gates: [{ ...gate, options: value }] });
    await test.reader.read();
    await expect(test.reader.resolveGate("gate_1", "yes", true)).rejects.toThrow();
    expect(test.calls.some((args) => args[1] === "gate-resolve")).toBe(false);
  });

  it("validates terminal handles and identifiers before a write", async () => {
    const test = setup();
    await test.reader.read();
    await expect(test.reader.openTerminal("term_2", false)).rejects.toThrow();
    await expect(test.reader.openTerminal("../term_2", true)).rejects.toThrow();
    await expect(test.reader.openTerminal("term_unknown", true)).rejects.toThrow();
    expect(test.calls.filter((args) => args[1] === "switch")).toHaveLength(0);
    await test.reader.openTerminal("term_2", true);
    expect(test.calls.at(-1)).toEqual(["terminal", "switch", "--terminal", "term_2", "--json"]);
  });

  it.each([["run_1", true], ["ctx-2", true], ["a:b.c@d", true], ["../escape", false], ["--check", false], ["bad value", false]])("validates result identifier %s", async (value, valid) => {
    const test = setup({ runs: [{ ...run, coordinator_handle: value }] });
    expect((await test.reader.read()).snapshot.availability === "ready").toBe(valid);
  });

  it("caps exponential retry delay", () => {
    expect([1, 2, 3, 4, 5, 6].map(orcaRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});

// Many-run fixture: ids in `active` have an unfinished task, the rest are finished.
function multi(ids: string[], active: Set<string>, delay = 0) {
  const state = { active: new Set(active), gates: new Map<string, Record<string, unknown>[]>(), calls: [] as string[][], running: 0, peak: 0 };
  const response = (result: unknown): OrcaCommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "", timedOut: false });
  let ledgerState: OrcaLedger | null = null;
  const ledger: OrcaLedgerStore = { load: async () => ledgerState, save: async (value) => { ledgerState = value; } };
  const execute = async (args: readonly string[]): Promise<OrcaCommandResult> => {
    state.calls.push([...args]);
    state.running++; state.peak = Math.max(state.peak, state.running);
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const command = args.slice(0, 2).join(" ");
      const runId = args[args.indexOf("--run") + 1] ?? "";
      if (command === "orchestration run-list") return response({ runs: ids.map((id) => ({ id, coordinator_handle: null })), nextCursor: null });
      if (command === "orchestration inbox") return response({ messages: [] });
      if (command === "orchestration task-list") return response({ runId, tasks: [{ id: "t_" + runId, task_title: "T " + runId, status: state.active.has(runId) ? "running" : "succeeded" }] });
      if (command === "orchestration worker-list") return response({ workers: [], page: { hasMore: false, nextCursor: null } });
      if (command === "orchestration gate-list") return response({ runId, gates: state.gates.get(runId) ?? [] });
      throw new Error("Unexpected command: " + command);
    } finally { state.running--; }
  };
  return { state, reader: new OrcaReader(execute, ledger), execute, ledger };
}
const perRun = (calls: string[][], id: string) => calls.filter((args) => args.includes(id));

describe("OrcaReader quick reads", () => {
  it("reuses finished runs and reads only active ones", async () => {
    const test = multi(["run_a", "run_b", "run_c"], new Set(["run_b"]));
    await test.reader.read();
    test.state.calls.length = 0;
    const result = await test.reader.read({ mode: "quick" });
    expect(result.snapshot.runs.map((item) => item.id)).toEqual(["run_a", "run_b", "run_c"]);
    expect(perRun(test.state.calls, "run_a")).toHaveLength(0);
    expect(perRun(test.state.calls, "run_c")).toHaveLength(0);
    expect(perRun(test.state.calls, "run_b")).toHaveLength(3);
    expect(test.state.calls.filter((args) => args[1] === "run-list" || args[1] === "inbox")).toHaveLength(2);
  });

  it("treats pending gates, unfinished workers and new runs as active, and finished workers as done", async () => {
    const test = multi(["run_a", "run_b"], new Set());
    await test.reader.read();
    test.state.gates.set("run_a", [{ id: "g1", task_id: "t_run_a", status: "pending", options: "[\"yes\",\"no\"]" }]);
    // run_a still looked finished in the last full read, so a quick read does not see its new gate.
    test.state.calls.length = 0;
    expect((await test.reader.read({ mode: "quick" })).snapshot.notifications).toEqual([]);
    expect(test.state.calls.some((args) => args.includes("run_a"))).toBe(false);
    // The full safety read revives it.
    const full = await test.reader.read();
    expect(full.snapshot.notifications.map((item) => item.gateId)).toEqual(["g1"]);
    // Now run_a is active and is read by quick reads; run_b stays reused.
    test.state.calls.length = 0;
    await test.reader.read({ mode: "quick" });
    expect(perRun(test.state.calls, "run_a")).toHaveLength(3);
    expect(perRun(test.state.calls, "run_b")).toHaveLength(0);
  });

  it("reads runs that newly appear and falls back to a full read before any success or after a failure", async () => {
    const test = multi(["run_a"], new Set());
    expect((await test.reader.read({ mode: "quick" })).snapshot.runs).toHaveLength(1);
    expect(perRun(test.state.calls, "run_a")).toHaveLength(3);
    const growing = multi(["run_a", "run_b"], new Set());
    await growing.reader.read();
    const ids = ["run_a", "run_b", "run_new"];
    const grown = new OrcaReader(async (args) => {
      if (args[1] === "run-list") return { code: 0, stdout: JSON.stringify({ ok: true, result: { runs: ids.map((id) => ({ id, coordinator_handle: null })), nextCursor: null } }), stderr: "", timedOut: false };
      return growing.execute(args);
    }, growing.ledger);
    await grown.read();
    growing.state.calls.length = 0;
    const withNew = await grown.read({ mode: "quick" });
    expect(withNew.snapshot.runs.map((item) => item.id)).toEqual(ids);
    let fail = true;
    const flaky = new OrcaReader(async (args) => fail ? { code: 1, stdout: "", stderr: "", timedOut: false } : growing.execute(args), growing.ledger);
    await flaky.read();
    expect((await flaky.read()).snapshot.availability).toBe("unavailable");
    fail = false;
    growing.state.calls.length = 0;
    await flaky.read({ mode: "quick" });
    expect(perRun(growing.state.calls, "run_a")).toHaveLength(3);
  });

  it("keeps notification meaning: baseline, ledger keys and no writes", async () => {
    const test = setup();
    const first = await test.reader.read();
    const keys = [...test.keys];
    test.calls.length = 0;
    const quick = await test.reader.read({ mode: "quick" });
    expect(quick.snapshot.notifications).toEqual([]);
    expect(first.snapshot.runs.map((item) => item.id)).toEqual(quick.snapshot.runs.map((item) => item.id));
    expect(test.keys).toEqual(keys);
    expect(test.calls.some((args) => args[1] === "run-list")).toBe(true);
    expect(test.calls.some((args) => args[1] === "gate-resolve")).toBe(false);
    expect(test.calls.filter((args) => args.includes("run_completed"))).toHaveLength(0);
  });
});

describe("OrcaReader parallel run reads", () => {
  it("runs at most MAX_PARALLEL_RUNS commands at once and keeps run order", async () => {
    expect(MAX_PARALLEL_RUNS).toBe(4);
    const ids = Array.from({ length: 10 }, (_, index) => "run_" + index);
    const test = multi(ids, new Set(ids), 5);
    const result = await test.reader.read();
    expect(test.state.peak).toBeLessThanOrEqual(MAX_PARALLEL_RUNS + 1);
    expect(test.state.peak).toBeGreaterThan(1);
    expect(result.snapshot.runs.map((item) => item.id)).toEqual(ids);
  });

  it("orders candidates by run even when later runs finish first", async () => {
    const ids = ["run_slow", "run_fast"];
    const test = multi(ids, new Set());
    for (const id of ids) test.state.gates.set(id, [{ id: "g_" + id, task_id: "t_" + id, status: "pending", options: "[\"yes\",\"no\"]" }]);
    await test.ledger.save({ version: 2, keys: [JSON.stringify(["orca-reader", "baseline"])], gates: [] });
    const slow = new OrcaReader(async (args) => {
      if (args.includes("run_slow")) await new Promise((resolve) => setTimeout(resolve, 30));
      return test.execute(args);
    }, test.ledger);
    const result = await slow.read();
    expect(result.snapshot.notifications.map((item) => item.runId)).toEqual(["run_slow", "run_fast"]);
  });
});
