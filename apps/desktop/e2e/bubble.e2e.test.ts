import { mkdtemp, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Area = { x: number; y: number; width: number; height: number };
type Bubble = {
  visible: boolean; text: string | null; priority: string | null; bounds: Area | null; side: "above" | "below" | null;
  focusable: boolean; focused: boolean; alwaysOnTop: boolean; resizable: boolean;
  renderer: { viewport: { width: number; height: number }; box: Area; textBox: Area; tail: Area; textContent: string;
    lines: number; truncated: boolean;
    textChildElements: number; elements: number; overflow: { width: number; height: number } };
};
type State = {
  visible: boolean; contentRect: Area; workArea: Area; character: { state: string; frame: number }; eventServer: { listening: boolean };
  rendererMetrics: { devicePixelRatio: number };
  queue: { pending: number }; delivery: { timer: boolean; nextAtMs: number | null }; clock: { ms: number; paused: boolean };
  bubble: Bubble;
};

let app: DesktopApp;
let tempDir: string;
let userDataDir: string;
let auth: { port: number; token: string };

const state = (): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const advance = (advanceMs: number): Promise<unknown> => app.request({ cmd: "clock", advanceMs });

/** Send a PetEvent over the real local HTTP API. */
function send(event: Record<string, unknown>): Promise<number> {
  const content = JSON.stringify({ type: "notify", ...event });
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

function expectInside(inner: Area | null, outer: Area): asserts inner is Area {
  if (!inner) throw new Error("Bubble has no bounds");
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-bubble-e2e-")); }, 30000);

beforeEach(async () => {
  userDataDir = join(tempDir, `user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
}, 30000);

// Same allowance as event.e2e.test.ts: the helper observes Electron's exit for up to 12 s.
afterEach(async () => { if (app) await app.dispose(); }, 15000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

test("a notify event shows a bubble above the pet until its display time has passed", async () => {
  await app.request({ cmd: "clock", pause: true });
  expect((await state()).bubble).toMatchObject({ visible: false, text: null, bounds: null });
  expect(await send({ source: "e2e", text: "안녕" })).toBe(202);
  const shown = await state();
  expect(shown.bubble).toMatchObject({ visible: true, text: "안녕", priority: "normal", side: "above",
    focusable: false, focused: false, alwaysOnTop: true, resizable: false });
  expect(shown.queue.pending).toBe(0);
  const bounds = shown.bubble.bounds;
  expectInside(bounds, shown.workArea);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(shown.contentRect.y);
  expect(Math.abs(bounds.x + bounds.width / 2 - shown.contentRect.x - shown.contentRect.width / 2)).toBeLessThanOrEqual(1);
  // The tail hangs below the body, toward the pet, and points at the pet's center.
  const { textBox, tail } = shown.bubble.renderer;
  expect(tail.y + tail.height).toBeGreaterThan(textBox.y + textBox.height);
  expect(Math.abs(bounds.x + tail.x + tail.width / 2 - shown.contentRect.x - shown.contentRect.width / 2)).toBeLessThanOrEqual(1);
  // Only the painted bubble takes clicks: the rounded corner and the strip beside the tail pass through.
  const hit = (x: number, y: number) => app.request({ cmd: "bubbleHitTest", x, y });
  expect(await hit(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2)).toEqual({ interactive: true });
  expect(await hit(0, 0)).toEqual({ interactive: false });
  expect(await hit(1, bounds.height - 1)).toEqual({ interactive: false });
  // With no mood there is no reaction, so the pet talks while the bubble is up.
  expect(shown.character.state).toBe("talk");

  await advance(5999);
  expect((await state()).bubble.visible).toBe(true);
  await advance(1);
  const closed = await state();
  expect(closed.bubble).toMatchObject({ visible: false, text: null, bounds: null });
  expect(closed.character.state).toBe("idle");
  expect(closed.delivery).toEqual({ timer: false, nextAtMs: null });
});

test("bubbles are five seconds apart, including urgent", async () => {
  await app.request({ cmd: "clock", pause: true });
  await send({ source: "first", text: "첫 번째" });
  await send({ source: "second", text: "두 번째" });
  const first = await state();
  expect(first.bubble).toMatchObject({ visible: true, text: "첫 번째" });
  expect(first.queue.pending).toBe(1);
  expect(first.delivery.nextAtMs).toBeTypeOf("number");

  await advance(6000);
  const gap = await state();
  expect(gap.bubble.visible).toBe(false);
  expect(gap.queue.pending).toBe(1);
  expect(gap.delivery.nextAtMs).toBe((first.delivery.nextAtMs ?? 0) + 5000);
  await advance(4999);
  expect((await state()).bubble.visible).toBe(false);
  await advance(1);
  const second = await state();
  expect(second.bubble).toMatchObject({ visible: true, text: "두 번째", priority: "normal" });
  expect(second.queue.pending).toBe(0);

  await send({ source: "third", text: "급한 알림", priority: "urgent" });
  expect((await state()).bubble).toMatchObject({ visible: true, text: "두 번째", priority: "normal" });
  expect((await state()).queue.pending).toBe(1);
  await advance(6000);
  expect((await state()).bubble.visible).toBe(false);
  await advance(5000);
  expect((await state()).bubble).toMatchObject({ visible: true, text: "급한 알림", priority: "urgent" });
  await advance(14999);
  expect((await state()).bubble.visible).toBe(true);
  await advance(1);
  expect((await state()).bubble.visible).toBe(false);
});

test("low priority and react events change the expression without a bubble", async () => {
  await app.request({ cmd: "clock", pause: true });
  await send({ source: "e2e", text: "조용한 알림", priority: "low", mood: "happy" });
  const low = await state();
  expect(low.bubble).toMatchObject({ visible: false, text: null });
  expect(low.queue.pending).toBe(0);
  expect(low.character.state).toBe("happy");
  // placeholder's happy is 6 frames at 10 fps and then returns to idle.
  await advance(600);
  expect((await state()).character.state).toBe("idle");

  await send({ source: "e2e", type: "react", mood: "surprised", text: "보이지 않는 글" });
  const reacted = await state();
  expect(reacted.bubble).toMatchObject({ visible: false, text: null });
  expect(reacted.character.state).toBe("surprised");

  await send({ source: "e2e", type: "status", mood: "happy", text: "기록만" });
  const recorded = await state();
  expect(recorded.bubble.visible).toBe(false);
  expect(recorded.character.state).toBe("surprised");
  await advance(417);
  expect((await state()).character.state).toBe("idle");
});

test("the pet holds its reaction until the bubble closes", async () => {
  await app.request({ cmd: "clock", pause: true });
  await send({ source: "e2e", text: "끝났어요", mood: "happy" });
  expect((await state()).character.state).toBe("happy");
  await advance(2_000);
  expect(await state()).toMatchObject({ character: { state: "happy", frame: 5 }, bubble: { visible: true } });
  const dismissed = await app.request({ cmd: "bubbleDismiss" }) as { bubble: Bubble };
  expect(dismissed.bubble).toMatchObject({ visible: false, text: null });
  expect((await state()).character.state).toBe("idle");
  expect((await app.requestRaw({ cmd: "bubbleDismiss" })).ok).toBe(false);

  // The queued urgent notification keeps its looping expression until its bubble closes.
  await send({ source: "e2e", text: "급해요", mood: "worried", priority: "urgent" });
  expect((await state()).queue.pending).toBe(1);
  await advance(5000);
  expect((await state()).character.state).toBe("worried");
  await advance(2249);
  expect((await state()).character.state).toBe("worried");
  await advance(1);
  expect((await state()).character.state).toBe("worried");
  await advance(12_750);
  expect(await state()).toMatchObject({ character: { state: "idle" }, bubble: { visible: false } });
});

test("the next notification starts its own expression after the held bubble closes", async () => {
  await app.request({ cmd: "clock", pause: true });
  expect(await send({ source: "first", text: "first", mood: "happy" })).toBe(202);
  await advance(2_000);
  expect(await state()).toMatchObject({ character: { state: "happy", frame: 5 }, bubble: { text: "first" } });
  expect(await send({ source: "second", text: "second", mood: "worried" })).toBe(202);
  expect(await state()).toMatchObject({ character: { state: "happy" }, bubble: { text: "first" }, queue: { pending: 1 } });
  await advance(4_000);
  expect(await state()).toMatchObject({ character: { state: "idle" }, bubble: { visible: false } });
  await advance(5_000);
  expect(await state()).toMatchObject({ character: { state: "worried" }, bubble: { visible: true, text: "second" } });
  await advance(2_000);
  expect((await state()).character.state).toBe("worried");
  await app.request({ cmd: "bubbleDismiss" });
  expect((await state()).character.state).toBe("idle");
});

test("a spoken interaction keeps its expression for the visible bubble", async () => {
  await app.request({ cmd: "clock", pause: true });
  const menu = await app.request({ cmd: "petMenuLabelsForTest" }) as { labels: string[] };
  const firstInteraction = menu.labels[0];
  const nextInteraction = menu.labels[2];
  if (!firstInteraction || !nextInteraction) throw new Error("Expected default interactions");
  await app.request({ cmd: "petMenuClickForTest", label: firstInteraction });
  expect(await state()).toMatchObject({ character: { state: "happy" }, bubble: { visible: true } });
  await advance(2_000);
  expect(await state()).toMatchObject({ character: { state: "happy", frame: 5 }, bubble: { visible: true } });
  await app.request({ cmd: "bubbleDismiss" });
  expect((await state()).character.state).toBe("idle");
  await advance(500);
  await app.request({ cmd: "petMenuClickForTest", label: nextInteraction });
  expect((await state()).bubble.visible).toBe(false);
  await advance(4_499);
  expect((await state()).bubble.visible).toBe(false);
  await advance(1);
  expect(await state()).toMatchObject({ character: { state: "surprised" }, bubble: { visible: true } });
  await advance(2_000);
  expect(await state()).toMatchObject({ character: { state: "surprised", frame: 4 }, bubble: { visible: true } });
  await app.request({ cmd: "bubbleDismiss" });
  expect((await state()).character.state).toBe("idle");
});

test("the bubble follows the pet and moves below it at the top of the screen", async () => {
  await app.request({ cmd: "clock", pause: true });
  await send({ source: "e2e", text: "따라가요" });
  const before = await state();
  await app.request({ cmd: "moveBy", dx: -300, dy: -200 });
  const moved = await state();
  expect(moved.contentRect.x - before.contentRect.x).toBe(-300);
  expect((moved.bubble.bounds?.x ?? 0) - (before.bubble.bounds?.x ?? 0)).toBe(-300);
  expect((moved.bubble.bounds?.y ?? 0) - (before.bubble.bounds?.y ?? 0)).toBe(-200);

  const grab = { x: moved.contentRect.x + moved.contentRect.width / 2, y: moved.contentRect.y + moved.contentRect.height / 2 };
  await app.request({ cmd: "dragStart", cursor: grab });
  await app.request({ cmd: "dragMove", cursor: { x: grab.x + 40, y: grab.y + 30 } });
  const dragged = await state();
  expect((dragged.bubble.bounds?.x ?? 0) - (moved.bubble.bounds?.x ?? 0)).toBe(40);
  expect((dragged.bubble.bounds?.y ?? 0) - (moved.bubble.bounds?.y ?? 0)).toBe(30);
  await app.request({ cmd: "dragEnd" });

  await app.request({ cmd: "moveBy", dx: 0, dy: -100000 });
  const top = await state();
  expect(top.contentRect.y).toBe(top.workArea.y);
  expect(top.bubble).toMatchObject({ visible: true, side: "below" });
  expectInside(top.bubble.bounds, top.workArea);
  expect(top.bubble.bounds.y).toBeGreaterThanOrEqual(top.contentRect.y + top.contentRect.height);
  expect(top.bubble.renderer.tail.y).toBeLessThan(top.bubble.renderer.textBox.y);

  await app.request({ cmd: "moveBy", dx: -100000, dy: 100000 });
  const corner = await state();
  expect(corner.bubble.side).toBe("above");
  expectInside(corner.bubble.bounds, corner.workArea);
});

test("120 Korean characters truncate after four rendered lines inside a window sized to the text", async () => {
  await app.request({ cmd: "clock", pause: true });
  const text = "가나다라마바사아자차".repeat(12);
  await send({ source: "e2e", text });
  const shown = await state();
  const { bounds, renderer } = shown.bubble;
  expectInside(bounds, shown.workArea);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(shown.contentRect.y);
  expect(bounds.width).toBeLessThanOrEqual(280);
  expect(shown.bubble.text).toBe(text);
  expect(renderer.textContent.endsWith("…")).toBe(true);
  expect(text.startsWith(renderer.textContent.slice(0, -1))).toBe(true);
  expect(renderer.truncated).toBe(true);
  expect(renderer.lines).toBe(4);
  expect(renderer.viewport).toEqual({ width: bounds.width, height: bounds.height });
  expect(renderer.box.x).toBe(0);
  expect(renderer.box.y).toBe(0);
  expect(renderer.box.width).toBeLessThanOrEqual(bounds.width);
  expect(renderer.box.height).toBeLessThanOrEqual(bounds.height);
  expect(bounds.width - renderer.box.width).toBeLessThan(1);
  expect(bounds.height - renderer.box.height).toBeLessThan(1);
  expect(renderer.overflow.width).toBeLessThanOrEqual(0);
  expect(renderer.overflow.height).toBeLessThanOrEqual(0);
  // Four rendered lines plus vertical padding, rather than one clipped line.
  expect(renderer.textBox.height).toBeGreaterThan(80);

  const shot = await app.request({ cmd: "bubbleScreenshot", path: "bubble-long.png" }) as { path: string; width: number; height: number };
  expect(shot.path).toBe(join(userDataDir, "bubble-long.png"));
  const png = await readFile(shot.path);
  const scale = shown.rendererMetrics.devicePixelRatio;
  expect(Math.abs(png.readUInt32BE(16) - bounds.width * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(png.readUInt32BE(20) - bounds.height * scale)).toBeLessThanOrEqual(1);

  for (const path of ["../escape.png", join(tempDir, "escape.png"), "missing/escape.png"]) {
    expect((await app.requestRaw({ cmd: "bubbleScreenshot", path })).ok).toBe(false);
  }
  await expect(stat(join(tempDir, "escape.png"))).rejects.toThrow("ENOENT");
});

test("markup in the text is shown as plain characters", async () => {
  await app.request({ cmd: "clock", pause: true });
  const baseline = (await state()).bubble.renderer.elements;
  const text = "<b>굵게</b><script>document.title='x'</script><img src=x onerror=alert(1)>";
  await send({ source: "e2e", text });
  const shown = await state();
  expect(shown.bubble).toMatchObject({ visible: true, text });
  expect(shown.bubble.renderer.textContent).toBe(text);
  expect(shown.bubble.renderer.textChildElements).toBe(0);
  expect(shown.bubble.renderer.elements).toBe(baseline);
});

test("hiding the pet hides the bubble, while queued urgent waits for the gap", async () => {
  await app.request({ cmd: "clock", pause: true });
  await send({ source: "e2e", text: "숨바꼭질" });
  expect((await state()).bubble.visible).toBe(true);
  await app.request({ cmd: "tray", action: "hide" });
  const hidden = await state();
  expect(hidden.visible).toBe(false);
  expect(hidden.bubble).toMatchObject({ visible: false, text: "숨바꼭질" });
  // Events that arrive while the pet is hidden wait in the queue.
  await send({ source: "later", text: "나중에", priority: "urgent" });
  expect((await state()).queue.pending).toBe(1);
  await advance(6000);
  await advance(5000);
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble).toMatchObject({ visible: true, text: "나중에", priority: "urgent" });
});

test("a hidden notification expires before the pet is shown again", async () => {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "tray", action: "hide" });
  expect(await send({ source: "ttl", text: "지나간 알림", ttlMs: 100 })).toBe(202);
  expect((await state()).queue.pending).toBe(1);
  await advance(101);
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.visible).toBe(false);
  expect((await state()).queue.pending).toBe(0);
});

test("the 30-second grouping window continues while the pet is hidden", async () => {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "tray", action: "hide" });
  await send({ source: "hidden-window", key: "a", text: "먼저" });
  await advance(30_001);
  await send({ source: "hidden-window", key: "b", text: "다음" });
  await send({ source: "hidden-window", key: "c", text: "마지막" });
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.text).toBe("먼저");
});

test("HTTP notifications show urgent first, merge matching keys, and group distinct keyed events", async () => {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "tray", action: "hide" });
  await send({ source: "priority-low", key: "low", text: "낮음", priority: "normal" });
  await send({ source: "priority-high", key: "high", text: "높음", priority: "high" });
  await send({ source: "priority-urgent", key: "urgent", text: "급함", priority: "urgent" });
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.text).toBe("급함");
  await advance(15000 + 5000);
  expect((await state()).bubble.text).toBe("높음");

  await app.request({ cmd: "tray", action: "hide" });
  await send({ source: "merge", key: "same", text: "옛날" });
  await send({ source: "merge", key: "same", text: "최신" });
  expect((await state()).queue.pending).toBe(2);
  await send({ source: "group", key: "a", text: "하나" });
  await send({ source: "group", key: "b", text: "둘" });
  await send({ source: "group", key: "c", text: "셋" });
  await advance(10000 + 5000);
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.text).toBe("낮음");
  await advance(6000 + 5000);
  expect((await state()).bubble.text).toBe("최신");
  await advance(6000 + 5000);
  expect((await state()).bubble.text).toBe("group 알림 3개");
});

test("HTTP input over the 100-item cap drops the oldest normal before display", async () => {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "tray", action: "hide" });
  for (let index = 0; index < 100; index += 1) {
    expect(await send({ source: `cap-${index}`, key: String(index), text: `알림 ${index}` })).toBe(202);
  }
  expect(await send({ source: "cap-urgent", key: "urgent", text: "최우선", priority: "urgent" })).toBe(202);
  expect((await state()).queue.pending).toBe(100);
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.text).toBe("최우선");
  await advance(20_000);
  expect((await state()).bubble.text).toBe("알림 1");
});

test("HTTP input expires a hidden entry before applying the capacity limit", async () => {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "tray", action: "hide" });
  await send({ source: "expired", key: "expired", text: "이미 만료", ttlMs: 1, priority: "high" });
  await advance(2);
  for (let index = 0; index < 99; index += 1) {
    expect(await send({ source: `retained-${index}`, key: String(index), text: `유지 ${index}` })).toBe(202);
  }
  expect(await send({ source: "latest", key: "urgent", text: "먼저", priority: "urgent" })).toBe(202);
  expect((await state()).queue.pending).toBe(100);
  await app.request({ cmd: "tray", action: "show" });
  expect((await state()).bubble.text).toBe("먼저");
  await advance(20_000);
  expect((await state()).bubble.text).toBe("유지 0");
});

test("the delivery timer exists only while a bubble or a waiting notification needs it", async () => {
  await app.request({ cmd: "clock", pause: true });
  expect((await state()).delivery).toEqual({ timer: false, nextAtMs: null });
  await send({ source: "e2e", text: "표정만", priority: "low", mood: "happy" });
  expect((await state()).delivery).toEqual({ timer: false, nextAtMs: null });
  await send({ source: "e2e", text: "급한 알림", priority: "urgent" });
  const showing = await state();
  expect(showing.bubble.visible).toBe(true);
  expect((await state()).delivery.timer).toBe(false);
  await app.request({ cmd: "clock", resume: true });
  expect((await state()).delivery.timer).toBe(true);
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "bubbleDismiss" });
  expect((await state()).delivery).toEqual({ timer: false, nextAtMs: null });
  await send({ source: "waiting", text: "기다리는 알림" });
  const waiting = await state();
  expect(waiting.bubble.visible).toBe(false);
  expect(waiting.queue.pending).toBe(1);
  expect(waiting.delivery.timer).toBe(false);
  expect(waiting.delivery.nextAtMs).toBeTypeOf("number");
  await advance(5000);
  expect((await state()).bubble).toMatchObject({ visible: true, text: "기다리는 알림" });
});
