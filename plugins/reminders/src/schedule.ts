export interface ReminderRule {
  id: string;
  /** Local time of day as zero-padded 24-hour "HH:MM" (00:00 through 23:59). */
  time: string;
  /** 0 (Sunday) through 6 (Saturday); omitted means every day. */
  days?: number[];
  /** Bubble text, 1 to 120 Unicode code points. */
  text: string;
  priority?: "low" | "normal" | "high" | "urgent";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const priorities = ["low", "normal", "high", "urgent"] as const;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/u;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * Nearest occurrence strictly after `from`, in the local timezone: an instant
 * equal to `from` counts as passed, so the following matching day is returned.
 * `rule.time` is assumed to be valid "HH:MM" as produced by validateReminderRules.
 */
export function nextOccurrence(rule: ReminderRule, from: Date): Date {
  const hours = Number(rule.time.slice(0, 2));
  const minutes = Number(rule.time.slice(3, 5));
  // Any weekday recurs within 7 days, and a passed time today pushes the same
  // weekday to offset 7, so offsets 0 through 7 always contain a match.
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes);
    if (candidate.getTime() > from.getTime() && (rule.days === undefined || rule.days.includes(candidate.getDay()))) {
      return candidate;
    }
  }
  throw new Error("rule has no matching day");
}

export type RuleProblemField = "id" | "time" | "days" | "text" | "priority" | "rule";
const problemFields: readonly RuleProblemField[] = ["id", "time", "days", "text", "priority"];

/** A rule the reminders plugin skips, with the first wrong field and the validator's messages for it. */
export type RuleStatus =
  | { ok: true; rule: ReminderRule }
  | { ok: false; field: RuleProblemField; errors: string[] };

/**
 * Per-rule verdicts in input order, exactly as the plugin applies them: a rule that fails validation, or that
 * repeats the id of an earlier accepted rule, is skipped. The settings window shows these same verdicts.
 */
export function evaluateRules(input: readonly unknown[]): RuleStatus[] {
  const seenIds = new Set<string>();
  return input.map((candidate): RuleStatus => {
    const result = validateReminderRules([candidate]);
    if (!result.ok) {
      const errors = result.errors.map((error) => error.replaceAll("rules[0].", ""));
      const first = errors[0] ?? "";
      return { ok: false, field: problemFields.find((name) => first.startsWith(`${name} `)) ?? "rule", errors };
    }
    const rule = result.value[0] as ReminderRule;
    if (seenIds.has(rule.id)) return { ok: false, field: "id", errors: [`id "${rule.id}" repeats an earlier rule`] };
    seenIds.add(rule.id);
    return { ok: true, rule };
  });
}

export function validateReminderRules(input: unknown):
  | { ok: true; value: ReminderRule[] }
  | { ok: false; errors: string[] } {
  if (!Array.isArray(input)) return { ok: false, errors: ["rules must be an array"] };
  const errors: string[] = [];
  const seenIds = new Set<string>();
  input.forEach((rule: unknown, index: number) => {
    const path = `rules[${index}]`;
    if (!isObject(rule)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (typeof rule.id !== "string") errors.push(`${path}.id must be a string`);
    else if (seenIds.has(rule.id)) errors.push(`${path}.id must not repeat an earlier id`);
    else seenIds.add(rule.id);
    if (typeof rule.time !== "string" || !timePattern.test(rule.time)) errors.push(`${path}.time must be HH:MM from 00:00 to 23:59`);
    if (Object.hasOwn(rule, "days")) {
      const daysError = `${path}.days must be a non-empty array of integers from 0 to 6`;
      if (!Array.isArray(rule.days) || rule.days.length === 0) errors.push(daysError);
      else {
        for (const day of rule.days) {
          if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
            errors.push(daysError);
            break;
          }
        }
      }
    }
    const textLength = typeof rule.text === "string" ? Array.from(rule.text).length : 0;
    if (textLength < 1 || textLength > 120) errors.push(`${path}.text must be a string of 1 to 120 Unicode code points`);
    if (Object.hasOwn(rule, "priority") && !isOneOf(rule.priority, priorities)) {
      errors.push(`${path}.priority must be low, normal, high, or urgent`);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: input as ReminderRule[] };
}
