import { describe, expect, it } from "vitest";
import { parseInteractions, sequenceIdPattern, stateNamePattern } from "./index.js";

const item = { id: "pat", label: "쓰다듬기", mood: "happy", bubble: true, lines: ["좋아요!"] };

describe("M6 interactions file", () => {
  it("preserves optional play and sequence through JSON round trips", () => {
    const input = { version: 1, items: [{ ...item, play: "bow", sequence: "greet-1" }] };
    const first = parseInteractions(input);
    expect(first.problems).toEqual([]);
    const second = parseInteractions(JSON.parse(JSON.stringify({ version: 1, items: first.interactions.items })));
    expect(second.interactions.items).toEqual(input.items);
    expect(parseInteractions({ version: 1, items: [item] }).interactions.items).toEqual([item]);
  });

  it("checks play and sequence with their actual patterns and drops invalid entries", () => {
    for (const play of ["a", "bow-2", "a".repeat(32)]) {
      expect(stateNamePattern.test(play)).toBe(true);
      expect(parseInteractions({ version: 1, items: [{ ...item, play }] }).interactions.items).toHaveLength(1);
    }
    for (const play of ["", "2bow", "Bow", "a".repeat(33), "bow_2", "walk/idle", "constructor"]) {
      if (play !== "constructor") expect(stateNamePattern.test(play)).toBe(false);
      expect(parseInteractions({ version: 1, items: [{ ...item, play }] }).interactions.items).toHaveLength(0);
    }
    for (const sequence of ["0", "greet-2", "a".repeat(48)]) {
      expect(sequenceIdPattern.test(sequence)).toBe(true);
      expect(parseInteractions({ version: 1, items: [{ ...item, sequence }] }).interactions.items).toHaveLength(1);
    }
    for (const sequence of ["", "-greet", "Greet", "a".repeat(49), "a_b", "../greet", "constructor"]) {
      if (sequence !== "constructor") expect(sequenceIdPattern.test(sequence)).toBe(false);
      expect(parseInteractions({ version: 1, items: [{ ...item, sequence }] }).interactions.items).toHaveLength(0);
    }
  });
  it("keeps valid items in order and hidden built-in ids", () => {
    expect(parseInteractions({ version: 1, items: [item, { ...item, id: "talk", mood: "neutral", bubble: false, lines: [] }],
      hidden: ["default-talk"] })).toEqual({ interactions: { items: [item, { ...item, id: "talk", mood: "neutral", bubble: false, lines: [] }],
      hidden: ["default-talk"] }, problems: [] });
  });

  it.each([null, [], {}, { version: 2, items: [] }, { version: 1, items: null }])(
    "returns empty data for malformed files", (input) => {
      const result = parseInteractions(input);
      expect(result.interactions.items).toEqual([]);
      expect(result.problems.length).toBeGreaterThan(0);
    });

  it.each([
    ["id", { id: "Pat" }], ["id", { id: "a".repeat(33) }], ["id", { id: "constructor" }],
    ["id", { id: "prototype" }], ["label", { label: "a".repeat(21) }],
    ["label", { label: "a\n" }], ["mood", { mood: "angry" }], ["bubble", { bubble: "true" }],
    ["lines", { lines: Array(17).fill("line") }], ["lines", { lines: ["a".repeat(121)] }],
  ])("drops an item with invalid %s and keeps the next one", (field, patch) => {
    const result = parseInteractions({ version: 1, items: [{ ...item, ...patch }, { ...item, id: "good" }] });
    expect(result.interactions.items.map((entry) => entry.id)).toEqual(["good"]);
    expect(result.problems.some((problem) => problem.includes(field))).toBe(true);
  });

  it("drops duplicate ids, invalid hidden ids, and entries beyond 32", () => {
    const result = parseInteractions({ version: 1,
      items: [item, item, ...Array.from({ length: 31 }, (_, index) => ({ ...item, id: `item-${index}` }))],
      hidden: ["talk", "talk", "constructor", ...Array.from({ length: 31 }, (_, index) => `hide-${index}`)] });
    expect(result.interactions.items).toHaveLength(31);
    expect(result.interactions.hidden).toHaveLength(30);
    expect(result.problems.some((problem) => problem.includes("duplicated"))).toBe(true);
    expect(result.problems.some((problem) => problem.includes("first 32"))).toBe(true);
  });

  it("rejects deep and prototype-key JSON without throwing", () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let depth = 0; depth < 9; depth += 1) {
      const child: Record<string, unknown> = {};
      node.next = child;
      node = child;
    }
    expect(parseInteractions({ version: 1, items: [item], extra: deep }).interactions.items).toEqual([]);
    expect(parseInteractions(JSON.parse('{"version":1,"items":[],"__proto__":{}}')).problems).toContain("JSON key __proto__ is forbidden");
  });

  it("accepts each event mood and reports an enabled empty bubble", () => {
    const moods = ["happy", "surprised", "sleepy", "worried", "neutral"];
    const result = parseInteractions({ version: 1, items: moods.map((mood) => ({ ...item, id: mood, mood, lines: [] })) });
    expect(result.interactions.items.map((entry) => entry.mood)).toEqual(moods);
    expect(result.problems).toHaveLength(5);
  });
});
