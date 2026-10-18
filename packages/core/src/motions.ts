import { stateNamePattern } from "./sequences.js";
import { validatePackJsonLimits } from "./validate.js";

/** The nine movement requests a pack may redirect to another state (ADR-0009 §9-2, §17). */
export const MOTION_KEYS = ["climb-ready", "climb", "climb-down", "descend", "jump", "hop-down", "fall", "land", "thrown"] as const;
export type MotionKey = typeof MOTION_KEYS[number];
export type MotionLanding = "soft" | "normal";

export interface Motions {
  motions: Partial<Record<MotionKey, { play: string }>>;
  landing: MotionLanding;
  afterLand?: { play: string };
}

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validStateName = (value: unknown): value is string =>
  typeof value === "string" && stateNamePattern.test(value) && !forbidden.has(value);
const empty = (): Motions => ({ motions: {}, landing: "normal" });

/** Bad entries are omitted with their reasons; malformed files produce empty motions. */
export function parseMotions(json: unknown): { motions: Motions; problems: string[] } {
  try {
    if (!isObject(json)) return { motions: empty(), problems: ["motions file must be an object"] };
    if (json.version !== 1) return { motions: empty(), problems: ["motions file version must be 1"] };
    const limits = validatePackJsonLimits(json);
    if (limits.length) return { motions: empty(), problems: limits };
    const result = empty();
    const problems: string[] = [];
    if (Object.hasOwn(json, "motions")) {
      if (!isObject(json.motions)) problems.push("motions must be an object");
      else {
        for (const name of Object.keys(json.motions)) {
          if (!MOTION_KEYS.some((key) => key === name)) problems.push(`motions.${name} is not a known movement`);
        }
        for (const key of MOTION_KEYS) {
          if (!Object.hasOwn(json.motions, key)) continue;
          const path = `motions.${key}`;
          const target: unknown = json.motions[key];
          if (!isObject(target)) { problems.push(`${path} must be an object`); continue; }
          for (const field of Object.keys(target)) {
            if (field !== "play") problems.push(`${path}.${field} is not supported`);
          }
          if (!Object.hasOwn(target, "play")) { problems.push(`${path} must have play`); continue; }
          if (!validStateName(target.play)) {
            problems.push(`${path}.play must be a safe state name of at most 32 characters`); continue;
          }
          result.motions[key] = { play: target.play };
        }
      }
    }
    if (Object.hasOwn(json, "landing")) {
      if (json.landing === "soft" || json.landing === "normal") result.landing = json.landing;
      else problems.push('landing must be "soft" or "normal"');
    }
    if (Object.hasOwn(json, "afterLand")) {
      const target: unknown = json.afterLand;
      if (!isObject(target)) problems.push("afterLand must be an object");
      else {
        const fields = Object.keys(target).filter((field) => field !== "play");
        for (const field of fields) problems.push(`afterLand.${field} is not supported`);
        if (!Object.hasOwn(target, "play")) problems.push("afterLand must have play");
        else if (!validStateName(target.play))
          problems.push("afterLand.play must be a safe state name of at most 32 characters");
        else if (fields.length === 0) result.afterLand = { play: target.play };
      }
    }
    return { motions: result, problems };
  } catch {
    return { motions: empty(), problems: ["motions file could not be parsed"] };
  }
}

/**
 * The state a movement request draws: the pack's mapped state (or the request name), then the pack's
 * fallbacks, then the app's defaults, then idle. Used by playback and by the settings window's preview of it.
 */
export function resolveMotionPlay(request: string, motions: Motions, manifest: { states: Record<string, unknown>; fallbacks: Record<string, string> },
  defaults: Readonly<Record<string, string>>): string {
  const mapped = Object.hasOwn(motions.motions, request) ? motions.motions[request as MotionKey]?.play : undefined;
  const visited = new Set<string>();
  let current = mapped ?? request;
  while (!visited.has(current)) {
    if (Object.hasOwn(manifest.states, current)) return current;
    visited.add(current);
    current = (Object.hasOwn(manifest.fallbacks, current) ? manifest.fallbacks[current] : undefined) ??
      (Object.hasOwn(defaults, current) ? defaults[current] : undefined) ?? "idle";
  }
  return "idle";
}
