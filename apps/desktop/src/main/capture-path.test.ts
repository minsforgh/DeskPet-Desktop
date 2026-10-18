import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { resolveInside } from "./capture-path.js";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "deskpet-capture-path-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "shots"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "target.png"), "");
  // Junctions need no extra privilege on Windows; elsewhere this is a directory symlink.
  await symlink(outside, join(root, "link"), "junction");
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

test("relative and absolute paths inside the folder are accepted", async () => {
  expect(await resolveInside(root, "bubble.png")).toBe(join(root, "bubble.png"));
  expect(await resolveInside(root, "shots/bubble.png")).toBe(join(root, "shots", "bubble.png"));
  expect(await resolveInside(root, join(root, "shots", "..", "bubble.png"))).toBe(join(root, "bubble.png"));
});

test("paths that leave the folder are rejected", async () => {
  await expect(resolveInside(root, "../outside/escape.png")).rejects.toThrow("outside the allowed folder");
  await expect(resolveInside(root, "shots/../../escape.png")).rejects.toThrow("outside the allowed folder");
  await expect(resolveInside(root, join(outside, "escape.png"))).rejects.toThrow("outside the allowed folder");
  await expect(resolveInside(root, "link/escape.png")).rejects.toThrow("outside the allowed folder");
  await expect(resolveInside(root, ".")).rejects.toThrow("outside the allowed folder");
});

test("a missing folder, a directory, and a link in place of the file are rejected", async () => {
  await expect(resolveInside(root, "missing/bubble.png")).rejects.toThrow("ENOENT");
  await expect(resolveInside(root, "shots")).rejects.toThrow("not a regular file");
  await expect(resolveInside(root, "link")).rejects.toThrow("not a regular file");
});
