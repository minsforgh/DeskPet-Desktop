import { describe, expect, it } from "vitest";
import { LineRenderer, parseLines, renderLine, renderLineParts } from "./lines.js";

const line = { id: "orca.worker-succeeded", label: "Worker succeeded", kind: "done",
  variables: ["task"], variants: ["{task} finished", "Done"] };
const file = (lines: unknown[]) => ({ version: 1, lines });

describe("line catalog", () => {
  it("accepts the ADR ids and all seven kinds", () => {
    const lines = [line, { ...line, id: "claude-code.wait" },
      ...["waiting", "failed", "info", "deadline", "reminder", "alert"].map((kind) =>
        ({ ...line, id: `orca.${kind}`, kind }))];
    expect(parseLines(file(lines.slice(0, 1).concat(lines.slice(2))), "orca").problems).toEqual([]);
    expect(parseLines(file([lines[1]]), "claude-code").problems).toEqual([]);
  });

  it.each(["slack.other.id", "Orca.Done", "orca..done", "../orca.done", "", "orca.1done"])(
    "rejects invalid id %s", (id) => {
      expect(parseLines(file([{ ...line, id }]), "orca").problems).toEqual(expect.arrayContaining([expect.stringContaining("id")]));
    });

  it("rejects duplicate ids and malformed fields", () => {
    expect(parseLines(file([line, line]), "orca").problems).toContain("lines[1].id is duplicated");
    for (const changed of [
      { label: " " }, { kind: "other" }, { variables: ["Task"] }, { variables: ["task", "task"] },
      { variants: [] }, { variants: Array(9).fill("x") }, { variants: ["x".repeat(401)] },
      { variants: [" "] }, { variants: ["{other}"] }, { variants: ["{{task}}"] },
      { variants: ["{task"] }, { variants: ["x\u0001"] },
    ]) expect(parseLines(file([{ ...line, ...changed }]), "orca").problems.length).toBeGreaterThan(0);
    expect(parseLines(file([{ ...line, variants: ["😀".repeat(400)] }]), "orca").problems).toEqual([]);
    expect(parseLines(file([{ ...line, variants: ["first\nsecond"] }]), "orca").problems).toEqual([]);
  });

  it("cycles per id, skips missing variables, and inserts values once", () => {
    const catalog = parseLines(file([line, { ...line, id: "orca.other" }]), "orca").catalog;
    const renderer = new LineRenderer();
    expect(renderer.render(catalog, line.id, { task: "{task}" })).toBe("{task} finished");
    expect(renderer.render(catalog, line.id)).toBe("Done");
    expect(renderer.render(catalog, "orca.other", { task: "A" })).toBe("A finished");
    expect(renderer.render(catalog, line.id, { task: "B" })).toBe("B finished");
    expect(renderLine(catalog, line.id, {}, 0)).toBe("Done");
    expect(renderLine(parseLines(file([{ ...line, variants: ["{task}"] }]), "orca").catalog, line.id)).toBeUndefined();
  });

  it("preserves one line break, normalizes spaces, and caps code points", () => {
    const catalog = parseLines(file([{ ...line, variants: ["  A   B\n C  {task}  "] }]), "orca").catalog;
    expect(renderLine(catalog, line.id, { task: "D" })).toBe("A B\nC D");
    const long = parseLines(file([{ ...line, variants: ["😀".repeat(400)] }]), "orca").catalog;
    expect(Array.from(renderLine(long, line.id) ?? "")).toHaveLength(120);
  });

  it("validates all three structured fields and keeps variables in content", () => {
    const valid = { prefix: "Hello", content: "{task}\nready", suffix: "now" };
    expect(parseLines(file([{ ...line, variants: [valid] }]), "orca").problems).toEqual([]);
    for (const variant of [
      { ...valid, content: " " }, { ...valid, prefix: 3 }, { ...valid, suffix: null },
      { ...valid, extra: "x" }, { ...valid, prefix: "{task}" }, { ...valid, suffix: "{task}" },
      { ...valid, content: "{other}" }, { ...valid, content: "{task" },
      { ...valid, suffix: "x\u0001" }, { ...valid, content: "x".repeat(401) },
    ]) expect(parseLines(file([{ ...line, variants: [variant] }]), "orca").problems.length).toBeGreaterThan(0);
    expect(parseLines(file([{ ...line, variants: [{ prefix: "a".repeat(100), content: "b".repeat(200), suffix: "c".repeat(100) }] }]), "orca").problems).toEqual([]);
    expect(parseLines(file([{ ...line, variants: [{ prefix: "a".repeat(101), content: "b".repeat(200), suffix: "c".repeat(100) }] }]), "orca").problems.length).toBeGreaterThan(0);
  });

  it("preserves structured edges, truncates content by code point, and skips impossible variants", () => {
    const variants = [{ prefix: "P", content: "😀".repeat(200), suffix: "S" }, "fallback"];
    const catalog = parseLines(file([{ ...line, variants }]), "orca").catalog;
    const result = renderLineParts(catalog, line.id);
    expect(result?.fullText).toBe(`P ${"😀".repeat(200)} S`);
    expect(result?.parts).toEqual({ prefix: "P", content: `${"😀".repeat(115)}…`, suffix: "S" });
    expect(result?.text).toBe(`P ${"😀".repeat(115)}… S`);
    expect(renderLine(catalog, line.id)).toBe(result?.text);
    const impossible = parseLines(file([{ ...line, variants: [
      { prefix: "p".repeat(118), content: "word", suffix: "S" }, "fallback",
    ] }]), "orca").catalog;
    expect(renderLineParts(impossible, line.id)?.text).toBe("fallback");
    expect(renderLineParts(catalog, line.id, {}, 1)).toEqual({ text: "fallback", fullText: "fallback" });
  });
});
