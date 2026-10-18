import type { PngImage } from "./png.js";

export interface Bounds { x: number; y: number; width: number; height: number }
export interface BackgroundResult { image: PngImage; transparentPixels: number }

function copy(image: PngImage): PngImage {
  return { width: image.width, height: image.height, pixels: image.pixels.slice() };
}

function rgb(pixels: Uint8Array, offset: number): number {
  return ((pixels[offset] ?? 0) << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0);
}

function colorDistance(a: number, b: number): number {
  const dr = ((a >>> 16) & 255) - ((b >>> 16) & 255);
  const dg = ((a >>> 8) & 255) - ((b >>> 8) & 255);
  const db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db;
}

export function removeBackground(image: PngImage, tolerance = 24): BackgroundResult {
  const result = copy(image);
  const { width, height, pixels } = result;
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const first = rgb(pixels, 0);
  const cornersMatch = corners.every((index) => pixels[index * 4 + 3] === 255 && rgb(pixels, index * 4) === first);
  const fullyOpaque = pixels.every((value, index) => index % 4 !== 3 || value === 255);
  if (!cornersMatch && !fullyOpaque) return { image: result, transparentPixels: 0 };
  // RGB PNGs decode as fully opaque. For a varied edge, use its most common corner color.
  const counts = new Map<number, number>();
  for (const index of corners) {
    const color = rgb(pixels, index * 4);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const background = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? first;
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;
  const limit = tolerance * tolerance * 3;
  const visit = (index: number): void => {
    if (visited[index]) return;
    visited[index] = 1;
    const offset = index * 4;
    if (pixels[offset + 3] === 255 && colorDistance(rgb(pixels, offset), background) <= limit) queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { visit(y * width); visit(y * width + width - 1); }
  let transparentPixels = 0;
  while (head < tail) {
    const index = queue[head++] ?? 0;
    pixels[index * 4] = 0;
    pixels[index * 4 + 1] = 0;
    pixels[index * 4 + 2] = 0;
    pixels[index * 4 + 3] = 0;
    transparentPixels += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) visit(index - 1);
    if (x + 1 < width) visit(index + 1);
    if (y > 0) visit(index - width);
    if (y + 1 < height) visit(index + width);
  }
  return { image: result, transparentPixels };
}

export function cropContent(image: PngImage): { image: PngImage; bounds: Bounds } {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    if ((image.pixels[(y * image.width + x) * 4 + 3] ?? 0) < 128) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error("PNG has no visible content after background removal");
  const width = right - left + 1;
  const height = bottom - top + 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const source = ((top + y) * image.width + left) * 4;
    pixels.set(image.pixels.subarray(source, source + width * 4), y * width * 4);
  }
  return { image: { width, height, pixels }, bounds: { x: left, y: top, width, height } };
}

export function downsample(image: PngImage, targetHeight: number): PngImage {
  if (!Number.isSafeInteger(targetHeight) || targetHeight < 1 || targetHeight > image.height) throw new Error("height must be between 1 and cropped image height");
  const width = Math.max(1, Math.round(image.width * targetHeight / image.height));
  const pixels = new Uint8Array(width * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) for (let x = 0; x < width; x += 1) {
    const x0 = Math.floor(x * image.width / width);
    const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * image.width / width));
    const y0 = Math.floor(y * image.height / targetHeight);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * image.height / targetHeight));
    const frequencies = new Map<number, { count: number; alpha: number }>();
    let transparent = 0;
    for (let sy = y0; sy < y1; sy += 1) for (let sx = x0; sx < x1; sx += 1) {
      const offset = (sy * image.width + sx) * 4;
      const alpha = image.pixels[offset + 3] ?? 0;
      if (alpha < 128) { transparent += 1; continue; }
      const color = rgb(image.pixels, offset);
      const entry = frequencies.get(color) ?? { count: 0, alpha };
      entry.count += 1;
      frequencies.set(color, entry);
    }
    if (transparent * 2 >= (x1 - x0) * (y1 - y0)) continue;
    const selected = [...frequencies].sort((a, b) => b[1].count - a[1].count || a[0] - b[0])[0];
    if (!selected) continue;
    const [color, entry] = selected;
    const target = (y * width + x) * 4;
    pixels[target] = (color >>> 16) & 255;
    pixels[target + 1] = (color >>> 8) & 255;
    pixels[target + 2] = color & 255;
    pixels[target + 3] = entry.alpha;
  }
  return { width, height: targetHeight, pixels };
}

export function cleanAlpha(image: PngImage): PngImage {
  const result = copy(image);
  for (let offset = 0; offset < result.pixels.length; offset += 4) {
    const opaque = (result.pixels[offset + 3] ?? 0) >= 128;
    result.pixels[offset + 3] = opaque ? 255 : 0;
    if (!opaque) result.pixels.fill(0, offset, offset + 3);
  }
  return result;
}

interface ColorCount { color: number; count: number }

function channels(color: number): [number, number, number] {
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
}

function representative(colors: ColorCount[]): number {
  const count = colors.reduce((total, entry) => total + entry.count, 0);
  const values = [0, 1, 2].map((channel) => Math.round(colors.reduce((total, entry) => total + (channels(entry.color)[channel] ?? 0) * entry.count, 0) / count));
  return ((values[0] ?? 0) << 16) | ((values[1] ?? 0) << 8) | (values[2] ?? 0);
}

export function reducePalette(image: PngImage, maxColors: number): PngImage {
  if (!Number.isSafeInteger(maxColors) || maxColors < 1) throw new Error("colors must be a positive integer");
  const histogram = new Map<number, number>();
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (image.pixels[offset + 3] !== 255) continue;
    const color = rgb(image.pixels, offset);
    histogram.set(color, (histogram.get(color) ?? 0) + 1);
  }
  if (histogram.size <= maxColors) return copy(image);
  const entries = [...histogram].map(([color, count]) => ({ color, count })).sort((a, b) => a.color - b.color);
  const darkest = [...entries].sort((a, b) => {
    const ca = channels(a.color); const cb = channels(b.color);
    return (ca[0] * 299 + ca[1] * 587 + ca[2] * 114) - (cb[0] * 299 + cb[1] * 587 + cb[2] * 114) || a.color - b.color;
  })[0]?.color ?? 0;
  const saturation = (color: number): number => { const c = channels(color); return Math.max(...c) - Math.min(...c); };
  const vivid = [...entries].sort((a, b) => saturation(b.color) - saturation(a.color) || a.color - b.color)[0]?.color ?? darkest;
  const anchors = [darkest];
  if (maxColors > 1 && vivid !== darkest) anchors.push(vivid);
  const remaining = entries.filter((entry) => !anchors.includes(entry.color));
  const boxes: ColorCount[][] = remaining.length ? [remaining] : [];
  while (boxes.length < maxColors - anchors.length) {
    let chosen = -1;
    let chosenRange = -1;
    let chosenChannel = 0;
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index] ?? [];
      if (box.length < 2) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        let minimum = 255;
        let maximum = 0;
        for (const entry of box) {
          const value = channels(entry.color)[channel] ?? 0;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
        const range = maximum - minimum;
        if (range > chosenRange) { chosen = index; chosenRange = range; chosenChannel = channel; }
      }
    }
    if (chosen < 0) break;
    const box = (boxes[chosen] ?? []).sort((a, b) => (channels(a.color)[chosenChannel] ?? 0) - (channels(b.color)[chosenChannel] ?? 0) || a.color - b.color);
    const half = box.reduce((total, entry) => total + entry.count, 0) / 2;
    let sum = 0;
    let split = 1;
    while (split < box.length - 1 && sum + (box[split - 1]?.count ?? 0) < half) { sum += box[split - 1]?.count ?? 0; split += 1; }
    boxes.splice(chosen, 1, box.slice(0, split), box.slice(split));
  }
  const palette = [...new Set([...anchors, ...boxes.map(representative)])];
  const result = copy(image);
  for (let offset = 0; offset < result.pixels.length; offset += 4) {
    if (result.pixels[offset + 3] !== 255) continue;
    const original = rgb(result.pixels, offset);
    const selected = anchors.includes(original) ? original : [...palette].sort((a, b) => colorDistance(original, a) - colorDistance(original, b) || a - b)[0] ?? original;
    result.pixels[offset] = (selected >>> 16) & 255;
    result.pixels[offset + 1] = (selected >>> 8) & 255;
    result.pixels[offset + 2] = selected & 255;
  }
  return result;
}

export function removeIsolatedPixels(image: PngImage): PngImage {
  const result = copy(image);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const offset = (y * image.width + x) * 4;
    if (image.pixels[offset + 3] !== 255) continue;
    let neighbor = false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < image.width && ny < image.height && image.pixels[(ny * image.width + nx) * 4 + 3] === 255) neighbor = true;
    }
    if (!neighbor) result.pixels.fill(0, offset, offset + 4);
  }
  return result;
}

export function scaleNearest(image: PngImage, scale: number): PngImage {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new Error("preview-scale must be a positive integer");
  const width = image.width * scale;
  const height = image.height * scale;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    pixels.set(image.pixels.subarray((Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4, (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4 + 4), (y * width + x) * 4);
  }
  return { width, height, pixels };
}

export function makeCheck(preview: PngImage): PngImage {
  const gap = 8;
  const width = preview.width * 2 + gap;
  const pixels = new Uint8Array(width * preview.height * 4);
  for (let y = 0; y < preview.height; y += 1) for (let x = 0; x < width; x += 1) {
    const shade = x < preview.width ? 232 : x >= preview.width + gap ? 40 : 128;
    const offset = (y * width + x) * 4;
    pixels.set([shade, shade, shade, 255], offset);
    if (x >= preview.width && x < preview.width + gap) continue;
    const sourceX = x < preview.width ? x : x - preview.width - gap;
    const source = (y * preview.width + sourceX) * 4;
    if (preview.pixels[source + 3] === 255) pixels.set(preview.pixels.subarray(source, source + 4), offset);
  }
  return { width, height: preview.height, pixels };
}

export function paletteHex(image: PngImage): string[] {
  const colors = new Set<number>();
  for (let offset = 0; offset < image.pixels.length; offset += 4) if (image.pixels[offset + 3] === 255) colors.add(rgb(image.pixels, offset));
  return [...colors].sort((a, b) => a - b).map((color) => `#${color.toString(16).padStart(6, "0")}`);
}
