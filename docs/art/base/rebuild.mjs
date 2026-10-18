// Run from the repository root. Fixed, repository-owned paths only; no path arguments.
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

const input = 'docs/art/concepts/2026-10-06-pixel/round2/processed/h96/q2-between-a-p6.sprite.png';
const out = 'docs/art/base';
execFileSync('pnpm', ['sprites:retouch', input, '--palette', `${out}/palette.json`, '--edits', `${out}/edits.json`, '--out', out, '--name', 'base'], { stdio: 'inherit', shell: process.platform === 'win32' });
const { readPng, writePng } = await import('../../../tools/sprite-pipeline/dist/png.js');
const { makeCheck, scaleNearest } = await import('../../../tools/sprite-pipeline/dist/pixelize.js');
const before = readPng(await readFile(input));
const after = readPng(await readFile(`${out}/base.sprite.png`));
const x2 = scaleNearest(after, 2);
const gap = 4;
const width = before.width + gap + after.width;
const pixels = new Uint8Array(width * after.height * 4);
for (let y = 0; y < after.height; y += 1) {
  for (const [image, x] of [[before, 0], [after, before.width + gap]]) {
    pixels.set(image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + x) * 4);
  }
}
await Promise.all([
  writeFile(`${out}/base.x2.png`, writePng(x2)),
  writeFile(`${out}/base.x2.check.png`, writePng(makeCheck(x2))),
  writeFile(`${out}/before-after.png`, writePng(scaleNearest({ width, height: after.height, pixels }, 4))),
]);
