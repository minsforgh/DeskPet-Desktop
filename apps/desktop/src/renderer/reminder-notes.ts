// The reminders plugin's own schedule module decides what runs and when; the settings window only words its verdicts.
import { evaluateRules, nextOccurrence } from "../../../../plugins/reminders/src/schedule.js";
import type { RuleProblemField } from "../../../../plugins/reminders/src/schedule.js";

const WEEKDAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

const REASONS: Record<RuleProblemField, string> = {
  time: "시각 형식이 맞지 않아 알림이 오지 않아요 (예: 23:30)",
  days: "요일 값이 맞지 않아 알림이 오지 않아요",
  id: "ID가 비었거나 앞 규칙과 겹쳐 알림이 오지 않아요",
  text: "말풍선 문구가 비었거나 120자를 넘어 알림이 오지 않아요",
  priority: "우선순위 값이 맞지 않아 알림이 오지 않아요",
  rule: "규칙 형식이 맞지 않아 알림이 오지 않아요",
};

export interface RuleNote { kind: "next" | "skipped"; text: string }

const pad = (value: number): string => String(value).padStart(2, "0");

/** "오늘 오후 11:30", "내일 오전 8:00"; a week out (same weekday, time already passed today) is "다음 주 …". */
export function formatNextOccurrence(next: Date, now: Date): string {
  const dayOffset = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() -
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const clock = `${next.getHours() < 12 ? "오전" : "오후"} ${next.getHours() % 12 || 12}:${pad(next.getMinutes())}`;
  const weekday = WEEKDAY_NAMES[next.getDay()] ?? "";
  if (dayOffset <= 0) return `오늘 ${clock}`;
  if (dayOffset === 1) return `내일 ${clock}`;
  return dayOffset >= 7 ? `다음 주 ${weekday} ${clock}` : `${weekday} ${clock}`;
}

/** Blank values are what the form leaves out on save (settings-service), so they are left out here too. */
const withoutBlanks = (row: unknown): unknown => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && !(Array.isArray(value) && value.length === 0)));
};

/** One note per row of the rules field, in order: the next time the plugin will fire it, or why it never will. */
export function describeRules(rows: readonly unknown[], now: Date): RuleNote[] {
  return evaluateRules(rows.map(withoutBlanks)).map((status): RuleNote => {
    if (!status.ok) return { kind: "skipped", text: REASONS[status.field] };
    const next = nextOccurrence(status.rule, now);
    const hours = Number(status.rule.time.slice(0, 2));
    const minutes = Number(status.rule.time.slice(3, 5));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    const passed = today.getTime() <= now.getTime() ? ` (오늘 ${hours % 12 || 12}:${pad(minutes)} 은 이미 지났어요)` : "";
    return { kind: "next", text: `다음 알림: ${formatNextOccurrence(next, now)}${passed}` };
  });
}
