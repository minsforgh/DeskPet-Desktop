import { describe, expect, it } from "vitest";
import { evaluateRules, nextOccurrence, validateReminderRules } from "./schedule.js";
import type { ReminderRule } from "./schedule.js";

const rule = (time: string, extra: Partial<ReminderRule> = {}): ReminderRule => ({ id: "r", time, text: "reminder", ...extra });

describe("nextOccurrence", () => {
  it("returns the same day when the rule time is still ahead, zeroing seconds and milliseconds", () => {
    // 2026-01-30 is a Friday.
    expect(nextOccurrence(rule("12:00"), new Date(2026, 0, 30, 11, 59, 59, 999)))
      .toEqual(new Date(2026, 0, 30, 12, 0, 0, 0));
  });

  it("moves to the next day when from is exactly at the rule time or past it", () => {
    expect(nextOccurrence(rule("12:00"), new Date(2026, 0, 30, 12, 0, 0, 0)))
      .toEqual(new Date(2026, 0, 31, 12, 0));
    expect(nextOccurrence(rule("12:00"), new Date(2026, 0, 30, 15, 0)))
      .toEqual(new Date(2026, 0, 31, 12, 0));
  });

  it("skips to the next selected weekday", () => {
    expect(nextOccurrence(rule("09:00", { days: [1] }), new Date(2026, 0, 30, 12, 0)))
      .toEqual(new Date(2026, 1, 2, 9, 0));
    expect(nextOccurrence(rule("08:00", { days: [6, 0] }), new Date(2026, 1, 2, 10, 0)))
      .toEqual(new Date(2026, 1, 7, 8, 0));
  });

  it("keeps the weekday when its time passed, landing seven days out", () => {
    expect(nextOccurrence(rule("09:00", { days: [5] }), new Date(2026, 0, 30, 15, 0)))
      .toEqual(new Date(2026, 1, 6, 9, 0));
  });

  it("crosses midnight from just before and just after", () => {
    expect(nextOccurrence(rule("00:00"), new Date(2026, 0, 30, 23, 59)))
      .toEqual(new Date(2026, 0, 31, 0, 0));
    expect(nextOccurrence(rule("00:00"), new Date(2026, 0, 31, 0, 0)))
      .toEqual(new Date(2026, 1, 1, 0, 0));
    expect(nextOccurrence(rule("00:00"), new Date(2026, 0, 31, 0, 1)))
      .toEqual(new Date(2026, 1, 1, 0, 0));
    expect(nextOccurrence(rule("23:59"), new Date(2026, 0, 31, 0, 0)))
      .toEqual(new Date(2026, 0, 31, 23, 59));
  });

  it("rolls over month ends, a non-leap February, and the year end", () => {
    expect(nextOccurrence(rule("00:15"), new Date(2026, 0, 31, 23, 30)))
      .toEqual(new Date(2026, 1, 1, 0, 15));
    expect(nextOccurrence(rule("01:00"), new Date(2027, 1, 28, 23, 0)))
      .toEqual(new Date(2027, 2, 1, 1, 0));
    expect(nextOccurrence(rule("00:01"), new Date(2026, 11, 31, 23, 59)))
      .toEqual(new Date(2027, 0, 1, 0, 1));
  });
});

describe("validateReminderRules", () => {
  it("accepts rules with optional fields omitted or present", () => {
    const value = [{ id: "lunch", time: "12:20", text: "점심" }, { id: "monday", time: "09:00", days: [1], text: "plan", priority: "high" }];
    expect(validateReminderRules(value)).toEqual({ ok: true, value });
    expect(validateReminderRules([])).toEqual({ ok: true, value: [] });
  });

  it("rejects an id repeated across rules", () => {
    const result = validateReminderRules([rule("09:00", { id: "same" }), rule("10:00", { id: "same" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("id");
  });

  it("accepts only zero-padded 24-hour HH:MM", () => {
    for (const time of ["00:00", "23:59", "09:05"]) {
      expect(validateReminderRules([rule(time)]).ok).toBe(true);
    }
    for (const time of ["24:00", "9:00", "12:60", "12:5", "123:45", "", "ab:cd", "12:30:00", "12-30"]) {
      const result = validateReminderRules([rule(time)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("time");
    }
  });

  it("checks days range 0 through 6 and rejects an empty selection", () => {
    for (const days of [[0], [3], [6]]) {
      expect(validateReminderRules([rule("09:00", { days })]).ok).toBe(true);
    }
    for (const days of [[-1], [7], [3.5], ["1"], []]) {
      const result = validateReminderRules([{ id: "r", time: "09:00", text: "t", days }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("days");
    }
  });

  it("bounds text between 1 and 120 Unicode code points", () => {
    expect(validateReminderRules([rule("09:00", { text: "a" })]).ok).toBe(true);
    expect(validateReminderRules([rule("09:00", { text: "😀".repeat(120) })]).ok).toBe(true);
    for (const text of ["", "😀".repeat(121), "ab".repeat(60) + "a", 42]) {
      const result = validateReminderRules([{ id: "r", time: "09:00", text }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("text");
    }
  });

  it("rejects unknown priorities, non-arrays, and non-object rules", () => {
    expect(validateReminderRules([{ id: "r", time: "09:00", text: "t", priority: "rush" }]).ok).toBe(false);
    expect(validateReminderRules({}).ok).toBe(false);
    expect(validateReminderRules([42]).ok).toBe(false);
  });

  it("names every invalid field in errors", () => {
    const result = validateReminderRules([{ id: "a", time: "25:00", text: "" }, { id: "a", time: "09:00", text: "ok", days: [9], priority: "rush" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/time.*text.*id.*days.*priority/u);
      expect(result.errors).toHaveLength(5);
    }
  });
});

describe("evaluateRules", () => {
  it("reports the first wrong field of each skipped rule and a repeated id, keeping valid rules", () => {
    const statuses = evaluateRules([rule("9:00"), rule("10:00", { days: [9] }), { id: "r", time: "10:00", text: "" }, rule("11:00"), rule("12:00"), 5]);
    expect(statuses.map((status) => status.ok ? "ok" : status.field)).toEqual(["time", "days", "text", "ok", "id", "rule"]);
    expect(statuses[4]).toMatchObject({ ok: false, errors: ['id "r" repeats an earlier rule'] });
  });
});
