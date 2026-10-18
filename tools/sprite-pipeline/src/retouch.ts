import type { PngImage } from "./png.js";

export interface PaletteColor { name: string; hex: string; role: string; rgba: [number, number, number, number] }
export interface Region { x: number; y: number; width: number; height: number }
export type Edit = ({ type: "pixel"; x: number; y: number; color: string } | { type: "rect"; color: string; region: Region } | { type: "replace"; from: string; color: string; region: Region }) & { note: string };

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

export function parsePalette(value: unknown): PaletteColor[] {
  const data = object(value, "palette");
  fields(data, ["colors"], "palette");
  if (!Array.isArray(data.colors) || data.colors.length < 1 || data.colors.length > 16) throw new Error("palette.colors must contain 1–16 colors");
  const names = new Set<string>();
  const hexes = new Set<string>();
  return data.colors.map((entry: unknown, index: number) => {
    const label = `palette.colors[${index}]`;
    const color = object(entry, label);
    fields(color, ["name", "hex", "role"], label);
    const name = text(color.name, `${label}.name`);
    const hex = text(color.hex, `${label}.hex`).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`${label}.hex must be #RRGGBB`);
    if (name === "transparent" || names.has(name)) throw new Error(`${label}.name is reserved or duplicated: ${name}`);
    if (hexes.has(hex)) throw new Error(`${label}.hex is duplicated: ${hex}`);
    names.add(name); hexes.add(hex);
    return { name, hex, role: text(color.role, `${label}.role`), rgba: [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255] };
  });
}

function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be an integer >= ${min}`);
  return value;
}

export function parseRegion(value: unknown, width: number, height: number, label: string): Region {
  const data = object(value, label);
  fields(data, ["x", "y", "width", "height"], label);
  const result = { x: integer(data.x, `${label}.x`, 0), y: integer(data.y, `${label}.y`, 0), width: integer(data.width, `${label}.width`, 1), height: integer(data.height, `${label}.height`, 1) };
  if (result.x + result.width > width || result.y + result.height > height) throw new Error(`${label} is outside ${width}x${height} canvas`);
  return result;
}

function colorName(value: unknown, label: string, palette: PaletteColor[]): string {
  const name = text(value, label);
  if (name !== "transparent" && !palette.some((color) => color.name === name)) throw new Error(`${label}: unknown palette color ${name}`);
  return name;
}

export function parseEdit(entry: unknown, label: string, palette: PaletteColor[], width: number, height: number): Edit {
  const edit = object(entry, label);
  const type = edit.type ?? "pixel";
  const note = text(edit.note, `${label}.note`);
  const color = colorName(edit.color, `${label}.color`, palette);
  if (type === "pixel") {
    fields(edit, ["type", "x", "y", "color", "note"], label);
    const bounds = parseRegion({ x: edit.x, y: edit.y, width: 1, height: 1 }, width, height, label);
    return { type, x: bounds.x, y: bounds.y, color, note };
  }
  if (type === "rect" || type === "replace") {
    fields(edit, type === "rect" ? ["type", "region", "color", "note"] : ["type", "region", "from", "color", "note"], label);
    const bounds = type === "replace" && edit.region === undefined ? { x: 0, y: 0, width, height } : parseRegion(edit.region, width, height, `${label}.region`);
    return type === "rect" ? { type, color, region: bounds, note } : { type, color, from: colorName(edit.from, `${label}.from`, palette), region: bounds, note };
  }
  throw new Error(`${label}.type must be pixel, rect, or replace`);
}

export function parseEdits(value: unknown, palette: PaletteColor[], width: number, height: number): Edit[] {
  const data = object(value, "edits");
  fields(data, ["edits"], "edits");
  if (!Array.isArray(data.edits)) throw new Error("edits.edits must be an array");
  return data.edits.map((entry: unknown, index: number): Edit => parseEdit(entry, `edits[${index}]`, palette, width, height));
}

function equal(pixels: Uint8Array, offset: number, rgba: number[]): boolean {
  return rgba.every((value, channel) => pixels[offset + channel] === value);
}

export function summarize(image: PngImage, palette: PaletteColor[]): { width: number; height: number; colors: number; transparentPixels: number; palette: { name: string; hex: string; pixels: number }[] } {
  const counts = palette.map(() => 0);
  let transparentPixels = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (image.pixels[offset + 3] === 0) { transparentPixels += 1; continue; }
    const index = palette.findIndex((color) => equal(image.pixels, offset, color.rgba));
    if (index < 0) throw new Error(`Pixel (${offset / 4 % image.width}, ${Math.floor(offset / 4 / image.width)}) is not opaque palette color or transparent`);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const used = palette.map((color, index) => ({ name: color.name, hex: color.hex, pixels: counts[index] ?? 0 })).filter((color) => color.pixels > 0);
  return { width: image.width, height: image.height, colors: used.length, transparentPixels, palette: used };
}

export function applyEdits(image: PngImage, palette: PaletteColor[], edits: Edit[]): void {
  const rgba = (name: string): number[] => {
    if (name === "transparent") return [0, 0, 0, 0];
    const color = palette.find((entry) => entry.name === name);
    if (!color) throw new Error(`Unknown palette color ${name}`);
    return color.rgba;
  };
  for (const edit of edits) {
    const bounds = edit.type === "pixel" ? { x: edit.x, y: edit.y, width: 1, height: 1 } : edit.region;
    const target = rgba(edit.color);
    const from = edit.type === "replace" ? rgba(edit.from) : undefined;
    for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (!from || equal(image.pixels, offset, from)) image.pixels.set(target, offset);
    }
  }
}

export function retouch(source: PngImage, palette: PaletteColor[], edits: Edit[]): PngImage {
  if (palette.length === 0) throw new Error("Palette must not be empty");
  const image = { ...source, pixels: source.pixels.slice() };
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    const alpha = image.pixels[offset + 3];
    if (alpha === 0) { image.pixels.fill(0, offset, offset + 4); continue; }
    if (alpha !== 255) throw new Error(`Input pixel (${offset / 4 % image.width}, ${Math.floor(offset / 4 / image.width)}) has partial alpha ${alpha}; use an opaque/transparent sprite`);
    let distance = Infinity;
    let nearest = palette[0];
    for (const color of palette) {
      const squared = color.rgba.slice(0, 3).reduce((sum, value, channel) => sum + (value - (image.pixels[offset + channel] ?? 0)) ** 2, 0);
      // Squared sRGB distance; the first palette entry wins exact ties.
      if (squared < distance) { distance = squared; nearest = color; }
    }
    if (nearest) image.pixels.set(nearest.rgba, offset);
  }
  applyEdits(image, palette, edits);
  summarize(image, palette);
  return image;
}
