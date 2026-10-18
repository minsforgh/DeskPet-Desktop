// Fixed, repository-owned inputs; no caller-supplied paths. Reuse the selected pixelize results.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readPng, writePng } from "../../../tools/sprite-pipeline/dist/png.js";
import { scaleNearest } from "../../../tools/sprite-pipeline/dist/pixelize.js";

const here = dirname(fileURLToPath(import.meta.url));
const palette = JSON.parse(readFileSync(join(here, "../base/palette.json"), "utf8")).colors;
const rgb = new Map(palette.map(({ name, hex }) => [name, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))]));
const variants = [
  { name: "bow", source: "master-bow-h88/bow-03", width: 106, legRow: 76, center: 40.5,
    map: ["outline", "outline", "dress-shadow", "dress", "ribbon", "dress", "hair-shadow", "hair-shadow", "hair-shadow", "hair-mid", "hair-mid", "hair-light", "hair-light", "apron-shadow", "skin", "apron"],
    face: [16, 20, 28, 24], head: [9, 0, 30, 26], upperEnd: 52 },
  { name: "curtsy", source: "master-curtsy-h94/curtsy-12", width: 130, legRow: 84, center: 64.5,
    map: ["outline", "outline", "outline", "dress-shadow", "dress", "eye", "stocking", "hair-shadow", "hair-shadow", "hair-mid", "apron-shadow", "hair-light", "hair-light", "skin", "apron", "apron"],
    face: [21, 18, 32, 24], head: [16, 0, 37, 26], upperEnd: 52 },
];
const masters = [];
for (const variant of variants) {
  const { name, width, legRow } = variant;
  const source = readPng(readFileSync(join(here, `gen/processed/${variant.source}.sprite.png`)));
  const metadata = JSON.parse(readFileSync(join(here, `gen/processed/${variant.source}.json`), "utf8"));
  const sourceColors = metadata.palette;
  const mapping = new Map(sourceColors.map((hex, i) => [hex.toLowerCase(), variant.map[i]]));
  const grid = Array.from({ length: source.height }, (_, y) => Array.from({ length: source.width }, (_, x) => {
    const at = (y * source.width + x) * 4;
    if (source.pixels[at + 3] === 0) return null;
    if (source.pixels[at + 3] !== 255) throw new Error("Nonbinary source alpha");
    const hex = `#${[...source.pixels.subarray(at, at + 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const color = mapping.get(hex);
    if (!color) throw new Error(`Unmapped source color ${hex}`);
    return color;
  }));
  let cleaned = 0;
  // Remove detached one-cell flecks, preserving attached ear tips and shoe contours.
  const before = grid.map((row) => row.slice());
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (!before[y][x]) continue;
    const connected = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && before[y + dy]?.[x + dx]));
    if (!connected) { grid[y][x] = null; cleaned++; }
    // Keep legs distinct from the navy fabric; shoes use the base shoe material.
    if (y >= legRow && grid[y][x] && grid[y][x] !== "outline") grid[y][x] = y >= source.height - 5 ? "shoe" : "stocking";
  }
  // White cloth and hair are separate materials even when their input shades are similar.
  for (let y = 27; y < legRow; y++) for (let x = 0; x < source.width; x++) {
    const apron = name === "bow" ? x >= 12 && x <= 29 && y >= 35 : x >= 12 && x <= 41 && y >= 39;
    if (apron && grid[y][x] === "hair-light") grid[y][x] = "apron-shadow";
  }
  let clothSpecks = 0;
  const cloth = grid.map((row) => row.slice());
  for (let y = 40; y < legRow - 2; y++) for (let x = 1; x < source.width - 1; x++) {
    if (cloth[y][x] !== "apron-shadow") continue;
    const around = [cloth[y - 1][x], cloth[y + 1][x], cloth[y][x - 1], cloth[y][x + 1]];
    if (around.every((color) => color === "apron")) { grid[y][x] = "apron"; clothSpecks++; }
  }
  if (name === "bow") {
    // Replace the dark triangular neck mark with a small horizontal bow below the face.
    for (let y = 24; y <= 28; y++) for (let x = 19; x <= 24; x++) {
      grid[y][x] = y === 24 ? "skin" : "apron";
    }
    for (const [x, y] of [[20, 27], [24, 27], [20, 28], [21, 28], [22, 28], [23, 28], [24, 28], [20, 29], [24, 29]]) grid[y][x] = "ribbon";
    // Close transparent notches inside the ponytail's lower mass, not the arm-to-hair gap.
    for (let y = 26; y <= 39; y++) {
      const start = y < 30 ? 30 : y < 34 ? 32 : 34;
      const end = y < 30 ? 42 : y < 34 ? 39 : 37;
      for (let x = start; x <= end; x++) if (!grid[y][x]) grid[y][x] = x === start || x === end ? "hair-shadow" : "hair-mid";
    }
  }
  let min = source.width, max = -1;
  for (let y = legRow; y < source.height; y++) for (let x = 0; x < source.width; x++) if (grid[y][x]) { min = Math.min(min, x); max = Math.max(max, x); }
  const offsetX = variant.center - (min + max + 0.5);
  const offsetY = 192 - source.height * 2;
  if (!Number.isInteger(offsetX)) throw new Error("Foot alignment requires a whole pixel offset");
  const pixels = new Uint8Array(width * 192 * 4);
  const put = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= 192) throw new Error(`${name}: content exceeds canvas; stop instead of clipping`);
    pixels.set([...rgb.get(color), 255], (y * width + x) * 4);
  };
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (grid[y][x]) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(x * 2 + offsetX + dx, y * 2 + offsetY + dy, grid[y][x]);
  }
  // Restore a one-master-pixel contour where bright head pixels touched transparency.
  let contour = 0;
  const unlined = pixels.slice();
  const headBox = variant.head;
  for (let y = offsetY; y < (headBox[3] + 1) * 2 + offsetY; y++) for (let x = headBox[0] * 2 + offsetX; x < (headBox[2] + 1) * 2 + offsetX; x++) {
    const at = (y * width + x) * 4;
    if (!unlined[at + 3] || unlined[at] < 140) continue;
    const edge = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => y + dy < 0 || !unlined[((y + dy) * width + x + dx) * 4 + 3]);
    if (edge) { put(x, y, "outline"); contour++; }
  }
  // Preserve the eye silhouette, giving both irises the same blue material.
  if (name === "curtsy") {
    for (let y = 44; y < 46; y++) for (let x = 52; x < 54; x++) put(x, y, "eye");
    const mx = 26 * 2 + offsetX, my = 23 * 2 + offsetY;
    for (let y = my - 2; y <= my + 1; y++) for (let x = mx - 2; x < mx + 6; x++) put(x, y, "skin");
    // Neutral four-pixel mouth: lift only the two endpoints by one master pixel.
    for (let i = 0; i < 4; i++) put(mx + i, my - (i === 0 || i === 3 ? 1 : 0), "mouth");
    // Add four pixels of headroom without resizing the face or moving the feet.
    // Translate the head, then shorten the torso by four rows before the hand line.
    const original = pixels.slice();
    pixels.fill(0);
    for (let y = 0; y < 192; y++) {
      const targetY = y < 72 ? y + 4 : y < 108 ? y + Math.round(4 * (108 - y) / 36) : y;
      if (targetY < 192) pixels.set(original.subarray(y * width * 4, (y + 1) * width * 4), targetY * width * 4);
    }
  }
  const image = { width, height: 192, pixels };
  writeFileSync(join(here, `${name}_base.png`), writePng(image));
  const headroom = name === "curtsy" ? 4 : 0;
  const box = ([x0, y0, x1, y1]) => [x0 * 2 + offsetX, y0 * 2 + offsetY + headroom, x1 * 2 + offsetX + 1, y1 * 2 + offsetY + headroom + 1];
  const parts = {
    $comment: "Inclusive master-pixel boxes. The upper region includes hair and hands; legs remain fixed.",
    image: `${name}_base.png`, size: [width, 192],
    parts: {
      head: { box: box(variant.head), note: "Head including ears; excludes the long ponytail." },
      face: { box: box(variant.face), note: name === "bow" ? "Closed eyes retained." : "Open blue eyes; mouth endpoints raised one master pixel." },
      upper: { box: [0, 0, width - 1, variant.upperEnd * 2 + offsetY - 1], note: "Head, torso and hands move most; skirt bands follow with smaller lifts." },
      "skirt-middle": { box: [0, variant.upperEnd * 2 + offsetY, width - 1, 147], note: "Middle skirt follows at two thirds of the upper-body lift." },
      "skirt-lower": { box: [0, 148, width - 1, legRow * 2 + offsetY - 1], note: "Hem follows at one third of the upper-body lift; feet stay planted." },
      legs: { box: [min * 2 + offsetX, legRow * 2 + offsetY, max * 2 + offsetX + 1, 191], note: "Fixed legs and shoes, inclusive bounds." },
    }, anchor: { "foot-row": 191, "foot-center-x": variant.center },
  };
  writeFileSync(join(here, `parts-${name}.json`), `${JSON.stringify(parts, null, 2)}\n`);
  const lifts = name === "bow" ? [12, 8, 3, 0, 0, 0, 4, 9, 12] : [8, 6, 2, 0, 0, 0, 1, 3, 6, 8];
  const colorNames = new Map(palette.map(({ name, hex }) => [hex, name]));
  const frames = lifts.map((lift, index) => {
    const ops = [];
    if (lift) {
      const bands = ["upper", "skirt-middle", "skirt-lower"];
      const amounts = [lift, Math.round(lift * 2 / 3), Math.round(lift / 3), 0];
      for (const [bandIndex, region] of bands.entries()) {
        const amount = amounts[bandIndex];
        if (!amount) continue;
        const [x0, y0, x1, seam] = parts.parts[region].box;
        for (let y = y0; y < Math.min(amount, seam + 1); y++) for (let x = x0; x <= x1; x++) {
          if (pixels[(y * width + x) * 4 + 3]) throw new Error(`${name}: lift would clip opaque pixels`);
        }
        ops.push({ type: "shift", region, dx: 0, dy: -amount, note: `Lift ${region} ${amount}px; distribute bending across the skirt.` });
        const gap = amount - amounts[bandIndex + 1];
        if (!gap) continue;
        // Each seam bridges only the difference between adjacent band lifts (at most 4px).
        let x = 0;
        while (x < width) {
          const at = (seam * width + x) * 4;
          if (!pixels[at + 3]) { x++; continue; }
          const hex = `#${[...pixels.subarray(at, at + 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const color = colorNames.get(hex);
          const start = x++;
          while (x < width && [0, 1, 2, 3].every((c) => pixels[(seam * width + x) * 4 + c] === pixels[at + c])) x++;
          ops.push({ type: "rect", region: { x: start, y: seam - amount + 1, width: x - start, height: gap }, color, note: "Bridge adjacent skirt bands with a short material run; preserve transparent gaps." });
        }
      }
    }
    const phase = lift === 0 ? "Hold the full greeting" : index === 0 ? "Enter from the least-bent pose" : index > lifts.lastIndexOf(0) ? "Recover toward idle" : "Lower into the greeting";
    return { note: `${index + 1}: ${phase}; upper body ${lift}px above master, feet unchanged.`, ops };
  });
  const spec = { base: `${name}_base.png`, palette: "../base/palette.json", parts: `parts-${name}.json`, states: { [name]: { fps: 8, frames } } };
  writeFileSync(join(here, `states-${name}.json`), `${JSON.stringify(spec, null, 2)}\n`);
  masters.push(image);
  process.stdout.write(`${name}: ${width}x192, source ${source.width}x${source.height}, offset ${offsetX},${offsetY}, feet ${variant.center}, detached flecks ${cleaned}, cloth specks ${clothSpecks}, contour pixels ${contour}\n`);
}
// Same-scale, foot-aligned inspection: base, bow, curtsy on light and dark backgrounds.
const base = readPng(readFileSync(join(here, "../base/base_final.png")));
const comparison = { width: 396, height: 392, pixels: new Uint8Array(396 * 392 * 4) };
for (let y = 0; y < 392; y++) for (let x = 0; x < 396; x++) comparison.pixels.set([...(y < 192 ? [232, 232, 232] : [40, 40, 40]), 255], (y * 396 + x) * 4);
for (const [index, image] of [base, ...masters].entries()) for (const top of [0, 200]) {
  for (let y = 0; y < 192; y++) for (let x = 0; x < image.width; x++) {
    const at = (y * image.width + x) * 4;
    if (image.pixels[at + 3]) comparison.pixels.set(image.pixels.subarray(at, at + 4), ((y + top) * 396 + index * 132 + x) * 4);
  }
}
writeFileSync(join(here, "masters.compare.png"), writePng(scaleNearest(comparison, 3)));
