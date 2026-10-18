import { describe, expect, it } from "vitest";
import { describeRules, formatNextOccurrence } from "./reminder-notes.js";

// 2026-10-07 is a Wednesday.
const now = new Date(2026, 9, 7, 12, 0);
const rule = (extra: Record<string, unknown>) => ({ id: "r", time: "09:00", text: "t", ...extra });

describe("formatNextOccurrence", () => {
  it("words today, tomorrow, a weekday and next week", () => {
    expect(formatNextOccurrence(new Date(2026, 9, 7, 23, 30), now)).toBe("오늘 오후 11:30");
    expect(formatNextOccurrence(new Date(2026, 9, 8, 8, 0), now)).toBe("내일 오전 8:00");
    expect(formatNextOccurrence(new Date(2026, 9, 9, 9, 5), now)).toBe("금요일 오전 9:05");
    expect(formatNextOccurrence(new Date(2026, 9, 14, 9, 0), now)).toBe("다음 주 수요일 오전 9:00");
  });
  it("counts calendar days across a month end and midnight", () => {
    expect(formatNextOccurrence(new Date(2026, 10, 1, 0, 0), new Date(2026, 9, 31, 23, 59))).toBe("내일 오전 12:00");
  });
});

describe("describeRules", () => {
  it("shows the next time for valid rules, from the same schedule the plugin uses", () => {
    expect(describeRules([rule({ time: "23:30" }), rule({ id: "b" }), rule({ id: "c", days: [3] }), rule({ id: "d", days: [5] })], now))
      .toEqual([
        { kind: "next", text: "다음 알림: 오늘 오후 11:30" },
        { kind: "next", text: "다음 알림: 내일 오전 9:00 (오늘 9:00 은 이미 지났어요)" },
        { kind: "next", text: "다음 알림: 다음 주 수요일 오전 9:00 (오늘 9:00 은 이미 지났어요)" },
        { kind: "next", text: "다음 알림: 금요일 오전 9:00 (오늘 9:00 은 이미 지났어요)" },
      ]);
  });
  it("gives a reason, and no next time, to a rule the plugin skips", () => {
    const notes = describeRules([rule({ time: "9:00" }), rule({ id: "b", days: [7] }), rule({ id: "c", text: "" }), rule({ id: "d" }), rule({ id: "d" })], now);
    expect(notes.map((note) => note.kind)).toEqual(["skipped", "skipped", "skipped", "next", "skipped"]);
    expect(notes[0]?.text).toBe("시각 형식이 맞지 않아 알림이 오지 않아요 (예: 23:30)");
    expect(notes[1]?.text).toContain("요일");
    expect(notes[2]?.text).toContain("문구");
    expect(notes[4]?.text).toContain("ID");
  });
  it("treats blank form values as left out, like saving does", () => {
    expect(describeRules([rule({ days: [] })], now)).toEqual([{ kind: "next", text: "다음 알림: 내일 오전 9:00 (오늘 9:00 은 이미 지났어요)" }]);
    expect(describeRules([{ id: "r", time: "", text: "t" }], now)[0]?.kind).toBe("skipped");
  });
});
