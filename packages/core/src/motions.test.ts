import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MOVEMENT_FALLBACKS, MOTION_KEYS, mergeCharacterManifest, parseMotions, resolveMotionPlay, validateCharacterManifest } from "./index.js";

const full = Object.fromEntries(MOTION_KEYS.map((key) => [key, { play: "happy" }]));

describe("M8 motions file", () => {
  it("keeps all nine movement keys and the landing style through JSON round trips", () => {
    const first = parseMotions({ version: 1, motions: full, landing: "soft" });
    expect(first.problems).toEqual([]);
    expect(Object.keys(first.motions.motions)).toEqual([...MOTION_KEYS]);
    expect(first.motions.landing).toBe("soft");
    const second = parseMotions(JSON.parse(JSON.stringify({ version: 1, ...first.motions })));
    expect(second).toEqual(first);
  });

  it("defaults to no mapping and normal landing", () => {
    expect(parseMotions({ version: 1 })).toEqual({ motions: { motions: {}, landing: "normal" }, problems: [] });
    expect(parseMotions({ version: 1, motions: {}, landing: "soft" }).motions.landing).toBe("soft");
  });

  it("keeps an optional afterLand state and omits only invalid afterLand entries", () => {
    expect(parseMotions({ version: 1, afterLand: { play: "curtsy" } })).toEqual({
      motions: { motions: {}, landing: "normal", afterLand: { play: "curtsy" } }, problems: [],
    });
    for (const [entry, reason] of [
      [null, "afterLand must be an object"], [{}, "afterLand must have play"],
      [{ play: "bad/name" }, "afterLand.play"], [{ play: "__proto__" }, "afterLand.play"],
      [{ play: "curtsy", sequence: "x" }, "afterLand.sequence"],
    ] as const) {
      const result = parseMotions({ version: 1, motions: { land: { play: "happy" } }, afterLand: entry });
      expect(result.motions).toEqual({ motions: { land: { play: "happy" } }, landing: "normal" });
      expect(result.problems.some((problem) => problem.includes(reason))).toBe(true);
    }
    expect(parseMotions({ version: 1 }).motions.afterLand).toBeUndefined();
  });

  it.each([null, [], {}, { version: 2, motions: {} }, { version: "1" }])("returns empty data for malformed files", (input) => {
    const result = parseMotions(input);
    expect(result.motions).toEqual({ motions: {}, landing: "normal" });
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("rejects unknown keys, sequence mappings, bad state names, and bad landing values", () => {
    const result = parseMotions({ version: 1, landing: "hard", motions: {
      land: { play: "happy" }, run: { play: "walk" }, jump: { sequence: "flip" }, fall: { play: "Bad Name" },
      climb: { play: "walk", sequence: "x" }, thrown: "happy", descend: {}, "hop-down": { play: "__proto__" } } });
    expect(result.motions.motions).toEqual({ land: { play: "happy" }, climb: { play: "walk" } });
    expect(result.motions.landing).toBe("normal");
    for (const part of ["motions.run ", "motions.jump.sequence", "motions.jump must have play", "motions.fall.play",
      "motions.climb.sequence", "motions.thrown must be an object", "motions.descend must have play",
      "motions.hop-down.play", "landing must be"]) {
      expect(result.problems.some((problem) => problem.includes(part)), part).toBe(true);
    }
  });
});

describe("M8 motions in derived packs", () => {
  const base = {
    id: "wolf-maid", name: "Wolf", apiVersion: "1", cellSize: [32, 48], anchor: [16, 47], scale: 2,
    states: { idle: { sheet: "sheets/idle.png", frames: 2, fps: 8, loop: true } }, fallbacks: {},
    motions: "motions.json",
  };
  const derived = { id: "wolf-maid-mine", name: "Mine", apiVersion: "1", extends: "wolf-maid" };

  it("inherits the original motions path or completely replaces it", () => {
    const inherited = mergeCharacterManifest(base, derived);
    expect(inherited.ok && inherited.value.motions).toBe("motions.json");
    const replaced = mergeCharacterManifest(base, { ...derived, motions: "custom/mine-motions.json" });
    expect(replaced.ok && replaced.value.motions).toBe("custom/mine-motions.json");
    const unsafe = mergeCharacterManifest(base, { ...derived, motions: "../motions.json" });
    expect(unsafe.ok).toBe(false);
    expect(base.motions).toBe("motions.json");
  });
});

describe("M8 motion play resolution", () => {
  const manifest = { states: { idle: {}, walk: {}, happy: {}, drag: {} }, fallbacks: { worried: "happy" } };
  const none = parseMotions({ version: 1 }).motions;

  it("without a mapping resolves exactly as the request name does", () => {
    expect(resolveMotionPlay("land", none, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("idle");
    expect(resolveMotionPlay("climb", none, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("walk");
    expect(resolveMotionPlay("thrown", none, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("drag");
    expect(resolveMotionPlay("jump", none, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("happy");
  });

  it("a mapped state wins, then follows pack fallbacks and app defaults", () => {
    const mapped = parseMotions({ version: 1, motions: { land: { play: "happy" }, fall: { play: "worried" },
      climb: { play: "descend" }, jump: { play: "ghost" } } }).motions;
    expect(resolveMotionPlay("land", mapped, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("happy");
    expect(resolveMotionPlay("fall", mapped, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("happy");
    expect(resolveMotionPlay("climb", mapped, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("walk");
    expect(resolveMotionPlay("jump", mapped, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("idle");
    expect(resolveMotionPlay("hop-down", mapped, manifest, DEFAULT_MOVEMENT_FALLBACKS)).toBe("drag");
  });
});

describe("M8 built-in packs", () => {
  const root = fileURLToPath(new URL("../../../characters/", import.meta.url));
  const packs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(`${root}${entry.name}/manifest.json`)).map((entry) => entry.name);

  it("keeps every built-in pack valid and gives only wolf-maid a motions file that parses cleanly", () => {
    expect(packs.length).toBeGreaterThanOrEqual(3);
    for (const id of packs) {
      const raw = JSON.parse(readFileSync(`${root}${id}/manifest.json`, "utf8")) as Record<string, unknown>;
      expect(validateCharacterManifest(raw).ok, id).toBe(true);
      if (id !== "wolf-maid") { expect(raw.motions, id).toBeUndefined(); continue; }
      expect(raw.motions).toBe("motions.json");
      const parsed = parseMotions(JSON.parse(readFileSync(`${root}${id}/motions.json`, "utf8")));
      expect(parsed.problems).toEqual([]);
      expect(parsed.motions.landing).toBe("soft");
    }
  });
});
