import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DEFAULT_MOVEMENT_FALLBACKS, MOVEMENT_PHYSICS, parseMotions, resolveMotionPlay, type CharacterManifest } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type State = { foot: Point; contentRect: Rect; state: string; clock: { ms: number };
  movement: { state: string }; displays: { id: number; workArea: Rect }[] };

const builtins = resolve(import.meta.dirname, "../../../characters");
const children = new Set<DesktopApp>();
const temporaryPaths: string[] = [];
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { for (const path of temporaryPaths) await cleanupTemporaryPath(path, [...children]); }
});

const state = (app: DesktopApp): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const advance = (app: DesktopApp, advanceMs: number): Promise<unknown> => app.request({ cmd: "clock", advanceMs });

/** The pack files as the app reads them: the expected values come from here, not from strings in this test. */
async function packFiles(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CharacterManifest;
  expect(manifest.motions).toBeTypeOf("string");
  const parsed = parseMotions(JSON.parse(await readFile(join(directory, manifest.motions ?? ""), "utf8")));
  expect(parsed.problems).toEqual([]);
  return { manifest, motions: parsed.motions };
}

const play = (files: Awaited<ReturnType<typeof packFiles>>, request: string): string =>
  resolveMotionPlay(request, files.motions, files.manifest, DEFAULT_MOVEMENT_FALLBACKS);

/** Drops the pet above an injected window, then reports the animation while falling and how long landing lasts. */
async function dropOnWindow(app: DesktopApp): Promise<{ falling: State; landing: State; grounded: State; landingMs: number }> {
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "setState", state: "idle" });
  const initial = await state(app);
  const area = [...initial.displays].sort((a, b) => a.workArea.x - b.workArea.x)
    .find(({ workArea }) => workArea.width > 600 && workArea.height > initial.contentRect.height + 260)?.workArea;
  if (!area) throw new Error("A display with space for movement is required");
  const platform = { id: "991234701", x: area.x + 80, y: area.y + Math.round(area.height * 0.7), w: 320, h: 100, platform: true };
  await app.request({ cmd: "terrainSetForTest", windows: [platform] });
  await app.request({ cmd: "moveBy", dx: platform.x + 120 - initial.foot.x, dy: platform.y - 80 - initial.foot.y });
  const falling = await state(app);
  expect(falling.movement.state).toBe("falling");
  let current = falling;
  for (let step = 0; step < 100 && current.movement.state !== "landing"; step += 1) {
    await advance(app, 16);
    current = await state(app);
  }
  expect(current.movement.state).toBe("landing");
  const landing = current;
  for (let step = 0; step < 100 && current.movement.state === "landing"; step += 1) {
    await advance(app, 16);
    current = await state(app);
  }
  expect(current.movement.state).toBe("grounded");
  return { falling, landing, grounded: current, landingMs: current.clock.ms - landing.clock.ms };
}

const expectedLanding = (landing: "soft" | "normal"): number =>
  landing === "soft" ? MOVEMENT_PHYSICS.softLandingMs : MOVEMENT_PHYSICS.normalLandingMs;
const STEP = 16;

async function launchWith(character: string, userDataDir: string): Promise<DesktopApp> {
  const app = await DesktopApp.launch(userDataDir, [`--character=${character}`]);
  children.add(app);
  return app;
}

test("wolf-maid draws its mapped land state and lands for the soft length its motions file names", async () => {
  const files = await packFiles(join(builtins, "wolf-maid"));
  expect(files.motions.landing).toBe("soft");
  const directory = await mkdtemp(join(tmpdir(), "deskpet-motions-e2e-"));
  temporaryPaths.push(directory);
  const app = await launchWith("wolf-maid", join(directory, "userData"));
  try {
    const result = await dropOnWindow(app);
    expect(result.falling.state).toBe(play(files, "fall"));
    expect(result.landing.state).toBe(play(files, "land"));
    const afterLand = files.motions.afterLand?.play;
    expect(afterLand).toBeDefined();
    expect(result.grounded.state).toBe(afterLand);
    if (!afterLand) throw new Error("Built-in pack has no afterLand state");
    const afterLandState = files.manifest.states[afterLand];
    expect(afterLandState?.loop).toBe(false);
    if (!afterLandState) throw new Error("afterLand state is missing from the manifest");
    await advance(app, Math.ceil(afterLandState.frames * 1_000 / afterLandState.fps) + STEP);
    expect((await state(app)).state).toBe(afterLandState.next ?? "idle");
    expect(result.landingMs).toBeGreaterThanOrEqual(expectedLanding(files.motions.landing));
    expect(result.landingMs).toBeLessThan(expectedLanding(files.motions.landing) + 2 * STEP);
    expect(expectedLanding(files.motions.landing)).toBeGreaterThan(expectedLanding("normal"));
  } finally { await app.dispose(); children.delete(app); }
}, 60000);

test("a derived pack's own motions replace the original's: mapped states play and landing is normal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskpet-motions-e2e-"));
  temporaryPaths.push(directory);
  const userDataDir = join(directory, "userData");
  const packDir = join(userDataDir, "characters", "wolf-maid-motions");
  await mkdir(packDir, { recursive: true });
  const base = JSON.parse(await readFile(join(builtins, "wolf-maid", "manifest.json"), "utf8")) as CharacterManifest;
  const states = Object.keys(base.states);
  const [fallState, landState] = [states.find((name) => name === "surprised") ?? states[1], states.find((name) => name === "happy") ?? states[2]];
  expect(fallState).toBeDefined();
  expect(landState).toBeDefined();
  await writeFile(join(packDir, "manifest.json"), JSON.stringify({ id: "wolf-maid-motions", name: "Motions", apiVersion: "1",
    extends: "wolf-maid", motions: "motions.json", meta: { createdWith: "deskpet-editor" } }));
  await writeFile(join(packDir, "motions.json"), JSON.stringify({ version: 1,
    motions: { fall: { play: fallState }, land: { play: landState } }, landing: "normal" }));
  // A derived manifest carries no art of its own; the original supplies states and fallbacks.
  const files = { ...await packFiles(packDir), manifest: base };
  const original = await packFiles(join(builtins, "wolf-maid"));
  expect(files.motions.landing).not.toBe(original.motions.landing);
  const app = await launchWith("wolf-maid-motions", userDataDir);
  try {
    // The derived file replaces the original as a whole, so the mapping is not what wolf-maid draws.
    expect(play(files, "land")).toBe(landState);
    expect(play(files, "land")).not.toBe(play(original, "land"));
    const result = await dropOnWindow(app);
    expect(result.falling.state).toBe(play(files, "fall"));
    expect(result.landing.state).toBe(play(files, "land"));
    expect(files.motions.afterLand).toBeUndefined();
    expect(result.grounded.state).toBe("idle");
    expect(result.landingMs).toBeGreaterThanOrEqual(expectedLanding(files.motions.landing));
    expect(result.landingMs).toBeLessThan(expectedLanding(files.motions.landing) + 2 * STEP);
  } finally { await app.dispose(); children.delete(app); }
}, 60000);
