import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { parseLines, renderLine } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const catalog = parseLines(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../plugins/orca/lines.json"), "utf8")), "orca").catalog;

type Fixture = { newWorker: boolean; gate: boolean; resolved: boolean; gateId: string;
  gates?: Array<{ id: string; status?: "pending" | "resolved"; options?: string[] }>;
  workerId?: string; workerState?: string; workerLiveness?: string;
  messageType?: string; messageId?: string; messages?: Array<{ id: string; type: string }>;
  waiting?: boolean; options?: string[]; fail?: boolean;
  delayMs?: number; extraRuns?: Array<{ id: string; active: boolean }>; extraGates?: Record<string, Array<{ id: string }>> };
type State = { bubble: { visible: boolean; text: string | null;
  renderer: { buttons: Array<{ label: string }> } }; trayMenu: string[];
  rendererMetrics: { badge: { visible: boolean; text: string | null;
    rect: { x: number; y: number; width: number; height: number } | null } };
  pluginHost: { plugins: Array<{ id: string; state: string }> } };
let root: string;
const roots: string[] = [];
const apps: DesktopApp[] = [];
const statePath = () => join(root, "state.json");
const logPath = () => join(root, "argv.jsonl");
const pluginRoot = () => join(root, "plugins");
const scriptPath = () => join(root, "fake-orca-cli.mjs");
const userData = () => join(root, "user-data");
const fixture = (changes: Partial<Fixture> = {}) => writeFile(statePath(), JSON.stringify({
  newWorker: false, gate: false, resolved: false, gateId: "gate_1", ...changes,
} satisfies Fixture));
const calls = async (): Promise<string[][]> => (await readFile(logPath(), "utf8")).trim().split("\n")
  .filter(Boolean).map((line) => (JSON.parse(line) as { args: string[] }).args);
const events = async (app: DesktopApp): Promise<string[]> =>
  ((await app.request({ cmd: "events" })) as { events: Array<{ event: {
    text?: string; line?: { id: string; vars?: Record<string, string> } } }> }).events
    .map(({ event }) => event.line ? renderLine(catalog, event.line.id, event.line.vars) ?? "" : event.text ?? "");
const state = (app: DesktopApp) => app.request({ cmd: "state" }) as Promise<State>;
const waitFor = (fn: () => Promise<void>) => vi.waitFor(fn, { timeout: 10_000, interval: 50 });
const clock = new Map<DesktopApp, { at: number; fresh: boolean }>();
const setTime = async (app: DesktopApp, at: number): Promise<void> => {
  clock.set(app, { at, fresh: true });
  await app.request({ cmd: "setOrcaTimeForTest", atMs: at });
};
const poll = async (app: DesktopApp): Promise<void> => {
  const value = clock.get(app);
  const at = value?.fresh ? value.at : (value?.at ?? -30_000) + 30_000;
  await setTime(app, at);
  clock.set(app, { at, fresh: false });
  // Seven fake-CLI snapshots reached 5.02 s in the unit-file run on this PC;
  // the dev hook waits for the complete CLI read and renderer effect.
  expect((await app.requestRaw({ cmd: "advanceReminderClockForTest", advanceMs: 30_000 }, 10_000)).ok).toBe(true);
};
const badge = async (app: DesktopApp): Promise<string | undefined> => {
  const auth = await app.eventServerAuth(userData());
  const response = await fetch(`http://127.0.0.1:${auth.port}/status`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  const body = await response.json() as { plugins: Array<{ id: string; badge?: string }> };
  return body.plugins.find(({ id }) => id === "orca")?.badge;
};

async function launch(dataDir: string): Promise<DesktopApp> {
  const app = await DesktopApp.launch(dataDir, [`--plugins-dir=${pluginRoot()}`, "--permission-answer=allow"]);
  apps.push(app);
  await app.request({ cmd: "setOrcaExecutableForTest", path: scriptPath() });
  return app;
}

test("WAL changes show a bubble quickly while unchanged requests reuse cache and missing WAL keeps the safety check", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-fast-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  const wal = join(directory, "orchestration.db-wal");
  await writeFile(wal, "");
  const app = await launch(userData());
  await app.request({ cmd: "setOrcaWalDirectoryForTest", path: directory });
  await app.request({ cmd: "setOrcaTimeForTest", atMs: 1_000 });
  await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 });
  const auth = await app.eventServerAuth(userData());
  const fastStatus = async () => {
    const response = await fetch(`http://127.0.0.1:${auth.port}/status`,
      { headers: { Authorization: `Bearer ${auth.token}` } });
    return await response.json() as { orca: { fastDetection: { enabled: boolean; message?: string } } };
  };
  expect((await fastStatus()).orca.fastDetection).toEqual({ enabled: true });
  const before = (await calls()).filter((args) => args[1] === "run-list").length;
  await app.request({ cmd: "setOrcaTimeForTest", atMs: 2_000 });
  await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 });
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(before);
  await fixture({ newWorker: true });
  await utimes(wal, new Date(10_000), new Date(10_000));
  await app.request({ cmd: "setOrcaTimeForTest", atMs: 4_000 });
  await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 });
  await waitFor(async () => {
    expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task이 끝났어" });
    expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]);
  });
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(before + 1);
  await unlink(wal);
  await app.request({ cmd: "setOrcaTimeForTest", atMs: 5_000 });
  await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 });
  expect((await fastStatus()).orca.fastDetection).toEqual({ enabled: false, message: "빠른 감지 꺼짐" });
  expect(JSON.stringify(await fastStatus())).not.toContain(root);
  await app.request({ cmd: "setOrcaTimeForTest", atMs: 34_000 });
  await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 });
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(before + 2);
  await app.quit();
}, 45_000);

test("real Orca plugin shows notifications and performs only clicked actions through the fake CLI", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixture();
  let app = await launch(userData());
  await poll(app);
  await waitFor(async () => { expect((await state(app)).pluginHost.plugins.find(({ id }) => id === "orca")?.state).toBe("running"); });
  expect((await events(app)).some((entry) => entry.includes("끝났어"))).toBe(false);

  await fixture({ newWorker: true, workerId: "ctx_success" });
  await poll(app);
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task이 끝났어" }); });
  expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]);
  await app.request({ cmd: "bubbleDismiss" });

  await fixture({ newWorker: true, workerId: "ctx_failed", workerState: "failed" });
  await poll(app);
  await waitFor(async () => { expect(await events(app)).toContain("Fixture task에 실패했어"); });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task에 실패했어" }); });
  expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]);
  await app.request({ cmd: "bubbleDismiss" });

  await fixture({ gate: true, options: ["승인", "거절"] });
  await poll(app);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => {
    expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task 확인이 필요해" });
    expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["승인", "거절", "다시 알리지 않기"]);
  });
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await app.request({ cmd: "bubbleAction", index: 0 });
  await waitFor(async () => { expect(await events(app)).toContain("결정했어"); });
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(1);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "결정했어" }); });
  await app.request({ cmd: "bubbleDismiss" });

  await fixture({ messageType: "question", messageId: "msg_question" });
  await poll(app);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect(await events(app)).toContain("Fixture task 질문이 왔어"); });
  await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]); });
  await app.request({ cmd: "bubbleAction", index: 0 });
  await waitFor(async () => { expect((await calls()).filter((args) => args[0] === "terminal" && args[1] === "switch")).toHaveLength(1); });
  expect((await calls()).find((args) => args[0] === "terminal" && args[1] === "switch"))
    .toContain("term_coordinator");

  await fixture({ messages: [{ id: "msg_question", type: "question" },
    { id: "msg_escalation", type: "escalation" }] });
  await poll(app);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect(await events(app)).toContain("Fixture task에서 문제가 생겼어"); });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task에서 문제가 생겼어" }); });
  await app.request({ cmd: "bubbleDismiss" });

  await fixture({ waiting: true });
  await poll(app);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect(await events(app)).toContain("Orca 작업에서 나를 기다려"); });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Orca 작업에서 나를 기다려" }); });
  await app.request({ cmd: "bubbleDismiss" });

  await fixture({ newWorker: true, workerId: "ctx_exited", workerState: "working", workerLiveness: "exited" });
  await poll(app);
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect(await events(app)).toContain("Fixture task이 멈춘 것 같아"); });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task이 멈춘 것 같아" }); });
  expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]);
  expect((await calls()).filter((args) => args[1] === "check")).toHaveLength(0);

  await app.quit();
  app = await launch(userData());
  await poll(app);
  expect((await events(app)).filter((entry) => entry === "Fixture task이 멈춘 것 같아")).toHaveLength(0);
  await app.quit();

  const missingDir = join(root, "missing-user-data");
  await mkdir(missingDir);
  app = await launch(missingDir);
  await app.request({ cmd: "setOrcaExecutableForTest", path: null });
  await poll(app);
  await waitFor(async () => { expect(await events(app)).toContain("Orca 상태를 확인할 수 없어"); });
  await poll(app);
  expect((await events(app)).filter((entry) => entry === "Orca 상태를 확인할 수 없어")).toHaveLength(1);
  const auth = await app.eventServerAuth(missingDir);
  const response = await fetch(`http://127.0.0.1:${auth.port}/status`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  const statusBody = await response.json() as { plugins: Array<{ id: string; badge?: string }> };
  expect(statusBody.plugins.find(({ id }) => id === "orca")?.badge).toBe("Orca 상태 확인 불가");
  expect((await calls()).filter((args) => args[1] === "check")).toHaveLength(0);
  await app.quit();
}, 90_000);

test("recovery baselines questions received during an outage and shows the next new question", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-recovery-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixture({ messages: [{ id: "msg_old", type: "question" }] });
  const app = await launch(userData());
  await setTime(app, 0);
  await poll(app);
  await waitFor(async () => { expect((await state(app)).pluginHost.plugins.find(({ id }) => id === "orca")?.state).toBe("running"); });
  expect((await events(app)).filter((entry) => entry === "Fixture task 질문이 왔어")).toHaveLength(0);

  await fixture({ fail: true, messages: [{ id: "msg_old", type: "question" }] });
  await poll(app);
  await setTime(app, 30_000);
  await poll(app);
  await waitFor(async () => { expect(await events(app)).toContain("Orca 상태를 확인할 수 없어"); });
  await fixture({ messages: [{ id: "msg_old", type: "question" }, { id: "msg_during_outage", type: "question" }] });
  await setTime(app, 90_000);
  await poll(app);
  expect((await events(app)).filter((entry) => entry === "Fixture task 질문이 왔어")).toHaveLength(0);
  expect((await state(app)).bubble.text).not.toBe("Fixture task 질문이 왔어");

  await fixture({ messages: [{ id: "msg_old", type: "question" }, { id: "msg_during_outage", type: "question" },
    { id: "msg_new", type: "question" }] });
  await poll(app);
  await waitFor(async () => { expect((await events(app)).filter((entry) => entry === "Fixture task 질문이 왔어")).toHaveLength(1); });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => {
    expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Fixture task 질문이 왔어" });
    expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["열기"]);
  });
  await app.quit();
}, 90_000);

test("pending gate badge, tray review, timed repeats, mute, restart, and resolution", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-gates-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixture();
  let app = await launch(userData());
  await setTime(app, 0);
  await poll(app);
  await fixture({ gate: true, options: ["승인", "거절"] });
  await setTime(app, 30_000);
  await poll(app);
  await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label))
    .toEqual(["승인", "거절", "다시 알리지 않기"]); });
  expect((await state(app)).rendererMetrics.badge.visible).toBe(false);
  expect(await badge(app)).toBe("확인 대기 1건");
  expect((await state(app)).trayMenu).toContain("대기 중인 Orca 확인 다시 보기");
  await app.request({ cmd: "bubbleDismiss" });
  await waitFor(async () => {
    const shown = await state(app);
    expect(shown.rendererMetrics.badge).toMatchObject({ visible: true, text: "확인 대기 1건" });
    expect(shown.trayMenu).toContain("Orca: 실행 중 · 확인 대기 1건");
  });
  const chip = (await state(app)).rendererMetrics.badge.rect;
  if (!chip) throw new Error("Pending gate badge has no bounds");
  expect(await app.request({ cmd: "petBadgeClickForTest",
    x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 })).toEqual({ clicked: true });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true,
    text: "Fixture task 확인이 필요해" }); });
  expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(["승인", "거절", "다시 알리지 않기"]);
  await app.request({ cmd: "clock", advanceMs: 30_000 });
  await waitFor(async () => { expect((await state(app)).bubble.visible).toBe(false); });
  await setTime(app, 329_999);
  await poll(app);
  expect((await events(app)).filter((text) => text === "Fixture task 확인이 필요해")).toHaveLength(2);
  await setTime(app, 360_000);
  await poll(app);
  await waitFor(async () => { expect((await events(app)).filter((text) => text === "Fixture task 확인이 필요해")).toHaveLength(3); });
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await app.quit();

  app = await launch(userData());
  await setTime(app, 660_000);
  await poll(app);
  await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label))
    .toEqual(["승인", "거절", "다시 알리지 않기"]); });
  const ledger = JSON.parse(await readFile(join(userData(), "orca-notification-ledger.json"), "utf8")) as {
    gates: Array<{ repeatCount: number; muted: boolean }> };
  expect(ledger.gates).toMatchObject([{ repeatCount: 2, muted: false }]);
  await app.request({ cmd: "bubbleAction", index: 2 });
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(userData(), "orca-notification-ledger.json"), "utf8")) as {
      gates: Array<{ muted: boolean }> };
    expect(saved.gates[0]?.muted).toBe(true);
  });
  await setTime(app, 960_000);
  await poll(app);
  expect((await events(app)).filter((text) => text === "Fixture task 확인이 필요해")).toHaveLength(1);
  expect(await badge(app)).toBe("확인 대기 1건");
  await app.request({ cmd: "trayMenuClick", label: "대기 중인 Orca 확인 다시 보기" });
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true,
    text: "Fixture task 확인이 필요해" }); });
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await fixture({ gate: true, resolved: true, options: ["승인", "거절"] });
  await poll(app);
  await waitFor(async () => { expect(await badge(app)).toBeUndefined(); });
  await app.request({ cmd: "bubbleDismiss" });
  const before = (await events(app)).filter((text) => text === "Fixture task 확인이 필요해").length;
  await app.request({ cmd: "trayMenuClick", label: "대기 중인 Orca 확인 다시 보기" });
  expect((await events(app)).filter((text) => text === "Fixture task 확인이 필요해")).toHaveLength(before);
  await app.quit();
}, 90_000);

test("multiple pending gates keep their buttons in order on alert and tray review", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-multiple-gates-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixture();
  const app = await launch(userData());
  await setTime(app, 0);
  await poll(app);
  await fixture({ gates: [
    { id: "gate_1", options: ["first", "no"] }, { id: "gate_2", options: [] },
    { id: "gate_3", options: ["third", "no"] },
  ] });
  const expected = [["first", "no", "다시 알리지 않기"], ["열기", "다시 알리지 않기"],
    ["third", "no", "다시 알리지 않기"]];
  for (const buttons of expected) {
    await poll(app);
    await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(buttons); });
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "clock", advanceMs: 5_000 });
  }
  expect(await badge(app)).toBe("확인 대기 3건");
  await app.request({ cmd: "trayMenuClick", label: "대기 중인 Orca 확인 다시 보기" });
  await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(expected[0]); });
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  for (const buttons of expected.slice(1)) {
    await poll(app);
    await waitFor(async () => { expect((await state(app)).bubble.renderer.buttons.map(({ label }) => label)).toEqual(buttons); });
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "clock", advanceMs: 5_000 });
  }
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await app.quit();
}, 90_000);

test("a gate in an active run shows within a quick read while a gate in a finished run waits for the safety check", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-quick-e2e-"));
  roots.push(root);
  await mkdir(join(pluginRoot(), "orca", "dist"), { recursive: true });
  await mkdir(userData());
  const source = resolve(import.meta.dirname, "../../../plugins/orca");
  await copyFile(join(source, "manifest.json"), join(pluginRoot(), "orca", "manifest.json"));
  await copyFile(join(source, "lines.json"), join(pluginRoot(), "orca", "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(pluginRoot(), "orca", "dist", "index.js"));
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  const extraRuns = [{ id: "run_old", active: false }, { id: "run_busy", active: true }];
  await fixture({ delayMs: 100, extraRuns });
  const directory = join(root, "orca");
  await mkdir(directory);
  const wal = join(directory, "orchestration.db-wal");
  await writeFile(wal, "");
  const app = await launch(userData());
  await app.request({ cmd: "setOrcaWalDirectoryForTest", path: directory });
  const tick = async (atMs: number) => {
    await app.request({ cmd: "setOrcaTimeForTest", atMs });
    expect((await app.requestRaw({ cmd: "advanceReminderClockForTest", advanceMs: 1_000 }, 20_000)).ok).toBe(true);
  };
  const runCalls = async (id: string) => (await calls()).filter((args) => args.includes(id)).length;
  await tick(1_000);
  const oldAfterFull = await runCalls("run_old");
  expect(oldAfterFull).toBeGreaterThan(0);

  await fixture({ delayMs: 100, extraRuns, extraGates: { run_old: [{ id: "gate_old" }] } });
  await utimes(wal, new Date(10_000), new Date(10_000));
  await tick(4_000);
  await waitFor(async () => { expect((await calls()).filter((args) => args[1] === "run-list").length).toBeGreaterThan(1); });
  expect(await runCalls("run_old")).toBe(oldAfterFull);
  expect((await events(app)).some((text) => text.includes("Extra run_old"))).toBe(false);

  await fixture({ delayMs: 100, extraRuns, extraGates: { run_old: [{ id: "gate_old" }], run_busy: [{ id: "gate_busy" }] } });
  await utimes(wal, new Date(20_000), new Date(20_000));
  const started = Date.now();
  await tick(7_000);
  await waitFor(async () => { expect((await state(app)).bubble).toMatchObject({ visible: true, text: "Extra run_busy 확인이 필요해" }); });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await runCalls("run_old")).toBe(oldAfterFull);
  await app.request({ cmd: "bubbleDismiss" });

  await tick(40_000);
  await waitFor(async () => { expect(await events(app)).toContain("Extra run_old 확인이 필요해"); });
  expect(await runCalls("run_old")).toBeGreaterThan(oldAfterFull);
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await app.quit();
}, 60_000);

afterAll(async () => {
  for (const app of apps) await app.dispose();
  for (const path of roots) await cleanupTemporaryPath(path, apps);
}, 45_000);
