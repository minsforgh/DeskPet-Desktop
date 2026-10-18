import { validateCharacterManifest, type CharacterManifest, type CharacterState } from "@deskpet/core";
import { readPng, writePng, type PngImage } from "./png.js";

export interface PackStateSpec { frames: string; offsetX: number; loop: boolean; next?: string; facing?: "left" | "right" }
export interface PackSpec {
  id: string; name: string; cellSize: [number, number]; anchor: [number, number]; scale: number;
  fallbacks: Record<string, string>; states: Record<string, PackStateSpec>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}

function plainStem(value: string): boolean {
  return !!value && value !== "." && value !== ".." && value.trim() === value &&
    ![...value].some((char) => '/\\:*?"<>|'.includes(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !value.endsWith(".");
}

export function parsePackSpec(value: unknown): PackSpec {
  const data = object(value, "spec");
  fields(data, ["id", "name", "cellSize", "anchor", "scale", "fallbacks", "states"], "spec");
  const states = object(data.states, "spec.states");
  if (!Object.hasOwn(states, "idle")) throw new Error("spec.states.idle is required");
  const parsed: Record<string, PackStateSpec> = {};
  for (const [name, raw] of Object.entries(states)) {
    if (!plainStem(name)) throw new Error(`spec.states.${name}: unsafe state name`);
    const label = `spec.states.${name}`;
    const state = object(raw, label);
    fields(state, ["frames", "offsetX", "loop", "next", "facing"], label);
    if (typeof state.frames !== "string" || !state.frames) throw new Error(`${label}.frames must be a folder path`);
    if (!Number.isSafeInteger(state.offsetX) || typeof state.offsetX !== "number") throw new Error(`${label}.offsetX must be an integer`);
    if (typeof state.loop !== "boolean") throw new Error(`${label}.loop must be a boolean`);
    if (state.next !== undefined && typeof state.next !== "string") throw new Error(`${label}.next must be a string`);
    if (state.facing !== undefined && state.facing !== "left" && state.facing !== "right") throw new Error(`${label}.facing must be left or right`);
    parsed[name] = { frames: state.frames, offsetX: state.offsetX, loop: state.loop,
      ...(state.next === undefined ? {} : { next: state.next }),
      ...(state.facing === undefined ? {} : { facing: state.facing }) };
  }
  const fallbacks = object(data.fallbacks, "spec.fallbacks");
  if (typeof data.id !== "string" || !plainStem(data.id)) throw new Error("spec.id must be a safe filename stem");
  const candidate: CharacterManifest = {
    id: data.id, name: data.name as string, apiVersion: "1",
    cellSize: data.cellSize as [number, number], anchor: data.anchor as [number, number],
    scale: data.scale as number, fallbacks: fallbacks as Record<string, string>,
    states: Object.fromEntries(Object.entries(parsed).map(([name, state]) => [name, {
      sheet: `sheets/${name}.png`, frames: 1, fps: 1, loop: state.loop,
      ...(state.next === undefined ? {} : { next: state.next }),
      ...(state.facing === undefined ? {} : { facing: state.facing }),
    }])),
  };
  const result = validateCharacterManifest(candidate);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return { id: candidate.id, name: candidate.name, cellSize: candidate.cellSize,
    anchor: candidate.anchor, scale: candidate.scale, fallbacks: candidate.fallbacks, states: parsed };
}

export function parseFrameMetadata(value: unknown, state: string): { fps: number; frames: number } {
  const data = object(value, "frames.json");
  const states = object(data.states, "frames.json.states");
  const entry = object(states[state], `frames.json.states.${state}`);
  if (typeof entry.fps !== "number" || !Number.isFinite(entry.fps) || entry.fps <= 0 || entry.fps > 60)
    throw new Error(`${state}: invalid fps in frames.json`);
  if (typeof entry.frames !== "number" || !Number.isSafeInteger(entry.frames) || entry.frames < 1)
    throw new Error(`${state}: invalid frame count in frames.json`);
  return { fps: entry.fps, frames: entry.frames };
}

export function buildSheet(frames: PngImage[], cellSize: [number, number], offsetX: number): PngImage {
  if (frames.length < 1) throw new Error("A sheet needs at least one frame");
  const [cellWidth, cellHeight] = cellSize;
  const width = cellWidth * frames.length;
  const pixels = new Uint8Array(width * cellHeight * 4);
  for (let frame = 0; frame < frames.length; frame += 1) {
    const image = frames[frame];
    if (!image) throw new Error("Missing frame");
    if (offsetX < 0 || offsetX + image.width > cellWidth || image.height > cellHeight)
      throw new Error(`Frame ${frame + 1} does not fit ${cellWidth}x${cellHeight} cell at offsetX ${offsetX}`);
    for (let y = 0; y < image.height; y += 1) {
      const source = y * image.width * 4;
      const target = (y * width + frame * cellWidth + offsetX) * 4;
      pixels.set(image.pixels.subarray(source, source + image.width * 4), target);
    }
  }
  return { width, height: cellHeight, pixels };
}

export function makePackFiles(spec: PackSpec, inputs: Record<string, { fps: number; frames: Uint8Array[] }>): [string, Uint8Array | string][] {
  const states: Record<string, CharacterState> = {};
  const files: [string, Uint8Array | string][] = [];
  for (const [name, config] of Object.entries(spec.states)) {
    const input = inputs[name];
    if (!input) throw new Error(`${name}: missing input`);
    const sheet = buildSheet(input.frames.map((bytes) => readPng(bytes)), spec.cellSize, config.offsetX);
    files.push([`sheets/${name}.png`, writePng(sheet)]);
    states[name] = { sheet: `sheets/${name}.png`, frames: input.frames.length, fps: input.fps, loop: config.loop,
      ...(config.next === undefined ? {} : { next: config.next }),
      ...(config.facing === undefined ? {} : { facing: config.facing }) };
  }
  const manifest: CharacterManifest = { id: spec.id, name: spec.name, apiVersion: "1", cellSize: spec.cellSize,
    anchor: spec.anchor, scale: spec.scale, states, fallbacks: spec.fallbacks };
  const result = validateCharacterManifest(manifest);
  if (!result.ok) throw new Error(result.errors.join("; "));
  files.unshift(["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`]);
  return files;
}
