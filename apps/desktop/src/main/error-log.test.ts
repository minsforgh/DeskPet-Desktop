import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createErrorLog, describeError } from "./error-log.js";
import { maskErrorText } from "./log-mask.js";

let dir: string;
let clock: number;
const home = "C:\\Users\\Alice Kim";
const make = (extra: Partial<Parameters<typeof createErrorLog>[0]> = {}) =>
  createErrorLog({ dir, home, now: () => new Date(clock), ...extra });
const lines = (name = "errors.log"): string[] => readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "error-log-"));
  clock = Date.parse("2026-10-10T00:00:00.000Z");
  for (const level of ["debug", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("maskErrorText", () => {
  const token = "a1b2c3d4".repeat(8);
  test("hides 64-hex tokens but keeps shorter hex", () => {
    expect(maskErrorText(`token ${token} id deadbeef`, undefined)).toBe("token *** id deadbeef");
    expect(maskErrorText(`${token}${token}`, undefined)).toBe("***");
  });
  test("replaces the home folder with ~ in every spelling, ignoring case", () => {
    expect(maskErrorText("at C:\\Users\\Alice Kim\\Desktop\\a.js:1", home)).toBe("at ~\\Desktop\\a.js:1");
    expect(maskErrorText("file:///c:/users/alice kim/x.js", home)).toBe("file:///~/x.js");
    expect(maskErrorText("{\"p\":\"C:\\\\Users\\\\Alice Kim\\\\x\"}", home)).toBe("{\"p\":\"~\\\\x\"}");
    expect(maskErrorText("C:\\Users\\Bob\\x", home)).toBe("C:\\Users\\Bob\\x");
  });
  test("an empty home changes nothing", () => { expect(maskErrorText("C:\\Users\\a", "")).toBe("C:\\Users\\a"); });
});

describe("createErrorLog", () => {
  test("writes ISO time, level, category and message on one line, masked", () => {
    const log = make();
    const token = "0123456789abcdef".repeat(4);
    log.record("main:uncaughtException",
      `Error: boom ${token}\n    at f (C:\\Users\\Alice Kim\\app\\x.js:1:1)\nAuthorization: Bearer SECRETVALUE\nGET /a?token=QS&k=1`);
    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^2026-10-10T00:00:00\.000Z ERROR main:uncaughtException Error: boom \*\*\* /);
    expect(written[0]).toContain("~\\app\\x.js");
    expect(written[0]).not.toMatch(/SECRETVALUE|QS|Alice|0123456789abcdef/);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("keeps stack text up to 8 KiB and cuts the rest", () => {
    make().record("renderer:error", "x".repeat(20_000));
    const [line] = lines();
    expect(Buffer.byteLength(line ?? "")).toBeLessThanOrEqual(8 * 1024 + 80);
    expect(Buffer.byteLength(line ?? "")).toBeGreaterThan(4 * 1024);
  });

  test("rotates and keeps errors.1-3.log (4 files)", () => {
    const log = make({ maxBytes: 600, maxLinesPerWindow: 10_000 });
    for (let index = 0; index < 60; index += 1) log.record("child:gone", `n${index} ${"z".repeat(100)}`);
    expect(readdirSync(dir).sort()).toEqual(["errors.1.log", "errors.2.log", "errors.3.log", "errors.log"]);
    expect(readFileSync(join(dir, "errors.log"), "utf8").length).toBeLessThan(900);
  });

  test("folds identical records inside a minute into one summary line", () => {
    const log = make();
    expect(log.record("renderer:error", "same")).toBe(1);
    clock += 1000;
    expect(log.record("renderer:error", "same")).toBe(2);
    expect(log.record("renderer:error", "same")).toBe(3);
    expect(lines()).toHaveLength(1);
    log.record("renderer:error", "other");
    expect(lines()).toHaveLength(3);
    expect(lines()[1]).toContain("(×2 반복) same");
  });

  test("flush writes an open summary; the count restarts after the window", () => {
    const log = make();
    log.record("plugin:exit", "id=jungle code=1");
    log.record("plugin:exit", "id=jungle code=1");
    log.flush();
    expect(lines().at(-1)).toContain("(×1 반복)");
    clock += 61_000;
    expect(log.record("plugin:exit", "id=jungle code=1")).toBe(1);
  });

  test("caps lines per window and reports how many were dropped", () => {
    const log = make({ maxLinesPerWindow: 3 });
    for (let index = 0; index < 8; index += 1) log.record("renderer:error", `distinct ${index}`);
    expect(lines()).toHaveLength(3);
    clock += 61_000;
    log.record("renderer:error", "later");
    const written = lines();
    expect(written.some((line) => line.includes("(×5 생략"))).toBe(true);
    expect(written.at(-1)).toContain("later");
  });

  test("a write failure never throws", () => {
    writeFileSync(join(dir, "blocker"), "x");
    const broken = createErrorLog({ dir: join(dir, "blocker", "nested"), home, now: () => new Date(clock) });
    broken.record("main:uncaughtException", "x");
    expect(() => broken.record("main:uncaughtException", "y")).not.toThrow();
  });
});

describe("describeError", () => {
  test("uses the stack of an Error, strings as they are, and JSON for other values", () => {
    expect(describeError(new Error("e"))).toContain("Error: e");
    expect(describeError("text")).toBe("text");
    expect(describeError({ a: 1 })).toBe("{\"a\":1}");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(typeof describeError(cyclic)).toBe("string");
  });
});
