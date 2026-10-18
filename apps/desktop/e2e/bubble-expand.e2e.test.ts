import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Area = { x: number; y: number; width: number; height: number };
type Bubble = { visible: boolean; bounds: Area | null; renderer: { box: Area; textContent: string;
  expanded: boolean; expandable: boolean; truncated: boolean; hintVisible: boolean; closeVisible: boolean;
  closeBox: Area;
  detailVisible: boolean; scroll: { height: number; clientHeight: number; overflowY: string; top: number };
  buttons: Array<{ label: string; box: Area }> } };
type State = { bubble: Bubble; workArea: Area };

let root: string;
let app: DesktopApp | undefined;
let auth: { port: number; token: string };

function running(): DesktopApp {
  if (!app) throw new Error("App is not running");
  return app;
}
const state = (): Promise<State> => running().request({ cmd: "state" }) as Promise<State>;
const clickText = (): Promise<unknown> => running().request({ cmd: "bubbleTextClick" });
const contains = async (text: string): Promise<boolean> =>
  ((await running().request({ cmd: "bubbleContainsText", text })) as { visible: boolean }).visible;

async function send(text: string, detail?: string, source = "bubble-expand-e2e", actions: string[] = []): Promise<void> {
  const content = JSON.stringify({ type: "notify", source, text, detail,
    actions: actions.map((label) => ({ label, action: "deskpet.ping" })) });
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

function inside(bounds: Area | null, area: Area): void {
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  expect(bounds.x).toBeGreaterThanOrEqual(area.x);
  expect(bounds.y).toBeGreaterThanOrEqual(area.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
}

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "deskpet-bubble-expand-e2e-")); }, 30_000);
afterEach(async () => { if (app) await app.dispose(); app = undefined; }, 20_000);
afterAll(async () => { await cleanupTemporaryPath(root, app ? [app] : []); }, 30_000);

test("truncated text expands within the work area, collapses, and a plain text click closes", async () => {
  app = await DesktopApp.launch(join(root, "text"));
  auth = await running().eventServerAuth(join(root, "text"));
  await running().request({ cmd: "clock", pause: true });
  const long = "긴 알림 내용을 끝까지 확인할 수 있습니다. ".repeat(4);
  await send(long, "supplemental detail");
  const closed = await state();
  expect(closed.bubble.renderer).toMatchObject({ truncated: true, expandable: true, expanded: false });
  expect(closed.bubble.renderer.textContent.endsWith("…")).toBe(true);
  await clickText();
  const opened = await state();
  expect(opened.bubble.renderer).toMatchObject({ expanded: true, closeVisible: true, textContent: long });
  expect(await contains("supplemental detail")).toBe(true);
  expect(opened.bubble.renderer.box.height).toBeGreaterThan(closed.bubble.renderer.box.height);
  inside(opened.bubble.bounds, opened.workArea);
  await clickText();
  const collapsed = await state();
  expect(collapsed.bubble.renderer.expanded).toBe(false);
  expect(collapsed.bubble.renderer.box.height).toBe(closed.bubble.renderer.box.height);
  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  await send("short");
  expect((await state()).bubble.renderer.expandable).toBe(false);
  await clickText();
  expect((await state()).bubble.visible).toBe(false);
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  await send("same", "same");
  expect((await state()).bubble.renderer).toMatchObject({ expandable: false, hintVisible: false });
}, 45_000);

test("an expanded bubble stays rendered past its original duration and closes after collapse", async () => {
  app = await DesktopApp.launch(join(root, "timer"));
  auth = await running().eventServerAuth(join(root, "timer"));
  await running().request({ cmd: "clock", pause: true });
  await send("summary", "detail to read");
  await running().request({ cmd: "clock", advanceMs: 1_000 });
  await clickText();
  await running().request({ cmd: "clock", advanceMs: 6_000 });
  expect((await state()).bubble).toMatchObject({ visible: true, renderer: { expanded: true, textContent: "summary" } });
  await clickText();
  expect((await state()).bubble).toMatchObject({ visible: true, renderer: { expanded: false } });
  await running().request({ cmd: "clock", advanceMs: 4_999 });
  expect((await state()).bubble.visible).toBe(true);
  await running().request({ cmd: "clock", advanceMs: 1 });
  expect((await state()).bubble.visible).toBe(false);
}, 45_000);

test("detail and hook-formatted detail appear only after expansion; close clears the prior detail", async () => {
  app = await DesktopApp.launch(join(root, "detail"));
  auth = await running().eventServerAuth(join(root, "detail"));
  await running().request({ cmd: "clock", pause: true });
  const detail = "Private detail from /event";
  await send("summary", detail);
  expect((await state()).bubble.renderer).toMatchObject({ expandable: true, hintVisible: true, detailVisible: false });
  expect(await contains(detail)).toBe(false);
  await running().request({ cmd: "bubbleHintClick" });
  expect((await state()).bubble.renderer).toMatchObject({ expanded: true, detailVisible: true, closeVisible: true });
  expect(await contains(detail)).toBe(true);
  await running().request({ cmd: "bubbleClose" });
  expect((await state()).bubble).toMatchObject({ visible: false, renderer: { detailVisible: false, expanded: false } });
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  const hookDetail = "C:\\work\\project\n시킨 일: build the project\n결과: passed";
  await send("hook result", hookDetail, "hook");
  expect((await state()).bubble.renderer.hintVisible).toBe(true);
  await clickText();
  expect(await contains(hookDetail)).toBe(true);
  await running().request({ cmd: "clock", advanceMs: 6_000 });
  expect((await state()).bubble).toMatchObject({ visible: true, renderer: { expanded: true } });
  await running().request({ cmd: "bubbleClose" });
  expect((await state()).bubble.visible).toBe(false);
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  await send("next");
  expect((await state()).bubble.renderer).toMatchObject({ expanded: false, expandable: false, detailVisible: false });
  expect(await contains(hookDetail)).toBe(false);
}, 50_000);

test("long detail scrolls while its action and close button stay visible", async () => {
  app = await DesktopApp.launch(join(root, "scroll"));
  auth = await running().eventServerAuth(join(root, "scroll"));
  await running().request({ cmd: "clock", pause: true });
  const detail = "A long private result line. ".repeat(160);
  await send("result", detail, "scroll", ["Act"]);
  await clickText();
  const opened = await state();
  expect(await contains(detail)).toBe(true);
  expect(opened.bubble.renderer.scroll.height).toBeGreaterThan(opened.bubble.renderer.scroll.clientHeight);
  expect(opened.bubble.renderer.scroll.overflowY).toBe("auto");
  expect(opened.bubble.renderer).toMatchObject({ closeVisible: true, buttons: [{ label: "Act" }] });
  expect(opened.bubble.renderer.closeBox.y + opened.bubble.renderer.closeBox.height)
    .toBeLessThanOrEqual(opened.bubble.renderer.box.height);
  expect(opened.bubble.renderer.buttons[0]?.box.y).toBeLessThan(opened.bubble.renderer.closeBox.y);
  inside(opened.bubble.bounds, opened.workArea);
}, 45_000);

test("a queued group exposes its member list as detail", async () => {
  app = await DesktopApp.launch(join(root, "group"));
  auth = await running().eventServerAuth(join(root, "group"));
  await running().request({ cmd: "clock", pause: true });
  await send("blocking", undefined, "blocker");
  for (const member of ["member one", "member two", "member three"]) await send(member, undefined, "group");
  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  expect((await state()).bubble.renderer.hintVisible).toBe(true);
  await clickText();
  expect(await contains("member one\nmember two\nmember three")).toBe(true);
}, 45_000);

test("a 20-member group is capped to about ten lines, scrolls by wheel, and keeps close in the window", async () => {
  app = await DesktopApp.launch(join(root, "cap"));
  auth = await running().eventServerAuth(join(root, "cap"));
  await running().request({ cmd: "clock", pause: true });
  await send("blocking", undefined, "blocker");
  for (let index = 1; index <= 20; index += 1) await send(`member ${index}`, undefined, "group");
  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  await clickText();
  const opened = await state();
  const r = opened.bubble.renderer;
  expect(r.expanded).toBe(true);
  expect(r.scroll.height).toBeGreaterThan(r.scroll.clientHeight);
  expect(r.scroll.clientHeight).toBeLessThanOrEqual(210);
  expect(r.box.height).toBeLessThanOrEqual(210 + 120);
  expect(r.closeBox.y + r.closeBox.height).toBeLessThanOrEqual(r.box.height);
  inside(opened.bubble.bounds, opened.workArea);
  const hit = await running().request({ cmd: "bubbleHitTest", x: r.box.x + r.box.width / 2, y: r.box.y + r.scroll.clientHeight / 2 });
  expect((hit as { interactive: boolean }).interactive).toBe(true);
  const scrolled = (await running().request({ cmd: "bubbleWheelForTest", deltaY: -120 })) as State;
  void scrolled;
  const after = await state();
  expect(after.bubble.renderer.scroll.top).toBeGreaterThan(0);
  expect(after.bubble.renderer.expanded).toBe(true);
  expect(after.bubble.visible).toBe(true);
}, 45_000);

test("a short detail expands without a scrollbar", async () => {
  app = await DesktopApp.launch(join(root, "short"));
  auth = await running().eventServerAuth(join(root, "short"));
  await running().request({ cmd: "clock", pause: true });
  await send("summary", "one short line");
  await clickText();
  const { scroll } = (await state()).bubble.renderer;
  expect(scroll.height).toBeLessThanOrEqual(scroll.clientHeight);
}, 45_000);
