import { describe, expect, it } from "vitest";
import type { AttendancePhase } from "./attendance-phase.js";
import { afterOpen, nextDelayMs } from "./schedule.js";
import type { ScheduleInput } from "./schedule.js";

const MIN = 60_000;

function kst(h: number, m: number, s = 0, day = 8): Date {
  return new Date(Date.UTC(2026, 9, day, h, m, s) - 9 * 3600 * 1000);
}

function input(over: Partial<ScheduleInput> & { phase: AttendancePhase }): ScheduleInput {
  return { now: kst(12, 0), outcome: "ok", consecutiveErrors: 0, fastPollsLeft: 0, ...over };
}

describe("nextDelayMs", () => {
  it("uses four 30-second polls after a successful login", () => {
    expect(nextDelayMs(input({ phase: "Studying", fastPollsLeft: 1 }))).toBe(30_000);
  });

  it("watches login every five seconds without bypassing error backoff", () => {
    expect(nextDelayMs(input({ phase: "Studying", outcome: "needsLogin", loginWatch: true }))).toBe(5_000);
    expect(nextDelayMs(input({ phase: "Studying", outcome: "needsLogin", loginWatch: false }))).toBe(10 * MIN);
    expect(nextDelayMs(input({ phase: "Studying", outcome: "error", loginWatch: true,
      consecutiveErrors: 2, fastPollsLeft: 1 }))).toBe(2 * MIN);
  });

  it("오류 백오프 1,2,4,8,16,30분 상한", () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 20, 1000].map((n) =>
      nextDelayMs(input({ phase: "Studying", outcome: "error", consecutiveErrors: n })),
    );
    expect(seq).toEqual([1, 2, 4, 8, 16, 30, 30, 30, 30].map((m) => m * MIN));
  });

  it("연속 오류 0 이어도 최소 1000ms 이상", () => {
    expect(nextDelayMs(input({ phase: "Studying", outcome: "error", consecutiveErrors: 0 }))).toBe(MIN);
  });

  it("needsLogin 10분", () => {
    expect(nextDelayMs(input({ phase: "NeedStart", outcome: "needsLogin" }))).toBe(10 * MIN);
  });

  it("Studying 15분", () => {
    expect(nextDelayMs(input({ phase: "Studying", remainingSeconds: 100 }))).toBe(15 * MIN);
  });

  it("NeedStart·NeedEnd: 1800초 경계", () => {
    for (const phase of ["NeedStart", "NeedEnd"] as const) {
      expect(nextDelayMs(input({ phase, remainingSeconds: 1801 }))).toBe(10 * MIN);
      expect(nextDelayMs(input({ phase, remainingSeconds: 1800 }))).toBe(150_000);
      expect(nextDelayMs(input({ phase, remainingSeconds: 1 }))).toBe(150_000);
    }
  });

  it("StartOverdue: 유예 있으면 150초, 없으면 10분", () => {
    expect(nextDelayMs(input({ phase: "StartOverdue", remainingSeconds: 300 }))).toBe(150_000);
    expect(nextDelayMs(input({ phase: "StartOverdue" }))).toBe(10 * MIN);
  });

  it("Complete: 보통 30분", () => {
    expect(nextDelayMs(input({ phase: "Complete", now: kst(12, 0) }))).toBe(30 * MIN);
  });

  it("Complete: 다음 날 04:00:30 이 30분보다 가까우면 그때까지", () => {
    // 03:30:30 → 정확히 30분 전: 30분
    expect(nextDelayMs(input({ phase: "Complete", now: kst(3, 30, 30, 9) }))).toBe(30 * MIN);
    // 03:30:31 → 29분 59초
    expect(nextDelayMs(input({ phase: "Complete", now: kst(3, 30, 31, 9) }))).toBe(30 * MIN - 1000);
    // 00:00 → 04:00:30 은 4시간 이상이라 30분
    expect(nextDelayMs(input({ phase: "Complete", now: kst(0, 0, 0, 9) }))).toBe(30 * MIN);
    // 23:50 같은 날 → 다음 04:00:30 은 멀다
    expect(nextDelayMs(input({ phase: "Complete", now: kst(23, 50) }))).toBe(30 * MIN);
    // 04:00:31 → 이미 지남: 다음 날 04:00:30 은 멀다
    expect(nextDelayMs(input({ phase: "Complete", now: kst(4, 0, 31, 9) }))).toBe(30 * MIN);
    // 04:00:29.5 → 500ms 남아도 최소 1000ms
    expect(nextDelayMs(input({ phase: "Complete", now: new Date(kst(4, 0, 29).getTime() + 500) }))).toBe(1000);
  });

  it("afterOpen 은 4", () => {
    expect(afterOpen()).toBe(4);
  });
});
