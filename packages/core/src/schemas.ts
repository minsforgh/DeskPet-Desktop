const eventType = ["notify", "react", "status"] as const;
const mood = ["happy", "surprised", "sleepy", "worried", "neutral"] as const;
const priority = ["low", "normal", "high", "urgent"] as const;
const voiceKind = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"] as const;
const voiceSlot = { type: "string", maxLength: 500, pattern: "^[^\\x00-\\x1F\\x7F-\\x9F]*$" } as const;

/** Runtime limits for character PNG sheets, separate from the manifest contract. */
export const CHARACTER_SHEET_MAX_BYTES = 8 * 1024 * 1024;
export const CHARACTER_SHEET_MAX_PIXELS = 16_777_216;
export const CHARACTER_PACK_MAX_SHEET_BYTES = 64 * 1024 * 1024;
export const CHARACTER_JSON_MAX_BYTES = 256 * 1024;
export const CHARACTER_INTERACTIONS_MAX_ITEMS = 32;
export const CHARACTER_INTERACTIONS_MAX_LINES = 16;
export const userCharacterIdPattern = "^[a-z0-9][a-z0-9-]{0,47}$";

export const petEventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["source", "type"],
  properties: {
    source: { type: "string" },
    type: { enum: eventType },
    key: { type: "string" },
    /** JSON Schema counts Unicode code points for maxLength. */
    text: { type: "string", maxLength: 120 },
    detail: { type: "string" },
    line: {
      type: "object", required: ["id"], additionalProperties: false,
      properties: {
        id: { type: "string" },
        vars: { type: "object", additionalProperties: voiceSlot },
      },
    },
    voice: {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { enum: voiceKind },
        slots: {
          type: "object",
          additionalProperties: false,
          properties: { task: voiceSlot, result: voiceSlot, folder: voiceSlot, message: voiceSlot },
        },
      },
    },
    mood: { enum: mood },
    priority: { enum: priority },
    /** A bubble may contain at most three actions. */
    actions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["label", "action"],
        additionalProperties: true,
        properties: {
          label: { type: "string" },
          action: { type: "string" },
          args: {},
        },
      },
    },
    ttlMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    timestamp: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
  },
  additionalProperties: true,
} as const;

export const reactionRuleSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["match", "play"],
  properties: {
    match: {
      type: "object",
      additionalProperties: true,
      properties: {
        source: { type: "string" },
        type: { enum: eventType },
        mood: { enum: mood },
        priority: { enum: priority },
      },
    },
    play: { type: "string" },
    durationMs: { type: "integer", minimum: 1, maximum: 60_000 },
    repeat: { type: "integer", minimum: 1, maximum: 10 },
    sound: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
  },
  additionalProperties: true,
} as const;

export const characterManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["id", "name", "apiVersion", "cellSize", "anchor", "scale", "states", "fallbacks"],
  properties: {
    id: { type: "string", maxLength: 48 },
    name: { type: "string", maxLength: 80 },
    /** The manifest example fixes this version to the string "1". */
    apiVersion: { const: "1" },
    cellSize: { type: "array", prefixItems: [{ type: "integer", minimum: 1, maximum: 1024 }, { type: "integer", minimum: 1, maximum: 1024 }], minItems: 2, maxItems: 2 },
    anchor: { type: "array", prefixItems: [{ type: "integer", minimum: 0 }, { type: "integer", minimum: 0 }], minItems: 2, maxItems: 2 },
    scale: { type: "number", exclusiveMinimum: 0, maximum: 4 },
    states: {
      type: "object",
      maxProperties: 32,
      required: ["idle"],
      additionalProperties: {
        type: "object",
        required: ["sheet", "frames", "fps", "loop"],
        additionalProperties: true,
        properties: {
          sheet: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
          /** A state must contain at least one animation frame. */
          frames: { type: "integer", minimum: 1, maximum: 64 },
          fps: { type: "number", exclusiveMinimum: 0, maximum: 60 },
          loop: { type: "boolean" },
          next: { type: "string" },
          facing: { enum: ["left", "right"] },
        },
      },
    },
    fallbacks: { type: "object", additionalProperties: { type: "string" } },
    /** Optional pack-relative path of the voice template file (D-029); same path rule as a sheet. */
    voice: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    preview: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    interactions: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    sequences: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    reactions: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    motions: { type: "string", pattern: "^(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+(?:/(?![^/]*[. ](?:/|$))(?!\\.{1,2}(?:/|$))[^\\x00-\\x1F\\x7F\\\\:/]+)*$" },
    behavior: {
      type: "object",
      additionalProperties: true,
      properties: {
        sleepAfterMs: { type: "integer", minimum: BEHAVIOR_RANGES.sleepAfterMs[0], maximum: BEHAVIOR_RANGES.sleepAfterMs[1] },
        blinkIntervalMs: { type: "array", minItems: 2, maxItems: 2,
          prefixItems: [0, 1].map(() => ({ type: "integer", minimum: BEHAVIOR_RANGES.blinkIntervalMs[0], maximum: BEHAVIOR_RANGES.blinkIntervalMs[1] })) },
        walkIntervalMs: { type: "array", minItems: 2, maxItems: 2,
          prefixItems: [0, 1].map(() => ({ type: "integer", minimum: BEHAVIOR_RANGES.walkIntervalMs[0], maximum: BEHAVIOR_RANGES.walkIntervalMs[1] })) },
        walkDurationMs: { type: "integer", minimum: BEHAVIOR_RANGES.walkDurationMs[0], maximum: BEHAVIOR_RANGES.walkDurationMs[1] },
        walkSpeedPxPerSecond: { type: "number", minimum: BEHAVIOR_RANGES.walkSpeedPxPerSecond[0], maximum: BEHAVIOR_RANGES.walkSpeedPxPerSecond[1] },
        climbChance: { type: "number", minimum: BEHAVIOR_RANGES.climbChance[0], maximum: BEHAVIOR_RANGES.climbChance[1] },
        descendChance: { type: "number", minimum: BEHAVIOR_RANGES.descendChance[0], maximum: BEHAVIOR_RANGES.descendChance[1] },
        jumpMaxHeight: { type: "number", minimum: BEHAVIOR_RANGES.jumpMaxHeight[0], maximum: BEHAVIOR_RANGES.jumpMaxHeight[1] },
        climbSpeed: { type: "number", minimum: BEHAVIOR_RANGES.climbSpeed[0], maximum: BEHAVIOR_RANGES.climbSpeed[1] },
        jumpClearance: { type: "number", minimum: BEHAVIOR_RANGES.jumpClearance[0], maximum: BEHAVIOR_RANGES.jumpClearance[1] },
        gravity: { type: "number", minimum: BEHAVIOR_RANGES.gravity[0], maximum: BEHAVIOR_RANGES.gravity[1] },
        gapJumpDistance: { type: "number", minimum: BEHAVIOR_RANGES.gapJumpDistance[0], maximum: BEHAVIOR_RANGES.gapJumpDistance[1] },
        gapJumpChance: { type: "number", minimum: BEHAVIOR_RANGES.gapJumpChance[0], maximum: BEHAVIOR_RANGES.gapJumpChance[1] },
      },
    },
    extends: { type: "string", pattern: userCharacterIdPattern },
    meta: { type: "object", additionalProperties: true, properties: {
      author: { type: "string", maxLength: 80 }, version: { type: "string", maxLength: 32 },
      license: { type: "string", maxLength: 80 }, description: { type: "string", maxLength: 500 },
      createdWith: { type: "string", maxLength: 80 },
    } },
  },
  additionalProperties: true,
} as const;
import { BEHAVIOR_RANGES } from "./behavior.js";
