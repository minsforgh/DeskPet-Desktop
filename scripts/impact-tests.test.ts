import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findImpact, safeRepoFile } from "./impact-tests.js";

const repo = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function cli(...args: string[]): string {
  return execFileSync(process.env.npm_execpath ?? (process.platform === "win32" ? "pnpm.exe" : "pnpm"),
    ["test:impact", ...args], { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}
function parent(commit: string): string { return execFileSync("git", ["rev-parse", commit + "^"], { cwd: repo, encoding: "utf8" }).trim(); }

test("the historical lineSend change includes the exact-comparison unit test", () => {
  const output = cli("--base", parent("6a2748e"), "--head", "6a2748e");
  expect(output).toContain("unit apps/desktop/src/renderer/voice-panel.test.ts");
  expect(output).toMatch(/선택: unit \d+개, e2e \d+개/u);
});

test("the historical pet window geometry change includes all three repaired e2e files", () => {
  const output = cli("--base", parent("1329ddf"), "--head", "1329ddf", "--run", "--list");
  for (const file of ["content-bounds", "pet", "plugin-badge"]) {
    const selected = output.split(/\r?\n/u).find((line) => line.startsWith("e2e  apps/desktop/e2e/" + file + ".e2e.test.ts"));
    expect(selected).toBeDefined();
    expect(selected).not.toContain("변경된 e2e");
    expect(output).toContain("pnpm test:e2e apps/desktop/e2e/" + file + ".e2e.test.ts");
  }
  expect(output).toMatch(/선택: unit \d+개, e2e (?:[1-4]?\d)개/u);
});

test("an unrelated README edit selects no tests", () => {
  const folder = mkdtempSync(join(tmpdir(), "deskpet-impact-readme-"));
  temporary.push(folder);
  execFileSync("git", ["init", "-q"], { cwd: folder });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: folder });
  writeFileSync(join(folder, "README.md"), "first\n");
  execFileSync("git", ["add", "README.md"], { cwd: folder });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: folder });
  writeFileSync(join(folder, "README.md"), "first\nsecond\n");
  expect(findImpact("HEAD", undefined, folder)).toEqual({ unit: [], e2e: [] });
});

test("workspace aliases and indirect imports reach unit tests", () => {
  const folder = mkdtempSync(join(tmpdir(), "deskpet-impact-alias-"));
  temporary.push(folder);
  execFileSync("git", ["init", "-q"], { cwd: folder });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: folder });
  mkdirSync(join(folder, "packages", "core", "src"), { recursive: true });
  mkdirSync(join(folder, "packages", "core", "src", "v2"));
  mkdirSync(join(folder, "apps", "desktop", "src"), { recursive: true });
  writeFileSync(join(folder, "packages", "core", "package.json"), JSON.stringify({ name: "@deskpet/core",
    exports: { "./v2": { types: "./src/v2/index.ts" } } }));
  writeFileSync(join(folder, "packages", "core", "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(folder, "packages", "core", "src", "v2", "index.ts"), "export const second = 1;\n");
  writeFileSync(join(folder, "apps", "desktop", "src", "bridge.ts"), 'export { value } from "@deskpet/core";\n');
  writeFileSync(join(folder, "apps", "desktop", "src", "bridge.test.ts"), 'import { value } from "./bridge.js";\n');
  writeFileSync(join(folder, "apps", "desktop", "src", "version.test.ts"), 'import { second } from "@deskpet/core/v2";\n');
  execFileSync("git", ["add", "."], { cwd: folder });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: folder });
  writeFileSync(join(folder, "packages", "core", "src", "index.ts"), "export const value = 2;\n");
  writeFileSync(join(folder, "packages", "core", "src", "v2", "index.ts"), "export const second = 2;\n");
  expect(findImpact("HEAD", undefined, folder).unit).toEqual([
    { file: "apps/desktop/src/bridge.test.ts",
      reason: "import: packages/core/src/index.ts ← apps/desktop/src/bridge.ts ← apps/desktop/src/bridge.test.ts" },
    { file: "apps/desktop/src/version.test.ts", reason: "import: packages/core/src/v2/index.ts ← apps/desktop/src/version.test.ts" },
  ]);
});

test("repository paths allow an internal file and reject traversal, absolute paths, and links", () => {
  const folder = mkdtempSync(join(tmpdir(), "deskpet-impact-path-"));
  temporary.push(folder);
  mkdirSync(join(folder, "inside"));
  writeFileSync(join(folder, "inside", "ok.ts"), "export const ok = true;\n");
  expect(safeRepoFile("inside/ok.ts", folder)).toBe(join(folder, "inside", "ok.ts"));
  expect(() => safeRepoFile("../outside.ts", folder)).toThrow();
  expect(() => safeRepoFile(join(folder, "inside", "ok.ts"), folder)).toThrow();
  symlinkSync(join(folder, "inside"), join(folder, "link"), "junction");
  expect(() => safeRepoFile("link/ok.ts", folder)).toThrow();
});
