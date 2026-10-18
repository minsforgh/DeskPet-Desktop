import { describe, expect, test } from "vitest";
import { createPluginClock } from "./clock.js";

describe("createPluginClock", () => {
  test("without the argument it follows the real clock", () => {
    let real = 1_000;
    const now = createPluginClock(["node", "runner.js"], () => real);
    expect(now().getTime()).toBe(1_000);
    real = 5_000;
    expect(now().getTime()).toBe(5_000);
  });

  test("with a valid argument it starts there and advances by real elapsed time", () => {
    let real = 9_000_000;
    const now = createPluginClock(["x", "--plugin-clock=2026-10-08T15:00:00+09:00"], () => real);
    const start = Date.parse("2026-10-08T15:00:00+09:00");
    expect(now().getTime()).toBe(start);
    real += 90_000;
    expect(now().getTime()).toBe(start + 90_000);
  });

  test("an unparsable argument is ignored", () => {
    const now = createPluginClock(["--plugin-clock=not-a-date", "--plugin-clock="], () => 42);
    expect(now().getTime()).toBe(42);
  });
});
