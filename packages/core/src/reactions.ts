import type { VoiceKind } from "./voice.js";
import { stateNamePattern, validSequenceId } from "./sequences.js";
import { validatePackJsonLimits } from "./validate.js";

export interface ReactionTarget {
  play?: string;
  sequence?: string;
}

export interface Reactions {
  kinds: Partial<Record<VoiceKind, ReactionTarget>>;
  lines?: Record<string, ReactionTarget>;
}

const kinds: readonly VoiceKind[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validStateName = (value: unknown): value is string =>
  typeof value === "string" && stateNamePattern.test(value) && !forbidden.has(value);

function parseTarget(target: unknown, path: string, problems: string[]): ReactionTarget | undefined {
  if (!isObject(target)) { problems.push(`${path} must be an object`); return undefined; }
  if (Object.hasOwn(target, "sequence")) {
    if (!validSequenceId(target.sequence)) {
      problems.push(`${path}.sequence must be a safe id of at most 48 characters`); return undefined;
    }
    if (Object.hasOwn(target, "play")) problems.push(`${path} has both play and sequence; sequence is used`);
    return { sequence: target.sequence };
  }
  if (Object.hasOwn(target, "play")) {
    if (!validStateName(target.play)) {
      problems.push(`${path}.play must be a safe state name of at most 32 characters`); return undefined;
    }
    return { play: target.play };
  }
  problems.push(`${path} must have play or sequence`);
  return undefined;
}

/** Bad entries are omitted with their reasons; malformed files produce empty reactions. */
export function parseReactions(json: unknown): { reactions: Reactions; problems: string[] } {
  const reactions: Reactions = { kinds: {} };
  try {
    if (!isObject(json)) return { reactions, problems: ["reactions file must be an object"] };
    if (json.version !== 1) return { reactions, problems: ["reactions file version must be 1"] };
    const limits = validatePackJsonLimits(json);
    if (limits.length) return { reactions, problems: limits };
    if (!isObject(json.kinds)) return { reactions, problems: ["kinds must be an object"] };
    const problems: string[] = [];
    for (const name of Object.keys(json.kinds)) {
      if (!kinds.some((kind) => kind === name)) problems.push(`kinds.${name} is not a known kind`);
    }
    for (const kind of kinds) {
      if (!Object.hasOwn(json.kinds, kind)) continue;
      const parsed = parseTarget(json.kinds[kind], `kinds.${kind}`, problems);
      if (parsed) reactions.kinds[kind] = parsed;
    }
    if (Object.hasOwn(json, "lines")) {
      if (!isObject(json.lines)) problems.push("lines must be an object");
      else {
        const lines: Record<string, ReactionTarget> = {};
        for (const [id, target] of Object.entries(json.lines)) {
          const parsed = parseTarget(target, `lines.${id}`, problems);
          if (parsed) Object.defineProperty(lines, id, { value: parsed, enumerable: true, writable: true, configurable: true });
        }
        reactions.lines = lines;
      }
    }
    return { reactions, problems };
  } catch {
    return { reactions: { kinds: {} }, problems: ["reactions file could not be parsed"] };
  }
}
