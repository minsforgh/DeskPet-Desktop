import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Box = { x: number; y: number; width: number; height: number };
type State = { workArea: Box; character: { state: string }; bubble: { visible: boolean; bounds: Box | null;
  renderer: { buttons: Array<{ label: string; box: Box; clipped: boolean;
    overflow: { width: number; height: number } }>; body: Box; tail: Box } } };

let app: DesktopApp;
let tempDir: string;
let auth: { port: number; token: string };

const state = (): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;

function notify(actions: Array<{ label: string; action: string }>, text = "Choose an action"): Promise<number> {
  const content = JSON.stringify({ source: "bubble-actions-e2e", type: "notify", text, actions });
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(content);
  });
}

function expectInside(inner: Box, outer: Box): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

function expectRenderedButtons(shown: State, labels: string[]): void {
  expect(shown.bubble.visible).toBe(true);
  const bounds = shown.bubble.bounds;
  if (!bounds) throw new Error("Bubble has no bounds");
  expectInside(bounds, shown.workArea);
  expect(bounds.width).toBeLessThanOrEqual(280);
  expect(shown.bubble.renderer.buttons.map(({ label }) => label)).toEqual(labels);
  for (const button of shown.bubble.renderer.buttons) {
    expect(button.clipped).toBe(false);
    expect(button.overflow.width).toBeLessThanOrEqual(0);
    expect(button.overflow.height).toBeLessThanOrEqual(0);
    expectInside(button.box, shown.bubble.renderer.body);
  }
}

const actions = (labels: string[]): Array<{ label: string; action: string }> =>
  labels.map((label) => ({ label, action: "deskpet.ping" }));

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-bubble-actions-e2e-")); }, 30000);
beforeEach(async () => {
  const userDataDir = join(tempDir, `user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
  await app.request({ cmd: "clock", pause: true });
}, 30000);
afterEach(async () => { if (app) await app.dispose(); }, 15000);
afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

test("a displayed ping button runs through the action registry and closes the bubble", async () => {
  const label = "<b>Ping</b>";
  const longLabel = "A long button label that needs room";
  expect(await notify([{ label, action: "deskpet.ping" },
    { label: longLabel, action: "deskpet.ping" }])).toBe(202);
  const shown = await state();
  expectRenderedButtons(shown, [label, longLabel]);
  const bounds = shown.bubble.bounds;
  if (!bounds) throw new Error("Bubble has no bounds");
  const button = shown.bubble.renderer.buttons[0]?.box;
  if (!button) throw new Error("Action button has no bounds");
  expect(await app.request({ cmd: "bubbleHitTest", x: button.x + button.width / 2,
    y: button.y + button.height / 2 })).toEqual({ interactive: true });
  await app.request({ cmd: "bubbleAction", index: 0 });
  expect((await state()).character.state).toBe("happy");
  expect((await state()).bubble.visible).toBe(false);
});

test("every fixed built-in plugin action label fits inside its rendered button", async () => {
  // plugins/orca/src/index.ts, plugins/jungle/src/reaction.ts and plugins/slack/src/index.ts.
  // Orca gate options are supplied by the caller; "승인" and "거절" occur in its built-in tests.
  const labels = ["열기", "승인", "거절", "다시 알리지 않기", "출석 페이지 열기", "다시 확인", "로그인", "Slack 에서 열기"];
  for (let index = 0; index < labels.length; index += 3) {
    const group = labels.slice(index, index + 3);
    expect(await notify(actions(group))).toBe(202);
    expectRenderedButtons(await state(), group);
    await app.request({ cmd: "bubbleDismiss" });
    if (index + 3 < labels.length) await app.request({ cmd: "clock", advanceMs: 5_000 });
  }
});

test("three long action labels wrap into more than one row inside the work area", async () => {
  const labels = ["아주 긴 첫 번째 선택 버튼", "아주 긴 두 번째 선택 버튼", "아주 긴 세 번째 선택 버튼"];
  expect(await notify(actions(labels))).toBe(202);
  const shown = await state();
  expectRenderedButtons(shown, labels);
  const buttons = shown.bubble.renderer.buttons;
  const first = buttons[0];
  if (!first) throw new Error("Action buttons are missing");
  expect(buttons.some(({ box }) => box.y > first.box.y)).toBe(true);
});

test("a short message widens to fit its long action label", async () => {
  expect(await notify([], "Hi")).toBe(202);
  const plain = await state();
  const plainWidth = plain.bubble.bounds?.width;
  if (!plainWidth) throw new Error("Text-only bubble has no bounds");
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });

  const label = "다시 알리지 않기";
  expect(await notify(actions([label]), "Hi")).toBe(202);
  const shown = await state();
  expectRenderedButtons(shown, [label]);
  const bounds = shown.bubble.bounds;
  if (!bounds) throw new Error("Bubble has no bounds");
  expect(bounds.width).toBeGreaterThan(plainWidth);
});

test("one action wider than 280px wraps its own text without clipping", async () => {
  const label = "한버튼안에서줄을바꾸어모든글자를보여주세요".repeat(3);
  expect(await notify(actions([label, "열기"]), "Hi")).toBe(202);
  const shown = await state();
  expectRenderedButtons(shown, [label, "열기"]);
  const [longButton, shortButton] = shown.bubble.renderer.buttons;
  if (!longButton || !shortButton) throw new Error("Action buttons are missing");
  expect(longButton.box.height).toBeGreaterThan(shortButton.box.height);
});

test("an unregistered action closes the bubble without changing the expression", async () => {
  expect(await notify([{ label: "Unknown", action: "deskpet.missing" }])).toBe(202);
  expect((await state()).bubble.renderer.buttons).toHaveLength(1);
  await app.request({ cmd: "bubbleAction", index: 0 });
  const closed = await state();
  expect(closed.bubble.visible).toBe(false);
  expect(closed.character.state).toBe("idle");
  expect((await app.requestRaw({ cmd: "bubbleAction", index: 0 })).ok).toBe(false);
});
