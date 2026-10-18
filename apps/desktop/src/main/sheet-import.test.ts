import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ lstat: [] as string[], stat: [] as string[], open: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => { fsCalls.lstat.push(String(args[0])); return actual.lstat(...args); },
    stat: (...args: Parameters<typeof actual.stat>) => { fsCalls.stat.push(String(args[0])); return actual.stat(...args); },
    open: (...args: Parameters<typeof actual.open>) => { fsCalls.open.push(String(args[0])); return actual.open(...args); } };
});

let decodeFails = false;
const decode = vi.fn((bytes: Buffer) => ({
  isEmpty: () => decodeFails,
  getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
  toBitmap: () => Buffer.alloc(bytes.readUInt32BE(16) * bytes.readUInt32BE(20) * 4),
}));
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: (bytes: Buffer) => decode(bytes) } }));
import { inspectSelectedSheet, stateNamePattern, validNewStateName } from "./sheet-import.js";
import { generatedSheetPattern } from "./pack-store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "deskpet-sheet-import-")); decodeFails = false; decode.mockClear();
  fsCalls.lstat = []; fsCalls.stat = []; fsCalls.open = []; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function png(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("state and generated sheet patterns accept and reject their documented forms", () => {
  for (const name of ["bow", "a", "a-1", "a".repeat(32)]) expect(validNewStateName(name)).toBe(true);
  for (const name of ["", "Bow", "1bow", "a_1", "a".repeat(33), "constructor", "prototype", "__proto__", "../bow"])
    expect(validNewStateName(name)).toBe(false);
  expect(stateNamePattern.test("bow")).toBe(true);
  for (const path of ["sheets/bow-1234abcd.png", "sheets/a-00000000.png"])
    expect(generatedSheetPattern.test(path)).toBe(true);
  for (const path of ["sheets/bow.png", "sheets/Bow-1234abcd.png", "sheets/bow-1234abcg.png", "../sheets/bow-1234abcd.png"])
    expect(generatedSheetPattern.test(path)).toBe(false);
});

test("selected file rejects links, directories and oversized content before decode", async () => {
  const target = join(root, "target.png");
  await writeFile(target, png());
  const linkedFolder = join(root, "linked");
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real", "target.png"), png());
  await symlink(join(root, "real"), linkedFolder, "junction");
  for (const path of [join(linkedFolder, "target.png"), root])
    await expect(inspectSelectedSheet(path, [1, 1], [0, 0], 1)).rejects.toThrow();
  const large = join(root, "large.png");
  await writeFile(large, Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(inspectSelectedSheet(large, [1, 1], [0, 0], 1)).rejects.toThrow("8 MiB");
  expect(decode).not.toHaveBeenCalled();
});

test("PNG header, dimensions and pixel ceiling precede native decode", async () => {
  const path = join(root, "sheet.png");
  for (const bytes of [Buffer.alloc(33), png(2, 1), png(4097, 4097)]) {
    await writeFile(path, bytes);
    await expect(inspectSelectedSheet(path, [1, 1], [0, 0], 1)).rejects.toThrow();
  }
  expect(decode).not.toHaveBeenCalled();
});

test("decode failure rejects a valid header", async () => {
  const path = join(root, "sheet.png");
  await writeFile(path, png());
  decodeFails = true;
  await expect(inspectSelectedSheet(path, [1, 1], [0, 0], 1)).rejects.toThrow("디코드");
  expect(decode).toHaveBeenCalledOnce();
});

test("lstat, stat and open use the same normalized path as the component check", async () => {
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "target.png"), png());
  const raw = `${root}${sep}sub${sep}..${sep}target.png`;
  await inspectSelectedSheet(raw, [1, 1], [0, 0], 1);
  const normalized = resolve(raw);
  expect(fsCalls.lstat.at(-1)).toBe(normalized);
  expect(fsCalls.stat).toEqual([normalized]);
  expect(fsCalls.open).toEqual([normalized]);
  expect([...fsCalls.lstat, ...fsCalls.stat, ...fsCalls.open].some((path) => path.includes(`${sep}..${sep}`))).toBe(false);
});
