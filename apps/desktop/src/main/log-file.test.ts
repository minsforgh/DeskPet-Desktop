import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogFile } from "./log-file.js";

let dir: string;
const fixed = (): Date => new Date("2026-10-08T01:02:03.000Z");
const read = (name = "deskpet.log"): string => readFileSync(join(dir, name), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-file-"));
  for (const level of ["debug", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("createLogFile", () => {
  test("writes one line per call and still prints to the console", () => {
    const logger = createLogFile({ dir: join(dir, "logs"), now: fixed });
    logger.info("hello", 3);
    logger.warn("careful");
    expect(readFileSync(join(dir, "logs", "deskpet.log"), "utf8")).toBe(
      "2026-10-08T01:02:03.000Z INFO hello 3\n2026-10-08T01:02:03.000Z WARN careful\n");
    expect(console.info).toHaveBeenCalledWith("hello", 3);
    expect(console.warn).toHaveBeenCalledWith("careful");
  });

  test("masks query secrets, tokens and cookies before writing", () => {
    const logger = createLogFile({ dir, now: fixed });
    logger.info("GET https://a.test/x?token=QSECRET&page=2 Bearer abc.def");
    logger.info("Cookie: sid=COOKIEVAL");
    logger.info("[plugin:x] Authorization: AUTHVAL");
    logger.info("got Set-Cookie: sid=COOKIEVAL2; Path=/");
    const text = read();
    expect(text).not.toMatch(/QSECRET|abc\.def|COOKIEVAL|AUTHVAL/);
    expect(text).toContain("page=2");
  });

  test("flattens newlines and truncates long lines", () => {
    const logger = createLogFile({ dir, now: fixed });
    logger.error(`a\nb\r\nc ${"x".repeat(5000)}`);
    const lines = read().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ERROR a b c /);
    expect(Buffer.byteLength(lines[0] ?? "")).toBeLessThanOrEqual(2048 + 40);
  });

  test("rotates before exceeding maxBytes and keeps only `keep` old files", () => {
    const logger = createLogFile({ dir, maxBytes: 200, keep: 2, now: fixed });
    for (let i = 0; i < 20; i += 1) logger.info(`line-${i} ${"y".repeat(40)}`);
    expect(readdirSync(dir).sort()).toEqual(["deskpet.1.log", "deskpet.2.log", "deskpet.log"]);
    for (const name of readdirSync(dir)) expect(Buffer.byteLength(read(name))).toBeLessThanOrEqual(200);
    expect(read()).toContain("line-19");
    expect(read("deskpet.1.log")).not.toContain("line-0 ");
  });

  test("swallows write errors and warns once", () => {
    writeFileSync(join(dir, "blocked"), "file");
    const logger = createLogFile({ dir: join(dir, "blocked", "logs"), now: fixed });
    expect(() => { logger.info("a"); logger.info("b"); }).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(2);
  });
});
