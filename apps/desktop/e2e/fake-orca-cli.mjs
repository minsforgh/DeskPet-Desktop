import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
appendFileSync(join(root, "argv.jsonl"), `${JSON.stringify({ at: Date.now(), args })}\n`);
const statePath = join(root, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.fail) process.exit(1);
// Optional per-command delay and extra runs: extraRuns = [{ id, active }]; extraGates = { runId: [{ id, status }] }.
if (state.delayMs) await sleep(state.delayMs);
const extra = new Map((state.extraRuns ?? []).map((entry) => [entry.id, entry]));
const argRun = args[args.indexOf("--run") + 1];
const command = args.slice(0, 2).join(" ");
const runId = "run_1";
const taskId = "task_1";
const worker = (id, workerState, liveness = "live") => ({ dispatchId: id, taskId, runId, workerState,
  agentTerminalHandle: "term_worker", projection: { stage: { activity: workerState },
    liveness: { verdict: liveness, observedAt: "2026-10-13T00:00:00Z" } } });
const gate = { id: state.gateId, task_id: taskId, status: state.resolved ? "resolved" : "pending",
  options: JSON.stringify(state.options ?? ["yes", "no"]) };
const gates = state.gates?.map((entry) => ({ id: entry.id, task_id: taskId, status: entry.status ?? "pending",
  options: JSON.stringify(entry.options ?? ["yes", "no"]) })) ?? (state.gate ? [gate] : []);
let result;
switch (command) {
  case "orchestration run-list": result = { runs: [{ id: runId, coordinator_handle: "term_coordinator" },
    { id: "run_completed", coordinator_handle: null },
    ...(state.extraRuns ?? []).map((entry) => ({ id: entry.id, coordinator_handle: null }))], nextCursor: null }; break;
  case "orchestration inbox": result = { messages: (state.messages ?? (state.messageType ?
    [{ id: state.messageId ?? "msg_1", type: state.messageType }] : [])).map((entry) => ({
      id: entry.id, run_id: runId, type: entry.type, payload: { taskId },
    })) }; break;
  case "orchestration task-list": result = extra.has(argRun)
    ? { runId: argRun, tasks: [{ id: "task_" + argRun, task_title: "Extra " + argRun, status: extra.get(argRun).active ? "running" : "completed" }] }
    : args[args.indexOf("--run") + 1] === "run_completed"
    ? { runId: "run_completed", tasks: [{ id: "task_completed", task_title: null, status: "completed" }] }
    : { runId, tasks: [{ id: taskId, task_title: state.title ?? "Fixture task", status: "running" }] }; break;
  case "orchestration worker-list": result = { workers: args[args.indexOf("--run") + 1] === "run_completed" || extra.has(argRun) ? [] : [worker("ctx_old", "succeeded"),
    ...(state.newWorker ? [worker(state.workerId ?? "ctx_new", state.workerState ?? "succeeded",
      state.workerLiveness ?? "live")] : [])], page: { hasMore: false, nextCursor: null } }; break;
  case "orchestration gate-list": result = extra.has(argRun)
    ? { runId: argRun, gates: (state.extraGates?.[argRun] ?? []).map((entry) => ({ id: entry.id, task_id: "task_" + argRun, status: entry.status ?? "pending", options: JSON.stringify(["yes", "no"]) })) }
    : args[args.indexOf("--run") + 1] === "run_completed"
    ? { runId: "run_completed", gates: [] } : { runId, gates }; break;
  case "orchestration worker-show": result = { dispatch: { status: "succeeded" } }; break;
  case "terminal show": result = { terminal: { agentWait: state.waiting ? { status: "waiting" } : null } }; break;
  case "orchestration gate-resolve":
    state.resolved = true;
    writeFileSync(statePath, JSON.stringify(state));
    result = { id: state.gateId, status: "resolved", resolution: args[args.indexOf("--resolution") + 1] };
    break;
  case "terminal switch": result = { terminal: "term_coordinator" }; break;
  default: process.stderr.write(`Unexpected fake Orca command: ${command}`); process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, result }));
