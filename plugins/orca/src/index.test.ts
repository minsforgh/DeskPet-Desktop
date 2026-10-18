import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { parseLines, renderLine } from "@deskpet/core";
import type { LinePetEvent } from "@deskpet/core";
import type { OrcaSnapshot, PluginContext } from "@deskpet/plugin-sdk/v2";
import { createOrcaPlugin } from "./index.js";

const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "orca");
const lineText = (event: LinePetEvent | undefined): string | undefined =>
  event?.line ? renderLine(parsed.catalog, event.line.id, event.line.vars) : undefined;
const kindOf = (event: LinePetEvent | undefined): string | undefined =>
  parsed.catalog.lines.find(({ id }) => id === event?.line?.id)?.kind;

type Notice = OrcaSnapshot["notifications"][number];
const notice = (kind: Notice["kind"], changes: Partial<Notice> = {}): Notice => ({
  kind, runId: "run_1", taskId: "task_1", dispatchId: null, gateId: null,
  messageId: null, messageType: null, terminalHandle: "term_1", title: "작업", ...changes,
});
const run: OrcaSnapshot["runs"][number] = {
  id: "run_1", coordinatorHandle: "term_1", coordinatorWaiting: false,
  tasks: [{ id: "task_1", title: "작업", status: "running" }],
  workers: [], gates: [{ id: "gate_1", taskId: "task_1", status: "pending", options: ["승인", "거절"] }],
  messages: [{ id: "msg_1", taskId: "task_1", type: "question" },
    { id: "msg_2", taskId: "task_1", type: "escalation" }],
};
const snapshot = (notifications: Notice[], overrides: Partial<OrcaSnapshot> = {}): OrcaSnapshot =>
  ({ availability: "ready", runs: [run], notifications, ...overrides });

function harness(initial: OrcaSnapshot = snapshot([])) {
  const emitted: LinePetEvent[] = [];
  const badges: Array<{ text: string; action?: string } | null> = [];
  const handlers = new Map<string, (args?: unknown) => Promise<void> | void>();
  const tray: Array<{ id: string; label: string; action: string }> = [];
  let tick: (() => Promise<void>) | undefined;
  let intervalMs = 0;
  let current = initial;
  const resolveGate = vi.fn<(gateId: string, option: string) => Promise<unknown>>(async () => "resolved");
  const openTerminal = vi.fn(async () => {});
  const muteGate = vi.fn(async () => {});
  const read = vi.fn(async () => current);
  const context = {
    emit: (event: LinePetEvent) => emitted.push(event),
    setBadge: (_id: string, badge: { text: string; action?: string } | null) => badges.push(badge),
    registerAction: (id: string, fn: (args?: unknown) => Promise<void> | void) => {
      handlers.set(id, fn); return { dispose() {} };
    },
    addTrayItem: (item: { id: string; label: string; action: string }) => {
      tray.push(item); return { dispose() {} };
    },
    schedule: { every: (_ms: number, fn: () => Promise<void>) => {
      intervalMs = _ms; tick = fn; return { dispose() {} };
    } },
    orca: { snapshot: read, resolveGate, muteGate, openTerminal },
    log: { warn: vi.fn() },
  } as unknown as PluginContext;
  const plugin = createOrcaPlugin(context);
  return { emitted, badges, tray, resolveGate, muteGate, openTerminal, read, plugin,
    intervalMs: () => intervalMs,
    set: (next: OrcaSnapshot) => { current = next; },
    poll: async () => { await tick?.(); },
    click: async (id: string, args?: unknown) => { await handlers.get(id)?.(args); },
  };
}

test("requests a snapshot each second", () => {
  const app = harness();
  expect(app.intervalMs()).toBe(1_000);
  app.plugin.dispose();
});

test("lines.json parses cleanly and every line is selected by the source", () => {
  expect(parsed.problems).toEqual([]);
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const ids = parsed.catalog.lines.map(({ id }) => id);
  expect(ids).toHaveLength(11);
  for (const id of ids) expect(source).toContain(`"${id}"`);
});

test("emits the requested line, priority, mood and buttons for every notification kind", async () => {
  const app = harness(snapshot([
    notice("worker-succeeded", { dispatchId: "done" }),
    notice("worker-failed", { dispatchId: "failed" }),
    notice("attention", { gateId: "gate_1" }),
    notice("attention", { messageId: "msg_1", messageType: "question" }),
    notice("attention", { messageId: "msg_2", messageType: "escalation" }),
    notice("coordinator-waiting"), notice("worker-exited", { dispatchId: "exited" }),
  ]));
  await app.poll();
  const vars = { task: "작업" };
  expect(app.emitted.map((event) => ({ line: event.line, text: lineText(event), kind: kindOf(event), plain: event.text,
    priority: event.priority, mood: event.mood, buttons: event.actions?.map(({ label }) => label) }))).toEqual([
    { line: { id: "orca.worker-succeeded", vars }, text: "작업이 끝났어", kind: "done", priority: "high", mood: "happy", buttons: ["열기"] },
    { line: { id: "orca.worker-failed", vars }, text: "작업에 실패했어", kind: "failed", priority: "high", mood: "worried", buttons: ["열기"] },
    { line: { id: "orca.gate-pending", vars }, text: "작업 확인이 필요해", kind: "waiting", priority: "urgent", mood: "surprised",
      buttons: ["승인", "거절", "다시 알리지 않기"] },
    { line: { id: "orca.question", vars }, text: "작업 질문이 왔어", kind: "waiting", priority: "urgent", mood: "worried", buttons: ["열기"] },
    { line: { id: "orca.escalation", vars }, text: "작업에서 문제가 생겼어", kind: "alert", priority: "urgent", mood: "worried", buttons: ["열기"] },
    { line: { id: "orca.coordinator-waiting", vars }, text: "작업에서 나를 기다려", kind: "waiting", priority: "high", mood: "surprised", buttons: ["열기"] },
    { line: { id: "orca.worker-exited", vars }, text: "작업이 멈춘 것 같아", kind: "failed", priority: "high", mood: "worried", buttons: ["열기"] },
  ].map((expected) => ({ ...expected, plain: undefined })));
  expect(app.resolveGate).not.toHaveBeenCalled();
  expect(app.openTerminal).not.toHaveBeenCalled();
  app.plugin.dispose();
});

test.each([{ options: [] }, { options: ["one"] }, { options: ["one", "two", "three"] }])("gate options $options show only open", async ({ options }) => {
  const app = harness(snapshot([notice("attention", { gateId: "gate_1" })],
    { runs: [{ ...run, gates: [{ id: "gate_1", taskId: "task_1", status: "pending", options }] }] }));
  await app.poll();
  expect(app.emitted[0]?.actions?.map(({ label }) => label)).toEqual(["열기", "다시 알리지 않기"]);
  app.plugin.dispose();
});

test("blank titles use the task fallback and long titles keep the sentence ending inside 120 code points", async () => {
  const app = harness(snapshot([notice("worker-succeeded", { title: "  " }),
    notice("worker-exited", { title: "😀".repeat(150), dispatchId: "long" })]));
  await app.poll();
  expect(app.emitted.map((event) => event.line)).toEqual([
    { id: "orca.worker-succeeded", vars: { task: "Orca 작업" } },
    { id: "orca.worker-exited", vars: { task: "😀".repeat(100) } }]);
  expect(lineText(app.emitted[0])).toBe("Orca 작업이 끝났어");
  expect(Array.from(lineText(app.emitted[1]) ?? "")).toHaveLength(109);
  expect(lineText(app.emitted[1])?.endsWith("이 멈춘 것 같아")).toBe(true);
  app.plugin.dispose();
});

test("missing terminal handle omits open", async () => {
  const app = harness(snapshot([notice("worker-exited", { terminalHandle: null })]));
  await app.poll();
  expect(app.emitted[0]?.actions).toEqual([]);
  app.plugin.dispose();
});

test("gate without a task id offers only the terminal action", async () => {
  const app = harness(snapshot([notice("attention", { gateId: "gate_1" })],
    { runs: [{ ...run, gates: [{ id: "gate_1", taskId: null, status: "pending", options: ["yes", "no"] }] }] }));
  await app.poll();
  expect(app.emitted[0]?.actions?.map(({ label }) => label)).toEqual(["열기", "다시 알리지 않기"]);
  await app.click("orca.resolve", { gateId: "gate_1", option: "yes" });
  expect(app.resolveGate).not.toHaveBeenCalled();
  app.plugin.dispose();
});

test("overlapping scheduled polls issue one snapshot request", async () => {
  const app = harness();
  let finish: (value: OrcaSnapshot) => void = () => {};
  app.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = app.poll();
  await app.poll();
  expect(app.read).toHaveBeenCalledTimes(1);
  finish(snapshot([]));
  await first;
  app.plugin.dispose();
});

test("unavailable reports once and clears the badge after recovery", async () => {
  const app = harness(snapshot([notice("unavailable")], { availability: "unavailable", runs: [] }));
  await app.poll(); await app.poll();
  expect(app.emitted.map((event) => event.line)).toEqual([{ id: "orca.unavailable" }]);
  expect(app.emitted.map(lineText)).toEqual(["Orca 상태를 확인할 수 없어"]);
  expect(kindOf(app.emitted[0])).toBe("alert");
  expect(app.badges.at(-1)?.text).toBe("Orca 상태 확인 불가");
  app.set(snapshot([], { runs: [] })); await app.poll();
  expect(app.badges.at(-1)).toBeNull();
  app.plugin.dispose();
});

test.each([
  ["resolved", "orca.gate-decided", "결정했어", "happy"], ["already-resolved", "orca.gate-already", "이미 처리된 확인이야", "worried"],
  ["unconfirmed", "orca.gate-unknown", "승인 결과를 확인하지 못했어", "worried"],
])("gate response %s yields %s", async (response, id, expected, mood) => {
  const app = harness(snapshot([notice("attention", { gateId: "gate_1" })]));
  app.resolveGate.mockResolvedValue(response);
  await app.poll();
  const action = app.emitted[0]?.actions?.[0];
  await app.click(action?.action ?? "", action?.args);
  expect(app.resolveGate).toHaveBeenCalledOnce();
  expect(app.emitted.at(-1)?.line).toEqual({ id });
  expect(lineText(app.emitted.at(-1))).toBe(expected);
  expect(kindOf(app.emitted.at(-1))).toBe("info");
  expect(app.emitted.at(-1)).toMatchObject({ mood, priority: "high" });
  app.plugin.dispose();
});

test("gate requests overlap at most once and open uses only a known terminal", async () => {
  const app = harness(snapshot([notice("attention", { gateId: "gate_1" }), notice("worker-exited") ]));
  let finish: (value: unknown) => void = () => {};
  app.resolveGate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await app.poll();
  const gate = app.emitted[0]?.actions?.[0];
  const first = app.click(gate?.action ?? "", gate?.args);
  await app.click(gate?.action ?? "", gate?.args);
  expect(app.resolveGate).toHaveBeenCalledTimes(1);
  finish("resolved"); await first;
  await app.click("orca.open", { handle: "unknown" });
  await app.click("orca.open", { handle: "term_1" });
  expect(app.openTerminal).toHaveBeenCalledExactlyOnceWith("term_1");
  app.plugin.dispose();
});

test("badge counts pending gates and tray review replays only the latest successful pending gates", async () => {
  const app = harness(snapshot([]));
  await app.poll();
  expect(app.badges.at(-1)?.text).toBe("확인 대기 1건");
  expect(app.badges.at(-1)?.action).toBe("orca.review");
  expect(app.tray).toEqual([{ id: "orca.review", label: "대기 중인 Orca 확인 다시 보기", action: "orca.review" }]);
  await app.click("orca.review");
  expect(app.emitted.at(-1)?.actions?.map(({ label }) => label)).toEqual(["승인", "거절", "다시 알리지 않기"]);
  expect(app.emitted.at(-1)?.line).toEqual({ id: "orca.gate-pending", vars: { task: "작업" } });
  app.set(snapshot([], { availability: "unavailable", runs: [] }));
  await app.poll();
  expect(app.badges.at(-1)?.text).toBe("확인 대기 1건");
  expect(app.badges.at(-1)?.action).toBeUndefined();
  app.set(snapshot([], { runs: [{ ...run, gates: [{ id: "gate_1", taskId: "task_1", status: "resolved", options: ["승인", "거절"] }] }] }));
  await app.poll();
  expect(app.badges.at(-1)).toBeNull();
  const before = app.emitted.length;
  await app.click("orca.review");
  expect(app.emitted).toHaveLength(before);
  app.plugin.dispose();
});

test("mute button calls only the local mute API for a pending gate", async () => {
  const app = harness(snapshot([notice("attention", { gateId: "gate_1" })]));
  await app.poll();
  const action = app.emitted[0]?.actions?.[2];
  await app.click(action?.action ?? "", action?.args);
  expect(app.muteGate).toHaveBeenCalledExactlyOnceWith("gate_1");
  expect(app.resolveGate).not.toHaveBeenCalled();
  app.plugin.dispose();
});

test("counts and replays multiple pending gates in snapshot order", async () => {
  const second = { id: "gate_2", taskId: "task_1", status: "pending" as const, options: ["yes", "no"] };
  const app = harness(snapshot([], { runs: [{ ...run, gates: [...run.gates, second] }] }));
  await app.poll();
  expect(app.badges.at(-1)?.text).toBe("확인 대기 2건");
  await app.click("orca.review");
  expect(app.emitted).toHaveLength(1);
  await app.poll();
  expect(app.emitted.map(({ actions }) => actions?.slice(0, 2).map(({ label }) => label)))
    .toEqual([["승인", "거절"], ["yes", "no"]]);
  app.plugin.dispose();
});

test("tray review opens an invalid-options gate even when the gate was baselined", async () => {
  const app = harness(snapshot([], { runs: [{ ...run, gates: [{ id: "gate_1", taskId: "task_1", status: "pending", options: [] }] }] }));
  await app.poll();
  await app.click("orca.review");
  expect(app.emitted[0]?.actions?.map(({ label }) => label)).toEqual(["열기", "다시 알리지 않기"]);
  const open = app.emitted[0]?.actions?.[0];
  await app.click(open?.action ?? "", open?.args);
  expect(app.openTerminal).toHaveBeenCalledExactlyOnceWith("term_1");
  app.plugin.dispose();
});

test("three simultaneous gate alerts keep their buttons across successive polls", async () => {
  const gates = ["gate_1", "gate_2", "gate_3"].map((id) => ({ id, taskId: "task_1", status: "pending" as const, options: ["yes", "no"] }));
  const app = harness(snapshot(gates.map(({ id }) => notice("attention", { gateId: id })),
    { runs: [{ ...run, gates }] }));
  await app.poll();
  expect(app.emitted).toHaveLength(1);
  app.set(snapshot([], { runs: [{ ...run, gates }] }));
  await app.poll();
  await app.poll();
  expect(app.emitted).toHaveLength(3);
  expect(app.emitted.every((event) => event.actions?.map(({ label }) => label).join(",") === "yes,no,다시 알리지 않기")).toBe(true);
  app.plugin.dispose();
});
