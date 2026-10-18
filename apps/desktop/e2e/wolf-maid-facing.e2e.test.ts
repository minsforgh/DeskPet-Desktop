import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readPng } from "../../../tools/sprite-pipeline/src/png.js";
import { DesktopApp } from "./desktop-app.js";
import { BADGE_TOP_MARGIN, petWindowY } from "./helpers/pet-window.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Image = ReturnType<typeof readPng>;
type Character = { id: string; loaded: boolean; states: string[]; state: string; frame: number };
type State = { bounds: { x: number; y: number; width: number; height: number };
  contentRect: { x: number; y: number; width: number; height: number } };

let temporary: string;
let app: DesktopApp;

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (temporary) await cleanupTemporaryPath(temporary, app ? [app] : []); }
});

async function capture(name: string): Promise<Image> {
  const path = join(temporary, "userData", name);
  await app.request({ cmd: "screenshot", path });
  return readPng(await readFile(path));
}

function rgba(image: Image, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
}

test("wolf maid walks in both directions and keeps front-facing idle unchanged", async () => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-wolf-facing-"));
  // The batch launcher supplies its default before user arguments.
  app = await DesktopApp.launch(join(temporary, "userData"), ["--terrain-source=off", "--character=placeholder", "--character=wolf-maid"]);
  await app.request({ cmd: "clock", action: "pause" });
  const character = await app.request({ cmd: "character" }) as Character;
  expect(character).toMatchObject({ id: "wolf-maid", loaded: true });
  expect(character.states).toContain("walk");
  const state = await app.request({ cmd: "state" }) as State;
  expect(state.bounds).toMatchObject({ width: 104, height: 154 + BADGE_TOP_MARGIN });

  await app.request({ cmd: "setState", state: "walk" });
  expect(await app.request({ cmd: "setMovementDirection", direction: "right" })).toMatchObject({ state: "walk", frame: 0 });
  const right = await capture("walk-right.png");
  const rightBounds = await app.request({ cmd: "state" }) as State;
  expect(await app.request({ cmd: "setMovementDirection", direction: "left" })).toMatchObject({ state: "walk", frame: 0 });
  const left = await capture("walk-left.png");
  expect(left.width).toBe(right.width);
  expect(left.height).toBe(right.height);
  let opaque = 0;
  for (let y = 0; y < right.height; y += 1) for (let x = 0; x < right.width; x += 1) {
    const original = rgba(right, x, y);
    const reflected = rgba(left, right.width - x - 1, y);
    expect(reflected).toEqual(original);
    if ((original[3] ?? 0) >= 128) opaque += 1;
  }
  expect(opaque).toBeGreaterThan(1000);
  const footprint = rightBounds.contentRect;
  const footprintLeft = footprint.x - rightBounds.bounds.x;
  const footprintRight = footprintLeft + footprint.width;
  for (const image of [right, left]) for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if ((rgba(image, x, y)[3] ?? 0) < 128) continue;
      const logicalX = Math.floor(x * state.bounds.width / image.width);
      expect(logicalX).toBeGreaterThanOrEqual(footprintLeft);
      expect(logicalX).toBeLessThan(footprintRight);
    }
  }
  let asymmetricPixel: { x: number; y: number } | undefined;
  for (let y = 0; y < state.bounds.height - BADGE_TOP_MARGIN && !asymmetricPixel; y += 1) {
    for (let x = 0; x < state.bounds.width; x += 1) {
      const px = Math.floor((x + 0.5) * right.width / state.bounds.width);
      const py = Math.floor(petWindowY(y + 0.5) * right.height / state.bounds.height);
      if ((rgba(right, px, py)[3] ?? 0) >= 128 && (rgba(left, px, py)[3] ?? 0) === 0) {
        // Screenshots include the top strip; the renderer hit test samples canvas art coordinates.
        asymmetricPixel = { x, y };
        break;
      }
    }
  }
  expect(asymmetricPixel).toBeDefined();
  if (!asymmetricPixel) throw new Error("Walk art has no asymmetric opaque pixel");
  expect(asymmetricPixel.x).toBeGreaterThanOrEqual(footprint.x - rightBounds.bounds.x);
  expect(asymmetricPixel.x).toBeLessThan(footprint.x - rightBounds.bounds.x + footprint.width);
  expect((await app.request({ cmd: "hitTest", ...asymmetricPixel }) as { interactive: boolean }).interactive).toBe(false);
  await app.request({ cmd: "setMovementDirection", direction: "right" });
  expect((await app.request({ cmd: "hitTest", ...asymmetricPixel }) as { interactive: boolean }).interactive).toBe(true);

  await app.request({ cmd: "moveBy", dx: 1_000_000, dy: 0 });
  await app.request({ cmd: "clock", action: "advanceMs", advanceMs: 250 });
  const turned = await app.request({ cmd: "state" }) as State & { animationMovement: { direction: string } };
  expect(turned.animationMovement.direction).toBe("left");

  await app.request({ cmd: "setState", state: "idle" });
  await app.request({ cmd: "setMovementDirection", direction: "right" });
  const idleRight = await capture("idle-right.png");
  await app.request({ cmd: "setMovementDirection", direction: "left" });
  const idleLeft = await capture("idle-left.png");
  expect(idleLeft.pixels).toEqual(idleRight.pixels);
  await app.quit();
}, 30000);
