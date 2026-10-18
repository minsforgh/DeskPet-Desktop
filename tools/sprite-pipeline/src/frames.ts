import type { PngImage } from "./png.js";
import { scaleNearest } from "./pixelize.js";
import { applyEdits, parseEdit, parseRegion, summarize, type Edit, type PaletteColor, type Region } from "./retouch.js";

export interface ShiftOp { type: "shift"; region: Region; dx: number; dy: number; fill?: string; only?: string[]; note: string }
export interface ShiftSetOp { type: "shift-set"; moves: (ShiftOp & { only: string[] })[]; note: string }
export type FrameOp = Edit | ShiftOp | ShiftSetOp;

export interface Parts {
  width: number;
  height: number;
  boxes: Map<string, Region>;
  footRow: number;
  footCenterX: number;
}

export interface SpecPaths { base: string; palette: string; parts: string; states: unknown }
export interface FrameDefinition { note: string; ops: FrameOp[] }
export interface StateDefinition { name: string; fps: number; frames: FrameDefinition[] }

export const STRIP_PREVIEW_GAP = 8;
export const PREVIEW_MAX_PIXELS = 4_000_000;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be an integer >= ${min}`);
  return value;
}

function whole(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function plainStem(name: string): boolean {
  return name.trim() !== "" && name !== "." && name !== ".." && ![...name].some((char) => '/\\:*?"<>|'.includes(char) || char.charCodeAt(0) < 32) && !name.endsWith(".") && !name.endsWith(" ");
}

export function parseParts(value: unknown): Parts {
  const data = object(value, "parts");
  fields(data, ["$comment", "image", "size", "parts", "anchor"], "parts");
  if (data.$comment !== undefined && typeof data.$comment !== "string") throw new Error("parts.$comment must be a string");
  text(data.image, "parts.image");
  if (!Array.isArray(data.size) || data.size.length !== 2) throw new Error("parts.size must be [width, height]");
  const width = integer(data.size[0], "parts.size[0]", 1);
  const height = integer(data.size[1], "parts.size[1]", 1);
  const parts = object(data.parts, "parts.parts");
  const boxes = new Map<string, Region>();
  for (const [name, entry] of Object.entries(parts)) {
    const label = `parts.parts.${name}`;
    if (!name.trim()) throw new Error(`${label}: part names must be nonempty`);
    const part = object(entry, label);
    fields(part, ["box", "note"], label);
    if (part.note !== undefined) text(part.note, `${label}.note`);
    if (!Array.isArray(part.box) || part.box.length !== 4) throw new Error(`${label}.box must be [x0, y0, x1, y1]`);
    const x0 = integer(part.box[0], `${label}.box[0]`, 0);
    const y0 = integer(part.box[1], `${label}.box[1]`, 0);
    const x1 = integer(part.box[2], `${label}.box[2]`, 0);
    const y1 = integer(part.box[3], `${label}.box[3]`, 0);
    if (x1 < x0 || y1 < y0) throw new Error(`${label}.box must satisfy x1 >= x0 and y1 >= y0`);
    if (x1 >= width || y1 >= height) throw new Error(`${label}.box is outside ${width}x${height} canvas`);
    boxes.set(name, { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
  }
  if (!boxes.has("legs")) throw new Error("parts.parts must define a legs part for foot validation");
  const anchor = object(data.anchor, "parts.anchor");
  fields(anchor, ["foot-row", "foot-center-x"], "parts.anchor");
  const footRow = integer(anchor["foot-row"], "parts.anchor.foot-row", 0);
  if (footRow >= height) throw new Error(`parts.anchor.foot-row must be a row below ${height - 1}`);
  const centerX = anchor["foot-center-x"];
  if (typeof centerX !== "number" || !Number.isFinite(centerX) || centerX < 0 || centerX > width) throw new Error("parts.anchor.foot-center-x must be a finite x coordinate inside the canvas");
  return { width, height, boxes, footRow, footCenterX: centerX };
}

export function parseSpecPaths(value: unknown): SpecPaths {
  const data = object(value, "spec");
  fields(data, ["base", "palette", "parts", "states"], "spec");
  const states = object(data.states, "spec.states");
  return { base: text(data.base, "spec.base"), palette: text(data.palette, "spec.palette"), parts: text(data.parts, "spec.parts"), states };
}

function partRegion(name: unknown, label: string, parts: Parts): Region {
  if (typeof name !== "string" || !name.trim()) throw new Error(`${label} must be a region object or a parts.json part name`);
  const box = parts.boxes.get(name);
  if (!box) throw new Error(`${label}: unknown part ${name}`);
  return box;
}

export function parseOp(value: unknown, label: string, palette: PaletteColor[], parts: Parts): FrameOp {
  const op = object(value, label);
  if (op.type === "shift-set") {
    fields(op, ["type", "moves", "note"], label);
    const note = text(op.note, `${label}.note`);
    if (!Array.isArray(op.moves) || op.moves.length < 1) throw new Error(`${label}.moves must be a nonempty array`);
    const moves = (op.moves as unknown[]).map((entry, index) => {
      const move = parseOp({ type: "shift", note, ...object(entry, `${label}.moves[${index}]`) }, `${label}.moves[${index}]`, palette, parts);
      if (move.type !== "shift" || move.only === undefined) throw new Error(`${label}.moves[${index}].only is required`);
      if (move.fill !== undefined) throw new Error(`${label}.moves[${index}].fill is not supported in shift-set`);
      return move as ShiftOp & { only: string[] };
    });
    return { type: "shift-set", moves, note };
  }
  if (op.type === "shift") {
    fields(op, ["type", "region", "dx", "dy", "fill", "only", "note"], label);
    const note = text(op.note, `${label}.note`);
    const region = typeof op.region === "string" ? partRegion(op.region, `${label}.region`, parts) : parseRegion(op.region, parts.width, parts.height, `${label}.region`);
    const dx = whole(op.dx, `${label}.dx`);
    const dy = whole(op.dy, `${label}.dy`);
    let fill: string | undefined;
    if (op.fill !== undefined) {
      fill = text(op.fill, `${label}.fill`);
      if (!palette.some((color) => color.name === fill)) throw new Error(`${label}.fill: unknown palette color ${fill}`);
    }
    let only: string[] | undefined;
    if (op.only !== undefined) {
      if (!Array.isArray(op.only) || op.only.length < 1) throw new Error(`${label}.only must be a nonempty array of palette color names`);
      only = (op.only as unknown[]).map((entry, index) => {
        const name = text(entry, `${label}.only[${index}]`);
        if (!palette.some((color) => color.name === name)) throw new Error(`${label}.only[${index}]: unknown palette color ${name}`);
        return name;
      });
    }
    return { type: "shift", region, dx, dy, ...(fill === undefined ? {} : { fill }), ...(only === undefined ? {} : { only }), note };
  }
  const edit: Record<string, unknown> = { ...op };
  if (typeof edit.region === "string") edit.region = partRegion(edit.region, `${label}.region`, parts);
  return parseEdit(edit, label, palette, parts.width, parts.height);
}

export function parseStates(value: unknown, palette: PaletteColor[], parts: Parts): StateDefinition[] {
  const data = object(value, "spec.states");
  const names = Object.keys(data);
  if (names.length === 0) throw new Error("spec.states must define at least one state");
  const states: StateDefinition[] = [];
  for (const name of names) {
    if (!plainStem(name)) throw new Error(`spec.states.${name}: state names must be plain filename stems`);
    const label = `spec.states.${name}`;
    const state = object(data[name], label);
    fields(state, ["fps", "frames"], label);
    const fps = integer(state.fps, `${label}.fps`, 1);
    if (!Array.isArray(state.frames) || state.frames.length < 1) throw new Error(`${label}.frames must be a nonempty array`);
    const frames = state.frames.map((entry: unknown, index: number): FrameDefinition => {
      const frameLabel = `${label}.frames[${index}]`;
      const frame = object(entry, frameLabel);
      fields(frame, ["note", "ops"], frameLabel);
      const note = text(frame.note, `${frameLabel}.note`);
      if (!Array.isArray(frame.ops)) throw new Error(`${frameLabel}.ops must be an array`);
      const ops = (frame.ops as unknown[]).map((op: unknown, opIndex: number) => parseOp(op, `${frameLabel}.ops[${opIndex}]`, palette, parts));
      return { note, ops };
    });
    states.push({ name, fps, frames });
  }
  return states;
}

export function applyShift(image: PngImage, palette: PaletteColor[], op: ShiftOp): void {
  const color = op.fill === undefined ? undefined : palette.find((entry) => entry.name === op.fill);
  if (op.fill !== undefined && !color) throw new Error(`Unknown palette color ${op.fill}`);
  const fill = color ? color.rgba : [0, 0, 0, 0];
  const { x, y, width, height } = op.region;
  if (op.only !== undefined) {
    // Only the listed colors move, and they pass behind every pixel that stays put.
    const names = new Map(palette.map((entry) => [entry.rgba.join(","), entry.name]));
    const moving = new Set(op.only);
    const cells: { x: number; y: number; rgba: number[] }[] = [];
    for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
      const at = ((y + row) * image.width + x + column) * 4;
      const rgba = Array.from(image.pixels.subarray(at, at + 4));
      if (rgba[3] === 255 && moving.has(names.get(rgba.join(",")) ?? "")) cells.push({ x: x + column, y: y + row, rgba });
    }
    for (const cell of cells) image.pixels.set(fill, (cell.y * image.width + cell.x) * 4);
    for (const cell of cells) {
      const targetX = cell.x + op.dx;
      const targetY = cell.y + op.dy;
      if (targetX < 0 || targetY < 0 || targetX >= image.width || targetY >= image.height) continue;
      const target = (targetY * image.width + targetX) * 4;
      if (image.pixels[target + 3] === 0) image.pixels.set(cell.rgba, target);
    }
    return;
  }
  const snapshot = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = ((y + row) * image.width + x) * 4;
    snapshot.set(image.pixels.subarray(source, source + width * 4), row * width * 4);
  }
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    image.pixels.set(fill, ((y + row) * image.width + x + column) * 4);
  }
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const targetX = x + column + op.dx;
    const targetY = y + row + op.dy;
    if (targetX < 0 || targetY < 0 || targetX >= image.width || targetY >= image.height) continue;
    const source = (row * width + column) * 4;
    image.pixels.set(snapshot.subarray(source, source + 4), (targetY * image.width + targetX) * 4);
  }
}

// 여러 이동을 같은 원본에서 동시에 읽어 옮긴다. 두 발이 서로 엇갈릴 때 한 발이 이미 옮겨진 픽셀을
// 다시 옮기는 일이 없다. 움직이지 않는 픽셀 뒤로 지나가고, 이동끼리 겹치면 목록의 앞쪽이 위에 온다.
export function applyShiftSet(image: PngImage, palette: PaletteColor[], op: ShiftSetOp): void {
  const names = new Map(palette.map((entry) => [entry.rgba.join(","), entry.name]));
  const groups = op.moves.map((move) => {
    const moving = new Set(move.only);
    const cells: { x: number; y: number; rgba: number[] }[] = [];
    for (let row = 0; row < move.region.height; row += 1) for (let column = 0; column < move.region.width; column += 1) {
      const x = move.region.x + column;
      const y = move.region.y + row;
      const at = (y * image.width + x) * 4;
      const rgba = Array.from(image.pixels.subarray(at, at + 4));
      if (rgba[3] === 255 && moving.has(names.get(rgba.join(",")) ?? "")) cells.push({ x, y, rgba });
    }
    return { move, cells };
  });
  for (const group of groups) for (const cell of group.cells) image.pixels.set([0, 0, 0, 0], (cell.y * image.width + cell.x) * 4);
  for (const group of groups) for (const cell of group.cells) {
    const targetX = cell.x + group.move.dx;
    const targetY = cell.y + group.move.dy;
    if (targetX < 0 || targetY < 0 || targetX >= image.width || targetY >= image.height) continue;
    const target = (targetY * image.width + targetX) * 4;
    if (image.pixels[target + 3] === 0) image.pixels.set(cell.rgba, target);
  }
}

export function buildFrame(base: PngImage, palette: PaletteColor[], ops: FrameOp[]): PngImage {
  const image = { width: base.width, height: base.height, pixels: base.pixels.slice() };
  let batch: Edit[] = [];
  const flush = (): void => {
    if (batch.length > 0) {
      applyEdits(image, palette, batch);
      batch = [];
    }
  };
  for (const op of ops) {
    if (op.type === "shift") {
      flush();
      applyShift(image, palette, op);
    } else if (op.type === "shift-set") {
      flush();
      applyShiftSet(image, palette, op);
    } else {
      batch.push(op);
    }
  }
  flush();
  return image;
}

export function validateFrame(image: PngImage, palette: PaletteColor[], parts: Parts, where: string): number {
  if (image.width !== parts.width || image.height !== parts.height) throw new Error(`${where}: size ${image.width}x${image.height} does not match the ${parts.width}x${parts.height} base`);
  let summary: ReturnType<typeof summarize>;
  try {
    summary = summarize(image, palette);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let bottomRow = -1;
  for (let y = image.height - 1; y >= 0 && bottomRow < 0; y -= 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 255) { bottomRow = y; break; }
    }
  }
  if (bottomRow < 0) throw new Error(`${where}: no opaque pixels`);
  if (bottomRow !== parts.footRow) throw new Error(`${where}: lowest opaque row ${bottomRow} does not match anchor foot-row ${parts.footRow}`);
  const legs = parts.boxes.get("legs");
  if (!legs) throw new Error(`${where}: parts.json has no legs part`);
  let minX = image.width;
  let maxX = -1;
  for (let y = legs.y; y < legs.y + legs.height; y += 1) for (let x = legs.x; x < legs.x + legs.width; x += 1) {
    if (image.pixels[(y * image.width + x) * 4 + 3] === 255) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  if (maxX < minX) throw new Error(`${where}: no opaque pixels inside the legs part`);
  const center = (minX + maxX) / 2;
  if (Math.abs(center - parts.footCenterX) > 2) throw new Error(`${where}: foot center x ${center} is more than 2px from anchor foot-center-x ${parts.footCenterX}`);
  return summary.colors;
}

export function buildStrip(frames: PngImage[]): PngImage {
  if (frames.length === 0) throw new Error("A strip needs at least one frame");
  const height = frames[0]?.height ?? 0;
  const width = frames.reduce((total, frame) => total + frame.width, 0);
  const pixels = new Uint8Array(width * height * 4);
  let offset = 0;
  for (const frame of frames) {
    if (frame.height !== height) throw new Error("Strip frames must share one height");
    for (let row = 0; row < height; row += 1) {
      pixels.set(frame.pixels.subarray(row * frame.width * 4, (row + 1) * frame.width * 4), (row * width + offset) * 4);
    }
    offset += frame.width;
  }
  return { width, height, pixels };
}

export function stripPreviewPixels(strip: PngImage, scale: number): number {
  return strip.width * scale * (strip.height * scale);
}

export function buildStripPreview(strip: PngImage, scale: number): PngImage {
  const scaled = scaleNearest(strip, scale);
  const width = scaled.width;
  const height = scaled.height * 2 + STRIP_PREVIEW_GAP;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const shade = y < scaled.height ? 232 : y >= scaled.height + STRIP_PREVIEW_GAP ? 40 : 128;
    const offset = (y * width + x) * 4;
    pixels.set([shade, shade, shade, 255], offset);
    const sourceY = y < scaled.height ? y : y >= scaled.height + STRIP_PREVIEW_GAP ? y - scaled.height - STRIP_PREVIEW_GAP : -1;
    if (sourceY < 0) continue;
    const source = (sourceY * width + x) * 4;
    if (scaled.pixels[source + 3] === 255) pixels.set(scaled.pixels.subarray(source, source + 4), offset);
  }
  return { width, height, pixels };
}
