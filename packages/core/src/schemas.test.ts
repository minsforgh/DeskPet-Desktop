import { describe, expect, it } from "vitest";
import {
  characterManifestSchema,
  petEventSchema,
  reactionRuleSchema,
} from "@deskpet/core";

describe("core contract schemas", () => {
  it("declares draft 2020-12 and required fields", () => {
    for (const schema of [petEventSchema, reactionRuleSchema, characterManifestSchema]) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.type).toBe("object");
    }
    expect(petEventSchema.required).toEqual(["source", "type"]);
    expect(reactionRuleSchema.required).toEqual(["match", "play"]);
    expect(characterManifestSchema.required).toContain("fallbacks");
  });

  it("retains explicit limits and enum values", () => {
    expect(petEventSchema.properties.text.maxLength).toBe(120);
    expect(petEventSchema.properties.voice.required).toEqual(["kind"]);
    expect(petEventSchema.properties.line.required).toEqual(["id"]);
    expect(petEventSchema.properties.line.properties.vars.additionalProperties.maxLength).toBe(500);
    expect(petEventSchema.properties.voice.properties.kind.enum).toEqual(["done", "waiting", "failed", "info", "deadline", "reminder", "alert"]);
    expect(petEventSchema.properties.voice.properties.slots.additionalProperties).toBe(false);
    const slot = petEventSchema.properties.voice.properties.slots.properties.task;
    expect(slot.maxLength).toBe(500);
    const pattern = new RegExp(slot.pattern);
    expect(pattern.test("한글 😀 = value")).toBe(true);
    expect(pattern.test("line\nbreak")).toBe(false);
    expect(pattern.test("a\tb")).toBe(false);
    expect(pattern.test("a\u007fb")).toBe(false);
    expect(petEventSchema.properties.actions.maxItems).toBe(3);
    expect(petEventSchema.properties.type.enum).toEqual(["notify", "react", "status"]);
    expect(reactionRuleSchema.properties.match.properties.mood.enum).toEqual([
      "happy", "surprised", "sleepy", "worried", "neutral",
    ]);
    expect(characterManifestSchema.properties.apiVersion.const).toBe("1");
    expect(characterManifestSchema.properties.sequences.pattern).toBe(characterManifestSchema.properties.interactions.pattern);
    expect(characterManifestSchema.properties.reactions.pattern).toBe(characterManifestSchema.properties.interactions.pattern);
    expect(characterManifestSchema.properties.states.additionalProperties.properties.frames).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 64,
    });
    expect(characterManifestSchema.properties.states.additionalProperties.properties.facing).toEqual({ enum: ["left", "right"] });
    expect(characterManifestSchema.properties.states.additionalProperties.required).not.toContain("facing");
    expect(petEventSchema.properties.ttlMs).toEqual({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    expect(petEventSchema.properties.timestamp).toEqual({ type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
    expect(petEventSchema.additionalProperties).toBe(true);
    expect(petEventSchema.properties.actions.items.additionalProperties).toBe(true);
    expect(reactionRuleSchema.additionalProperties).toBe(true);
    expect(reactionRuleSchema.properties.match.additionalProperties).toBe(true);
    expect(characterManifestSchema.additionalProperties).toBe(true);
    expect(characterManifestSchema.properties.states.additionalProperties.additionalProperties).toBe(true);
  });

  it("declares M2 numeric bounds and required idle state", () => {
    expect(characterManifestSchema.properties.cellSize.prefixItems).toEqual([
      { type: "integer", minimum: 1, maximum: 1024 }, { type: "integer", minimum: 1, maximum: 1024 },
    ]);
    expect(characterManifestSchema.properties.anchor.prefixItems).toEqual([
      { type: "integer", minimum: 0 }, { type: "integer", minimum: 0 },
    ]);
    expect(characterManifestSchema.properties.scale).toEqual({ type: "number", exclusiveMinimum: 0, maximum: 4 });
    expect(characterManifestSchema.properties.states.required).toContain("idle");
    expect(characterManifestSchema.properties.states.additionalProperties.properties.fps).toEqual({ type: "number", exclusiveMinimum: 0, maximum: 60 });
  });

  it("declares M3 reaction bounds and reuses the actual sheet path pattern", () => {
    expect(reactionRuleSchema.properties.durationMs).toEqual({ type: "integer", minimum: 1, maximum: 60_000 });
    expect(reactionRuleSchema.properties.repeat).toEqual({ type: "integer", minimum: 1, maximum: 10 });
    const sheetPattern = characterManifestSchema.properties.states.additionalProperties.properties.sheet.pattern;
    expect(reactionRuleSchema.properties.sound.pattern).toBe(sheetPattern);
    const soundPattern = new RegExp(reactionRuleSchema.properties.sound.pattern);
    for (const value of ["sounds/warning.wav", "warning.wav", "한글/알림.wav"]) expect(soundPattern.test(value)).toBe(true);
    for (const value of ["", "../warning.wav", "sounds/../warning.wav", "/warning.wav", "C:/warning.wav", "sounds\\warning.wav", "sounds//warning.wav", "sounds/file. "]) expect(soundPattern.test(value)).toBe(false);
  });
});
