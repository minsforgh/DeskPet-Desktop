import { describe, expect, it } from "vitest";
import { parseReactions, sequenceIdPattern, stateNamePattern } from "./index.js";

const kinds = {
  done: { sequence: "greet" }, waiting: { play: "sleep" }, failed: { play: "worried" },
  info: { sequence: "0" }, deadline: { play: "surprised" }, reminder: { sequence: "notify-me" },
  alert: { play: "talk" },
};

describe("M7 reactions file", () => {
  it("loads line targets with the same play and sequence validation as kinds", () => {
    const parsed = parseReactions({ version: 1, kinds: { done: { play: "happy" } }, lines: {
      "fixture.done": { sequence: "notice" }, "fixture.bad": { play: "../bad" },
    } });
    expect(parsed.reactions.kinds).toEqual({ done: { play: "happy" } });
    expect(parsed.reactions.lines).toEqual({ "fixture.done": { sequence: "notice" } });
    expect(parsed.problems).toContain("lines.fixture.bad.play must be a safe state name of at most 32 characters");
    expect(parseReactions({ version: 1, kinds: {} }).reactions).toEqual({ kinds: {} });
  });
  it("keeps all seven known kinds in a fixed order through JSON round trips", () => {
    const input = { version: 1, kinds: {
      ...kinds, reminder: { sequence: "a".repeat(48) }, alert: { play: "a".repeat(32) } } };
    const first = parseReactions(input);
    expect(first.problems).toEqual([]);
    expect(Object.keys(first.reactions.kinds)).toEqual(
      ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"]);
    expect(first.reactions.kinds.reminder).toEqual({ sequence: "a".repeat(48) });
    const second = parseReactions(JSON.parse(JSON.stringify({ version: 1, kinds: first.reactions.kinds })));
    expect(second).toEqual(first);
  });

  it.each([null, [], {}, { version: 2, kinds: {} }, { version: 1, kinds: null }, { version: 1, kinds: [] },
    { version: 1 }])("returns empty data for malformed files", (input) => {
    const result = parseReactions(input);
    expect(result.reactions.kinds).toEqual({});
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("drops unknown kind keys and keeps the known ones", () => {
    const result = parseReactions({ version: 1, kinds: { ...kinds, mood: { play: "idle" }, deadlines: {} } });
    expect(result.reactions.kinds).toEqual(kinds);
    expect(result.problems.some((problem) => problem.includes("mood"))).toBe(true);
    expect(result.problems.some((problem) => problem.includes("deadlines"))).toBe(true);
  });

  it("uses sequence when both play and sequence exist and warns", () => {
    const result = parseReactions({ version: 1, kinds: { done: { play: "happy", sequence: "greet" } } });
    expect(result.reactions.kinds.done).toEqual({ sequence: "greet" });
    expect(result.problems.some((problem) => problem.includes("sequence is used"))).toBe(true);
  });

  it("checks play and sequence with their actual patterns", () => {
    for (const play of ["a", "bow-2", "a".repeat(32)]) {
      expect(stateNamePattern.test(play)).toBe(true);
      expect(parseReactions({ version: 1, kinds: { done: { play } } }).reactions.kinds.done).toEqual({ play });
    }
    for (const play of ["", "2bow", "Bow", "a".repeat(33), "a_b", "../a", "constructor", "prototype", "__proto__"]) {
      if (!["constructor", "prototype", "__proto__"].includes(play)) expect(stateNamePattern.test(play)).toBe(false);
      const result = parseReactions({ version: 1, kinds: { done: { play } } });
      expect(result.reactions.kinds).toEqual({});
      expect(result.problems.length).toBeGreaterThan(0);
    }
    for (const sequence of ["0", "greet-2", "a".repeat(48)]) {
      expect(sequenceIdPattern.test(sequence)).toBe(true);
      expect(parseReactions({ version: 1, kinds: { done: { sequence } } }).reactions.kinds.done).toEqual({ sequence });
    }
    for (const sequence of ["", "-a", "A", "a".repeat(49), "a_b", "../a", "constructor", "prototype"]) {
      if (!["constructor", "prototype"].includes(sequence)) expect(sequenceIdPattern.test(sequence)).toBe(false);
      const result = parseReactions({ version: 1, kinds: { done: { sequence } } });
      expect(result.reactions.kinds).toEqual({});
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["empty object", {}],
    ["unknown field only", { future: true }],
    ["string value", "idle"],
    ["number value", 1],
    ["null value", null],
    ["array value", []],
    ["null play", { play: null }],
    ["number sequence", { sequence: 1 }],
    ["invalid sequence with valid play", { play: "happy", sequence: "../a" }],
  ])("drops the %s kind and keeps the next one", (_label, target) => {
    const result = parseReactions({ version: 1, kinds: { done: target, failed: { play: "worried" } } });
    expect(result.reactions.kinds).toEqual({ failed: { play: "worried" } });
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("rejects JSON depth and forbidden prototype keys", () => {
    expect(parseReactions(JSON.parse('{"version":1,"kinds":{},"__proto__":{}}')).problems).toContain("JSON key __proto__ is forbidden");
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let depth = 0; depth < 9; depth += 1) {
      const child: Record<string, unknown> = {};
      node.next = child;
      node = child;
    }
    expect(parseReactions({ version: 1, kinds: kinds, extra: deep }).reactions.kinds).toEqual({});
  });
});
