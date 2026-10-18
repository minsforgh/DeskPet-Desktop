import type { PetEvent, ValidationResult } from "./contracts.js";

export interface DoNotDisturbWindow {
  /** Local wall-clock time in 24-hour "HH:MM" format. */
  start: string;
  /** Start is inclusive; end is exclusive and may fall before start to wrap past midnight. */
  end: string;
}

export interface DoNotDisturbConfig {
  /** Manual switch: true is always quiet regardless of schedule. */
  enabled: boolean;
  schedule?: DoNotDisturbWindow[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hhmmPattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const summaryMaxCodePoints = 120;

function minutesOfDay(value: string): number | undefined {
  const match = hhmmPattern.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function coversMinute(window: DoNotDisturbWindow, minute: number): boolean {
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  if (start === undefined || end === undefined || start === end) return false;
  // start inclusive, end exclusive; start > end spans midnight.
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Pure do-not-disturb check: the caller injects every clock reading. */
export function isQuietNow(config: DoNotDisturbConfig, now: Date): boolean {
  if (config.enabled) return true;
  const minute = now.getHours() * 60 + now.getMinutes();
  return (config.schedule ?? []).some((window) => coversMinute(window, minute));
}

export function validateDoNotDisturbConfig(input: unknown): ValidationResult<DoNotDisturbConfig> {
  if (!isObject(input)) return { ok: false, errors: ["config must be an object"] };
  const errors: string[] = [];
  if (typeof input.enabled !== "boolean") errors.push("enabled must be a boolean");
  if (Object.hasOwn(input, "schedule")) {
    if (!Array.isArray(input.schedule)) errors.push("schedule must be an array");
    else input.schedule.forEach((entry: unknown, index: number) => {
      if (!isObject(entry)) errors.push(`schedule[${index}] must be an object`);
      else for (const field of ["start", "end"] as const) {
        const value = entry[field];
        if (typeof value !== "string" || !hhmmPattern.test(value)) {
          errors.push(`schedule[${index}].${field} must be a "HH:MM" time from 00:00 to 23:59`);
        }
      }
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as DoNotDisturbConfig };
}

/** Collapses held notify events into one summary bubble; undefined when nothing was held. */
export function summarizeHeld(held: readonly PetEvent[]): PetEvent | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  for (const event of held) {
    if (event.type !== "notify") continue;
    counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return undefined;
  const breakdown = [...counts].map(([source, count]) => `${source} ${count}`);
  const text = `방해 금지 중 알림 ${total}개: ${breakdown.join(", ")}`;
  const codePoints = Array.from(text);
  return {
    source: "deskpet",
    type: "notify",
    key: "dnd-summary",
    text: codePoints.length <= summaryMaxCodePoints ? text : codePoints.slice(0, summaryMaxCodePoints).join(""),
    priority: "normal",
  };
}
