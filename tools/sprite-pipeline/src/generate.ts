import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharacterManifest, CharacterState } from "@deskpet/core";
import { writePng } from "./png.js";

const CELL = 256;
const ANCHOR: [number, number] = [128, 240];
const STATES: Record<string, Omit<CharacterState, "sheet">> = {
  idle: { frames: 8, fps: 8, loop: true },
  blink: { frames: 4, fps: 12, loop: false, next: "idle" },
  walk: { frames: 6, fps: 10, loop: true },
  sleep: { frames: 4, fps: 3, loop: true },
  happy: { frames: 6, fps: 10, loop: false, next: "idle" },
  surprised: { frames: 5, fps: 12, loop: false, next: "idle" },
  worried: { frames: 6, fps: 8, loop: true },
  talk: { frames: 4, fps: 8, loop: true },
  drag: { frames: 4, fps: 8, loop: true },
};

type Color = readonly [number, number, number, number];
interface Palette { body: Color; accent: Color; outline: Color; cheek: Color; }
const PRIMARY: Palette = { body: [255, 174, 91, 255], accent: [255, 216, 148, 255], outline: [72, 52, 66, 255], cheek: [250, 109, 119, 255] };
const ALTERNATE: Palette = { body: [69, 204, 222, 255], accent: [177, 248, 234, 255], outline: [24, 60, 101, 255], cheek: [145, 88, 224, 255] };

class Canvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number) { this.pixels = new Uint8Array(width * height * 4); }
  pixel(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels.set(color, (y * this.width + x) * 4);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, color: Color): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.pixel(x, y, color);
      }
    }
  }
  rect(left: number, top: number, width: number, height: number, color: Color): void {
    for (let y = top; y < top + height; y += 1) for (let x = left; x < left + width; x += 1) this.pixel(x, y, color);
  }
  line(x1: number, y1: number, x2: number, y2: number, thickness: number, color: Color): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps;
      this.ellipse(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), thickness, thickness, color);
    }
  }
}

function drawFrame(canvas: Canvas, frameX: number, state: string, frame: number, alternate: boolean, palette: Palette): void {
  const bob = state === "idle" || state === "happy" ? Math.round(Math.sin(frame * Math.PI / 2) * 3) : 0;
  const sway = state === "walk" ? (frame % 2 === 0 ? -6 : 6) : state === "drag" ? -7 : 0;
  const sleep = state === "sleep";
  const surprised = state === "surprised";
  const centerX = frameX + 128 + sway;
  const centerY = sleep ? 173 : 163 + bob;
  // The two soles always share a ground line, including during walk and drag.
  const stride = state === "walk" ? (frame % 2 === 0 ? 7 : -7) : 0;
  const leftFootX = frameX + 107 - stride;
  const rightFootX = frameX + 149 + stride;
  canvas.ellipse(leftFootX, 231, 17, 9, palette.outline);
  canvas.ellipse(rightFootX, 231, 17, 9, palette.outline);
  canvas.ellipse(leftFootX, 230, 14, 8, palette.body);
  canvas.ellipse(rightFootX, 230, 14, 8, palette.body);
  canvas.line(centerX - 23, centerY + 36, leftFootX, 225, 5, palette.body);
  canvas.line(centerX + 23, centerY + 36, rightFootX, 225, 5, palette.body);

  if (alternate) {
    // Distinct broad, flat topped body and long diamond ears.
    canvas.rect(centerX - 52, centerY - 43, 104, 73, palette.outline);
    canvas.rect(centerX - 47, centerY - 40, 94, 70, palette.body);
    canvas.ellipse(centerX, centerY + 26, 47, 37, palette.body);
    canvas.line(centerX - 32, centerY - 32, centerX - 48, centerY - 72, 8, palette.outline);
    canvas.line(centerX + 32, centerY - 32, centerX + 48, centerY - 72, 8, palette.outline);
    canvas.line(centerX - 32, centerY - 32, centerX - 48, centerY - 72, 5, palette.accent);
    canvas.line(centerX + 32, centerY - 32, centerX + 48, centerY - 72, 5, palette.accent);
  } else {
    canvas.ellipse(centerX, centerY, surprised ? 56 : 51, surprised ? 62 : 56, palette.outline);
    canvas.ellipse(centerX, centerY - 2, surprised ? 51 : 46, surprised ? 57 : 51, palette.body);
    canvas.ellipse(centerX - 27, centerY - 46, 17, 28, palette.outline);
    canvas.ellipse(centerX + 27, centerY - 46, 17, 28, palette.outline);
    canvas.ellipse(centerX - 27, centerY - 47, 12, 22, palette.cheek);
    canvas.ellipse(centerX + 27, centerY - 47, 12, 22, palette.cheek);
  }
  canvas.ellipse(centerX, centerY + 20, 29, 25, palette.accent);
  const faceY = centerY - 12;
  if (state === "blink" || sleep || state === "happy") {
    const tilt = sleep ? 5 : state === "happy" ? -4 : 0;
    canvas.line(centerX - 25, faceY + tilt, centerX - 11, faceY - tilt, 2, palette.outline);
    canvas.line(centerX + 11, faceY - tilt, centerX + 25, faceY + tilt, 2, palette.outline);
  } else {
    canvas.ellipse(centerX - 18, faceY, surprised ? 6 : 4, surprised ? 9 : 7, palette.outline);
    canvas.ellipse(centerX + 18, faceY, surprised ? 6 : 4, surprised ? 9 : 7, palette.outline);
  }
  canvas.ellipse(centerX - 33, centerY + 6, 7, 4, palette.cheek);
  canvas.ellipse(centerX + 33, centerY + 6, 7, 4, palette.cheek);
  if (surprised || state === "talk") {
    canvas.ellipse(centerX, centerY + 11, surprised ? 11 : frame % 2 === 0 ? 8 : 4, surprised ? 13 : frame % 2 === 0 ? 9 : 4, palette.outline);
  } else if (state === "worried") {
    canvas.line(centerX - 10, centerY + 16, centerX, centerY + 9, 2, palette.outline);
    canvas.line(centerX, centerY + 9, centerX + 10, centerY + 16, 2, palette.outline);
    canvas.line(centerX - 29, faceY - 11, centerX - 9, faceY - 5, 2, palette.outline);
    canvas.line(centerX + 9, faceY - 5, centerX + 29, faceY - 11, 2, palette.outline);
  } else {
    canvas.line(centerX - 8, centerY + 9, centerX, centerY + 15 + (state === "happy" ? 6 : 0), 2, palette.outline);
    canvas.line(centerX, centerY + 15 + (state === "happy" ? 6 : 0), centerX + 8, centerY + 9, 2, palette.outline);
  }
  if (state === "drag") {
    canvas.line(centerX - 42, centerY + 12, centerX - 66, centerY - 8, 5, palette.outline);
    canvas.line(centerX + 42, centerY + 12, centerX + 66, centerY - 8, 5, palette.outline);
  }
}

async function generatePack(directory: string, alternate: boolean): Promise<void> {
  const palette = alternate ? ALTERNATE : PRIMARY;
  const states: Record<string, CharacterState> = {};
  await mkdir(join(directory, "sheets"), { recursive: true });
  for (const [state, config] of Object.entries(STATES)) {
    if (alternate && (state === "worried" || state === "talk")) continue;
    const canvas = new Canvas(CELL * config.frames, CELL);
    for (let frame = 0; frame < config.frames; frame += 1) drawFrame(canvas, frame * CELL, state, frame, alternate, palette);
    states[state] = { sheet: `sheets/${state}.png`, ...config };
    await writeFile(join(directory, "sheets", `${state}.png`), writePng(canvas));
  }
  const manifest: CharacterManifest = {
    id: alternate ? "placeholder-alt" : "placeholder",
    name: alternate ? "Placeholder Alt" : "Placeholder",
    apiVersion: "1",
    cellSize: [CELL, CELL],
    anchor: ANCHOR,
    scale: 1,
    states,
    fallbacks: alternate ? { worried: "surprised", talk: "idle", celebrate: "happy" } : { celebrate: "happy" },
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const charactersDirectory = fileURLToPath(new URL("../../../characters/", import.meta.url));
await generatePack(join(charactersDirectory, "placeholder"), false);
await generatePack(join(charactersDirectory, "placeholder-alt"), true);
