import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readJsonFile } from "./read-json.js";

const root = await mkdtemp(join(tmpdir(), "deskpet-cli-files-"));
afterAll(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });

test("reads UTF-8 and UTF-16 BOM files", async () => {
  const input = { text: "한글" };
  await writeFile(join(root, "utf8.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(input))]));
  await writeFile(join(root, "utf16.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(input), "utf16le")]));
  expect(await readJsonFile("utf8.json", root)).toEqual(input);
  expect(await readJsonFile("utf16.json", root)).toEqual(input);
});

test("rejects traversal, absolute paths, and links", async () => {
  await writeFile(join(root, "good.json"), "{}");
  await expect(readJsonFile("../good.json", root)).rejects.toThrow();
  await expect(readJsonFile(join(root, "good.json"), root)).rejects.toThrow();
  await symlink(root, join(root, "link"), "junction");
  await expect(readJsonFile("link/good.json", root)).rejects.toThrow();
});
