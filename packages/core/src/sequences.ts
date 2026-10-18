import { validatePackJsonLimits } from "./validate.js";

export interface SequenceStep {
  play: string;
  ms?: number;
  say?: string;
}

export interface SequenceItem {
  id: string;
  label?: string;
  steps: SequenceStep[];
}

export interface Sequences {
  sequences: SequenceItem[];
}

export const sequenceIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
export const stateNamePattern = /^[a-z][a-z0-9-]{0,31}$/u;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const validSequenceId = (value: unknown): value is string =>
  typeof value === "string" && sequenceIdPattern.test(value) && !forbidden.has(value);
const validStateName = (value: unknown): value is string =>
  typeof value === "string" && stateNamePattern.test(value) && !forbidden.has(value);
const validText = (value: unknown): value is string =>
  typeof value === "string" && Array.from(value).length <= 120 && !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });

/** Bad entries are omitted with their reasons; malformed files produce empty sequences. */
export function parseSequences(json: unknown): { sequences: Sequences; problems: string[] } {
  const sequences: Sequences = { sequences: [] };
  try {
    if (!isObject(json)) return { sequences, problems: ["sequences file must be an object"] };
    if (json.version !== 1) return { sequences, problems: ["sequences file version must be 1"] };
    const limits = validatePackJsonLimits(json);
    if (limits.length) return { sequences, problems: limits };
    if (!Array.isArray(json.sequences)) return { sequences, problems: ["sequences must be an array"] };
    const problems: string[] = [];
    if (json.sequences.length > 32) problems.push("sequences keeps only the first 32 entries");
    const ids = new Set<string>();
    json.sequences.slice(0, 32).forEach((item: unknown, index: number) => {
      const path = `sequences[${index}]`;
      if (!isObject(item)) { problems.push(`${path} must be an object`); return; }
      if (!validSequenceId(item.id)) { problems.push(`${path}.id must be a safe id of at most 48 characters`); return; }
      if (ids.has(item.id)) { problems.push(`${path}.id is duplicated`); return; }
      if (Object.hasOwn(item, "label") && !validText(item.label)) {
        problems.push(`${path}.label must be at most 120 code points without control characters`); return;
      }
      if (!Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > 8) {
        problems.push(`${path}.steps must contain 1 to 8 steps`); return;
      }
      const steps: SequenceStep[] = [];
      for (const [stepIndex, step] of item.steps.entries()) {
        const stepPath = `${path}.steps[${stepIndex}]`;
        if (!isObject(step)) { problems.push(`${stepPath} must be an object`); break; }
        if (!validStateName(step.play) || step.play === "walk" || step.play === "drag") {
          problems.push(`${stepPath}.play must be a safe non-moving state name`); break;
        }
        if (Object.hasOwn(step, "ms") &&
            (typeof step.ms !== "number" || !Number.isSafeInteger(step.ms) || step.ms < 300 || step.ms > 10_000)) {
          problems.push(`${stepPath}.ms must be an integer from 300 to 10000`); break;
        }
        if (Object.hasOwn(step, "say") && !validText(step.say)) {
          problems.push(`${stepPath}.say must be at most 120 code points without control characters`); break;
        }
        steps.push({ play: step.play,
          ...(typeof step.ms === "number" ? { ms: step.ms } : {}),
          ...(typeof step.say === "string" ? { say: step.say } : {}) });
      }
      if (steps.length !== item.steps.length) return;
      ids.add(item.id);
      sequences.sequences.push({ id: item.id,
        ...(typeof item.label === "string" ? { label: item.label } : {}), steps });
    });
    return { sequences, problems };
  } catch {
    return { sequences: { sequences: [] }, problems: ["sequences file could not be parsed"] };
  }
}
