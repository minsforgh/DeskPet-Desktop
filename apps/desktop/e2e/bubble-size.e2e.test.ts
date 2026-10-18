import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { lineVariantText, type LineVariant } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Bubble = { visible: boolean; bounds: { width: number } | null;
  renderer: { box: { width: number }; textContent: string; lines: number; truncated: boolean;
    buttons: Array<{ label: string; box: { x: number; width: number }; clipped: boolean }> } };
type State = { bubble: Bubble };

let root: string;
let userData: string;
let app: DesktopApp | undefined;
let auth: { port: number; token: string };

function running(): DesktopApp {
  if (!app) throw new Error("App is not running");
  return app;
}
const state = (): Promise<State> => running().request({ cmd: "state" }) as Promise<State>;
const query = (selector: string): Promise<Array<{ text: string; value: string | null }>> =>
  running().request({ cmd: "settingsQuery", selector }) as Promise<Array<{ text: string; value: string | null }>>;
const set = (selector: string, value: string): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
const waitSaved = (selector: string): Promise<void> => vi.waitFor(async () => {
  expect((await query(selector)).map(({ text }) => text)).toEqual(["저장했어요"]);
}, { timeout: 5_000, interval: 50 });

async function send(text: string, labels: string[] = []): Promise<void> {
  const content = JSON.stringify({ type: "notify", source: "bubble-size-e2e", text,
    actions: labels.map((label) => ({ label, action: "deskpet.ping" })) });
  const status = await new Promise<number>((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(content);
  });
  expect(status).toBe(202);
}

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "deskpet-bubble-size-e2e-")); }, 30_000);
afterEach(async () => { if (app) await app.dispose(); app = undefined; }, 20_000);
afterAll(async () => { await cleanupTemporaryPath(root, app ? [app] : []); }, 30_000);

test("general display controls change the next rendered bubble, preserve each other, and survive restart", async () => {
  userData = join(root, "user-data");
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  auth = await running().eventServerAuth(userData);
  await running().request({ cmd: "clock", pause: true });
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  expect((await query("#bubble-display legend")).map(({ text }) => text)).toEqual(["말풍선 표시"]);
  expect((await query("#bubble-max-width")).map(({ value }) => value)).toEqual(["280"]);
  expect((await query("#bubble-max-lines")).map(({ value }) => value)).toEqual(["4"]);

  await set("#bubble-max-lines", "12");
  await waitSaved("#bubble-status");
  await set("#bubble-max-width", "200");
  await waitSaved("#bubble-status");
  const long = "작업 결과를 확인하고 모든 항목을 처리했습니다. ".repeat(4);
  const labels = ["첫 번째 긴 선택 버튼", "두 번째 긴 선택 버튼"];
  await send(long, labels);
  const narrow = (await state()).bubble;
  expect(narrow.visible).toBe(true);
  expect(narrow.renderer.box.width).toBeLessThanOrEqual(200);
  expect(narrow.renderer.box.width).toBeGreaterThan(190);
  expect(narrow.renderer.truncated).toBe(false);
  expect(narrow.renderer.buttons.map(({ label }) => label)).toEqual(labels);
  for (const button of narrow.renderer.buttons) {
    expect(button.clipped).toBe(false);
    expect(button.box.x + button.box.width).toBeLessThanOrEqual(narrow.renderer.box.width);
  }

  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5000 });
  await set("#bubble-max-width", "400");
  await waitSaved("#bubble-status");
  await send(long, labels);
  const wide = (await state()).bubble;
  expect(wide.renderer.box.width).toBeGreaterThan(300);
  expect(wide.renderer.box.width).toBeLessThanOrEqual(400);
  expect(wide.renderer.box.width).toBeGreaterThan(narrow.renderer.box.width);
  expect(wide.renderer.buttons.map(({ label }) => label)).toEqual(labels);
  for (const button of wide.renderer.buttons) {
    expect(button.clipped).toBe(false);
    expect(button.box.x + button.box.width).toBeLessThanOrEqual(wide.renderer.box.width);
  }

  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5000 });
  await set("#bubble-max-lines", "3");
  await waitSaved("#bubble-status");
  await send(long);
  const clipped = (await state()).bubble.renderer;
  expect(clipped.lines).toBeLessThanOrEqual(3);
  expect(clipped.truncated).toBe(true);
  expect(clipped.textContent.endsWith("…")).toBe(true);

  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5000 });
  await send("짧은 알림");
  const short = (await state()).bubble.renderer;
  expect(short.truncated).toBe(false);
  expect(short.textContent).toBe("짧은 알림");
  expect(short.lines).toBe(1);

  await set("#badge-gap", "8");
  await waitSaved("#badge-status");
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8"))).toMatchObject({
    display: { bubble: { maxWidthDip: 400, maxLines: 3 }, badge: { gap: 8 } },
  });
  await running().request({ cmd: "settingsClose" });
  await running().dispose();
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  auth = await running().eventServerAuth(userData);
  await running().request({ cmd: "clock", pause: true });
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  expect((await query("#bubble-max-width")).map(({ value }) => value)).toEqual(["400"]);
  expect((await query("#bubble-max-lines")).map(({ value }) => value)).toEqual(["3"]);
  expect((await query("#badge-gap")).map(({ value }) => value)).toEqual(["8"]);
  await send(long);
  expect((await state()).bubble.renderer).toMatchObject({ truncated: true, lines: 3 });
}, 90_000);

test("default four lines renders representative built-in notices", async () => {
  userData = join(root, "builtin-user-data");
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  auth = await running().eventServerAuth(userData);
  await running().request({ cmd: "clock", pause: true });
  const variants = async (plugin: string, id: string): Promise<string> => {
    const file = JSON.parse(await readFile(join(import.meta.dirname, "../../../plugins", plugin, "lines.json"), "utf8")) as {
      lines: Array<{ id: string; variants: LineVariant[] }> };
    const value = file.lines.find((line) => line.id === id)?.variants[0];
    if (!value) throw new Error(`Missing built-in line: ${plugin}/${id}`);
    return lineVariantText(value);
  };
  const longResult = "검증을 마치고 변경 사항을 정리했습니다. ".repeat(2);
  const notices = {
    orca: (await variants("orca", "orca.worker-succeeded")).replace("{task}", longResult),
    "claude-code": (await variants("claude-code", "claude-code.done-task-result"))
      .replace("{folder}", "DeskPet").replace("{task}", "설정 작업").replace("{result}", longResult),
    slack: (await variants("slack", "slack.mention"))
      .replace("{sender}", "팀원").replace("{channel}", "작업 알림").replace("{body}", longResult),
    jungle: await variants("jungle", "jungle.attendance-complete"),
    reminders: (await variants("reminders", "reminders.rule")).replace("{message}", longResult),
  };
  const measured: Record<string, { lines: number; truncated: boolean }> = {};
  for (const [name, text] of Object.entries(notices)) {
    await send(text);
    const renderer = (await state()).bubble.renderer;
    expect(renderer.lines).toBeLessThanOrEqual(4);
    expect(renderer.truncated).toBe(renderer.textContent.endsWith("…") && !text.endsWith("…"));
    measured[name] = { lines: renderer.lines, truncated: renderer.truncated };
    await running().request({ cmd: "bubbleDismiss" });
    await running().request({ cmd: "clock", advanceMs: 5000 });
  }
  console.info(`Built-in bubble layout at 280 DIP / 4 lines: ${JSON.stringify(measured)}`);
}, 60_000);
