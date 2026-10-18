import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

// ADR-0009 13: how movement coexists with sequences, sleep, interactions and the saved position.

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type State = { bounds: Rect; foot: Point; state: string;
  movement: { state: string; foot: Point; platformWindowId: string | null };
  character: { state: string };
  bubble: { visible: boolean; text: string | null } | null;
  displays: { id: number; workArea: Rect }[] };

const children = new Set<DesktopApp>();
const temporaryPaths: string[] = [];
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { for (const path of temporaryPaths) await cleanupTemporaryPath(path, [...children]); }
});

const state = (app: DesktopApp): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const advance = (app: DesktopApp, advanceMs: number): Promise<unknown> => app.request({ cmd: "clock", advanceMs });
async function moveFoot(app: DesktopApp, foot: Point): Promise<State> {
  const before = await state(app);
  await app.request({ cmd: "moveBy", dx: foot.x - before.foot.x, dy: foot.y - before.foot.y });
  return state(app);
}

/** A pack with one sequence, one plain interaction and a sleep state, so the menu can start both kinds. */
async function packDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deskpet-coexist-e2e-"));
  temporaryPaths.push(root);
  const charactersDir = join(root, "characters");
  const packDir = join(charactersDir, "placeholder");
  await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), packDir, { recursive: true });
  await cp(resolve(import.meta.dirname, "../../../characters/placeholder-alt"),
    join(charactersDir, "placeholder-alt"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(packDir, "manifest.json"), JSON.stringify({ ...manifest,
    interactions: "interactions.json", sequences: "sequences.json" }));
  await writeFile(join(packDir, "sequences.json"), JSON.stringify({ version: 1, sequences: [{ id: "greet", steps: [
    { play: "happy", ms: 5_000, say: "첫 단계" }, { play: "worried", ms: 5_000, say: "둘째 단계" }] }] }));
  await writeFile(join(packDir, "interactions.json"), JSON.stringify({ version: 1, items: [
    { id: "sequence", label: "시퀀스", mood: "happy", bubble: true, lines: ["안 보이는 대사"], sequence: "greet" },
    { id: "ordinary", label: "일반 동작", mood: "happy", bubble: true, lines: ["일반 대사"] },
  ], hidden: [] }));
  return charactersDir;
}

async function launch(extraArgs: string[] = [], userData?: string): Promise<{ app: DesktopApp; userData: string }> {
  const directory = userData ?? join(await mkdtemp(join(tmpdir(), "deskpet-coexist-e2e-")), "userData");
  if (!userData) temporaryPaths.push(join(directory, ".."));
  const app = await DesktopApp.launch(directory, extraArgs);
  children.add(app);
  return { app, userData: directory };
}

async function launchPaused(): Promise<{ app: DesktopApp; platform: { id: string; x: number; y: number; w: number; h: number; platform: true };
  floor: number }> {
  const charactersDir = await packDirectory();
  const { app } = await launch([`--characters-dir=${charactersDir}`]);
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "setState", state: "idle" });
  const initial = await state(app);
  const display = [...initial.displays].sort((a, b) => a.workArea.x - b.workArea.x)
    .find(({ workArea }) => workArea.width > 600 && workArea.height > 600);
  if (!display) throw new Error("A display with space for movement is required");
  const area = display.workArea;
  const platform = { id: "991234701", x: area.x + 80, y: area.y + Math.round(area.height * 0.7), w: 400, h: 100,
    platform: true as const };
  await app.request({ cmd: "movementChancesForTest", climbChance: 0, descendChance: 0 });
  await app.request({ cmd: "terrainSetForTest", windows: [platform] });
  return { app, platform, floor: area.y + area.height };
}

async function standOn(app: DesktopApp, platform: { id: string; x: number; y: number }): Promise<void> {
  await moveFoot(app, { x: platform.x + 200, y: platform.y - 60 });
  await advance(app, 1_000);
  expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });
}

async function quit(app: DesktopApp): Promise<void> {
  await app.quit({ cmd: "trayMenuClick", label: "종료" });
  children.delete(app);
}

test("a sequence is cut and the pet falls when the window it stands on disappears", async () => {
  const { app, platform, floor } = await launchPaused();
  try {
    await standOn(app, platform);
    await app.request({ cmd: "petMenuClickForTest", label: "시퀀스" });
    const playing = await state(app);
    expect(playing).toMatchObject({ character: { state: "happy" }, bubble: { text: "첫 단계" } });
    // The sequence does not start a walk even when a walk is requested on the platform.
    await advance(app, 500);
    expect((await state(app)).bounds.x).toBe(playing.bounds.x);

    await app.request({ cmd: "terrainSetForTest", windows: [] });
    const falling = await state(app);
    expect(falling.movement.state).toBe("falling");
    expect(falling.character.state).not.toBe("happy");
    expect(falling.bounds.x).toBe(playing.bounds.x);

    await advance(app, 1_500);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ state: "grounded", platformWindowId: null });
    expect(landed.foot.y).toBe(floor);
    // The cut sequence does not resume: its first step is not played again after landing.
    await advance(app, 6_000);
    expect(["happy", "worried"]).not.toContain((await state(app)).character.state);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a sleeping pet wakes and falls when its platform disappears, then counts the sleep time again after landing", async () => {
  const { app, platform, floor } = await launchPaused();
  try {
    await standOn(app, platform);
    for (let waited = 0; waited < 90_000 && (await state(app)).character.state !== "sleep"; waited += 1_000)
      await advance(app, 1_000);
    expect((await state(app)).character.state).toBe("sleep");

    await app.request({ cmd: "terrainSetForTest", windows: [] });
    const woken = await state(app);
    expect(woken.movement.state).toBe("falling");
    expect(woken.character.state).not.toBe("sleep");

    await advance(app, 1_500);
    const landed = await state(app);
    expect(landed.movement).toMatchObject({ state: "grounded", platformWindowId: null });
    expect(landed.foot.y).toBe(floor);
    // Sleep time restarts at the landing: still awake well before a full period, asleep after it.
    await advance(app, 30_000);
    expect((await state(app)).character.state).not.toBe("sleep");
    let slept = false;
    for (let waited = 0; waited < 45_000 && !slept; waited += 1_000) {
      await advance(app, 1_000);
      slept = (await state(app)).character.state === "sleep";
    }
    expect(slept).toBe(true);
  } finally { await app.dispose(); children.delete(app); }
}, 90000);

test("a menu interaction chosen in the air plays after landing", async () => {
  const { app, platform } = await launchPaused();
  try {
    await moveFoot(app, { x: platform.x + 200, y: platform.y - 200 });
    const air = await state(app);
    expect(air.movement.state).toBe("falling");
    await app.request({ cmd: "petMenuClickForTest", label: "일반 동작" });
    const during = await state(app);
    expect(during.movement.state).toBe("falling");
    expect(during.character.state).not.toBe("happy");

    await advance(app, 400);
    expect((await state(app)).character.state).not.toBe("happy");
    // Landing takes a moment; the reaction waits for it to end.
    await advance(app, 1_000);
    const after = await state(app);
    expect(after.movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });
    expect(after).toMatchObject({ character: { state: "happy" }, bubble: { visible: true, text: "일반 대사" } });
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a restart stands on the window under the saved foot, and falls to the platform below when the foot is in empty air", async () => {
  const charactersDir = await packDirectory();
  const first = await launch([`--characters-dir=${charactersDir}`]);
  const initial = await state(first.app);
  const display = [...initial.displays].sort((a, b) => a.workArea.x - b.workArea.x)
    .find(({ workArea }) => workArea.width > 600 && workArea.height > 600);
  if (!display) throw new Error("A display with space for movement is required");
  const area = display.workArea;
  const high = { id: "991234801", x: area.x + 80, y: area.y + Math.round(area.height * 0.5), w: 400, h: 80, platform: true };
  const low = { id: "991234802", x: area.x + 80, y: area.y + Math.round(area.height * 0.8), w: 400, h: 80, platform: true };
  const windowsArg = `--terrain-windows=${JSON.stringify([high, low])}`;
  try {
    await first.app.request({ cmd: "clock", pause: true });
    await first.app.request({ cmd: "terrainSetForTest", windows: [high, low] });
    await moveFoot(first.app, { x: high.x + 200, y: high.y - 40 });
    await advance(first.app, 1_500);
    const stood = await state(first.app);
    expect(stood.movement).toMatchObject({ state: "grounded", platformWindowId: high.id });
    await quit(first.app);

    // Same window at the same place: the pet is standing there at the first frame, with no window id on disk.
    const saved = JSON.parse(await readFile(join(first.userData, "pet-position.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(saved)).not.toContain(high.id);
    const second = await launch([`--characters-dir=${charactersDir}`, windowsArg], first.userData);
    const restored = await state(second.app);
    expect(restored.foot).toEqual(stood.foot);
    expect(restored.movement).toMatchObject({ state: "grounded", platformWindowId: high.id });
    await quit(second.app);

    // The window under the foot is gone: the pet falls past it onto the platform below.
    const third = await launch([`--characters-dir=${charactersDir}`, `--terrain-windows=${JSON.stringify([low])}`],
      first.userData);
    await third.app.request({ cmd: "clock", pause: true });
    await advance(third.app, 1_500);
    const dropped = await state(third.app);
    expect(dropped.foot).toEqual({ x: stood.foot.x, y: low.y });
    expect(dropped.movement).toMatchObject({ state: "grounded", platformWindowId: low.id });
    await quit(third.app);
  } finally { for (const child of children) await child.dispose(); }
}, 90000);
