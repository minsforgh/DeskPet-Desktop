// 독립 작성(D-026): 규칙 표만 입력으로 쓰고 외부 프로젝트 코드를 참고하지 않았다.

export type AttendancePhase = "NeedStart" | "StartOverdue" | "Studying" | "NeedEnd" | "Complete";

// KST is a fixed UTC+09:00 offset (no daylight saving), so shifting the UTC
// timestamp by +9h and reading UTC components yields the KST wall clock
// regardless of the host time zone.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
// The attendance day starts at 04:00 KST; 00:00-03:59 belongs to the previous day.
const DAY_START = 4 * 60 * 60;
const START_DEADLINE = 10 * 60 * 60;
const START_GRACE_END = 10 * 60 * 60 + 10 * 60;
const END_DEADLINE = 23 * 60 * 60;

function secondsSinceKstMidnight(now: Date): number {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() * 3600 + kst.getUTCMinutes() * 60 + kst.getUTCSeconds();
}

export function attendancePhase(
  now: Date,
  status: { started: boolean; ended: boolean },
): { phase: AttendancePhase; remainingSeconds?: number } {
  if (status.ended) {
    return { phase: "Complete" };
  }

  const t = secondsSinceKstMidnight(now);

  if (!status.started) {
    if (t >= DAY_START && t < START_DEADLINE) {
      return { phase: "NeedStart", remainingSeconds: START_DEADLINE - t };
    }
    if (t >= START_DEADLINE && t < START_GRACE_END) {
      // 10:00-10:09:59 keeps a grace countdown until 10:10.
      return { phase: "StartOverdue", remainingSeconds: START_GRACE_END - t };
    }
    return { phase: "StartOverdue" };
  }

  if (t >= DAY_START && t < END_DEADLINE) {
    return { phase: "Studying", remainingSeconds: END_DEADLINE - t };
  }
  // After 23:00 or before 04:00 the remaining time counts up to the next 04:00.
  const toNextDayStart = t >= END_DEADLINE ? DAY_SECONDS - t + DAY_START : DAY_START - t;
  return { phase: "NeedEnd", remainingSeconds: toNextDayStart };
}

export function attendanceDay(now: Date): string {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const day = kst.getUTCHours() < 4 ? new Date(kst.getTime() - DAY_MS) : kst;
  const year = day.getUTCFullYear();
  const month = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(day.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}
