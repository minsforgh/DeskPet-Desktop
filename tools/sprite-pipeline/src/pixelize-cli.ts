import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPng, writePng } from "./png.js";
import { cleanAlpha, cropContent, downsample, makeCheck, paletteHex, reducePalette, removeBackground, removeIsolatedPixels, scaleNearest } from "./pixelize.js";

interface Options { input: string; out: string; height: number; colors: number; previewScale: number; removeSpecks: boolean }

function positiveInteger(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} requires a positive integer`);
  return number;
}

function parseArgs(args: string[]): Options {
  let input: string | undefined;
  let out: string | undefined;
  let height = 96;
  let colors = 16;
  let previewScale = 4;
  let removeSpecks = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--no-remove-specks") { removeSpecks = false; continue; }
    if (arg === "--out" || arg === "--height" || arg === "--colors" || arg === "--preview-scale") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--out") out = value;
      else if (arg === "--height") height = positiveInteger(value, arg);
      else if (arg === "--colors") colors = positiveInteger(value, arg);
      else previewScale = positiveInteger(value, arg);
      continue;
    }
    if (arg.startsWith("--") || input) throw new Error(`Unexpected argument: ${arg}`);
    input = arg;
  }
  if (!input || !out) throw new Error("Usage: pnpm sprites:pixelize <input.png> --out <folder> [--height N] [--colors N] [--preview-scale N] [--no-remove-specks]");
  if (parse(input).ext.toLowerCase() !== ".png") throw new Error("Input must be a PNG file");
  return { input, out, height, colors, previewScale, removeSpecks };
}

export async function resolveWorkspacePath(root: string, userPath: string): Promise<string> {
  if (isAbsolute(userPath) || userPath.replaceAll("\\", "/").split("/").includes("..")) throw new Error(`Path must stay inside the workspace: ${userPath}`);
  const rootReal = await realpath(root);
  const target = resolve(rootReal, userPath);
  let existing = target;
  const suffix: string[] = [];
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
  const resolved = join(existing, ...suffix);
  const fromRoot = relative(rootReal, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Path must stay inside the workspace: ${userPath}`);
  return resolved;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const inputPath = await resolveWorkspacePath(root, options.input);
  const outPath = await resolveWorkspacePath(root, options.out);
  const source = readPng(await readFile(inputPath));
  const background = removeBackground(source);
  const cropped = cropContent(background.image);
  const reduced = downsample(cropped.image, options.height);
  const alpha = cleanAlpha(reduced);
  const quantized = reducePalette(alpha, options.colors);
  const sprite = options.removeSpecks ? removeIsolatedPixels(quantized) : quantized;
  const preview = scaleNearest(sprite, options.previewScale);
  const check = makeCheck(preview);
  const palette = paletteHex(sprite);
  await mkdir(outPath, { recursive: true });
  const name = parse(inputPath).name;
  await Promise.all([
    writeFile(join(outPath, `${name}.sprite.png`), writePng(sprite)),
    writeFile(join(outPath, `${name}.preview.png`), writePng(preview)),
    writeFile(join(outPath, `${name}.check.png`), writePng(check)),
    writeFile(join(outPath, `${name}.json`), `${JSON.stringify({ width: sprite.width, height: sprite.height, colors: palette.length, palette, crop: cropped.bounds, transparentPixels: background.transparentPixels }, null, 2)}\n`),
  ]);
  process.stdout.write(`${name}: ${sprite.width}x${sprite.height}, ${palette.length} colors, ${background.transparentPixels} background pixels removed\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
