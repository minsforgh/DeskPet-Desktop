import type { CharacterBehavior } from "./contracts.js";
import type { CharacterAnimationOptions } from "./character-animation.js";

export const BEHAVIOR_RANGES = {
  sleepAfterMs: [5_000, 3_600_000],
  blinkIntervalMs: [1_000, 60_000],
  walkIntervalMs: [1_000, 600_000],
  walkDurationMs: [500, 30_000],
  walkSpeedPxPerSecond: [0, 300],
  climbChance: [0, 1],
  descendChance: [0, 1],
  jumpMaxHeight: [0, 2000],
  climbSpeed: [20, 1000],
  jumpClearance: [0, 300],
  gravity: [200, 10000],
  gapJumpDistance: [0, 1000],
  gapJumpChance: [0, 1],
} as const;

export const DEFAULT_BEHAVIOR = {
  sleepAfterMs: 60_000,
  blinkIntervalMs: [3_000, 7_000],
  walkIntervalMs: [18_000, 30_000],
  walkDurationMs: 3_000,
  walkSpeedPxPerSecond: 30,
  // ADR-0009 §10 candidates: climbing a wall is rarer than stepping off a ledge.
  climbChance: 0.4,
  descendChance: 0.5,
  // ADR-0009 §17 candidates, DIP and DIP/s.
  jumpMaxHeight: 150,
  climbSpeed: 120,
  jumpClearance: 24,
  gravity: 2000,
  // ADR-0009 §18: hopping across the gap between windows.
  gapJumpDistance: 200,
  gapJumpChance: 0.5,
} as const;

/** Numbers that PetMovement uses (ADR-0009 §10, §17); the animation machine ignores them. */
export const MOVEMENT_FIELDS = ["climbChance", "descendChance", "jumpMaxHeight", "climbSpeed", "jumpClearance", "gravity", "gapJumpDistance", "gapJumpChance"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isNumber(value: unknown, min: number, max: number, integer: boolean): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
    (!integer || Number.isInteger(value));
}

function isInterval(value: unknown, min: number, max: number): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    isNumber(value[0], min, max, true) && isNumber(value[1], min, max, true) && value[0] <= value[1];
}

/** Validate known fields without treating future fields as errors. */
export function validateBehavior(input: unknown): string[] {
  if (!isObject(input)) return ["behavior must be an object"];
  const errors: string[] = [];
  for (const field of ["sleepAfterMs", "walkDurationMs"] as const) {
    const range = BEHAVIOR_RANGES[field];
    if (Object.hasOwn(input, field) && !isNumber(input[field], range[0], range[1], true))
      errors.push(`behavior.${field} must be an integer from ${BEHAVIOR_RANGES[field][0]} to ${BEHAVIOR_RANGES[field][1]}`);
  }
  if (Object.hasOwn(input, "walkSpeedPxPerSecond") &&
      !isNumber(input.walkSpeedPxPerSecond, ...BEHAVIOR_RANGES.walkSpeedPxPerSecond, false))
    errors.push("behavior.walkSpeedPxPerSecond must be a number from 0 to 300");
  for (const field of MOVEMENT_FIELDS) {
    if (Object.hasOwn(input, field) && !isNumber(input[field], BEHAVIOR_RANGES[field][0], BEHAVIOR_RANGES[field][1], false))
      errors.push(`behavior.${field} must be a number from ${BEHAVIOR_RANGES[field][0]} to ${BEHAVIOR_RANGES[field][1]}`);
  }
  for (const field of ["blinkIntervalMs", "walkIntervalMs"] as const) {
    const range = BEHAVIOR_RANGES[field];
    if (Object.hasOwn(input, field) && !isInterval(input[field], range[0], range[1]))
      errors.push(`behavior.${field} must contain two ordered integers from ${BEHAVIOR_RANGES[field][0]} to ${BEHAVIOR_RANGES[field][1]}`);
  }
  return errors;
}

function validFields(input: unknown): CharacterBehavior {
  if (!isObject(input)) return {};
  const result: CharacterBehavior = {};
  for (const field of ["sleepAfterMs", "walkDurationMs"] as const) {
    const range = BEHAVIOR_RANGES[field];
    if (isNumber(input[field], range[0], range[1], true)) result[field] = input[field];
  }
  if (isNumber(input.walkSpeedPxPerSecond, ...BEHAVIOR_RANGES.walkSpeedPxPerSecond, false))
    result.walkSpeedPxPerSecond = input.walkSpeedPxPerSecond;
  for (const field of MOVEMENT_FIELDS)
    if (isNumber(input[field], BEHAVIOR_RANGES[field][0], BEHAVIOR_RANGES[field][1], false)) result[field] = input[field];
  for (const field of ["blinkIntervalMs", "walkIntervalMs"] as const) {
    const range = BEHAVIOR_RANGES[field];
    if (isInterval(input[field], range[0], range[1])) result[field] = [input[field][0], input[field][1]];
  }
  return result;
}

/** The animation machine ignores the two chances; PetMovement takes them (ADR-0009 §10). */
export type ResolvedBehavior = CharacterAnimationOptions & { [K in (typeof MOVEMENT_FIELDS)[number]]: number };

/** Resolve code defaults, pack values, then valid user overrides. */
export function resolveBehavior(pack: unknown, user: unknown): ResolvedBehavior {
  return { ...DEFAULT_BEHAVIOR, ...validFields(pack), ...validFields(user) };
}
