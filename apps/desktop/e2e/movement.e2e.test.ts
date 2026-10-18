import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Motion = { state: string; foot: Point; velocity: Point; platformWindowId: string | null };
type State = { bounds: Rect; foot: Point; contentRect: Rect; state: string; movement: Motion;
  bubble: { visible: boolean; text: string | null; bounds: Rect | null } | null;
  character: { states: string[] };
  displays: { id: number; workArea: Rect }[] };

const children = new Set<DesktopApp>();
const temporaryPaths: string[] = [];
const userDataPaths = new Map<DesktopApp, string>();
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { for (const path of temporaryPaths) await cleanupTemporaryPath(path, [...children]); }
});

async function launch(): Promise<DesktopApp> {
  const directory = await mkdtemp(join(tmpdir(), "deskpet-movement-e2e-"));
  temporaryPaths.push(directory);
  const userDataDir = join(directory, "userData");
  const app = await DesktopApp.launch(userDataDir);
  children.add(app);
  userDataPaths.set(app, userDataDir);
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "setState", state: "idle" });
  return app;
}

const state = (app: DesktopApp): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const advance = (app: DesktopApp, advanceMs: number): Promise<unknown> => app.request({ cmd: "clock", advanceMs });
async function moveFoot(app: DesktopApp, foot: Point): Promise<State> {
  const before = await state(app);
  await app.request({ cmd: "moveBy", dx: foot.x - before.foot.x, dy: foot.y - before.foot.y });
  return state(app);
}

async function fixture(app: DesktopApp) {
  const initial = await state(app);
  const display = [...initial.displays].sort((a, b) => a.workArea.x - b.workArea.x)
    .find(({ workArea }) => workArea.width > 600 && workArea.height > initial.contentRect.height + 260);
  if (!display) throw new Error("A display with space for movement is required");
  const area = display.workArea;
  const platform = { id: "991234601", x: area.x + 80,
    y: area.y + Math.round(area.height * 0.7), w: 320, h: 100, platform: true };
  return { area, platform };
}

/** Starts the pet walking right so the next advance reaches whatever stands at the foot's right. */
async function walkRight(app: DesktopApp): Promise<void> {
  await app.request({ cmd: "setState", state: "walk" });
  await app.request({ cmd: "setMovementDirection", direction: "right" });
}

/** The animation a request plays when the pack has no state of that name (DEFAULT_MOVEMENT_FALLBACKS). */
const played = (current: State, name: string, fallback: string): string =>
  current.character.states.includes(name) ? name : fallback;

async function notify(app: DesktopApp): Promise<number> {
  const userDataDir = userDataPaths.get(app);
  if (!userDataDir) throw new Error("The test app has no userData directory");
  const auth = await app.eventServerAuth(userDataDir);
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "movement-e2e", type: "notify", text: "이동 중 알림", mood: "happy" }));
  });
}

test("a dropped pet lands on an injected window, falls in place when it moves, then reaches the screen floor", async () => {
  const app = await launch();
  try {
    const { area, platform } = await fixture(app);
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    const above = await moveFoot(app, { x: platform.x + 120, y: platform.y - 80 });
    expect(above.movement.state).toBe("falling");
    await advance(app, 600);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ foot: { x: platform.x + 120, y: platform.y },
      platformWindowId: platform.id });
    expect(landed.foot).toEqual(landed.movement.foot);
    await advance(app, 400);
    expect((await state(app)).movement.state).toBe("grounded");

    await app.request({ cmd: "terrainSetForTest", windows: [{ ...platform, x: platform.x + 25, y: platform.y + 20 }] });
    const dropped = await state(app);
    expect(dropped.movement.state).toBe("falling");
    expect(dropped.foot).toEqual(landed.foot);
    expect(dropped.bounds.x).toBe(landed.bounds.x);
    await app.request({ cmd: "terrainSetForTest", windows: [] });
    await advance(app, 1_000);
    const floor = await state(app);
    expect(floor.foot.y).toBe(area.y + area.height);
    expect(floor.movement.platformWindowId).toBeNull();
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("walking reverses at a denied ledge and descends when allowed", async () => {
  const app = await launch();
  try {
    const { area, platform } = await fixture(app);
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await app.request({ cmd: "setState", state: "walk" });
    await app.request({ cmd: "setMovementDirection", direction: "right" });
    await advance(app, 100);
    const turned = await state(app);
    expect(turned.movement.state).toBe("grounded");
    expect(turned.foot.x).toBeLessThan(platform.x + platform.w);

    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 1 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await app.request({ cmd: "setState", state: "walk" });
    await app.request({ cmd: "setMovementDirection", direction: "right" });
    await advance(app, 100);
    const climbingDown = await state(app);
    expect(climbingDown.movement.state).toBe("climbing-down");
    expect(climbingDown.state).toBe(played(climbingDown, "climb-down", played(climbingDown, "climb", "walk")));
    const drop = area.y + area.height - platform.y;
    await advance(app, Math.ceil(drop / 120 * 1_000) + 300);
    const floor = await state(app);
    expect(floor.foot.y).toBe(area.y + area.height);
    expect(floor.movement).toMatchObject({ state: "grounded", platformWindowId: null });
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("walking hops down a low ledge and lands softly", async () => {
  const app = await launch();
  try {
    const { area, platform } = await fixture(app);
    const low = { ...platform, y: area.y + area.height - 80 };
    await app.request({ cmd: "terrainSetForTest", windows: [low] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 1 });
    await moveFoot(app, { x: low.x + low.w - 2, y: low.y });
    await walkRight(app);
    await advance(app, 100);
    const hopping = await state(app);
    expect(hopping.movement.state).toBe("hop-down");
    expect(hopping.state).toBe(played(hopping, "hop-down", played(hopping, "fall", "drag")));
    await advance(app, 800);
    const landed = await state(app);
    expect(landed.foot.y).toBe(area.y + area.height);
    expect(landed.movement.platformWindowId).toBeNull();
    expect(["landing", "grounded"]).toContain(landed.movement.state);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("walking jumps onto a low wall and climbs a tall one, and turns back when the chance is zero", async () => {
  const app = await launch();
  try {
    const { platform } = await fixture(app);
    const wall = { ...platform, id: "991234602", x: platform.x + platform.w, y: platform.y - 60 };
    await app.request({ cmd: "terrainSetForTest", windows: [platform, wall] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 1, descendChance: 0 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    const jumping = await state(app);
    expect(jumping.movement.state).toBe("jumping");
    expect(jumping.state).toBe(played(jumping, "jump", "happy"));
    await advance(app, 800);
    expect((await state(app)).movement).toMatchObject({ platformWindowId: wall.id });
    await advance(app, 500);
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: wall.id });

    const tall = { ...wall, y: platform.y - 300, h: 500 };
    await app.request({ cmd: "terrainSetForTest", windows: [platform, tall] });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    const ready = await state(app);
    expect(ready.movement.state).toBe("climb-ready");
    expect(ready.state).toBe(played(ready, "climb-ready", "surprised"));
    await advance(app, 400);
    expect((await state(app)).movement.state).toBe("climbing");
    await advance(app, 3_000);
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: tall.id });

    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a pet on the floor climbs a window far taller than itself at chance 1 and turns back at chance 0", async () => {
  const app = await launch();
  try {
    const { area } = await fixture(app);
    const floorY = area.y + area.height;
    // Like the 2026-10-09 report: the top is far above the pet and the body reaches the floor.
    const big = { id: "991234603", x: area.x + 300, y: area.y + 260, w: 300, h: area.height - 260, platform: true };
    await app.request({ cmd: "terrainSetForTest", windows: [big] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0 });
    await moveFoot(app, { x: big.x - 2, y: floorY });
    await walkRight(app);
    await advance(app, 100);
    const turned = await state(app);
    expect(turned.movement).toMatchObject({ state: "grounded", platformWindowId: null });
    expect(turned.foot.x).toBeLessThan(big.x);
    await advance(app, 1_000);
    expect((await state(app)).foot.x).toBeLessThan(big.x);

    await app.request({ cmd: "movementChancesForTest", climbChance: 1, descendChance: 0 });
    await moveFoot(app, { x: big.x - 2, y: floorY });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement.state).toBe("climb-ready");
    await advance(app, 400);
    expect((await state(app)).movement.state).toBe("climbing");
    await advance(app, Math.ceil((floorY - big.y) / 120 * 1_000) + 300);
    const top = await state(app);
    expect(top.movement).toMatchObject({ state: "grounded", platformWindowId: big.id });
    expect(top.foot.y).toBe(big.y);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a pet on the floor jumps onto a low step", async () => {
  const app = await launch();
  try {
    const { area, platform } = await fixture(app);
    const floorY = area.y + area.height;
    const step = { ...platform, y: floorY - 100 };
    await app.request({ cmd: "terrainSetForTest", windows: [step] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 1, descendChance: 0 });
    await moveFoot(app, { x: step.x - 2, y: floorY });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement.state).toBe("jumping");
    await advance(app, 1_000);
    const stood = await state(app);
    expect(stood.movement).toMatchObject({ platformWindowId: step.id });
    expect(stood.foot.y).toBe(step.y);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a moving drag is thrown, wraps across the screen edge, and lands", async () => {
  const app = await launch();
  try {
    const { area } = await fixture(app);
    await moveFoot(app, { x: area.x + 180, y: area.y + 250 });
    const before = await state(app);
    const cursor = { x: before.bounds.x + 100, y: before.bounds.y + 100 };
    await app.request({ cmd: "dragStart", cursor });
    await advance(app, 50);
    await app.request({ cmd: "dragMove", cursor: { x: cursor.x - 100, y: cursor.y - 30 } });
    await advance(app, 50);
    await app.request({ cmd: "dragEnd" });
    const thrown = await state(app);
    expect(thrown.movement.state).toBe("thrown");
    expect(thrown.state).toBe(thrown.character.states.includes("thrown") ? "thrown" :
      thrown.character.states.includes("fall") ? "fall" : "drag");
    expect(thrown.movement.velocity.x).toBeLessThan(0);
    await advance(app, 200);
    const wrapped = await state(app);
    expect(wrapped.foot.x).toBeGreaterThan(area.x + area.width - 150);
    await advance(app, 1_500);
    const landed = await state(app);
    // The wrap can carry the pet onto another display whose work area is offset (e.g. y=1), so use the floor it landed on.
    const landedArea = landed.displays.find(({ workArea }) =>
      landed.foot.x >= workArea.x && landed.foot.x < workArea.x + workArea.width)?.workArea ?? area;
    expect(landed.foot.y).toBe(landedArea.y + landedArea.height);
    expect(landed.movement.platformWindowId).toBeNull();
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("upward and strong downward throws wrap vertically, then land", async () => {
  const app = await launch();
  try {
    const { area } = await fixture(app);
    const up = await moveFoot(app, { x: area.x + 200, y: area.y + 350 });
    const upCursor = { x: up.bounds.x + 100, y: up.bounds.y + 100 };
    await app.request({ cmd: "dragStart", cursor: upCursor });
    await advance(app, 50);
    await app.request({ cmd: "dragMove", cursor: { x: upCursor.x, y: upCursor.y - 200 } });
    await advance(app, 50);
    await app.request({ cmd: "dragEnd" });
    expect((await state(app)).movement.velocity.y).toBeLessThan(0);
    await advance(app, 200);
    const wrappedUp = await state(app);
    expect(wrappedUp.foot.y).toBeGreaterThan(area.y + area.height - 300);

    const down = await moveFoot(app, { x: area.x + 200, y: area.y + area.height - 250 });
    const downCursor = { x: down.bounds.x + 100, y: down.bounds.y + 100 };
    await app.request({ cmd: "dragStart", cursor: downCursor });
    await advance(app, 50);
    await app.request({ cmd: "dragMove", cursor: { x: downCursor.x, y: downCursor.y + 150 } });
    await advance(app, 50);
    await app.request({ cmd: "dragEnd" });
    expect((await state(app)).movement.velocity.y).toBeGreaterThanOrEqual(1_500);
    await advance(app, 100);
    const passed = await state(app);
    expect(passed.foot.y).toBeLessThan(area.y + 120);
    await advance(app, 1_700);
    const landed = await state(app);
    expect(landed.foot.y).toBe(area.y + area.height);
    expect(landed.movement.platformWindowId).toBeNull();
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("still release falls and terrain off keeps the legacy drag placement", async () => {
  const app = await launch();
  try {
    const { area } = await fixture(app);
    const before = await moveFoot(app, { x: area.x + 200, y: area.y + 170 });
    const cursor = { x: before.bounds.x + 100, y: before.bounds.y + 100 };
    await app.request({ cmd: "dragStart", cursor });
    await advance(app, 150);
    await app.request({ cmd: "dragEnd" });
    expect((await state(app)).movement.state).toBe("falling");
    await advance(app, 1_500);
    expect((await state(app)).foot.y).toBe(area.y + area.height);
    await app.request({ cmd: "terrainOffForTest" });
    const off = await moveFoot(app, { x: area.x + 200, y: area.y + 170 });
    const offCursor = { x: off.bounds.x + 100, y: off.bounds.y + 100 };
    await app.request({ cmd: "dragStart", cursor: offCursor });
    await app.request({ cmd: "dragEnd" });
    await advance(app, 900);
    expect((await state(app)).foot).toEqual(off.foot);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a notify bubble follows a falling pet and its reaction waits for landing", async () => {
  const app = await launch();
  try {
    const { platform } = await fixture(app);
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await moveFoot(app, { x: platform.x + 120, y: platform.y - 180 });
    await advance(app, 16);
    const falling = await state(app);
    expect(falling.movement.state).toBe("falling");
    expect(await notify(app)).toBe(202);
    const shown = await state(app);
    expect(shown.bubble).toMatchObject({ visible: true, text: "이동 중 알림" });
    expect(shown.state).not.toBe("happy");
    const beforeBubble = shown.bubble?.bounds;
    await advance(app, 120);
    const moved = await state(app);
    expect(moved.foot.y).toBeGreaterThan(falling.foot.y);
    expect(moved.bubble?.bounds?.y).not.toBe(beforeBubble?.y);
    expect(moved.state).not.toBe("happy");
    await advance(app, 800);
    expect((await state(app)).movement.state).toBe("grounded");
    expect((await state(app)).state).toBe("happy");
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("fullscreen uses only the floor and hiding pauses movement", async () => {
  const app = await launch();
  try {
    const { area, platform } = await fixture(app);
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await moveFoot(app, { x: platform.x + 120, y: platform.y });
    expect((await state(app)).movement.platformWindowId).toBe(platform.id);
    await app.request({ cmd: "setFullscreenForTest", fullscreen: true });
    expect((await state(app)).movement.state).toBe("falling");
    const beforeHide = await state(app);
    await app.request({ cmd: "tray", action: "hide" });
    await advance(app, 1_000);
    expect((await state(app)).foot).toEqual(beforeHide.foot);
    await app.request({ cmd: "tray", action: "show" });
    await advance(app, 1_300);
    expect((await state(app)).foot.y).toBe(area.y + area.height);
    await app.request({ cmd: "setFullscreenForTest", fullscreen: false });
    expect((await state(app)).movement.platformWindowId).toBeNull();
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("walking jumps across the gap to the next window at chance 1 and otherwise falls back to descending", async () => {
  const app = await launch();
  try {
    const { platform } = await fixture(app);
    const next = { ...platform, id: "991234603", x: platform.x + platform.w + 150 };
    await app.request({ cmd: "terrainSetForTest", windows: [platform, next] });

    // Chance 0 and no descending: the pet turns around at the ledge.
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0, gapJumpChance: 0 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });

    // Chance 0 with descending: the old ledge rule applies (a long drop climbs down).
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 1, gapJumpChance: 0 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement.state).toBe("climbing-down");

    // Chance 1: the pet jumps over the 150 DIP gap and stands on the far window.
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0, gapJumpChance: 1 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    const jumping = await state(app);
    expect(jumping.movement.state).toBe("jumping");
    expect(jumping.state).toBe(played(jumping, "jump", "happy"));
    await advance(app, 1_500);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ state: "grounded", platformWindowId: next.id });
    expect(landed.foot.y).toBe(next.y);
    expect(landed.foot.x).toBeGreaterThan(next.x);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("moving the window a pet is climbing makes it fall", async () => {
  const app = await launch();
  try {
    const { area } = await fixture(app);
    const floorY = area.y + area.height;
    const big = { id: "991234603", x: area.x + 300, y: area.y + 260, w: 300, h: area.height - 260, platform: true };
    await app.request({ cmd: "terrainSetForTest", windows: [big] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 1, descendChance: 0 });
    await moveFoot(app, { x: big.x - 2, y: floorY });
    await walkRight(app);
    await advance(app, 500);
    await advance(app, 500);
    const climbing = await state(app);
    expect(climbing.movement.state).toBe("climbing");
    expect(climbing.foot.y).toBeLessThan(floorY);
    await app.request({ cmd: "terrainSetForTest", windows: [{ ...big, x: big.x + 40 }] });
    await advance(app, 50);
    expect((await state(app)).movement.state).toBe("falling");
    await advance(app, 2_000);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ state: "grounded", platformWindowId: null });
    expect(landed.foot.y).toBe(floorY);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("removing the far window during a gap jump keeps the pet flying until it lands on the floor", async () => {
  const app = await launch();
  try {
    const { platform } = await fixture(app);
    const next = { ...platform, id: "991234603", x: platform.x + platform.w + 150 };
    await app.request({ cmd: "terrainSetForTest", windows: [platform, next] });
    await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0, gapJumpChance: 1 });
    await moveFoot(app, { x: platform.x + platform.w - 2, y: platform.y });
    await walkRight(app);
    await advance(app, 100);
    expect((await state(app)).movement.state).toBe("jumping");
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await advance(app, 50);
    const flying = await state(app);
    expect(flying.movement.state).toBe("falling");
    expect(flying.movement.velocity.x).toBeGreaterThan(0);
    await advance(app, 3_000);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ state: "grounded", platformWindowId: null });
    expect(landed.foot.x).toBeGreaterThan(platform.x + platform.w);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);
