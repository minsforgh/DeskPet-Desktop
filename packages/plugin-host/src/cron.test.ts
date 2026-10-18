import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron, InvalidArgumentError } from "./cron.js";

describe("cron", () => {
  it("parses the supported fields and rejects other grammar", () => {
    expect(parseCron("5 9 * * 1-5").days).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * 0,6").days).toEqual([0, 6]);
    for (const value of ["*/5 9 * * *", "60 9 * * *", "1 24 * * *", "1 2 3 * *", "1 2 * * 7", "1 2 * * 5-1"]) {
      expect(() => parseCron(value)).toThrow(InvalidArgumentError);
    }
  });

  it("skips a nonexistent New York wall time and emits an overlap once", () => {
    const nonexistent = parseCron("30 2 * * *", "America/New_York");
    expect(nextCronOccurrence(nonexistent, new Date("2026-03-08T00:00:00.000Z")).toISOString()).toBe("2026-03-09T06:30:00.000Z");
    const overlap = parseCron("30 1 * * *", "America/New_York");
    const first = nextCronOccurrence(overlap, new Date("2026-11-01T00:00:00.000Z"));
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronOccurrence(overlap, first).toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("finds the next occurrence in zones without DST and and skips a southern-hemisphere spring-forward gap", () => {
    const seoul = parseCron("20 12 * * *", "Asia/Seoul");
    expect(nextCronOccurrence(seoul, new Date("2026-10-07T03:20:00.000Z")).toISOString()).toBe("2026-10-08T03:20:00.000Z");
    expect(nextCronOccurrence(seoul, new Date("2026-10-07T03:19:00.000Z")).toISOString()).toBe("2026-10-07T03:20:00.000Z");
    const sydney = parseCron("30 2 * * *", "Australia/Sydney");
    expect(nextCronOccurrence(sydney, new Date("2026-10-03T00:00:00.000Z")).toISOString()).toBe("2026-10-04T15:30:00.000Z");
  });
});
