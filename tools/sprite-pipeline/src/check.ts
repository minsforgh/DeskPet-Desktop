import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CHARACTER_PACK_MAX_SHEET_BYTES, CHARACTER_SHEET_MAX_BYTES, inspectSpriteFootFrame, validateCharacterManifest } from "@deskpet/core";
import { readPng, type PngImage } from "./png.js";

export interface CheckIssue { state: string; frame: number | null; reason: string; measured?: number | string; expected?: number | string }
export interface CheckResult { pack: string; ok: boolean; issues: CheckIssue[]; decorations: number }

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== "" && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
}

export async function checkPack(pack: string): Promise<CheckResult> {
  const issues: CheckIssue[] = [];
  let decorations = 0;
  const result = (): CheckResult => ({ pack, ok: issues.length === 0, issues, decorations });
  let root: string;
  try {
    const requested = resolve(pack);
    root = await realpath(requested);
    const parent = await realpath(dirname(requested));
    if (dirname(root) !== parent) throw new Error("Pack folder resolves outside character folder");
    const manifestPath = await realpath(join(root, "manifest.json"));
    if (!inside(root, manifestPath)) throw new Error("Manifest resolves outside pack folder");
  } catch (error) {
    issues.push({ state: "manifest", frame: null, reason: "pack path invalid", measured: String(error) });
    return result();
  }
  let input: unknown;
  try { input = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown; }
  catch (error) {
    issues.push({ state: "manifest", frame: null, reason: "manifest read/parse failed", measured: String(error) });
    return result();
  }
  const validation = validateCharacterManifest(input);
  if (!validation.ok) {
    for (const error of validation.errors) issues.push({ state: "manifest", frame: null, reason: error });
    return result();
  }
  const manifest = validation.value;
  const [width, height] = manifest.cellSize;
  let totalBytes = 0;
  const images = new Map<string, PngImage>();
  for (const [state, config] of Object.entries(manifest.states)) {
    let image = images.get(config.sheet);
    try {
      if (!image) {
        const path = await realpath(join(root, config.sheet));
        if (!inside(root, path)) throw new Error("Sheet resolves outside pack folder");
        const size = (await stat(path)).size;
        if (size > CHARACTER_SHEET_MAX_BYTES) throw new Error("Sheet exceeds 8 MiB file limit");
        totalBytes += size;
        if (totalBytes > CHARACTER_PACK_MAX_SHEET_BYTES) throw new Error("Pack exceeds 64 MiB sheet limit");
        image = readPng(await readFile(path));
        images.set(config.sheet, image);
      }
    } catch (error) {
      issues.push({ state, frame: null, reason: "sheet missing or invalid", measured: String(error) });
      continue;
    }
    const expectedWidth = width * config.frames;
    if (image.width !== expectedWidth || image.height !== height) {
      issues.push({ state, frame: null, reason: "sheet dimensions mismatch",
        measured: `${image.width}x${image.height}`, expected: `${expectedWidth}x${height}` });
      continue;
    }
    for (let frame = 0; frame < config.frames; frame += 1) {
      const checked = inspectSpriteFootFrame({
        pixels: image.pixels, pixelFormat: "rgba", width: image.width, height: image.height,
        cellSize: manifest.cellSize, frames: config.frames, anchor: manifest.anchor,
      }, frame);
      decorations += checked.decorations;
      for (const issue of checked.issues) issues.push({ state, ...issue });
    }
  }
  return result();
}
