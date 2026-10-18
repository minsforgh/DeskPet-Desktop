import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginEntry } from "./entry-path.js";

const temporary: string[] = [];

async function fixture(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskpet-entry-"));
  temporary.push(folder);
  await mkdir(path.join(folder, "dist"));
  await writeFile(path.join(folder, "manifest.json"), "{}");
  await writeFile(path.join(folder, "dist", "index.js"), "export {};");
  return folder;
}

afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("plugin entry path", () => {
  it("resolves an ordinary entry and rejects escaped paths", async () => {
    const folder = await fixture();
    expect(await resolvePluginEntry(folder, "dist/index.js")).toBe(path.join(folder, "dist", "index.js"));
    for (const entry of ["", "../index.js", "dist/../index.js", "C:relative.js", "C:/absolute.js",
      "/absolute.js", "\\\\server\\share\\index.js", "dist\\index.js", "dist/\0index.js",
      "dist/index.ts", "a".repeat(261) + ".js"]) {
      await expect(resolvePluginEntry(folder, entry)).rejects.toThrow();
    }
  });

  it("rejects directory links and junctions in an entry and plugin folder", async (context) => {
    const folder = await fixture();
    const outside = await fixture();
    try {
      await symlink(path.join(outside, "dist"), path.join(folder, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")) {
        console.warn(`Skipping link test: ${String(error.code)}`);
        context.skip();
        return;
      }
      throw error;
    }
    await expect(resolvePluginEntry(folder, "linked/index.js")).rejects.toThrow();
    await symlink(folder, path.join(outside, "folder-link"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolvePluginEntry(path.join(outside, "folder-link"), "dist/index.js")).rejects.toThrow();
  });

  it("rejects a linked manifest", async (context) => {
    const folder = await fixture();
    const outside = await fixture();
    await rm(path.join(folder, "manifest.json"));
    try {
      await symlink(path.join(outside, "manifest.json"), path.join(folder, "manifest.json"));
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")) {
        console.warn(`Skipping file link test: ${String(error.code)}`);
        context.skip();
        return;
      }
      throw error;
    }
    await expect(resolvePluginEntry(folder, "dist/index.js")).rejects.toThrow();
  });
});
