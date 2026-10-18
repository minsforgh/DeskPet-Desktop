import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { readPng, writePng } from "../../../../tools/sprite-pipeline/dist/png.js";
import { scaleNearest } from "../../../../tools/sprite-pipeline/dist/pixelize.js";

// Fixed repository assets only; this script accepts no input paths.
const scale = 2;
const cellWidth = 320;
const rowHeight = 450;
const groups = [
  { action: "bow", numbers: [1, 2, 3, 4] },
  { action: "curtsy", numbers: [1, 2, 3, 4] },
  { action: "curtsy", numbers: [5, 6, 7, 8] },
  { action: "curtsy", numbers: [9, 10, 11, 12], reference: "curtsy-02" },
];
const width = cellWidth * 5;
const height = rowHeight * groups.length * 2;
const pixels = new Uint8Array(width * height * 4);
const base = readPng(await readFile(new URL("../../base/base_final.png", import.meta.url)));
const glyphs = {
  " ": ["000", "000", "000", "000", "000"],
  "-": ["000", "000", "111", "000", "000"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  E: ["111", "100", "110", "100", "111"],
  O: ["111", "101", "101", "101", "111"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  W: ["101", "101", "101", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
};

function label(text, left, top, shade) {
  for (const [index, character] of [...text].entries()) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Missing label glyph: ${character}`);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 3; x += 1) {
      if (glyph[y][x] !== "1") continue;
      for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        pixels.set([shade, shade, shade, 255], ((top + y * 2 + dy) * width + left + index * 8 + x * 2 + dx) * 4);
      }
    }
  }
}

function draw(source, column, row) {
  const enlarged = scaleNearest(source, scale);
  if (enlarged.width > cellWidth - 16 || enlarged.height > rowHeight - 56) {
    throw new Error("Comparison cell is too small for the source image");
  }
  const left = column * cellWidth + Math.floor((cellWidth - enlarged.width) / 2);
  const top = (row + 1) * rowHeight - 16 - enlarged.height;
  for (let y = 0; y < enlarged.height; y += 1) for (let x = 0; x < enlarged.width; x += 1) {
    const sourceOffset = (y * enlarged.width + x) * 4;
    const targetOffset = ((top + y) * width + left + x) * 4;
    const alpha = enlarged.pixels[sourceOffset + 3];
    if (alpha !== 0 && alpha !== 255) throw new Error("Comparison requires binary alpha");
    if (alpha === 255) pixels.set(enlarged.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
}

for (const [group, { action, numbers, reference }] of groups.entries()) {
  const referenceImage = reference
    ? readPng(await readFile(new URL(`processed/${reference}/${reference}.sprite.png`, import.meta.url)))
    : base;
  const candidates = await Promise.all(numbers.map(async (number) => {
    const name = `${action}-${String(number).padStart(2, "0")}`;
    return readPng(await readFile(new URL(`processed/${name}/${name}.sprite.png`, import.meta.url)));
  }));
  for (const [background, shade] of [232, 40].entries()) {
    const row = group * 2 + background;
    const top = row * rowHeight;
    for (let offset = top * width * 4; offset < (top + rowHeight) * width * 4; offset += 4) {
      pixels.set([shade, shade, shade, 255], offset);
    }
    label(`${action.toUpperCase()} - 2X`, 16, top + 12, 272 - shade);
    for (const [column, source] of [referenceImage, ...candidates].entries()) {
      label(column === 0 ? reference?.toUpperCase() ?? "BASE" : `${action.toUpperCase()}-${String(numbers[column - 1]).padStart(2, "0")}`, column * cellWidth + 16, top + 32, 272 - shade);
      draw(source, column, row);
    }
  }
}

await writeFile(new URL("compare.png", import.meta.url), writePng({ width, height, pixels }));
