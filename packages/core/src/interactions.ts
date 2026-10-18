import type { PetEvent } from "./contracts.js";
import { CHARACTER_INTERACTIONS_MAX_ITEMS, CHARACTER_INTERACTIONS_MAX_LINES } from "./schemas.js";
import { validatePackJsonLimits } from "./validate.js";
import { stateNamePattern, validSequenceId } from "./sequences.js";

export interface InteractionItem {
  id: string;
  label: string;
  mood: NonNullable<PetEvent["mood"]>;
  bubble: boolean;
  lines: string[];
  play?: string;
  sequence?: string;
}

export interface Interactions {
  items: InteractionItem[];
  hidden: string[];
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const moods: readonly NonNullable<PetEvent["mood"]>[] = ["happy", "surprised", "sleepy", "worried", "neutral"];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" && idPattern.test(value) && !forbidden.has(value);
const validMood = (value: unknown): value is NonNullable<PetEvent["mood"]> =>
  moods.some((mood) => mood === value);
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && Array.from(value).length <= max && !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });

/** Bad entries are omitted with their reasons; malformed files produce empty interactions. */
export function parseInteractions(json: unknown): { interactions: Interactions; problems: string[] } {
  const interactions: Interactions = { items: [], hidden: [] };
  try {
    if (!isObject(json)) return { interactions, problems: ["interactions file must be an object"] };
    if (json.version !== 1) return { interactions, problems: ["interactions file version must be 1"] };
    const limits = validatePackJsonLimits(json);
    if (limits.length) return { interactions, problems: limits };
    const problems: string[] = [];
    if (!Array.isArray(json.items)) return { interactions, problems: ["items must be an array"] };
    if (json.items.length > CHARACTER_INTERACTIONS_MAX_ITEMS)
      problems.push(`items keeps only the first ${CHARACTER_INTERACTIONS_MAX_ITEMS} entries`);
    const ids = new Set<string>();
    json.items.slice(0, CHARACTER_INTERACTIONS_MAX_ITEMS).forEach((item: unknown, index: number) => {
      const path = `items[${index}]`;
      if (!isObject(item)) { problems.push(`${path} must be an object`); return; }
      if (!validId(item.id)) { problems.push(`${path}.id must be a safe id of at most 32 characters`); return; }
      if (ids.has(item.id)) { problems.push(`${path}.id is duplicated`); return; }
      if (!validText(item.label, 20)) { problems.push(`${path}.label must be at most 20 code points without control characters`); return; }
      if (!validMood(item.mood)) { problems.push(`${path}.mood is unknown`); return; }
      if (typeof item.bubble !== "boolean") { problems.push(`${path}.bubble must be a boolean`); return; }
      if (!Array.isArray(item.lines) || item.lines.length > CHARACTER_INTERACTIONS_MAX_LINES ||
          !item.lines.every((line: unknown) => validText(line, 120))) {
        problems.push(`${path}.lines must contain at most 16 lines of at most 120 code points`); return;
      }
      if (Object.hasOwn(item, "play") &&
          (typeof item.play !== "string" || !stateNamePattern.test(item.play) || forbidden.has(item.play))) {
        problems.push(`${path}.play must be a safe state name of at most 32 characters`); return;
      }
      if (Object.hasOwn(item, "sequence") && !validSequenceId(item.sequence)) {
        problems.push(`${path}.sequence must be a safe id of at most 48 characters`); return;
      }
      ids.add(item.id);
      interactions.items.push({ id: item.id, label: item.label, mood: item.mood,
        bubble: item.bubble, lines: item.lines,
        ...(typeof item.play === "string" ? { play: item.play } : {}),
        ...(typeof item.sequence === "string" ? { sequence: item.sequence } : {}) });
      if (item.bubble && item.lines.length === 0) problems.push(`${path} has bubble enabled without lines`);
    });
    if (Object.hasOwn(json, "hidden")) {
      if (!Array.isArray(json.hidden)) problems.push("hidden must be an array");
      else {
        if (json.hidden.length > CHARACTER_INTERACTIONS_MAX_ITEMS)
          problems.push(`hidden keeps only the first ${CHARACTER_INTERACTIONS_MAX_ITEMS} entries`);
        for (const [index, id] of json.hidden.slice(0, CHARACTER_INTERACTIONS_MAX_ITEMS).entries()) {
          if (!validId(id)) problems.push(`hidden[${index}] must be a safe id`);
          else if (interactions.hidden.includes(id)) problems.push(`hidden[${index}] is duplicated`);
          else interactions.hidden.push(id);
        }
      }
    }
    return { interactions, problems };
  } catch {
    return { interactions: { items: [], hidden: [] }, problems: ["interactions file could not be parsed"] };
  }
}
