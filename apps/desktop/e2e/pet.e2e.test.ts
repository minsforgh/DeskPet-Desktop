import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { BADGE_TOP_MARGIN, petWindowY } from "./helpers/pet-window.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type State = {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  contentRect: { x: number; y: number; width: number; height: number };
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  trayReady: boolean;
  ready: boolean;
  ignoreMouseEvents: boolean;
  cursor: { x: number; y: number };
  workArea: { x: number; y: number; width: number; height: number };
  rendererMetrics: { devicePixelRatio: number };
  character: CharacterState;
  state: string;
};

type CharacterState = { id: string; loaded: boolean; error?: string; state: string; frame: number; states: string[] };

const desktopRoot = resolve(import.meta.dirname, "..");
let name: string;
let app: DesktopApp;
let tempDir: string;

function runScript(script: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const launcher = spawn(process.execPath, [join(desktopRoot, "scripts", script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    launcher.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    launcher.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    launcher.on("error", rejectRun);
    // "exit" can arrive before the last stdout/stderr chunk under load; "close" waits for both streams to end.
    launcher.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function request(command: Record<string, unknown>): Promise<unknown> { return app.request(command); }

function waitForReady(): Promise<State> { return app.waitReady() as Promise<State>; }

function decodePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Not PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    const contents = png.subarray(offset + 8, offset + 8 + length);
    if (kind === "IHDR") {
      width = contents.readUInt32BE(0);
      height = contents.readUInt32BE(4);
      if (contents[8] !== 8) throw new Error("Expected 8-bit PNG");
      colorType = contents[9] ?? 0;
    }
    if (kind === "IDAT") data.push(contents);
    offset += length + 12;
    if (kind === "IEND") break;
  }
  if (colorType !== 6) throw new Error("Expected RGBA PNG");
  const bytes = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filter = bytes[position++] ?? 0;
    const row = Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const raw = bytes[position++] ?? 0;
      const left = index >= 4 ? row[index - 4] ?? 0 : 0;
      const up = previous[index] ?? 0;
      const upLeft = index >= 4 ? previous[index - 4] ?? 0 : 0;
      const predictor = left + up - upLeft;
      const paeth = [left, up, upLeft].sort((a, b) => Math.abs(predictor - a) - Math.abs(predictor - b))[0] ?? 0;
      const adjustment = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      if (adjustment === undefined) throw new Error("Unknown PNG filter");
      row[index] = (raw + adjustment) & 255;
    }
    row.copy(pixels, rowIndex * stride);
    previous = row;
  }
  return { width, height, pixels };
}

function pngPixelAt(png: Buffer, x: number, y: number): number[] {
  const decoded = decodePng(png);
  if (x >= decoded.width || y >= decoded.height) throw new Error("Pixel outside PNG");
  return [...decoded.pixels.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)];
}

function pngPixelAtLogical(png: Buffer, x: number, y: number): number[] {
  const image = decodePng(png);
  return pngPixelAt(png, Math.floor((x + 0.5) * image.width / 256),
    Math.floor(petWindowY(y + 0.5) * image.height / (256 + BADGE_TOP_MARGIN)));
}

function pngAlphaAtLogical(png: Buffer, x: number, y: number): number {
  return pngPixelAtLogical(png, x, y)[3] ?? 0;
}

function bottomOpaqueRow(png: Buffer): number {
  const { width, height, pixels } = decodePng(png);
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) if (pixels[(y * width + x) * 4 + 3] !== 0) return y;
  }
  throw new Error("Screenshot has no opaque pixel");
}

async function screenshot(path: string): Promise<Buffer> {
  await request({ cmd: "screenshot", path });
  return readFile(path);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "deskpet-e2e-"));
  app = await DesktopApp.launch(join(tempDir, "user-data"), ["--terrain-source=off"]);
  name = app.name;
}, 30000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});
test("pet window state and PNG transparency", async () => {
  const state = await waitForReady();
  expect(state.visible).toBe(true);
  expect(state.trayReady).toBe(true);
  expect(state.alwaysOnTop).toBe(true);
  expect(state.skipTaskbar).toBe(true);
  expect(state.bounds.width).toBe(256);
  expect(state.bounds.height).toBe(256 + BADGE_TOP_MARGIN);
  expect(state.character).toMatchObject({ id: "placeholder", loaded: true, state: "idle" });
  expect(typeof state.ignoreMouseEvents).toBe("boolean");

  const path = join(tempDir, "pet.png");
  const cli = await runScript("screenshot.mjs", [path, "--name", name]);
  expect(cli.code).toBe(0);
  const result = JSON.parse(cli.stdout) as { path: string; width: number; height: number };
  const ratio = state.rendererMetrics.devicePixelRatio;
  expect(result).toEqual({ path, width: Math.round(256 * ratio), height: Math.round((256 + BADGE_TOP_MARGIN) * ratio) });
  const png = await readFile(path);
  expect(pngAlphaAtLogical(png, 128, 137)).toBe(255);
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]] as const) {
    expect(pngAlphaAtLogical(png, x, y)).toBe(0);
  }
}, 30000);

test("canvas alpha controls the hit test", async () => {
  await waitForReady();
  expect(await request({ cmd: "hitTest", x: 128, y: 137 })).toEqual({ interactive: true, alpha: 255 });
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]] as const) {
    expect(await request({ cmd: "hitTest", x, y })).toEqual({ interactive: false, alpha: 0 });
  }
});

test("switching packs changes art and fallback states", async () => {
  await waitForReady();
  await request({ cmd: "clock", action: "pause" });
  await request({ cmd: "setState", state: "idle" });
  const original = await screenshot(join(tempDir, "original.png"));
  const changed = await request({ cmd: "setCharacter", character: "placeholder-alt" }) as CharacterState;
  expect(changed).toMatchObject({ id: "placeholder-alt", loaded: true, state: "idle" });
  const alternate = await screenshot(join(tempDir, "alternate.png"));
  expect(pngPixelAtLogical(alternate, 128, 137).slice(0, 3)).not.toEqual(pngPixelAtLogical(original, 128, 137).slice(0, 3));
  expect(await request({ cmd: "setState", state: "worried" })).toMatchObject({ state: "surprised" });
  expect(await request({ cmd: "setState", state: "missing-everywhere" })).toMatchObject({ state: "idle" });
  await expect(request({ cmd: "setCharacter", character: "../placeholder" })).rejects.toThrow();
  await request({ cmd: "setCharacter", character: "placeholder" });
});

test("clock controls blink, walking, sleeping, and anchored feet", async () => {
  // The default spawn pins the content to the right edge of the work area and the walk
  // direction is random, so a "right" walk stays clamped for its first tick. Center the
  // window horizontally first so either direction must move it.
  const { bounds, workArea } = await request({ cmd: "state" }) as State;
  await request({ cmd: "moveBy", dx: Math.floor(workArea.x + (workArea.width - bounds.width) / 2) - bounds.x, dy: 0 });
  await request({ cmd: "setState", state: "idle" });
  const idle = await screenshot(join(tempDir, "idle.png"));
  const firstFrame = (await request({ cmd: "character" }) as CharacterState).frame;
  await request({ cmd: "clock", advanceMs: 125 });
  expect((await request({ cmd: "character" }) as CharacterState).frame).not.toBe(firstFrame);
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 7_000 });
  const blink = await screenshot(join(tempDir, "blink.png"));
  const footTolerance = Math.ceil(2 * decodePng(idle).height / (256 + BADGE_TOP_MARGIN));
  expect(Math.abs(bottomOpaqueRow(idle) - bottomOpaqueRow(blink))).toBeLessThanOrEqual(footTolerance);
  expect((await request({ cmd: "character" }) as CharacterState).state).toBe("blink");
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 400 });
  expect((await request({ cmd: "character" }) as CharacterState).state).toBe("idle");
  const beforeJump = (await request({ cmd: "state" }) as State).bounds.x;
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 30_000 });
  const afterJump = (await request({ cmd: "state" }) as State).bounds.x;
  expect(Math.abs(afterJump - beforeJump)).toBeLessThanOrEqual(8);
  expect((await request({ cmd: "character" }) as CharacterState).state).toBe("walk");
  const before = (await request({ cmd: "state" }) as State).bounds.x;
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 1000 });
  const after = (await request({ cmd: "state" }) as State).bounds.x;
  expect(after).not.toBe(before);
  const walk = await screenshot(join(tempDir, "walk.png"));
  expect(Math.abs(bottomOpaqueRow(idle) - bottomOpaqueRow(walk))).toBeLessThanOrEqual(footTolerance);
  await request({ cmd: "setState", state: "idle" });
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 61_000 });
  expect((await request({ cmd: "character" }) as CharacterState).state).toBe("sleep");
  const sleep = await screenshot(join(tempDir, "sleep.png"));
  expect(Math.abs(bottomOpaqueRow(idle) - bottomOpaqueRow(sleep))).toBeLessThanOrEqual(footTolerance);
  await request({ cmd: "setState", state: "idle" });
});

test("re-entering walk in one tick does not move before the new walk begins", async () => {
  await request({ cmd: "clock", action: "pause" });
  const { bounds, workArea } = await request({ cmd: "state" }) as State;
  await request({ cmd: "moveBy", dx: Math.floor(workArea.x + (workArea.width - bounds.width) / 2) - bounds.x, dy: 0 });
  await request({ cmd: "setState", state: "walk" });
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 2_999 });
  const beforeReentry = (await request({ cmd: "state" }) as State).bounds.x;
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 30_000 });
  const reentered = await request({ cmd: "state" }) as State;
  expect(reentered.character).toMatchObject({ state: "walk", frame: 0 });
  expect(reentered.bounds.x).toBe(beforeReentry);
  await request({ cmd: "clock", action: "advanceMs", advanceMs: 100 });
  const after = (await request({ cmd: "state" }) as State).bounds.x;
  expect(Math.abs(after - reentered.bounds.x)).toBe(3);
  await request({ cmd: "setState", state: "idle" });
});

test("clock rejects multiple actions", async () => {
  expect((await app.requestRaw({ cmd: "clock", pause: true, resume: true })).ok).toBe(false);
  expect((await app.requestRaw({ cmd: "clock", action: "pause", advanceMs: 1 })).ok).toBe(false);
});

test("launch selection and invalid manifest fall back without crashing", async () => {
  const invalidRoot = join(tempDir, "broken-characters");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(invalidRoot, "placeholder"), { recursive: true })
    .then(() => writeFile(join(invalidRoot, "placeholder", "manifest.json"), "{}")));
  for (const [args, loaded, id] of [
    [["--character=placeholder-alt"], true, "placeholder-alt"],
    [[`--characters-dir=${invalidRoot}`], false, "placeholder"],
  ] as const) {
    const selected = await DesktopApp.launch(join(tempDir, loaded ? "alt-user-data" : "bad-user-data"),
      ["--terrain-source=off", ...args]);
    try {
      const state = await selected.request({ cmd: "state" }) as State;
      expect(state.ready, selected.diagnostics).toBe(true);
      expect(state?.character).toMatchObject({ id, loaded });
      if (!loaded) expect(state?.character.error).toBeTruthy();
      const path = join(tempDir, `${selected.name}.png`);
      await selected.request({ cmd: "screenshot", path });
      const png = await readFile(path);
      expect(pngAlphaAtLogical(png, 128, 137)).toBeGreaterThan(0);
      if (loaded) expect(pngPixelAtLogical(png, 128, 137).slice(0, 3)).toEqual(
        pngPixelAtLogical(await readFile(join(tempDir, "alternate.png")), 128, 137).slice(0, 3));
    } finally {
      await selected.dispose();
    }
  }
}, 30000);

test("moving the pet shares the drag bounds limit", async () => {
  const initial = await waitForReady();
  await request({ cmd: "moveBy", dx: -40, dy: -30 });
  const moved = await request({ cmd: "state" }) as State;
  expect(moved.bounds.x).toBe(initial.bounds.x - 40);
  expect(moved.bounds.y).toBe(initial.bounds.y - 30);

  await request({ cmd: "moveBy", dx: -1_000_000, dy: -1_000_000 });
  const topLeft = await request({ cmd: "state" }) as State;
  expect(topLeft.contentRect.x).toBe(topLeft.workArea.x);
  expect(topLeft.contentRect.y).toBe(topLeft.workArea.y);

  await request({ cmd: "moveBy", dx: 1_000_000, dy: 1_000_000 });
  const bottomRight = await request({ cmd: "state" }) as State;
  expect(bottomRight.contentRect.x + bottomRight.contentRect.width).toBe(bottomRight.workArea.x + bottomRight.workArea.width);
  expect(bottomRight.contentRect.y + bottomRight.contentRect.height).toBe(bottomRight.workArea.y + bottomRight.workArea.height);
});

test("tray actions hide, show, and quit the pet", async () => {
  await waitForReady();
  await request({ cmd: "trayMenuClick", label: "숨김" });
  const hidden = await request({ cmd: "state" }) as State;
  expect(hidden.visible).toBe(false);
  expect(hidden.trayReady).toBe(true);
  const hiddenClock = await request({ cmd: "clock", action: "advanceMs", advanceMs: 10_000 }) as { clockMs: number; state: string; frame: number; bounds: State["bounds"] };
  expect(hiddenClock.state).toBe(hidden.state);
  expect(hiddenClock.frame).toBe(hidden.character.frame);
  expect(hiddenClock.bounds).toEqual(hidden.bounds);

  await request({ cmd: "trayMenuClick", label: "표시" });
  const shown = await request({ cmd: "state" }) as State;
  expect(shown.visible).toBe(true);
  expect(shown.trayReady).toBe(true);
  const hit = await request({ cmd: "hitTest", x: shown.cursor.x - shown.bounds.x, y: shown.cursor.y - shown.bounds.y }) as { interactive: boolean };
  expect(shown.ignoreMouseEvents).toBe(!hit.interactive);

  await request({ cmd: "trayMenuClick", label: "숨김" });
  expect((await request({ cmd: "state" }) as State).visible).toBe(false);
  await app.quit({ cmd: "trayMenuClick", label: "종료" });

  const pipeError = await request({ cmd: "state" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(pipeError).toBeInstanceOf(Error);
  expect(["ENOENT", "ECONNREFUSED"]).toContain((pipeError as NodeJS.ErrnoException).code);
}, 30000);

test("screenshot CLI fails when the pipe closes before a response", async () => {
  const fakeName = randomUUID().replaceAll("-", "");
  const server = createServer((socket) => { socket.once("data", () => socket.end()); });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(`\\\\.\\pipe\\deskpet-dev-${fakeName}`, resolveListen);
  });
  try {
    for (const [script, args] of [
      ["screenshot.mjs", [join(tempDir, "closed.png"), "--name", fakeName]],
    ] as const) {
      const result = await runScript(script, args);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/closed|disconnected/i);
    }
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
