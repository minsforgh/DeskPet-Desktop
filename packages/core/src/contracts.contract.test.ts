import { describe, expect, it } from "vitest";
import {
  BEHAVIOR_RANGES,
  characterManifestSchema,
  validateCharacterManifest,
  validatePetEvent,
  validateReactionRule,
} from "@deskpet/core";
import type { CharacterManifest, PetEvent, ReactionRule } from "@deskpet/core";
import type { ValidationResult } from "@deskpet/core";

function expectRejected<T>(result: ValidationResult<T>): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.every((error) => typeof error === "string" && error.length > 0)).toBe(true);
}

const event = {
  source: "jungle",
  type: "notify",
  key: "jungle.deadline",
  text: "출석 마감 30분 전",
  detail: "출석 페이지를 확인하세요.",
  mood: "worried",
  priority: "high",
  actions: [{ label: "열기", action: "jungle.openCheckIn" }],
  ttlMs: 60_000,
  timestamp: 1_000,
} satisfies PetEvent;

const rule = {
  match: { source: "jungle", type: "notify", mood: "worried", priority: "high" },
  play: "worried",
  durationMs: 2_000,
  repeat: 1,
  sound: "sounds/warning.wav",
} satisfies ReactionRule;

// The character pack example from docs/plan.md §6-3.
const mochi = {
  id: "mochi",
  name: "모치",
  apiVersion: "1",
  cellSize: [256, 256],
  anchor: [128, 240],
  scale: 0.6,
  states: {
    idle: { sheet: "sheets/idle.png", frames: 8, fps: 8, loop: true },
    blink: { sheet: "sheets/blink.png", frames: 4, fps: 12, loop: false, next: "idle" },
    walk: { sheet: "sheets/walk.png", frames: 6, fps: 10, loop: true },
    sleep: { sheet: "sheets/sleep.png", frames: 4, fps: 3, loop: true },
    happy: { sheet: "sheets/happy.png", frames: 6, fps: 10, loop: false, next: "idle" },
    surprised: { sheet: "sheets/surprised.png", frames: 5, fps: 12, loop: false, next: "idle" },
    worried: { sheet: "sheets/worried.png", frames: 6, fps: 8, loop: true },
    talk: { sheet: "sheets/talk.png", frames: 4, fps: 8, loop: true },
    drag: { sheet: "sheets/drag.png", frames: 4, fps: 8, loop: true },
  },
  fallbacks: { worried: "surprised", celebrate: "happy" },
} satisfies CharacterManifest;

describe("PetEvent contract", () => {
  it("accepts a valid event", () => {
    expect(validatePetEvent(event)).toEqual({ ok: true, value: event });
  });

  it.each([
    ["minimal event", { source: "jungle", type: "notify" }],
    ["120-character text", { ...event, text: "a".repeat(120) }],
    ["zero actions", { ...event, actions: [] }],
    ["three actions", { ...event, actions: Array.from({ length: 3 }, (_, i) => ({ label: `${i}`, action: "jungle.openCheckIn" })) }],
    ["voice without slots", { ...event, voice: { kind: "info" } }],
    ["voice deadline", { ...event, voice: { kind: "deadline", slots: { message: "내일까지" } } }],
    ["voice reminder", { ...event, voice: { kind: "reminder", slots: { message: "회의" } } }],
    ["voice alert", { ...event, voice: { kind: "alert", slots: { message: "로그인 만료" } } }],
    ["voice with slots", { ...event, voice: { kind: "done", slots: { task: "Build", result: "Passed", folder: "work", message: "Ready" } } }],
    ["500 Unicode code point slot", { ...event, voice: { kind: "done", slots: { message: "😀".repeat(500) } } }],
  ])("accepts %s", (_label, input) => {
    expect(validatePetEvent(input)).toEqual({ ok: true, value: input });
  });

  it("allows unknown event and action fields", () => {
    expect(validatePetEvent({ ...event, future: true, actions: [{ ...event.actions[0], future: true }] }).ok).toBe(true);
  });

  it.each([
    ["text longer than 120 characters", { ...event, text: "a".repeat(121) }],
    ["four actions", { ...event, actions: Array.from({ length: 4 }, (_, i) => ({ label: `${i}`, action: "open" })) }],
    ["unknown type", { ...event, type: "message" }],
    ["unknown mood", { ...event, mood: "angry" }],
    ["unknown priority", { ...event, priority: "critical" }],
    ["missing source", { type: "notify" }],
    ["missing type", { source: "jungle" }],
    ["action missing label", { ...event, actions: [{ action: "jungle.openCheckIn" }] }],
    ["action missing action", { ...event, actions: [{ label: "열기" }] }],
    ["null optional text", { ...event, text: null }],
    ["null optional actions", { ...event, actions: null }],
    ["wrong optional ttlMs type", { ...event, ttlMs: "60000" }],
    ["wrong optional timestamp type", { ...event, timestamp: "1000" }],
    ["fractional timestamp", { ...event, timestamp: 1.5 }],
    ["zero ttlMs", { ...event, ttlMs: 0 }],
    ["fractional ttlMs", { ...event, ttlMs: 1.5 }],
    ["null voice", { ...event, voice: null }],
    ["unknown voice kind", { ...event, voice: { kind: "start" } }],
    ["unknown voice kind near new ones", { ...event, voice: { kind: "deadlines" } }],
    ["unknown voice property", { ...event, voice: { kind: "done", future: true } }],
    ["non-object slots", { ...event, voice: { kind: "done", slots: [] } }],
    ["unknown slot", { ...event, voice: { kind: "done", slots: { unknown: "value" } } }],
    ["numeric slot", { ...event, voice: { kind: "done", slots: { task: 1 } } }],
    ["501 Unicode code point slot", { ...event, voice: { kind: "done", slots: { message: "😀".repeat(501) } } }],
    ["control character slot", { ...event, voice: { kind: "done", slots: { message: "line\nbreak" } } }],
    ["tab slot", { ...event, voice: { kind: "done", slots: { message: "a\tb" } } }],
    ["null input", null],
    ["array input", []],
    ["primitive input", "event"],
  ])("rejects %s", (_label, input) => {
    expectRejected(validatePetEvent(input));
  });
});

describe("ReactionRule contract", () => {
  it("accepts a valid rule", () => {
    expect(validateReactionRule(rule)).toEqual({ ok: true, value: rule });
  });

  it.each([
    ["empty match", { match: {}, play: "idle" }],
  ])("accepts %s", (_label, input) => {
    expect(validateReactionRule(input)).toEqual({ ok: true, value: input });
  });

  it("allows unknown rule and match fields", () => {
    expect(validateReactionRule({ ...rule, future: true, match: { ...rule.match, future: true } }).ok).toBe(true);
  });

  it.each([
    ["unknown match mood", { ...rule, match: { mood: "angry" } }],
    ["unknown match type", { ...rule, match: { type: "message" } }],
    ["missing play", { match: { mood: "happy" } }],
    ["missing match", { play: "happy" }],
    ["unknown match priority", { ...rule, match: { priority: "critical" } }],
    ["durationMs type", { ...rule, durationMs: "2000" }],
    ["repeat type", { ...rule, repeat: "1" }],
    ["null input", null],
    ["array input", []],
    ["primitive input", 1],
  ])("rejects %s", (_label, input) => {
    expectRejected(validateReactionRule(input));
  });
});

describe("CharacterManifest contract", () => {
  it("adds an optional sequences path without changing apiVersion or PetEvent", () => {
    const withSequences = { ...mochi, sequences: "sequences.json" };
    expect(validateCharacterManifest(withSequences)).toEqual({ ok: true, value: withSequences });
    expect(characterManifestSchema.properties.apiVersion.const).toBe("1");
    expect(characterManifestSchema.required).not.toContain("sequences");
    expect(validatePetEvent(event)).toEqual({ ok: true, value: event });
  });
  it("adds an optional reactions path without changing apiVersion or PetEvent", () => {
    const withReactions = { ...mochi, reactions: "reactions.json" };
    expect(validateCharacterManifest(withReactions)).toEqual({ ok: true, value: withReactions });
    expect(characterManifestSchema.required).not.toContain("reactions");
    expect(validatePetEvent(event)).toEqual({ ok: true, value: event });
  });
  it("accepts the mochi manifest", () => {
    expect(validateCharacterManifest(mochi)).toEqual({ ok: true, value: mochi });
  });

  it.each([
    ["sleepAfterMs", 5_000, 3_600_000],
    ["walkDurationMs", 500, 30_000],
    ["walkSpeedPxPerSecond", 0, 300],
    ["climbChance", 0, 1],
    ["descendChance", 0, 1],
    ["jumpMaxHeight", 0, 2000],
    ["climbSpeed", 20, 1000],
    ["jumpClearance", 0, 300],
    ["gravity", 200, 10000],
    ["gapJumpDistance", 0, 1000],
    ["gapJumpChance", 0, 1],
  ])("accepts both %s boundaries and rejects values outside them", (field, min, max) => {
    for (const value of [min, max])
      expect(validateCharacterManifest({ ...mochi, behavior: { [field]: value } }).ok).toBe(true);
    for (const value of [min - 1, max + 1, "1", null, Infinity])
      expectRejected(validateCharacterManifest({ ...mochi, behavior: { [field]: value } }));
    if (!["walkSpeedPxPerSecond", "climbChance", "descendChance", "jumpMaxHeight", "climbSpeed", "jumpClearance", "gravity", "gapJumpDistance", "gapJumpChance"].includes(field))
      expectRejected(validateCharacterManifest({ ...mochi, behavior: { [field]: min + 0.5 } }));
  });

  it.each([
    ["blinkIntervalMs", 1_000, 60_000],
    ["walkIntervalMs", 1_000, 600_000],
  ])("accepts %s boundaries and rejects malformed intervals", (field, min, max) => {
    for (const value of [[min, min], [max, max], [min, max]])
      expect(validateCharacterManifest({ ...mochi, behavior: { [field]: value } }).ok).toBe(true);
    for (const value of [[min - 1, min], [max, max + 1], [max, min], [min], [min, max, max],
      [min + 0.5, max], [min, max + 0.5], "1,2", null])
      expectRejected(validateCharacterManifest({ ...mochi, behavior: { [field]: value } }));
  });

  it("keeps behavior optional and ignores unknown behavior keys", () => {
    expect(validateCharacterManifest(mochi).ok).toBe(true);
    expect(validateCharacterManifest({ ...mochi, behavior: { future: true } }).ok).toBe(true);
    expectRejected(validateCharacterManifest({ ...mochi, behavior: null }));
    const schema = characterManifestSchema.properties.behavior;
    expect(schema.additionalProperties).toBe(true);
    expect(schema.properties.sleepAfterMs).toEqual({ type: "integer", minimum: BEHAVIOR_RANGES.sleepAfterMs[0], maximum: BEHAVIOR_RANGES.sleepAfterMs[1] });
    expect(schema.properties.walkSpeedPxPerSecond).toEqual({ type: "number", minimum: 0, maximum: 300 });
    expect(schema.properties.climbChance).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties.descendChance).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties.jumpMaxHeight).toEqual({ type: "number", minimum: 0, maximum: 2000 });
    expect(schema.properties.climbSpeed).toEqual({ type: "number", minimum: 20, maximum: 1000 });
    expect(schema.properties.jumpClearance).toEqual({ type: "number", minimum: 0, maximum: 300 });
    expect(schema.properties.gravity).toEqual({ type: "number", minimum: 200, maximum: 10000 });
    expect(schema.properties.gapJumpDistance).toEqual({ type: "number", minimum: 0, maximum: 1000 });
    expect(schema.properties.gapJumpChance).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties.blinkIntervalMs.prefixItems).toEqual([
      { type: "integer", minimum: 1_000, maximum: 60_000 },
      { type: "integer", minimum: 1_000, maximum: 60_000 },
    ]);
    expect(schema.properties.walkIntervalMs.prefixItems).toEqual([
      { type: "integer", minimum: 1_000, maximum: 600_000 },
      { type: "integer", minimum: 1_000, maximum: 600_000 },
    ]);
  });

  it.each([
    ["one frame", { ...mochi, states: { ...mochi.states, idle: { ...mochi.states.idle, frames: 1 } } }],
  ])("accepts %s", (_label, input) => {
    expect(validateCharacterManifest(input)).toEqual({ ok: true, value: input });
  });

  it("allows unknown manifest and state fields", () => {
    expect(validateCharacterManifest({ ...mochi, future: true, states: { ...mochi.states, idle: { ...mochi.states.idle, future: true } } }).ok).toBe(true);
  });

  it.each([
    ["unsupported apiVersion", { ...mochi, apiVersion: "2" }],
    ["numeric apiVersion", { ...mochi, apiVersion: 1 }],
    ["zero frames", { ...mochi, states: { idle: { ...mochi.states.idle, frames: 0 } } }],
    ["negative frames", { ...mochi, states: { idle: { ...mochi.states.idle, frames: -1 } } }],
    ["fractional frames", { ...mochi, states: { idle: { ...mochi.states.idle, frames: 1.5 } } }],
    ["cellSize length one", { ...mochi, cellSize: [256] }],
    ["cellSize length three", { ...mochi, cellSize: [256, 256, 256] }],
    ["anchor length one", { ...mochi, anchor: [128] }],
    ["anchor length three", { ...mochi, anchor: [128, 240, 0] }],
    ["loop type", { ...mochi, states: { idle: { ...mochi.states.idle, loop: "yes" } } }],
    ["missing id", { ...mochi, id: undefined }],
    ["missing name", { ...mochi, name: undefined }],
    ["missing apiVersion", { ...mochi, apiVersion: undefined }],
    ["missing cellSize", { ...mochi, cellSize: undefined }],
    ["missing anchor", { ...mochi, anchor: undefined }],
    ["missing scale", { ...mochi, scale: undefined }],
    ["missing states", { id: "mochi", name: "모치", apiVersion: "1", cellSize: [256, 256], anchor: [128, 240], scale: 0.6, fallbacks: {} }],
    ["missing fallbacks", { id: "mochi", name: "모치", apiVersion: "1", cellSize: [256, 256], anchor: [128, 240], scale: 0.6, states: mochi.states }],
    ["missing sheet", { ...mochi, states: { idle: { frames: 1, fps: 8, loop: true } } }],
    ["missing frames", { ...mochi, states: { idle: { sheet: "sheets/idle.png", fps: 8, loop: true } } }],
    ["missing fps", { ...mochi, states: { idle: { sheet: "sheets/idle.png", frames: 1, loop: true } } }],
    ["missing loop", { ...mochi, states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 8 } } }],
    ["reactions path with wrong extension", { ...mochi, reactions: "reactions.txt" }],
    ["reactions path escaping the pack", { ...mochi, reactions: "../reactions.json" }],
    ["null input", null],
    ["array input", []],
    ["primitive input", false],
  ])("rejects %s", (_label, input) => {
    expectRejected(validateCharacterManifest(input));
  });
});
