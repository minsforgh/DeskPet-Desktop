import type { AttendancePhase } from "./attendance-phase.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const KST_OFFSET_MS = 9 * 60 * MINUTE;
const DAY_MS = 24 * 60 * MINUTE;
const NEW_DAY_OFFSET_MS = 4 * 60 * MINUTE + 30 * SECOND; // 04:00:30 KST
const MIN_DELAY_MS = SECOND;
const MAX_BACKOFF_MS = 30 * MINUTE;

export const FAST_POLL_MS = 30 * SECOND;
export const FAST_POLLS_AFTER_OPEN = 4;

/** 출석 페이지를 연 직후 빠르게 확인할 횟수. */
export function afterOpen(): number {
  return FAST_POLLS_AFTER_OPEN;
}

export interface ScheduleInput {
  phase: AttendancePhase;
  remainingSeconds?: number;
  now: Date;
  outcome: "ok" | "needsLogin" | "error";
  consecutiveErrors: number;
  fastPollsLeft: number;
  loginWatch?: boolean;
}

function msUntilNextDayStart(now: Date): number {
  const kstMs = now.getTime() + KST_OFFSET_MS;
  const sinceMidnight = ((kstMs % DAY_MS) + DAY_MS) % DAY_MS;
  let diff = NEW_DAY_OFFSET_MS - sinceMidnight;
  if (diff <= 0) diff += DAY_MS;
  return diff;
}

function okDelay(input: ScheduleInput): number {
  const { phase, remainingSeconds } = input;
  switch (phase) {
    case "Complete":
      return Math.min(30 * MINUTE, msUntilNextDayStart(input.now));
    case "Studying":
      return 15 * MINUTE;
    case "NeedStart":
    case "NeedEnd":
      return remainingSeconds !== undefined && remainingSeconds <= 1800 ? 150 * SECOND : 10 * MINUTE;
    case "StartOverdue":
      return remainingSeconds !== undefined ? 150 * SECOND : 10 * MINUTE;
  }
}

export function nextDelayMs(input: ScheduleInput): number {
  let delay: number;
  if (input.outcome === "error") {
    const step = Math.max(0, Math.floor(input.consecutiveErrors) - 1);
    delay = Math.min(MINUTE * 2 ** Math.min(step, 10), MAX_BACKOFF_MS);
  } else if (input.loginWatch && input.outcome !== "ok") {
    delay = 5 * SECOND;
  } else if (input.fastPollsLeft > 0) {
    delay = FAST_POLL_MS;
  } else if (input.outcome === "needsLogin") {
    delay = 10 * MINUTE;
  } else {
    delay = okDelay(input);
  }
  return Math.max(MIN_DELAY_MS, Math.round(delay));
}
