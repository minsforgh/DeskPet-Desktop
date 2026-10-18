import { parseEdits, parsePalette, retouch, summarize } from "./retouch.js";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPng, writePng, type PngImage } from "./png.js";
import { resolveWorkspacePath } from "./pixelize-cli.js";
import { cleanAlpha, cropContent, downsample, makeCheck, paletteHex, reducePalette, removeBackground, removeIsolatedPixels, scaleNearest } from "./pixelize.js";

// Every root-command test starts pnpm and compiles with tsc. A solo run takes ~2-6 s, but a parallel Electron e2e run
// slowed them past 3x (2026-10-10: 3 of 38 timed out under load, one cleanup hook also timed out); the timeouts below
// are solo measurements times this factor.
const LOAD_FACTOR = 4;

function image(rows: number[][][]): PngImage {
  return { width: rows[0]?.length ?? 0, height: rows.length, pixels: Uint8Array.from(rows.flat(2)) };
}

const pixel = (source: PngImage, x: number, y: number): number[] => [...source.pixels.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4)];
const paletteData = { colors: [{ name: "black", hex: "#000000", role: "outline" }, { name: "white", hex: "#ffffff", role: "light" }] };
const flatImage = (pixels: number[]): PngImage => ({ width: pixels.length / 4, height: 1, pixels: Uint8Array.from(pixels) });
const B = [255, 255, 255, 255];
const R = [200, 0, 0, 255];

// 8x8 frames fixture: red ear rows 0-1 cols 6-7, white body rows 2-5 cols 2-5, black feet rows 6-7 cols 2-5.
const fT = [0, 0, 0, 0];
const fK = [0, 0, 0, 255];
const fW = [255, 255, 255, 255];
const fR = [255, 0, 0, 255];
const framesPaletteData = { colors: [{ name: "black", hex: "#000000", role: "outline" }, { name: "white", hex: "#ffffff", role: "body" }, { name: "red", hex: "#ff0000", role: "accent" }] };
const framesPalette = parsePalette(framesPaletteData);
const framesBase = image([
  [fT, fT, fT, fT, fT, fT, fR, fR],
  [fT, fT, fT, fT, fT, fT, fR, fR],
  [fT, fT, fW, fW, fW, fW, fT, fT],
  [fT, fT, fW, fW, fW, fW, fT, fT],
  [fT, fT, fW, fW, fW, fW, fT, fT],
  [fT, fT, fW, fW, fW, fW, fT, fT],
  [fT, fT, fK, fK, fK, fK, fT, fT],
  [fT, fT, fK, fK, fK, fK, fT, fT],
]);
const framesPartsData = { image: "base.png", size: [8, 8], parts: { ear: { box: [6, 0, 7, 1], note: "ear" }, legs: { box: [0, 6, 7, 7], note: "legs" } }, anchor: { "foot-row": 7, "foot-center-x": 3.5 } };
const framesStates = { blink: { fps: 2, frames: [
  { note: "ear flattened", ops: [{ type: "rect", region: "ear", color: "white", note: "cover ear" }] },
  { note: "rest pose", ops: [] },
] } };

describe("pixelize stages", () => {
  it("floods only the exterior background and crops the remaining bounds", () => {
    const source = image([[B, B, B, B, B], [B, R, R, R, B], [B, R, B, R, B], [B, R, R, R, B], [B, B, B, B, B]]);
    const removed = removeBackground(source);
    expect(removed.transparentPixels).toBe(16);
    expect(pixel(removed.image, 2, 2)).toEqual(B);
    expect(pixel(removed.image, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(cropContent(removed.image).bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    expect(pixel(source, 0, 0)).toEqual(B);
  });

  it("uses the most frequent source color and transparency majority per target cell", () => {
    const T = [0, 0, 0, 0];
    const source = image([[R, R, B, T], [R, B, T, T], [B, B, R, R], [B, R, R, R]]);
    const small = downsample(source, 2);
    expect(pixel(small, 0, 0)).toEqual(R);
    expect(pixel(small, 1, 0)).toEqual(T);
    expect(pixel(small, 0, 1)).toEqual(B);
    expect(pixel(small, 1, 1)).toEqual(R);
  });

  it("thresholds alpha and clears hidden RGB", () => {
    const cleaned = cleanAlpha(image([[[1, 2, 3, 127], [4, 5, 6, 128]]]));
    expect([...cleaned.pixels]).toEqual([0, 0, 0, 0, 4, 5, 6, 255]);
    expect(cropContent(image([[[1, 2, 3, 1], [4, 5, 6, 128]]])).bounds).toEqual({ x: 1, y: 0, width: 1, height: 1 });
  });

  it("caps palette while retaining darkest and most saturated source colors", () => {
    const source = image([[[1, 1, 1, 255], [120, 120, 120, 255], [130, 130, 130, 255], [0, 255, 0, 255], [200, 120, 120, 255]]]);
    const reduced = reducePalette(source, 3);
    expect(paletteHex(reduced)).toHaveLength(3);
    expect(paletteHex(reduced)).toContain("#010101");
    expect(paletteHex(reduced)).toContain("#00ff00");
  });

  it("removes isolated opaque pixels using the original 8-neighborhood", () => {
    const T = [0, 0, 0, 0];
    const source = image([[R, T, T], [T, T, T], [T, R, R]]);
    const result = removeIsolatedPixels(source);
    expect(pixel(result, 0, 0)).toEqual(T);
    expect(pixel(result, 1, 2)).toEqual(R);
  });

  it("scales without blending and composites light and dark checks", () => {
    const source = image([[R, [0, 0, 0, 0]]]);
    const preview = scaleNearest(source, 2);
    expect(pixel(preview, 1, 1)).toEqual(R);
    const check = makeCheck(preview);
    expect(pixel(check, 3, 0)).toEqual([232, 232, 232, 255]);
    expect(pixel(check, preview.width + 8 + 3, 0)).toEqual([40, 40, 40, 255]);
  });
});

describe("root sprites:pack command", () => {
  const folders: string[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) {
      const part = relative(await realpath(process.cwd()), await realpath(folder));
      if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Unsafe test cleanup path");
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
  async function fixture(): Promise<{ folder: string; args: string[] }> {
    const folder = await mkdtemp(join(process.cwd(), "pack-cli-test-"));
    folders.push(folder);
    const source = join(folder, "source");
    await mkdir(join(source, "idle"), { recursive: true });
    const pixels = new Uint8Array(2 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 2; x += 1) pixels[(y * 2 + x) * 4 + 3] = 255;
    await writeFile(join(source, "idle", "frame-01.png"), writePng({ width: 2, height: 4, pixels }));
    await writeFile(join(source, "frames.json"), JSON.stringify({ states: { idle: { fps: 8, frames: 1 } } }));
    await writeFile(join(folder, "spec.json"), JSON.stringify({ id: "test", name: "Test", cellSize: [4, 4], anchor: [2, 3], scale: 1,
      fallbacks: {}, states: { idle: { frames: "source/idle", offsetX: 1, loop: true } } }));
    const local = relative(process.cwd(), folder);
    return { folder, args: ["sprites:pack", "--spec", `${local}/spec.json`, "--out", `${local}/out`] };
  }
  function run(args: string[]): Buffer {
    return execFileSync("pnpm", args, { cwd: process.cwd(), shell: process.platform === "win32", stdio: "pipe" });
  }
  // Windows root command measured at 2.7 s per run; 17.5 s covers two sequential runs and suite load.
  it("runs twice with byte-identical pack files through the documented command", { timeout: 17_500 * LOAD_FACTOR }, async () => {
    const { folder, args } = await fixture();
    run(args);
    const paths = [join(folder, "out", "manifest.json"), join(folder, "out", "sheets", "idle.png")];
    const first = await Promise.all(paths.map((path) => readFile(path)));
    run(args);
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(first);
    expect(JSON.parse(first[0]?.toString() ?? "")).toMatchObject({ states: { idle: { fps: 8, frames: 1 } } });
    expect(readPng(first[1] ?? new Uint8Array()).width).toBe(4);
  });
  // Windows root command measured at 2.7 s; 10 s covers each isolated rejection case.
  it.each(["parent", "absolute", "linked source", "linked output"])("rejects unsafe %s paths through the command", { timeout: 10_000 * LOAD_FACTOR }, async (kind) => {
    const { folder, args } = await fixture();
    if (kind === "parent") args[args.indexOf("--out") + 1] = "../escape";
    if (kind === "absolute") args[args.indexOf("--spec") + 1] = join(folder, "spec.json");
    if (kind === "linked source" || kind === "linked output") {
      const outside = await mkdtemp(join(tmpdir(), "pack-outside-"));
      if (kind === "linked source") {
        const sourcePart = relative(await realpath(folder), await realpath(join(folder, "source")));
        if (sourcePart !== "source") throw new Error("Unsafe source cleanup path");
        await rm(join(folder, "source"), { recursive: true });
        await symlink(outside, join(folder, "source"), "junction");
      } else {
        await symlink(outside, join(folder, "out"), "junction");
      }
      try { expect(() => run(args)).toThrow("inside the workspace"); }
      finally { await rm(outside, { recursive: true, force: true }); }
      return;
    }
    expect(() => run(args)).toThrow("inside the workspace");
  });
});

describe("pixelize command and paths", () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); }, 30_000);

  it("rejects parent, absolute, and linked paths outside the workspace", async () => {
    const root = await mkdtemp(join(process.cwd(), "pixelize-path-test-"));
    const outside = await mkdtemp(join(tmpdir(), "pixelize-outside-"));
    folders.push(root, outside);
    await expect(resolveWorkspacePath(root, "../escape.png")).rejects.toThrow(/inside the workspace/);
    await expect(resolveWorkspacePath(root, outside)).rejects.toThrow(/inside the workspace/);
    await symlink(outside, join(root, "linked"), "junction");
    await expect(resolveWorkspacePath(root, "linked/escape.png")).rejects.toThrow(/inside the workspace/);
  });

  // Windows full-suite measurement with sequential CLI suites: two root pixelize
  // builds took at most 9,649 ms. Use twice that observed cost, rounded to 19.3s.
  it("runs the root command and produces four repeatable files", { timeout: 19_300 * LOAD_FACTOR }, async () => {
    const folder = await mkdtemp(join(process.cwd(), "pixelize-cli-test-"));
    folders.push(folder);
    const input = join(folder, "synthetic.png");
    const T = [0, 0, 0, 0];
    await writeFile(input, writePng(image([[T, T, T, T], [T, R, R, T], [T, R, R, T], [T, T, T, T]])));
    const args = ["sprites:pixelize", relative(process.cwd(), input), "--out", relative(process.cwd(), join(folder, "out")), "--height", "2", "--colors", "2", "--preview-scale", "3"];
    const run = (): void => { execFileSync("pnpm", args, { cwd: process.cwd(), shell: process.platform === "win32", stdio: "pipe" }); };
    run();
    const names = ["sprite.png", "preview.png", "check.png", "json"].map((extension) => join(folder, "out", `synthetic.${extension}`));
    const first = await Promise.all(names.map((name) => readFile(name)));
    expect(readPng(first[0] ?? new Uint8Array()).height).toBe(2);
    expect(readPng(first[1] ?? new Uint8Array()).height).toBe(6);
    expect(JSON.parse((first[3] ?? Buffer.alloc(0)).toString())).toMatchObject({ height: 2, colors: 1, crop: { x: 1, y: 1, width: 2, height: 2 } });
    run();
    const second = await Promise.all(names.map((name) => readFile(name)));
    for (let index = 0; index < names.length; index += 1) expect(second[index]).toEqual(first[index]);
  });
});

// Keep commands that compile the same dist directory in this one sequential test file.
// Running three CLI suites concurrently caused build contention (5.3–7.1s per test on Windows).
// This also avoids multiple compilers writing the same outputs at once.
describe("root sprites:retouch command", () => {
  const folders: { path: string; parent: string }[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) {
      // Cleanup only known mkdtemp roots whose real paths stay in their recorded parent.
      const from = relative(await realpath(folder.parent), await realpath(folder.path));
      if (!from || from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) throw new Error("Unsafe test cleanup");
      await rm(folder.path, { recursive: true, force: true });
    }
  }, 30_000);
  async function fixture(): Promise<{ folder: string; args: string[] }> {
    const folder = await mkdtemp(join(process.cwd(), "retouch-test-"));
    folders.push({ path: folder, parent: process.cwd() });
    await writeFile(join(folder, "input.png"), writePng(flatImage([2, 2, 2, 255, 245, 245, 245, 255])));
    await writeFile(join(folder, "palette.json"), JSON.stringify(paletteData));
    await writeFile(join(folder, "edits.json"), JSON.stringify({ edits: [{ x: 0, y: 0, color: "white", note: "test" }] }));
    const local = relative(process.cwd(), folder);
    return { folder, args: ["sprites:retouch", `${local}/input.png`, "--palette", `${local}/palette.json`, "--edits", `${local}/edits.json`, "--out", `${local}/out`, "--preview-scale", "3"] };
  }
  function run(args: string[]): Buffer {
    // All arguments are fixed test strings or mkdtemp paths, never user/shell input.
    return execFileSync("pnpm", args, { cwd: process.cwd(), shell: process.platform === "win32", stdio: "pipe" });
  }
  // Windows full-suite measurement, sequential root CLI builds: maximum 8,044 ms
  // for this two-invocation test. Allow twice that observed cost, rounded to 16.1s.
  it("runs twice byte-for-byte, with correct statistics and nearest-neighbor checks", { timeout: 16_100 * LOAD_FACTOR }, async () => {
    const { folder, args } = await fixture();
    run(args);
    const files = (await readdir(join(folder, "out"))).sort();
    expect(files).toEqual(["input.check.png", "input.json", "input.preview.png", "input.sprite.png"]);
    const first = await Promise.all(files.map((file) => readFile(join(folder, "out", file))));
    expect(JSON.parse(first[1]?.toString() ?? "{}")).toMatchObject({ width: 2, height: 1, colors: 1, palette: [{ name: "white", pixels: 2 }] });
    const preview = readPng(first[2] ?? new Uint8Array());
    expect([preview.width, preview.height]).toEqual([6, 3]);
    expect([...preview.pixels].every((value) => value === 255)).toBe(true);
    const check = readPng(first[0] ?? new Uint8Array());
    expect([check.width, check.height]).toEqual([20, 3]);
    run(args);
    expect(await Promise.all(files.map((file) => readFile(join(folder, "out", file))))).toEqual(first);
  });
  // Windows solo runs via vitest -t (3 runs over all 6 cases): max 3,724 ms; use ~3x, rounded to 11.2s.
  it.each(["palette", "edits", "coordinates", "json", "scale", "name"])("exits nonzero for invalid %s with a useful diagnostic", { timeout: 11_200 * LOAD_FACTOR }, async (kind) => {
    const { folder, args } = await fixture();
    let expected = "";
    if (kind === "palette") { await writeFile(join(folder, "palette.json"), JSON.stringify({ colors: [{ name: "x", hex: "#xyz", role: "test" }] })); expected = "palette.colors[0].hex"; }
    if (kind === "edits") { await writeFile(join(folder, "edits.json"), JSON.stringify({ edits: [{ x: 0, y: 0, color: "absent", note: "test" }] })); expected = "edits[0].color"; }
    if (kind === "coordinates") { await writeFile(join(folder, "edits.json"), JSON.stringify({ edits: [{ x: 2, y: 0, color: "white", note: "test" }] })); expected = "outside 2x1"; }
    if (kind === "json") { await writeFile(join(folder, "edits.json"), "{"); expected = "edits.json"; }
    if (kind === "scale") { args[args.length - 1] = "1.5"; expected = "--preview-scale"; }
    if (kind === "name") { args.push("--name", "../escape"); expected = "plain filename stem"; }
    expect(() => run(args)).toThrow(expected);
    await expect(readdir(join(folder, "out"))).rejects.toThrow();
  });
  // Windows solo runs via vitest -t (3 runs over all 4 cases): max 2,667 ms; use ~3x, rounded to 8s.
  it.each(["input", "--palette", "--edits", "--out"])("rejects escaping links in %s through the CLI", { timeout: 8_000 * LOAD_FACTOR }, async (flag) => {
    const { folder, args } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "retouch-outside-"));
    folders.push({ path: outside, parent: tmpdir() });
    await symlink(outside, join(folder, "link"), "junction");
    args[flag === "input" ? 1 : args.indexOf(flag) + 1] = `${relative(process.cwd(), folder)}/link/escape`;
    if (flag === "input") args[1] += ".png";
    expect(() => run(args)).toThrow("inside the workspace");
    expect(await readdir(outside)).toEqual([]);
  });
  // Windows solo runs via vitest -t (3 runs over both cases): max 2,407 ms; use ~3x, rounded to 7.2s.
  it.each(["parent", "absolute"])("rejects %s output paths through the CLI", { timeout: 7_200 * LOAD_FACTOR }, async (kind) => {
    const { args } = await fixture();
    args[args.indexOf("--out") + 1] = kind === "parent" ? "../escape" : process.cwd();
    expect(() => run(args)).toThrow("inside the workspace");
  });
  // Windows solo runs via vitest -t (3 runs): max 1,955 ms; use ~3x, rounded to 5.9s.
  it("accepts omitted edits and a custom output name", { timeout: 5_900 * LOAD_FACTOR }, async () => {
    const { folder, args } = await fixture();
    args.splice(args.indexOf("--edits"), 2);
    args.push("--name", "base");
    run(args);
    expect(JSON.parse(await readFile(join(folder, "out/base.json"), "utf8"))).toMatchObject({ colors: 2 });
  });
  // Windows solo runs via vitest -t (3 runs): max 2,103 ms; use ~3x, rounded to 6.3s.
  it("rejects a linked output leaf before writing any output", { timeout: 6_300 * LOAD_FACTOR }, async () => {
    const { folder, args } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "retouch-leaf-"));
    folders.push({ path: outside, parent: tmpdir() });
    await mkdir(join(folder, "out"));
    await symlink(outside, join(folder, "out/input.json"), "junction");
    expect(() => run(args)).toThrow("inside the workspace");
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(folder, "out"))).toEqual(["input.json"]);
  });
  // Windows solo runs via vitest -t (3 runs): max 2,401 ms; use ~3x, rounded to 7.2s.
  it("protects the palette from output name collisions", { timeout: 7_200 * LOAD_FACTOR }, async () => {
    const { folder, args } = await fixture();
    args[args.indexOf("--out") + 1] = relative(process.cwd(), folder);
    args.push("--name", "palette");
    expect(() => run(args)).toThrow("must not overwrite");
    expect(JSON.parse(await readFile(join(folder, "palette.json"), "utf8"))).toEqual(paletteData);
  });
});

describe("root sprites:frames command", () => {
  const folders: { path: string; parent: string }[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) {
      // Cleanup only known mkdtemp roots whose real paths stay in their recorded parent.
      const from = relative(await realpath(folder.parent), await realpath(folder.path));
      if (!from || from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) throw new Error("Unsafe test cleanup");
      await rm(folder.path, { recursive: true, force: true });
    }
  }, 30_000);

  async function framesFixture(specName = "spec.json", states: unknown = framesStates): Promise<{ folder: string; args: string[] }> {
    const folder = await mkdtemp(join(process.cwd(), "frames-test-"));
    folders.push({ path: folder, parent: process.cwd() });
    await writeFile(join(folder, "base.png"), writePng(framesBase));
    await writeFile(join(folder, "palette.json"), JSON.stringify(framesPaletteData));
    await writeFile(join(folder, "parts.json"), JSON.stringify(framesPartsData));
    await writeFile(join(folder, specName), JSON.stringify({ base: "base.png", palette: "palette.json", parts: "parts.json", states }));
    const local = relative(process.cwd(), folder);
    return { folder, args: ["sprites:frames", "--spec", `${local}/${specName}`, "--out", `${local}/out`, "--preview-scale", "2"] };
  }
  function run(args: string[]): Buffer {
    // All arguments are fixed test strings or mkdtemp paths, never user/shell input.
    return execFileSync("pnpm", args, { cwd: process.cwd(), shell: process.platform === "win32", stdio: "pipe" });
  }
  const framesOutputs = (folder: string): string[] => ["blink/frame-01.png", "blink/frame-02.png", "blink.strip.png", "blink.strip.preview.png", "frames.json"].map((file) => join(folder, "out", file));

  // Windows solo runs via vitest -t (3 runs): max 5,825 ms; use ~3x, rounded to 17.5s.
  it("runs twice byte-for-byte through the documented entry point", { timeout: 17_500 * LOAD_FACTOR }, async () => {
    const { folder, args } = await framesFixture();
    run(args);
    const first = await Promise.all(framesOutputs(folder).map((file) => readFile(file)));
    run(args);
    expect(await Promise.all(framesOutputs(folder).map((file) => readFile(file)))).toEqual(first);
    expect((await readdir(join(folder, "out"))).sort()).toEqual(["blink", "blink.strip.png", "blink.strip.preview.png", "frames.json"]);
    expect(JSON.parse((first[4] ?? Buffer.alloc(0)).toString())).toEqual({ width: 8, height: 8, states: { blink: { fps: 2, frames: 2, list: [{ note: "ear flattened", colors: 2 }, { note: "rest pose", colors: 3 }] } } });
    expect(first[1]).toEqual(writePng(retouch(framesBase, framesPalette, [])));
    expect(first[0]).not.toEqual(first[1]);
    const strip = readPng(first[2] ?? new Uint8Array());
    expect([strip.width, strip.height]).toEqual([16, 8]);
    const preview = readPng(first[3] ?? new Uint8Array());
    expect([preview.width, preview.height]).toEqual([32, 40]);
  });

  // Windows solo runs via vitest -t (3 runs): max 3,610 ms; use ~3x, rounded to 10.9s.
  it("exits nonzero naming the state and frame when validation fails", { timeout: 10_900 * LOAD_FACTOR }, async () => {
    const { folder, args } = await framesFixture("spec.json", { blink: { fps: 2, frames: [
      { note: "feet slide right", ops: [{ type: "shift", region: { x: 2, y: 6, width: 4, height: 2 }, dx: 4, dy: 0, note: "slide" }] },
    ] } });
    expect(() => run(args)).toThrow(/blink.*frame 1.*foot center/);
    await expect(readdir(join(folder, "out"))).rejects.toThrow();
  });

  // Windows solo runs via vitest -t (3 runs over all 5 cases): max 13,055 ms; use ~3x, rounded to 39.2s.
  it.each(["out parent", "out absolute", "spec absolute", "spec base escaping", "spec base absolute"])("rejects unsafe %s through the CLI", { timeout: 39_200 * LOAD_FACTOR }, async (kind) => {
    const { folder, args } = await framesFixture();
    if (kind === "out parent") args[args.indexOf("--out") + 1] = "../escape";
    if (kind === "out absolute") {
      const outside = await mkdtemp(join(tmpdir(), "frames-out-"));
      folders.push({ path: outside, parent: tmpdir() });
      args[args.indexOf("--out") + 1] = outside;
    }
    if (kind === "spec absolute") args[args.indexOf("--spec") + 1] = join(folder, "spec.json");
    if (kind === "spec base escaping") await writeFile(join(folder, "spec.json"), JSON.stringify({ base: "../../escape.png", palette: "palette.json", parts: "parts.json", states: framesStates }));
    if (kind === "spec base absolute") await writeFile(join(folder, "spec.json"), JSON.stringify({ base: join(folder, "base.png"), palette: "palette.json", parts: "parts.json", states: framesStates }));
    expect(() => run(args)).toThrow("inside the workspace");
  });

  // Windows solo runs via vitest -t (3 runs): max 3,101 ms; use ~3x, rounded to 9.4s.
  it("protects the spec from output collisions", { timeout: 9_400 * LOAD_FACTOR }, async () => {
    const { folder, args } = await framesFixture("frames.json");
    args[args.indexOf("--out") + 1] = relative(process.cwd(), folder);
    expect(() => run(args)).toThrow("must not overwrite");
  });
});

// Windows solo runs via vitest -t (3 runs): max 2,679 ms; use ~3x, rounded to 8s.
it("rebuilds the reviewed q2 art through its documented entry point with stable bytes and aligned feet", { timeout: 8_000 * LOAD_FACTOR }, async () => {
  const folder = "docs/art/base";
  const names = ["base.sprite.png", "base.preview.png", "base.check.png", "base.json", "base.x2.png", "base.x2.check.png", "before-after.png"];
  const before = await Promise.all(names.map((name) => readFile(`${folder}/${name}`)));
  execFileSync(process.execPath, ["docs/art/base/rebuild.mjs"], { stdio: "pipe" });
  expect(await Promise.all(names.map((name) => readFile(`${folder}/${name}`)))).toEqual(before);
  const sprite = readPng(before[0] ?? new Uint8Array());
  expect([sprite.width, sprite.height]).toEqual([53, 96]);
  const palette = parsePalette(JSON.parse(await readFile(`${folder}/palette.json`, "utf8")) as unknown);
  expect(palette).toHaveLength(15);
  const summary = summarize(sprite, palette);
  expect(summary).toEqual(JSON.parse(before[3]?.toString() ?? "{}"));
  expect(summary.colors).toBeLessThanOrEqual(16);
  expect([...sprite.pixels].filter((_, index) => index % 4 === 3).every((alpha) => alpha === 0 || alpha === 255)).toBe(true);
  const edits = parseEdits(JSON.parse(await readFile(`${folder}/edits.json`, "utf8")) as unknown, palette, 53, 96);
  expect(edits.length).toBeGreaterThan(0);
  expect(edits.every((edit) => !edit.note.includes("???"))).toBe(true);
  const bottom = Array.from({ length: sprite.width }, (_, x) => x).filter((x) => sprite.pixels[(95 * sprite.width + x) * 4 + 3] === 255);
  expect(bottom).toEqual([15, 16, 17, 18, 19, 21, 22, 23, 24, 25]);
  expect([(15 + 19) / 2, (21 + 25) / 2]).toEqual([17, 23]);
  const eye = (left: number): number[] => {
    const pixels: number[] = [];
    for (let y = 18; y <= 21; y += 1) for (let x = left; x < left + 5; x += 1) pixels.push(...sprite.pixels.slice((y * 53 + x) * 4, (y * 53 + x) * 4 + 4));
    return pixels;
  };
  // Each eye must show a pupil: iris blue, the darker pupil navy and a white highlight (user decision 2026-10-06).
  const hexOf = (name: string): string => palette.find((color) => color.name === name)?.hex.toLowerCase() ?? "";
  const hexes = (pixels: number[]): Set<string> => {
    const found = new Set<string>();
    for (let i = 0; i < pixels.length; i += 4) {
      found.add(`#${[0, 1, 2].map((k) => (pixels[i + k] ?? 0).toString(16).padStart(2, "0")).join("")}`);
    }
    return found;
  };
  for (const left of [14, 21]) {
    const colors = hexes(eye(left));
    for (const name of ["eye", "ribbon", "apron", "outline"]) expect(colors.has(hexOf(name))).toBe(true);
  }
  expect(summary.palette.find((color) => color.name === "mouth")?.pixels).toBe(2);
  const source = readPng(await readFile("docs/art/concepts/2026-10-06-pixel/round2/processed/h96/q2-between-a-p6.sprite.png"));
  expect([...sprite.pixels].filter((alpha, index) => index % 4 === 3 && alpha !== source.pixels[index])).toHaveLength(6);
  const x2 = readPng(before[4] ?? new Uint8Array());
  expect([x2.width, x2.height]).toEqual([106, 192]);
  for (let y = 0; y < 192; y += 1) for (let x = 0; x < 106; x += 1) {
    const offset = (Math.floor(y / 2) * 53 + Math.floor(x / 2)) * 4;
    expect(x2.pixels.slice((y * 106 + x) * 4, (y * 106 + x) * 4 + 4)).toEqual(sprite.pixels.slice(offset, offset + 4));
  }
  const readme = await readFile(`${folder}/README.md`, "utf8");
  const links = readme.split("](").slice(1).map((part) => part.slice(0, part.indexOf(")")));
  expect(links).toContain("base.check.png");
  for (const link of links) await access(resolve(folder, link));
});
