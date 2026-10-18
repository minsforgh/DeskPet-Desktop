// 독립 작성(D-026): 규칙 표만 입력으로 쓰고 외부 프로젝트 코드를 참고하지 않았다.

import { describe, expect, it } from "vitest";
import { attendanceDay, attendancePhase } from "./attendance-phase.js";
import type { AttendancePhase } from "./attendance-phase.js";

// Build a Date from a KST wall clock using only UTC arithmetic so the test
// input itself never depends on the host time zone: parse the wall clock as a
// UTC instant and subtract the fixed +09:00 offset.
// Example: kstDate("2026-10-08", "03:59:59") === 2026-10-07T18:59:59Z.
function kstDate(date: string, time: string): Date {
  return new Date(Date.parse(`${date}T${time}Z`) - 9 * 60 * 60 * 1000);
}

describe("attendancePhase before starting", () => {
  const cases = [
    ["03:59:59", { phase: "StartOverdue" }],
    ["04:00:00", { phase: "NeedStart", remainingSeconds: 21600 }],
    ["09:59:59", { phase: "NeedStart", remainingSeconds: 1 }],
    ["10:00:00", { phase: "StartOverdue", remainingSeconds: 600 }],
    ["10:09:59", { phase: "StartOverdue", remainingSeconds: 1 }],
    ["10:10:00", { phase: "StartOverdue" }],
    ["22:59:59", { phase: "StartOverdue" }],
    ["23:00:00", { phase: "StartOverdue" }],
    ["00:30:00", { phase: "StartOverdue" }],
  ] as const;

  it.each(cases)("KST %s with started=false returns %o", (time, expected) => {
    const result = attendancePhase(kstDate("2026-10-08", time), { started: false, ended: false });
    expect(result).toStrictEqual(expected);
    if (!("remainingSeconds" in expected)) {
      expect("remainingSeconds" in result).toBe(false);
    }
  });
});

describe("attendancePhase while studying", () => {
  const cases = [
    ["03:59:59", { phase: "NeedEnd", remainingSeconds: 1 }],
    ["04:00:00", { phase: "Studying", remainingSeconds: 68400 }],
    ["22:59:59", { phase: "Studying", remainingSeconds: 1 }],
    ["23:00:00", { phase: "NeedEnd", remainingSeconds: 18000 }],
    ["00:30:00", { phase: "NeedEnd", remainingSeconds: 12600 }],
  ] as const;

  it.each(cases)("KST %s with started=true returns %o", (time, expected) => {
    const result = attendancePhase(kstDate("2026-10-08", time), { started: true, ended: false });
    expect(result).toStrictEqual(expected);
    if (!("remainingSeconds" in expected)) {
      expect("remainingSeconds" in result).toBe(false);
    }
  });
});

describe("attendancePhase after ending", () => {
  const cases = [
    ["00:30:00", false],
    ["10:05:00", true],
    ["23:30:00", true],
  ] as const;

  it.each(cases)("KST %s with ended=true (started=%s) returns Complete", (time, started) => {
    const result = attendancePhase(kstDate("2026-10-08", time), { started, ended: true });
    expect(result).toStrictEqual({ phase: "Complete" });
    expect("remainingSeconds" in result).toBe(false);
  });
});

describe("attendanceDay", () => {
  const cases = [
    // 00:00-03:59 KST belongs to the previous day.
    ["2026-10-08", "03:59:59", "2026-10-07"],
    ["2026-10-08", "04:00:00", "2026-10-08"],
    ["2026-10-08", "23:59:59", "2026-10-08"],
    // Month end: 2026-11-01 03:59:59 KST is still the October day.
    ["2026-11-01", "03:59:59", "2026-10-31"],
    // Year end: 2027-01-01 03:00 KST is still the 2026 day.
    ["2027-01-01", "03:00:00", "2026-12-31"],
    // UTC calendar date (2026-10-08T15:30:00Z) differs from the KST wall date (2026-10-09).
    ["2026-10-09", "00:30:00", "2026-10-08"],
    // UTC calendar date (2026-10-07T23:00:00Z) differs from the KST wall date (2026-10-08).
    ["2026-10-08", "08:00:00", "2026-10-08"],
  ] as const;

  it.each(cases)("KST %s %s maps to %s", (date, time, expected) => {
    expect(attendanceDay(kstDate(date, time))).toBe(expected);
  });
});

describe("attendancePhase result shape", () => {
  it("covers every phase value from the rule table", () => {
    const phases = new Set<AttendancePhase>([
      attendancePhase(kstDate("2026-10-08", "05:00:00"), { started: false, ended: false }).phase,
      attendancePhase(kstDate("2026-10-08", "10:05:00"), { started: false, ended: false }).phase,
      attendancePhase(kstDate("2026-10-08", "12:00:00"), { started: true, ended: false }).phase,
      attendancePhase(kstDate("2026-10-08", "23:30:00"), { started: true, ended: false }).phase,
      attendancePhase(kstDate("2026-10-08", "12:00:00"), { started: true, ended: true }).phase,
    ]);
    expect(phases).toEqual(new Set(["NeedStart", "StartOverdue", "Studying", "NeedEnd", "Complete"]));
  });
});
