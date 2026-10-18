import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "./pixelize-cli.js";
import { makeCheck, scaleNearest } from "./pixelize.js";
import { readPng, writePng } from "./png.js";
import { parseEdits, parsePalette, retouch, summarize } from "./retouch.js";

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let input: string | undefined;
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--palette", "--edits", "--out", "--preview-scale", "--name"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--") || flags.has(arg)) throw new Error(`${arg} requires exactly one value`);
      flags.set(arg, value);
    } else if (arg.startsWith("--") || input) throw new Error(`Unexpected argument: ${arg}`);
    else input = arg;
  }
  const paletteFile = flags.get("--palette");
  const out = flags.get("--out");
  if (!input || !paletteFile || !out) throw new Error("Usage: pnpm sprites:retouch <input.png> --palette <palette.json> [--edits <edits.json>] --out <folder> [--preview-scale N] [--name stem]");
  if (parse(input).ext.toLowerCase() !== ".png") throw new Error("Input must be a PNG file");
  const scale = Number(flags.get("--preview-scale") ?? 4);
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 32) throw new Error("--preview-scale must be an integer from 1 to 32");
  const root = process.cwd();
  const inputPath = await resolveWorkspacePath(root, input);
  const outPath = await resolveWorkspacePath(root, out);
  const palettePath = await resolveWorkspacePath(root, paletteFile);
  const palette = parsePalette(await json(palettePath));
  const source = readPng(await readFile(inputPath));
  if (source.width * source.height * scale * scale > 4_000_000) throw new Error("Preview exceeds 4 million pixels; reduce --preview-scale");
  const editsFile = flags.get("--edits");
  const editsPath = editsFile ? await resolveWorkspacePath(root, editsFile) : undefined;
  const edits = editsPath ? parseEdits(await json(editsPath), palette, source.width, source.height) : [];
  const sprite = retouch(source, palette, edits);
  const preview = scaleNearest(sprite, scale);
  const name = flags.get("--name") ?? parse(inputPath).name;
  if (!name || name === "." || name === ".." || [...name].some((char) => '/\\:*?"<>|'.includes(char) || char.charCodeAt(0) < 32) || name.endsWith(".") || name.endsWith(" ")) throw new Error("--name must be a plain filename stem");
  const summary = summarize(sprite, palette);
  const outputs: [string, Uint8Array | string][] = [
    [`${name}.sprite.png`, writePng(sprite)],
    [`${name}.preview.png`, writePng(preview)],
    [`${name}.check.png`, writePng(makeCheck(preview))],
    [`${name}.json`, `${JSON.stringify(summary, null, 2)}\n`],
  ];
  // Validate existing output leaves too: a safe directory can contain escaping links.
  const targets = await Promise.all(outputs.map(([file]) => resolveWorkspacePath(root, relative(root, join(outPath, file)))));
  if (targets.some((target) => [inputPath, palettePath, editsPath].includes(target))) throw new Error("Output must not overwrite the input sprite, palette, or edits");
  await mkdir(outPath, { recursive: true });
  await Promise.all(outputs.map(([, bytes], index) => writeFile(targets[index] ?? "", bytes)));
  process.stdout.write(`${name}: ${sprite.width}x${sprite.height}, ${summary.colors} colors, ${edits.length} edits\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
