import { describe, expect, it } from "vitest";
import { characterManifestSchema, mergeCharacterManifest, userCharacterIdPattern,
  validUserCharacterId, validateCharacterManifest } from "./index.js";

const base = {
  id: "wolf-maid", name: "Wolf", apiVersion: "1", cellSize: [32, 48], anchor: [16, 47], scale: 2,
  states: {
    idle: { sheet: "sheets/idle.png", frames: 2, fps: 8, loop: true, next: "idle" },
    happy: { sheet: "sheets/happy.png", frames: 1, fps: 6, loop: true },
  },
  fallbacks: { rest: "idle" }, voice: "voice.json", interactions: "interactions.json",
  meta: { author: "original", version: "1" }, preview: "preview.png",
};
const derived = { id: "wolf-maid-mine", name: "Mine", apiVersion: "1", extends: "wolf-maid" };

describe("M6 character pack inheritance", () => {
  it("inherits source art and optional files, replacing only specified settings", () => {
    const result = mergeCharacterManifest(base, { ...derived, scale: 3, meta: { author: "me" },
      preview: "mine.png", voice: "mine-voice.json", interactions: "mine-interactions.json",
      states: { idle: { fps: 12, loop: false, next: "happy" } }, fallbacks: { rest: "happy" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ id: derived.id, name: "Mine", cellSize: [32, 48],
      anchor: [16, 47], scale: 3, voice: "mine-voice.json", interactions: "mine-interactions.json",
      preview: "mine.png", meta: { author: "me", version: "1" }, fallbacks: { rest: "happy" },
      states: { idle: { sheet: "sheets/idle.png", frames: 2, fps: 12, loop: false, next: "happy" } } });
    expect(validateCharacterManifest(result.value).ok).toBe(true);
    expect(base.states.idle.fps).toBe(8);
  });

  it.each([
    ["sheet", { states: { idle: { sheet: "other.png" } } }],
    ["frames", { states: { idle: { frames: 1 } } }],
    ["cellSize", { cellSize: [32, 48] }],
    ["anchor", { anchor: [16, 47] }],
    ["add a state", { states: { new: { fps: 8 } } }],
    ["fps", { states: { idle: { fps: 0 } } }],
    ["fallbacks", { fallbacks: { rest: "missing" } }],
    ["next", { states: { idle: { next: "missing" } } }],
  ])("rejects forbidden or invalid %s overrides", (_reason, patch) => {
    expect(mergeCharacterManifest(base, { ...derived, ...patch }).ok).toBe(false);
  });

  it("rejects missing, chained, and circular bases", () => {
    expect(mergeCharacterManifest(base, { ...derived, extends: "missing" }).ok).toBe(false);
    expect(mergeCharacterManifest({ ...base, extends: "another" }, derived).ok).toBe(false);
    expect(mergeCharacterManifest(base, { ...derived, id: "wolf-maid" }).ok).toBe(false);
  });

  it("rejects malformed nested input and prototype keys", () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let depth = 0; depth < 9; depth += 1) {
      const child: Record<string, unknown> = {};
      node.child = child;
      node = child;
    }
    expect(mergeCharacterManifest(base, { ...derived, extra: deep }).ok).toBe(false);
    expect(mergeCharacterManifest(base, JSON.parse(`{"id":"mine","name":"Mine","apiVersion":"1","extends":"wolf-maid","fallbacks":{"__proto__":"idle"}}`)).ok).toBe(false);
  });

  it("merges behavior by key and validates derived values", () => {
    const source = { ...base, behavior: { sleepAfterMs: 30_000, blinkIntervalMs: [2_000, 4_000], walkDurationMs: 2_000 } };
    const result = mergeCharacterManifest(source, { ...derived, behavior: { blinkIntervalMs: [3_000, 6_000], walkSpeedPxPerSecond: 0 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.behavior).toEqual({ sleepAfterMs: 30_000,
      blinkIntervalMs: [3_000, 6_000], walkDurationMs: 2_000, walkSpeedPxPerSecond: 0 });
    expect(source.behavior.blinkIntervalMs).toEqual([2_000, 4_000]);
    expect(mergeCharacterManifest(source, { ...derived, behavior: { walkDurationMs: 30_001 } }).ok).toBe(false);
    expect(mergeCharacterManifest(source, { ...derived, behavior: null }).ok).toBe(false);
  });

  it("inherits or completely replaces the sequences file path", () => {
    const source = { ...base, sequences: "sequences.json" };
    const inherited = mergeCharacterManifest(source, derived);
    expect(inherited.ok).toBe(true);
    if (inherited.ok) expect(inherited.value.sequences).toBe("sequences.json");
    const replaced = mergeCharacterManifest(source, { ...derived, sequences: "custom/mine.json" });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.value.sequences).toBe("custom/mine.json");
    expect(source.sequences).toBe("sequences.json");
  });

  it("inherits or completely replaces the reactions file path", () => {
    const source = { ...base, reactions: "reactions.json" };
    const inherited = mergeCharacterManifest(source, derived);
    expect(inherited.ok).toBe(true);
    if (inherited.ok) expect(inherited.value.reactions).toBe("reactions.json");
    const replaced = mergeCharacterManifest(source, { ...derived, reactions: "custom/mine-reactions.json" });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.value.reactions).toBe("custom/mine-reactions.json");
    expect(source.reactions).toBe("reactions.json");
  });

  it("accepts and rejects ids with the actual pattern and Windows reserved names", () => {
    const pattern = new RegExp(userCharacterIdPattern);
    for (const id of ["placeholder", "placeholder-alt", "wolf-maid", "mochi", "a", "a".repeat(48)]) {
      expect(pattern.test(id)).toBe(true);
      expect(validUserCharacterId(id)).toBe(true);
    }
    for (const id of ["", "A", "-a", "a".repeat(49), "a_b", "a.", "a ", "../a", "a/b", "C:\\a", "con", "nul", "com1", "lpt9"]) {
      if (!["con", "nul", "com1", "lpt9"].includes(id)) expect(pattern.test(id)).toBe(false);
      expect(validUserCharacterId(id)).toBe(false);
    }
  });

  it("validates extended manifest fields and path patterns", () => {
    const pathPattern = new RegExp(characterManifestSchema.properties.preview.pattern);
    for (const path of ["preview.png", "assets/preview.png"]) {
      expect(pathPattern.test(path)).toBe(true);
      expect(validateCharacterManifest({ ...base, preview: path, interactions: path.replace(/\.png$/u, ".json") }).ok).toBe(true);
    }
    for (const path of ["../preview.png", "/preview.png", "C:/preview.png", "a/../preview.png", "a\\preview.png", "a/" + "b".repeat(65)]) {
      if (!path.endsWith("b".repeat(65))) expect(pathPattern.test(path)).toBe(false);
      expect(validateCharacterManifest({ ...base, preview: path, interactions: path }).ok).toBe(false);
    }
    expect(validateCharacterManifest({ ...base, preview: "image.jpg" }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, interactions: "interactions.txt" }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, preview: `${"a/".repeat(80)}p.png` }).ok).toBe(false);
    for (const meta of [{ author: "a".repeat(81) }, { version: "v".repeat(33) },
      { license: "a\n" }, { description: "a".repeat(501) }, { createdWith: "\u202E" }])
      expect(validateCharacterManifest({ ...base, meta }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, meta: { author: "me", version: "1.2.0",
      license: "CC-BY-4.0", description: "한글 😀", createdWith: "deskpet-editor" } }).ok).toBe(true);
    expect(validateCharacterManifest({ ...base, name: "\u202E" }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, cellSize: [1025, 48] }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, cellSize: [1024, 48] }).ok).toBe(true);
    expect(validateCharacterManifest({ ...base, states: { idle: { ...base.states.idle, frames: 65 } } }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, states: { idle: { ...base.states.idle, frames: 64 } } }).ok).toBe(true);
    const manyStates = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [index === 0 ? "idle" : `s${index}`, base.states.idle]));
    expect(validateCharacterManifest({ ...base, states: manyStates }).ok).toBe(false);
    const manyKeys = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`k${index}`, index]));
    expect(validateCharacterManifest({ ...base, extra: manyKeys }).ok).toBe(false);
    expect(validateCharacterManifest({ ...base, future: true }).ok).toBe(true);
  });
});
