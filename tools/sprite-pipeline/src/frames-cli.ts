import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrame, buildStrip, buildStripPreview, parseParts, parseSpecPaths, parseStates, stripPreviewPixels, validateFrame, PREVIEW_MAX_PIXELS } from "./frames.js";
import { resolveWorkspacePath } from "./pixelize-cli.js";
import { readPng, writePng, type PngImage } from "./png.js";
import { parsePalette, retouch } from "./retouch.js";

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--spec", "--out", "--preview-scale"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--") || flags.has(arg)) throw new Error(`${arg} requires exactly one value`);
      flags.set(arg, value);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  const spec = flags.get("--spec");
  const out = flags.get("--out");
  if (!spec || !out) throw new Error("Usage: pnpm sprites:frames --spec <states.json> --out <folder> [--preview-scale N]");
  if (parse(spec).ext.toLowerCase() !== ".json") throw new Error("Spec must be a JSON file");
  const scale = Number(flags.get("--preview-scale") ?? 4);
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 32) throw new Error("--preview-scale must be an integer from 1 to 32");
  const root = process.cwd();
  const specPath = await resolveWorkspacePath(root, spec);
  const outPath = await resolveWorkspacePath(root, out);
  const raw = await json(specPath);
  const paths = parseSpecPaths(raw);
  // Paths inside the spec are relative to the spec file; absolute values, parent
  // traversal beyond the workspace, and escaping links are rejected by real path.
  const specDir = dirname(specPath);
  const resolveSpecFile = (userPath: string): string => {
    if (isAbsolute(userPath)) throw new Error(`Path must stay inside the workspace: ${userPath}`);
    return resolve(specDir, userPath);
  };
  const fromRoot = (absolute: string): string => relative(root, absolute) || ".";
  const basePath = await resolveWorkspacePath(root, fromRoot(resolveSpecFile(paths.base)));
  if (parse(basePath).ext.toLowerCase() !== ".png") throw new Error("spec.base must be a PNG file");
  const palettePath = await resolveWorkspacePath(root, fromRoot(resolveSpecFile(paths.palette)));
  const partsPath = await resolveWorkspacePath(root, fromRoot(resolveSpecFile(paths.parts)));
  const palette = parsePalette(await json(palettePath));
  const parts = parseParts(await json(partsPath));
  const base = readPng(await readFile(basePath));
  if (base.width !== parts.width || base.height !== parts.height) throw new Error(`spec.base is ${base.width}x${base.height} but parts.json size is ${parts.width}x${parts.height}`);
  const states = parseStates(paths.states, palette, parts);
  const clean = retouch(base, palette, []);

  interface Rendered { name: string; fps: number; files: [string, Uint8Array][]; frames: number; notes: { note: string; colors: number }[] }
  const rendered: Rendered[] = [];
  for (const state of states) {
    const files: [string, Uint8Array][] = [];
    const notes: { note: string; colors: number }[] = [];
    const images = state.frames.map((frame, index): PngImage => {
      const image = buildFrame(clean, palette, frame.ops);
      const file = `frame-${String(index + 1).padStart(2, "0")}.png`;
      const where = `state "${state.name}" frame ${index + 1} (${state.name}/${file})`;
      notes.push({ note: frame.note, colors: validateFrame(image, palette, parts, where) });
      files.push([`${state.name}/${file}`, writePng(image)]);
      return image;
    });
    const strip = buildStrip(images);
    if (stripPreviewPixels(strip, scale) > PREVIEW_MAX_PIXELS) throw new Error(`${state.name}.strip preview exceeds ${PREVIEW_MAX_PIXELS} pixels; reduce --preview-scale`);
    files.push([`${state.name}.strip.png`, writePng(strip)]);
    files.push([`${state.name}.strip.preview.png`, writePng(buildStripPreview(strip, scale))]);
    rendered.push({ name: state.name, fps: state.fps, files, frames: state.frames.length, notes });
  }
  const manifest = {
    width: clean.width,
    height: clean.height,
    states: Object.fromEntries(rendered.map((state) => [state.name, { fps: state.fps, frames: state.frames, list: state.notes }])),
  };
  const outputs: [string, Uint8Array | string][] = [...rendered.flatMap((state) => state.files), ["frames.json", `${JSON.stringify(manifest, null, 2)}\n`]];
  // Validate existing output leaves too: a safe directory can contain escaping links.
  const targets = await Promise.all(outputs.map(([file]) => resolveWorkspacePath(root, relative(root, join(outPath, file)))));
  if (targets.some((target) => [specPath, basePath, palettePath, partsPath].includes(target))) throw new Error("Output must not overwrite the spec, base, palette, or parts files");
  await mkdir(outPath, { recursive: true });
  await Promise.all(rendered.map((state) => mkdir(join(outPath, state.name), { recursive: true })));
  await Promise.all(outputs.map(([, bytes], index) => writeFile(targets[index] ?? "", bytes)));
  for (const state of rendered) process.stdout.write(`${state.name}: ${state.frames} frames, ${state.fps} fps, ${clean.width}x${clean.height}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
