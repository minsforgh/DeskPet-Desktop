import { describe, expect, it } from "vitest";
import { isQuietNow, summarizeHeld, validateDoNotDisturbConfig } from "@deskpet/core";
import type { DoNotDisturbConfig, PetEvent } from "@deskpet/core";

const at = (hour: number, minute = 0): Date => new Date(2026, 0, 1, hour, minute);
const notify = (source: string): PetEvent => ({ source, type: "notify", text: "held" });

describe("isQuietNow", () => {
  it("is always quiet while enabled, regardless of schedule", () => {
    expect(isQuietNow({ enabled: true, schedule: [{ start: "09:00", end: "17:00" }] }, at(3))).toBe(true);
    expect(isQuietNow({ enabled: true }, at(12))).toBe(true);
  });

  it("stays quiet only inside a same-day window with inclusive start and exclusive end", () => {
    const day: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "09:00", end: "17:00" }] };
    expect(isQuietNow(day, at(8, 59))).toBe(false);
    expect(isQuietNow(day, at(9, 0))).toBe(true);
    expect(isQuietNow(day, at(12, 30))).toBe(true);
    expect(isQuietNow(day, at(16, 59))).toBe(true);
    expect(isQuietNow(day, at(17, 0))).toBe(false);
  });

  it("wraps windows past midnight with the same boundaries", () => {
    const night: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] };
    expect(isQuietNow(night, at(21, 59))).toBe(false);
    expect(isQuietNow(night, at(22, 0))).toBe(true);
    expect(isQuietNow(night, at(23, 30))).toBe(true);
    expect(isQuietNow(night, at(3, 0))).toBe(true);
    expect(isQuietNow(night, at(6, 59))).toBe(true);
    expect(isQuietNow(night, at(7, 0))).toBe(false);
    expect(isQuietNow(night, at(12, 0))).toBe(false);
  });

  it("treats equal start and end as an empty window", () => {
    const empty: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "09:00", end: "09:00" }] };
    expect(isQuietNow(empty, at(8, 59))).toBe(false);
    expect(isQuietNow(empty, at(9, 0))).toBe(false);
    expect(isQuietNow(empty, at(9, 30))).toBe(false);
  });

  it("is quiet when any window matches and never quiet without a schedule", () => {
    const both: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "09:00", end: "09:30" }, { start: "22:00", end: "07:00" }] };
    expect(isQuietNow(both, at(9, 15))).toBe(true);
    expect(isQuietNow(both, at(23, 0))).toBe(true);
    expect(isQuietNow(both, at(12, 0))).toBe(false);
    expect(isQuietNow({ enabled: false }, at(12, 0))).toBe(false);
  });
});

describe("validateDoNotDisturbConfig", () => {
  it("accepts valid configs including boundary times 00:00 and 23:59", () => {
    expect(validateDoNotDisturbConfig({ enabled: false, schedule: [{ start: "22:00", end: "07:00" }] })).toEqual({ ok: true, value: { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] } });
    expect(validateDoNotDisturbConfig({ enabled: true })).toEqual({ ok: true, value: { enabled: true } });
    expect(validateDoNotDisturbConfig({ enabled: false, schedule: [{ start: "00:00", end: "23:59" }] }).ok).toBe(true);
  });

  it("rejects malformed HH:MM times with a per-field error", () => {
    for (const start of ["24:00", "7:00", "07:6", "07:60", "0700", "07:00:00", "07-00", "07:0a", ""] as const) {
      const result = validateDoNotDisturbConfig({ enabled: false, schedule: [{ start, end: "07:00" }] });
      expect(result).toMatchObject({ ok: false, errors: [`schedule[0].start must be a "HH:MM" time from 00:00 to 23:59`] });
    }
  });

  it("reports structural errors", () => {
    expect(validateDoNotDisturbConfig(null)).toEqual({ ok: false, errors: ["config must be an object"] });
    expect(validateDoNotDisturbConfig({ enabled: "yes" })).toMatchObject({ ok: false, errors: ["enabled must be a boolean"] });
    expect(validateDoNotDisturbConfig({ enabled: false, schedule: {} })).toMatchObject({ ok: false, errors: ["schedule must be an array"] });
    expect(validateDoNotDisturbConfig({ enabled: false, schedule: [null] })).toMatchObject({ ok: false, errors: ["schedule[0] must be an object"] });
    expect(validateDoNotDisturbConfig({ enabled: false, schedule: [{ start: "09:00" }] })).toMatchObject({ ok: false, errors: [`schedule[0].end must be a "HH:MM" time from 00:00 to 23:59`] });
  });
});

describe("summarizeHeld", () => {
  it("returns undefined when nothing was held", () => {
    expect(summarizeHeld([])).toBeUndefined();
    expect(summarizeHeld([{ source: "slack", type: "react" }, { source: "slack", type: "status" }])).toBeUndefined();
  });

  it("summarizes held notifies per source in first-appearance order", () => {
    const held: PetEvent[] = [
      notify("slack"),
      notify("orca"),
      notify("slack"),
      notify("orca"),
      notify("slack"),
      { source: "orca", type: "status" },
    ];
    expect(summarizeHeld(held)).toEqual({
      source: "deskpet",
      type: "notify",
      key: "dnd-summary",
      text: "방해 금지 중 알림 5개: slack 3, orca 2",
      priority: "normal",
    });
    expect(summarizeHeld([notify("orca"), notify("slack")])?.text).toBe("방해 금지 중 알림 2개: orca 1, slack 1");
  });

  it("truncates long summaries to 120 code points", () => {
    const held: PetEvent[] = Array.from({ length: 30 }, (_, index) => notify(`very-long-source-name-${index}`));
    const summary = summarizeHeld(held);
    const text = summary?.text ?? "";
    expect(text.startsWith("방해 금지 중 알림 30개: very-long-source-name-0 1,")).toBe(true);
    expect(Array.from(text).length).toBe(120);
    expect(summary).toMatchObject({ source: "deskpet", type: "notify", key: "dnd-summary", priority: "normal" });
  });
});
