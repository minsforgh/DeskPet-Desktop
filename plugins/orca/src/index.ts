import type { LinePetEvent } from "@deskpet/core";
import type { Disposable } from "@deskpet/plugin-sdk";
import type { OrcaSnapshot, PluginContext, PluginDefinition } from "@deskpet/plugin-sdk/v2";

const GATE_ACTION = "orca.resolve";
const OPEN_ACTION = "orca.open";
const REVIEW_ACTION = "orca.review";
const MUTE_ACTION = "orca.mute";
const BADGE = "orca.status";
// M12 observed a WAL mtime change within 0.1 s in 250 ms samples on this PC.
// The host caches unchanged requests; the 1 s IPC poll preserves a 30 s CLI safety check.
const POLL_MS = 1_000;

type Notice = OrcaSnapshot["notifications"][number];

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// The longest default sentence adds 10 code points around the task, and a bubble holds 120.
function taskVars(title: string): { task: string } {
  return { task: Array.from(title.trim() || "Orca 작업").slice(0, 100).join("") };
}

function noticeKey(item: Notice): string {
  const target = item.gateId ?? item.dispatchId ?? item.messageId ?? item.taskId ?? item.terminalHandle ?? item.kind;
  return `${item.runId}:${item.kind}:${target}`;
}

export function createOrcaPlugin(ctx: PluginContext): Disposable {
  let disposed = false;
  let polling = false;
  let unavailable = false;
  let latest: OrcaSnapshot | null = null;
  let reviewQueue: Array<{ runId: string; gateId: string }> = [];
  const pendingGates = new Set<string>();
  const gateOptions = new Map<string, readonly string[]>();
  const terminals = new Set<string>();
  const resources: Disposable[] = [];

  const showGate = (run: OrcaSnapshot["runs"][number], gate: OrcaSnapshot["runs"][number]["gates"][number]): void => {
    const title = run.tasks.find((task) => task.id === gate.taskId)?.title ?? "Orca 작업";
    const open = run.coordinatorHandle
      ? [{ label: "열기", action: OPEN_ACTION, args: { handle: run.coordinatorHandle } }] : [];
    const actions = gate.taskId !== null && gate.options.length === 2 && gate.options.every((option) => option.length > 0)
      ? gate.options.map((option) => ({ label: option, action: GATE_ACTION, args: { gateId: gate.id, option } })) : open;
    ctx.emit({ source: "orca", type: "notify", key: `${run.id}:attention:${gate.id}`, line: { id: "orca.gate-pending", vars: taskVars(title) },
      mood: "surprised", priority: "urgent", actions: [...actions,
        { label: "다시 알리지 않기", action: MUTE_ACTION, args: { runId: run.id, gateId: gate.id } }] });
  };

  const showNextReview = (): boolean => {
    while (reviewQueue.length > 0) {
      const next = reviewQueue.shift();
      const run = latest?.runs.find((item) => item.id === next?.runId);
      const gate = run?.gates.find((item) => item.id === next?.gateId && item.status === "pending");
      if (run && gate) { showGate(run, gate); return true; }
    }
    return false;
  };

  const poll = async (): Promise<void> => {
    if (disposed || polling) return;
    polling = true;
    try {
      const snapshot = await ctx.orca.snapshot();
      if (disposed) return;
      if (snapshot.availability === "unavailable") {
        const count = latest?.runs.reduce((total, run) => total + run.gates.filter((gate) => gate.status === "pending").length, 0) ?? 0;
        ctx.setBadge(BADGE, { text: count ? `확인 대기 ${count}건` : "Orca 상태 확인 불가", tone: "warn" });
        if (!unavailable) ctx.emit({ source: "orca", type: "notify", key: "unavailable",
          line: { id: "orca.unavailable" }, mood: "worried", priority: "low" });
        unavailable = true;
        return;
      }
      latest = snapshot;
      const gateCount = snapshot.runs.reduce((total, run) => total + run.gates.filter((gate) => gate.status === "pending").length, 0);
      ctx.setBadge(BADGE, gateCount ? { text: `확인 대기 ${gateCount}건`, tone: "warn", action: REVIEW_ACTION } : null);
      unavailable = false;
      gateOptions.clear();
      terminals.clear();
      for (const run of snapshot.runs) {
        if (run.coordinatorHandle) terminals.add(run.coordinatorHandle);
        for (const gate of run.gates) if (gate.status === "pending" && gate.taskId !== null) gateOptions.set(gate.id, gate.options);
      }
      // One gate per poll keeps the notification queue from grouping away its action buttons.
      let gateShown = showNextReview();
      for (const item of snapshot.notifications) {
        if (item.kind === "unavailable") {
          ctx.setBadge(BADGE, { text: "Orca 상태 확인 불가", tone: "warn" });
          if (!unavailable) ctx.emit({ source: "orca", type: "notify", key: "unavailable",
            line: { id: "orca.unavailable" }, mood: "worried", priority: "low" });
          unavailable = true;
          continue;
        }
        const run = snapshot.runs.find((entry) => entry.id === item.runId);
        const event: LinePetEvent = { source: "orca", type: "notify", key: noticeKey(item) };
        const open = item.terminalHandle
          ? [{ label: "열기", action: OPEN_ACTION, args: { handle: item.terminalHandle } }] : [];
        if (item.terminalHandle) terminals.add(item.terminalHandle);
        switch (item.kind) {
          case "worker-succeeded":
            Object.assign(event, { line: { id: "orca.worker-succeeded", vars: taskVars(item.title) }, mood: "happy", priority: "high", actions: open });
            break;
          case "worker-failed":
            Object.assign(event, { line: { id: "orca.worker-failed", vars: taskVars(item.title) }, mood: "worried", priority: "high", actions: open });
            break;
          case "worker-exited":
            Object.assign(event, { line: { id: "orca.worker-exited", vars: taskVars(item.title) }, mood: "worried", priority: "high", actions: open });
            break;
          case "coordinator-waiting":
            Object.assign(event, { line: { id: "orca.coordinator-waiting", vars: taskVars(item.title) }, mood: "surprised", priority: "high", actions: open });
            break;
          case "attention": {
            event.priority = "urgent";
            const gate = item.gateId && run?.gates.find((entry) => entry.id === item.gateId && entry.status === "pending");
            if (gate && run) {
              if (!gateShown) { showGate(run, gate); gateShown = true; }
              else if (!reviewQueue.some((entry) => entry.runId === run.id && entry.gateId === gate.id))
                reviewQueue.push({ runId: run.id, gateId: gate.id });
              continue;
            }
            else {
              event.line = { id: item.messageType === "escalation" ? "orca.escalation" : "orca.question", vars: taskVars(item.title) };
              event.mood = "worried";
              event.actions = open;
            }
            break;
          }
        }
        ctx.emit(event);
      }
    } catch {
      ctx.log.warn("orca:snapshot-failed count=1");
      const count = latest?.runs.reduce((total, run) => total + run.gates.filter((gate) => gate.status === "pending").length, 0) ?? 0;
      ctx.setBadge(BADGE, { text: count ? `확인 대기 ${count}건` : "Orca 상태 확인 불가", tone: "warn" });
      if (!unavailable && !disposed) ctx.emit({ source: "orca", type: "notify", key: "unavailable",
        line: { id: "orca.unavailable" }, mood: "worried", priority: "low" });
      unavailable = true;
    } finally {
      polling = false;
    }
  };

  resources.push(ctx.registerAction(GATE_ACTION, async (args) => {
    const entry = object(args);
    const gateId = entry?.gateId;
    const option = entry?.option;
    if (typeof gateId !== "string" || typeof option !== "string" ||
        !gateOptions.get(gateId)?.includes(option) || pendingGates.has(gateId)) return;
    pendingGates.add(gateId);
    let result: unknown;
    try {
      result = await ctx.orca.resolveGate(gateId, option);
    } catch {
      ctx.log.warn("orca:gate-failed count=1");
    } finally {
      pendingGates.delete(gateId);
    }
    if (disposed) return;
    ctx.emit({ source: "orca", type: "notify", key: `gate-result:${gateId}`,
      line: { id: result === "resolved" ? "orca.gate-decided" : result === "already-resolved" ? "orca.gate-already" :
        "orca.gate-unknown" }, mood: result === "resolved" ? "happy" : "worried", priority: "high" });
  }));
  resources.push(ctx.registerAction(OPEN_ACTION, async (args) => {
    const handle = object(args)?.handle;
    if (typeof handle !== "string" || !terminals.has(handle)) return;
    try { await ctx.orca.openTerminal(handle); }
    catch { ctx.log.warn("orca:open-failed count=1"); }
  }));
  resources.push(ctx.registerAction(MUTE_ACTION, async (args) => {
    const entry = object(args);
    const runId = entry?.runId;
    const gateId = entry?.gateId;
    if (typeof runId !== "string" || typeof gateId !== "string" ||
        !latest?.runs.some((run) => run.id === runId && run.gates.some((gate) => gate.id === gateId && gate.status === "pending"))) return;
    try { await ctx.orca.muteGate(gateId); }
    catch { ctx.log.warn("orca:mute-failed count=1"); }
  }));
  resources.push(ctx.registerAction(REVIEW_ACTION, () => {
    reviewQueue = [];
    for (const run of latest?.runs ?? []) for (const gate of run.gates) if (gate.status === "pending")
      reviewQueue.push({ runId: run.id, gateId: gate.id });
    showNextReview();
  }));
  resources.push(ctx.addTrayItem({ id: REVIEW_ACTION, label: "대기 중인 Orca 확인 다시 보기", action: REVIEW_ACTION }));
  resources.push(ctx.schedule.every(POLL_MS, poll));
  return { dispose() {
    disposed = true;
    for (const resource of resources) resource.dispose();
    ctx.setBadge(BADGE, null);
  } };
}

let active: Disposable | undefined;
export default { activate(ctx) {
  active?.dispose();
  active = createOrcaPlugin(ctx);
}, deactivate() {
  active?.dispose();
  active = undefined;
} } satisfies PluginDefinition;
