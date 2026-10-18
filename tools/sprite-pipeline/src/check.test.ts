import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPack } from "./check.js";
import { writePng } from "./png.js";

const characters = resolve(dirname(fileURLToPath(import.meta.url)), "../../../characters");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

type Kind = "valid" | "raised" | "shifted" | "width" | "missing" | "empty" |
  "opaque-speck" | "translucent-speck" | "offset-foot" | "decoration" | "lifted-foot" | "one-lifted-foot";
async function makePack(kind: Kind): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), "deskpet-sprite-test-"));
  temporary.push(pack);
  await mkdir(join(pack, "sheets"));
  const manifest = {
    id: "test", name: "Test", apiVersion: "1", cellSize: [16, 16], anchor: [8, 14], scale: 1,
    states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true } }, fallbacks: {},
  };
  if (kind === "translucent-speck") manifest.anchor = [8, 10];
  await writeFile(join(pack, "manifest.json"), JSON.stringify(manifest));
  if (kind !== "missing") {
    const width = kind === "width" ? 17 : 16;
    const pixels = new Uint8Array(width * 16 * 4);
    const pixel = (x: number, y: number, alpha = 255): void => { pixels[(y * width + x) * 4 + 3] = alpha; };
    if (kind !== "empty") {
      const bottom = ["raised", "opaque-speck", "translucent-speck"].includes(kind) ? 9 : 14;
      const center = ["shifted", "offset-foot"].includes(kind) ? 13 : kind === "one-lifted-foot" ? 12 : 8;
      for (let y = bottom - 4; y <= bottom; y += 1)
        for (let x = center - 1; x <= center + 1; x += 1) pixel(x, y);
      if (kind === "opaque-speck") pixel(8, 14);
      if (kind === "translucent-speck") pixel(8, 14, 1);
      if (kind === "offset-foot") {
        for (let y = 6; y <= 10; y += 1) for (let x = 7; x <= 9; x += 1) pixel(x, y);
      }
      if (kind === "decoration") pixel(1, 1);
      if (kind === "lifted-foot") {
        for (let y = 6; y <= 10; y += 1) for (let x = 5; x <= 7; x += 1) pixel(x, y);
      }
      if (kind === "one-lifted-foot") {
        // Raised shoe ends above the old four-row band, but both feet center on x8.
        for (let y = 7; y <= 10; y += 1) for (let x = 3; x <= 5; x += 1) pixel(x, y);
      }
    }
    await writeFile(join(pack, "sheets", "idle.png"), writePng({ width, height: 16, pixels }));
  }
  return pack;
}

describe("sprite pack checker", () => {
  it.each(["placeholder", "placeholder-alt"])("accepts generated %s pack", async (name) => {
    expect(await checkPack(join(characters, name))).toMatchObject({ ok: true, issues: [] });
  });
  it.each([
    ["raised", "foot y exceeds tolerance", 9],
    ["shifted", "foot x exceeds tolerance", 13],
    ["width", "sheet dimensions mismatch", "17x16"],
    ["missing", "sheet missing or invalid", undefined],
    ["empty", "empty frame", "no body pixels"],
  ] as const)("reports %s as %s", async (kind, reason, measurement) => {
    const result = await checkPack(await makePack(kind));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ state: "idle", frame: kind === "width" || kind === "missing" ? null : 1, reason, ...(measurement === undefined ? {} : { measured: measurement }) })]);
  });
  it.each(["opaque-speck", "translucent-speck", "offset-foot"] as const)("rejects review counterexample %s", async (kind) => {
    const result = await checkPack(await makePack(kind));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      reason: kind === "opaque-speck" ? "발 근처 잡점" :
        kind === "translucent-speck" ? "발 아래 반투명 잔여" : "foot x exceeds tolerance",
    }));
  });
  it.each(["decoration", "lifted-foot"] as const)("accepts %s", async (kind) => {
    expect(await checkPack(await makePack(kind))).toMatchObject({ ok: true, decorations: kind === "decoration" ? 1 : 0 });
  });
  it("includes a raised foot in the eight-row center while rejecting both shifted feet", async () => {
    expect(await checkPack(await makePack("one-lifted-foot"))).toMatchObject({ ok: true, issues: [] });
    const shifted = await checkPack(await makePack("shifted"));
    expect(shifted.issues).toContainEqual(expect.objectContaining({ reason: "foot x exceeds tolerance", measured: 13 }));
  });
  it("rejects a junction pack and a junction sheets folder", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deskpet-junction-"));
    temporary.push(parent);
    const outside = await makePack("valid");
    await symlink(outside, join(parent, "linked"), "junction");
    expect((await checkPack(join(parent, "linked"))).ok).toBe(false);
    const pack = await makePack("valid");
    await rm(join(pack, "sheets"), { recursive: true });
    await symlink(join(outside, "sheets"), join(pack, "sheets"), "junction");
    expect((await checkPack(pack)).ok).toBe(false);
  });
});
