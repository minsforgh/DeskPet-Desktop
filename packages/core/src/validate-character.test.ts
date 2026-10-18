import { describe, expect, it } from "vitest";
import { characterManifestSchema, validateCharacterManifest } from "./index.js";

const valid = {
  id: "test", name: "Test", apiVersion: "1", cellSize: [32, 48], anchor: [0, 47], scale: 4,
  states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 60, loop: true } },
  fallbacks: { missing: "idle" },
};

describe("M2 character manifest rules", () => {
  it("accepts either facing value and the legacy absence, and rejects other values", () => {
    for (const facing of ["left", "right"]) {
      expect(validateCharacterManifest({ ...valid, states: { idle: { ...valid.states.idle, facing } } }).ok).toBe(true);
    }
    expect(validateCharacterManifest(valid).ok).toBe(true);
    for (const facing of ["front", null, 1]) {
      const result = validateCharacterManifest({ ...valid, states: { idle: { ...valid.states.idle, facing } } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContain("states.idle.facing must be left or right");
    }
  });
  it("accepts boundary values, unknown fields, and a fallback key absent from states", () => {
    const input = { ...valid, future: true, states: { idle: { ...valid.states.idle, future: true } } };
    expect(validateCharacterManifest(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ["cellSize[0]", { cellSize: [0, 48] }],
    ["cellSize[1]", { cellSize: [32, 1.5] }],
    ["anchor[0]", { anchor: [-1, 47] }],
    ["anchor[1]", { anchor: [0, 48] }],
    ["scale", { scale: 0 }],
    ["scale", { scale: 4.1 }],
    ["states.idle", { states: {} }],
    ["states.idle.fps", { states: { idle: { ...valid.states.idle, fps: 0 } } }],
    ["states.idle.fps", { states: { idle: { ...valid.states.idle, fps: 61 } } }],
    ["states.idle.next", { states: { idle: { ...valid.states.idle, next: "missing" } } }],
    ["fallbacks.missing", { fallbacks: { missing: "absent" } }],
  ])("rejects invalid %s", (field, patch) => {
    const result = validateCharacterManifest({ ...valid, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.includes(field))).toBe(true);
  });

  it("keeps the sheet schema pattern and validator in agreement", () => {
    const pattern = new RegExp(characterManifestSchema.properties.states.additionalProperties.properties.sheet.pattern);
    for (const sheet of ["idle.png", "sheets/idle.png", "a..b/frame.png", "nested folder/frame.png"]) {
      expect(pattern.test(sheet)).toBe(true);
      expect(validateCharacterManifest({ ...valid, states: { idle: { ...valid.states.idle, sheet } } }).ok).toBe(true);
    }
    for (const sheet of ["", "../idle.png", "sheets/../idle.png", "/idle.png", "C:/idle.png",
      "https://example.com/idle.png", "sheets\\idle.png", "./idle.png", "sheets//idle.png",
      "sheets/idle.", "sheets/idle ", "sheets/\n../idle.png", "./C:/idle.png",
      "sheets/\0idle.png", "\\\\server\\share\\idle.png"]) {
      expect(pattern.test(sheet)).toBe(false);
      expect(validateCharacterManifest({ ...valid, states: { idle: { ...valid.states.idle, sheet } } }).ok).toBe(false);
    }
  });

  it("accepts a voice file path inside the pack and rejects paths that leave it", () => {
    for (const voice of ["voice.json", "voice/ko.json"]) {
      expect(validateCharacterManifest({ ...valid, voice }).ok).toBe(true);
    }
    expect(validateCharacterManifest(valid).ok).toBe(true);
    for (const voice of ["", "../voice.json", "a/../voice.json", "/voice.json", "C:/voice.json", "a\b.json", 1, null]) {
      const result = validateCharacterManifest({ ...valid, voice });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContain("voice must be a safe pack-relative path");
    }
  });

  it("validates the optional sequences JSON path with the sheet path pattern", () => {
    const pattern = new RegExp(characterManifestSchema.properties.sequences.pattern);
    expect(characterManifestSchema.properties.sequences.pattern).toBe(characterManifestSchema.properties.interactions.pattern);
    for (const sequences of ["sequences.json", "custom/동작.json"]) {
      expect(pattern.test(sequences)).toBe(true);
      expect(validateCharacterManifest({ ...valid, sequences }).ok).toBe(true);
    }
    expect(validateCharacterManifest(valid).ok).toBe(true);
    for (const sequences of ["", "../sequences.json", "a/../sequences.json", "/sequences.json",
      "C:/sequences.json", "a\\sequences.json", "sequences.txt", null, 1]) {
      if (typeof sequences === "string" && sequences !== "sequences.txt") expect(pattern.test(sequences)).toBe(false);
      expect(validateCharacterManifest({ ...valid, sequences }).ok).toBe(false);
    }
  });

  it("validates the optional reactions JSON path with the sheet path pattern", () => {
    const pattern = new RegExp(characterManifestSchema.properties.reactions.pattern);
    expect(characterManifestSchema.properties.reactions.pattern).toBe(characterManifestSchema.properties.interactions.pattern);
    for (const reactions of ["reactions.json", "custom/반응.json"]) {
      expect(pattern.test(reactions)).toBe(true);
      expect(validateCharacterManifest({ ...valid, reactions }).ok).toBe(true);
    }
    expect(validateCharacterManifest(valid).ok).toBe(true);
    for (const reactions of ["", "../reactions.json", "a/../reactions.json", "/reactions.json",
      "C:/reactions.json", "a\\reactions.json", "reactions.txt", null, 1]) {
      if (typeof reactions === "string" && reactions !== "reactions.txt") expect(pattern.test(reactions)).toBe(false);
      expect(validateCharacterManifest({ ...valid, reactions }).ok).toBe(false);
    }
  });
});
