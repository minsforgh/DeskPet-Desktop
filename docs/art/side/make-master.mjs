// 선택한 옆모습 후보(ART-6 candidate-01 의 팔레트 정리본)를 앞모습 기준과 같은 106x192 마스터로 만든다.
// 2배 확대(nearest) 뒤 가로를 106 으로 가운데 맞춤한다(꼬리·포니테일이 잘리지 않게). 옆모습의 발 중심은 몸 중심과 달라서 앞모습의 x40.5 를 따르지 않고 parts-side.json 에 따로 적는다. 다시 실행해도 같은 결과.
// 사용: node docs/art/side/make-master.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readPng, writePng } from "../../../tools/sprite-pipeline/dist/png.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readPng(readFileSync(join(here, "gen/processed/candidate-01/candidate-01.sprite.sprite.png")));
const palette = JSON.parse(readFileSync(join(here, "../base/palette.json"), "utf8")).colors;
const W = 106, H = 192;
if (source.height * 2 !== H) throw new Error(`expected a 96px tall source, got ${source.height}`);
const at = (x, y) => (y * source.width + x) * 4;
// 발(마지막 12줄)의 불투명 픽셀 가로 중심을 구한다.
let min = source.width, max = -1;
for (let y = source.height - 12; y < source.height; y++) for (let x = 0; x < source.width; x++) if (source.pixels[at(x, y) + 3] === 255) { min = Math.min(min, x); max = Math.max(max, x); }
const footCenter = ((min + max + 1) / 2) * 2; // 2배 확대 후의 중심
const offset = Math.floor((W - source.width * 2) / 2);
// 색 보정(앞모습과 의복 색감을 맞춤): 생성 후 팔레트 정리에서 치마와 소매가 어두운 shoe 색으로 배정됐다.
// (1) 신발 위쪽(source 86줄 미만)의 shoe 색을 dress 로 바꾸고,
// (2) 의복 안쪽에 있는 outline 픽셀(위·아래·좌·우 이웃의 3개 이상이 dress/dress-shadow 이고 투명 이웃이 없는 것)을 dress-shadow 로 바꾼다.
const nameOf = new Map(palette.map((c) => [[1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16)).join(","), c.name]));
const rgbOf = new Map(palette.map((c) => [c.name, [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16))]));
const LEG_ROW = 86;
const grid = Array.from({ length: source.height }, (_, y) => Array.from({ length: source.width }, (_, x) => {
  const i = at(x, y);
  if (source.pixels[i + 3] !== 255) return null;
  const name = nameOf.get([...source.pixels.subarray(i, i + 3)].join(","));
  if (!name) throw new Error(`color at ${x},${y} is not in the palette`);
  return name;
}));
const recolored = grid.map((row) => row.slice());
let changedShoe = 0, changedOutline = 0;
for (let y = 0; y < LEG_ROW; y++) for (let x = 0; x < source.width; x++) {
  if (grid[y][x] === "shoe") { recolored[y][x] = "dress"; changedShoe++; }
}
const isDress = (name) => name === "dress" || name === "dress-shadow" || name === "shoe";
for (let y = 1; y < LEG_ROW; y++) for (let x = 1; x < source.width - 1; x++) {
  if (grid[y][x] !== "outline") continue;
  const around = [grid[y - 1][x], grid[y + 1]?.[x], grid[y][x - 1], grid[y][x + 1]];
  if (around.some((name) => name === null || name === undefined)) continue;
  if (around.filter(isDress).length >= 3) { recolored[y][x] = "dress-shadow"; changedOutline++; }
}
const pixels = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.floor((x - offset) / 2), sy = Math.floor(y / 2);
  if (sx < 0 || sx >= source.width) continue;
  const name = recolored[sy][sx];
  if (name === null) continue;
  pixels.set([...rgbOf.get(name), 255], (y * W + x) * 4);
}
writeFileSync(join(here, "side_base.png"), writePng({ width: W, height: H, pixels }));
process.stdout.write(`side_base.png ${W}x${H}, offset ${offset}, foot center ${footCenter + offset}, shoe→dress ${changedShoe}, outline→dress-shadow ${changedOutline}
`);
