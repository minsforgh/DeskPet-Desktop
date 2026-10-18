import { describe, expect, it } from "vitest";
import { parseSequences, sequenceIdPattern, stateNamePattern } from "./index.js";

const item = { id: "greet", label: "인사", steps: [{ play: "bow", ms: 300, say: "안녕 😀" }] };
const parse = (items: unknown[]) => parseSequences({ version: 1, sequences: items });

describe("M7 sequences file", () => {
  it("preserves valid steps and optional fields", () => {
    const input = { ...item, steps: [item.steps[0], { play: "happy" }] };
    expect(parse([input])).toEqual({ sequences: { sequences: [input] }, problems: [] });
    expect(parse([{ id: "0", steps: [{ play: "idle" }] }]).sequences.sequences).toHaveLength(1);
  });

  it.each([null, [], {}, { version: 2, sequences: [] }, { version: 1, sequences: null }])(
    "returns empty data for malformed files", (input) => {
      const result = parseSequences(input);
      expect(result.sequences.sequences).toEqual([]);
      expect(result.problems.length).toBeGreaterThan(0);
    });

  it("enforces id and state patterns with allowed and rejected examples", () => {
    for (const id of ["0", "greet-2", "a".repeat(48)]) {
      expect(sequenceIdPattern.test(id)).toBe(true);
      expect(parse([{ ...item, id }]).sequences.sequences).toHaveLength(1);
    }
    for (const id of ["", "-a", "A", "a".repeat(49), "a_b", "../a", "constructor", "prototype"]) {
      if (!["constructor", "prototype"].includes(id)) expect(sequenceIdPattern.test(id)).toBe(false);
      expect(parse([{ ...item, id }]).sequences.sequences).toHaveLength(0);
    }
    for (const play of ["a", "bow-2", "a".repeat(32)]) {
      expect(stateNamePattern.test(play)).toBe(true);
      expect(parse([{ ...item, steps: [{ play }] }]).sequences.sequences).toHaveLength(1);
    }
    for (const play of ["", "2bow", "Bow", "a".repeat(33), "a_b", "walk", "drag", "constructor"]) {
      if (!["walk", "drag", "constructor"].includes(play)) expect(stateNamePattern.test(play)).toBe(false);
      expect(parse([{ ...item, steps: [{ play }] }]).sequences.sequences).toHaveLength(0);
    }
  });

  it("accepts text and step boundaries and rejects values outside them", () => {
    for (const field of ["label", "say"] as const) {
      const withText = (text: unknown) => field === "label" ? { ...item, label: text } :
        { ...item, steps: [{ play: "bow", say: text }] };
      expect(parse([withText("😀".repeat(120))]).sequences.sequences).toHaveLength(1);
      for (const text of ["😀".repeat(121), "a\n", "a\u202e", 1, null])
        expect(parse([withText(text)]).sequences.sequences).toHaveLength(0);
    }
    for (const ms of [300, 10_000]) expect(parse([{ ...item, steps: [{ play: "bow", ms }] }]).sequences.sequences).toHaveLength(1);
    for (const ms of [299, 10_001, 300.5, "300", null]) expect(parse([{ ...item, steps: [{ play: "bow", ms }] }]).sequences.sequences).toHaveLength(0);
    for (const count of [1, 8]) expect(parse([{ ...item, steps: Array.from({ length: count }, () => ({ play: "bow" })) }]).sequences.sequences).toHaveLength(1);
    for (const count of [0, 9]) expect(parse([{ ...item, steps: Array.from({ length: count }, () => ({ play: "bow" })) }]).sequences.sequences).toHaveLength(0);
  });

  it("drops later duplicates, invalid entries, and entries beyond 32", () => {
    const result = parse([item, { ...item, label: "duplicate" },
      ...Array.from({ length: 31 }, (_, index) => ({ ...item, id: `item-${index}` }))]);
    expect(result.sequences.sequences).toHaveLength(31);
    expect(result.sequences.sequences[0]).toEqual(item);
    expect(result.problems.some((problem) => problem.includes("duplicated"))).toBe(true);
    expect(result.problems.some((problem) => problem.includes("first 32"))).toBe(true);
    expect(parse([{ ...item, steps: [null] }, { ...item, id: "good" }]).sequences.sequences.map((entry) => entry.id)).toEqual(["good"]);
  });

  it("rejects JSON depth and forbidden prototype keys", () => {
    expect(parseSequences(JSON.parse('{"version":1,"sequences":[],"__proto__":{}}')).problems).toContain("JSON key __proto__ is forbidden");
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let depth = 0; depth < 9; depth += 1) {
      const child: Record<string, unknown> = {};
      node.next = child;
      node = child;
    }
    expect(parseSequences({ version: 1, sequences: [item], extra: deep }).sequences.sequences).toEqual([]);
  });
});
