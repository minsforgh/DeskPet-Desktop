import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseLines, parseVoicePack, renderVoice, renderVoiceParts } from "./index.js";

const pack = (templates: unknown) => ({ version: 1, templates });

describe("parseVoicePack", () => {
  it("accepts structured templates and lines, rejecting malformed fields", () => {
    const valid = { prefix: "Hello", content: "{task}", suffix: "done" };
    expect(parseVoicePack({ version: 1, templates: { done: [valid] }, lines: { "fixture.done": [valid] } }).problems).toEqual([]);
    expect(parseVoicePack(pack({ done: [{ prefix: "a".repeat(100), content: "b".repeat(200), suffix: "c".repeat(100) }] })).problems).toEqual([]);
    for (const variant of [
      { ...valid, content: "" }, { ...valid, prefix: 1 }, { ...valid, suffix: undefined },
      { ...valid, unknown: "x" }, { ...valid, prefix: "{task}" }, { ...valid, suffix: "{task}" },
      { ...valid, content: "{unknown}" }, { ...valid, content: "{task" },
      { ...valid, content: "x\u0001" }, { ...valid, content: "x".repeat(401) },
      { prefix: "a".repeat(101), content: "b".repeat(200), suffix: "c".repeat(100) },
    ]) {
      expect(parseVoicePack(pack({ done: [variant] })).problems.length).toBeGreaterThan(0);
      if (variant.content !== "{unknown}")
        expect(parseVoicePack({ version: 1, templates: {}, lines: { "fixture.done": [variant] } }).problems.length).toBeGreaterThan(0);
    }
  });
  it("loads line variants without changing legacy templates and reports bad line entries", () => {
    const parsed = parseVoicePack({ version: 1, templates: { done: ["{task} 끝"] }, lines: {
      "fixture.done": ["{task} 완료", ""], "fixture.bad": ["{broken"], "fixture.long": ["x".repeat(401)],
    } });
    expect(parsed.templates).toEqual({ done: ["{task} 끝"] });
    expect(parsed.lines).toEqual({ "fixture.done": ["{task} 완료"] });
    expect(parsed.problems).toEqual(expect.arrayContaining([
      "lines.fixture.done[1] must be a non-empty string", "lines.fixture.bad[0] has invalid braces",
      "lines.fixture.long[0] is longer than 400 code points",
    ]));
    expect(parseVoicePack(pack({ done: ["old"] })).lines).toEqual({});
  });
  it("keeps valid variants for each kind", () => {
    const { templates, problems } = parseVoicePack(pack({ done: ["{task} 끝", "{result}"], info: ["{message}"] }));
    expect(templates).toEqual({ done: ["{task} 끝", "{result}"], info: ["{message}"] });
    expect(problems).toEqual([]);
  });
  it("drops a variant with an unknown slot and reports it", () => {
    const { templates, problems } = parseVoicePack(pack({ done: ["{name} 끝", "{task} 끝"] }));
    expect(templates).toEqual({ done: ["{task} 끝"] });
    expect(problems).toEqual(["templates.done[0] uses unknown slot {name}"]);
  });
  it("omits a kind whose variants are all invalid, and an empty array", () => {
    const { templates, problems } = parseVoicePack(pack({ done: ["{x}"], failed: [], waiting: [3, ""] }));
    expect(templates).toEqual({});
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
  it("drops a variant over 400 code points and keeps one of exactly 400", () => {
    const { templates, problems } = parseVoicePack(pack({ done: ["가".repeat(401), "😀".repeat(400)] }));
    expect(templates).toEqual({ done: ["😀".repeat(400)] });
    expect(problems).toHaveLength(1);
  });
  it("keeps only the first 8 variants and ignores unknown kinds", () => {
    const { templates, problems } = parseVoicePack(pack({ done: Array.from({ length: 10 }, (_, i) => `v${i}`), other: ["x"] }));
    expect(templates.done).toHaveLength(8);
    expect(problems).toHaveLength(2);
  });
  it.each([null, "x", [], 5, {}, { version: 2, templates: {} }, { version: 1 }, { version: 1, templates: [] }])(
    "returns empty templates for a broken file %j", (input) => {
      const { templates, problems } = parseVoicePack(input);
      expect(templates).toEqual({});
      expect(problems.length).toBeGreaterThan(0);
    });
});

describe("renderVoice", () => {
  it("returns structured parts with the same short text and skips a variant without content room", () => {
    const voice = { kind: "done", slots: { task: "😀".repeat(200) } } as const;
    const template = { prefix: "P", content: "{task}", suffix: "S" };
    const result = renderVoiceParts({ done: [template] }, voice, 0);
    expect(result?.fullText).toBe(`P ${"😀".repeat(200)} S`);
    expect(result?.text).toBe(`P ${"😀".repeat(115)}… S`);
    expect(result?.parts?.content).toBe(`${"😀".repeat(115)}…`);
    expect(renderVoice({ done: [template] }, voice, 0)).toBe(result?.text);
    expect(renderVoiceParts({ done: [{ prefix: "p".repeat(118), content: "x", suffix: "S" }, "fallback"] }, voice, 0)?.text).toBe("fallback");
  });
  const templates = { done: ["A {task}", "B {task}", "C {task}"], waiting: ["{message} 기다려요"] };
  const voice = { kind: "done", slots: { task: "빌드" } } as const;

  it("cycles variants by seed, including negative and large seeds", () => {
    expect([0, 1, 2, 3, 4].map((seed) => renderVoice(templates, voice, seed))).toEqual(["A 빌드", "B 빌드", "C 빌드", "A 빌드", "B 빌드"]);
    expect(renderVoice(templates, voice, -1)).toBe("C 빌드");
    expect(renderVoice(templates, voice, 2 ** 40)).toBe("B 빌드");
  });
  it("skips a variant whose slot is empty or missing", () => {
    const mixed = { done: ["{task} {result}", "{task} 끝"] };
    expect(renderVoice(mixed, { kind: "done", slots: { task: "빌드" } }, 0)).toBe("빌드 끝");
    expect(renderVoice(mixed, { kind: "done", slots: { task: "빌드", result: "   " } }, 0)).toBe("빌드 끝");
    expect(renderVoice(mixed, { kind: "done", slots: { task: "빌드", result: "통과" } }, 0)).toBe("빌드 통과");
  });
  it("returns null when no variant is usable, kind has no templates, or no voice", () => {
    expect(renderVoice(templates, { kind: "done" }, 0)).toBeNull();
    expect(renderVoice(templates, { kind: "failed", slots: { task: "x" } }, 0)).toBeNull();
    expect(renderVoice(templates, undefined, 0)).toBeNull();
    expect(renderVoice({}, voice, 0)).toBeNull();
  });
  it("tidies whitespace and truncates to 120 code points with an ellipsis", () => {
    expect(renderVoice({ done: ["  {task}   끝 "] }, { kind: "done", slots: { task: "a  b" } }, 0)).toBe("a b 끝");
    const long = renderVoice({ done: ["{task}"] }, { kind: "done", slots: { task: "😀".repeat(200) } }, 0) as string;
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(renderVoice({ done: ["{task}"] }, { kind: "done", slots: { task: "x".repeat(120) } }, 0)).toBe("x".repeat(120));
  });
  it("does not substitute braces inside slot values again", () => {
    const text = renderVoice({ done: ["{task} / {result}"] }, { kind: "done", slots: { task: "{result}", result: "{task} {" } }, 0);
    expect(text).toBe("{result} / {task} {");
  });
});

describe("new voice kinds and the wolf-maid pack", () => {
  const wolf = parseVoicePack(JSON.parse(readFileSync(new URL("../../../characters/wolf-maid/voice.json", import.meta.url), "utf8")));
  const kinds = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"] as const;

  it("parses and renders deadline, reminder and alert variants", () => {
    const { templates, problems } = parseVoicePack(pack({ deadline: ["{message}!"], reminder: ["{message}?"], alert: ["{message}."] }));
    expect(problems).toEqual([]);
    expect(renderVoice(templates, { kind: "deadline", slots: { message: "곧" } }, 0)).toBe("곧!");
    expect(renderVoice(templates, { kind: "reminder", slots: { message: "회의" } }, 0)).toBe("회의?");
    expect(renderVoice(templates, { kind: "alert", slots: { message: "로그인" } }, 0)).toBe("로그인.");
  });
  it("wolf-maid voice.json has no problems and variants for all 7 kinds", () => {
    expect(wolf.problems).toEqual([]);
    for (const kind of kinds) expect(wolf.templates[kind]?.length ?? 0).toBeGreaterThan(0);
    expect(renderVoice(wolf.templates, { kind: "deadline", slots: { message: "내일" } }, 0)).toBe("주인님, 서둘러 주세요! 내일");
    expect(renderVoice(wolf.templates, { kind: "alert", slots: { message: "로그인" } }, 1)).toBe("주인님, 문제가 생겼어요. 로그인");
  });
  it("wolf-maid done keeps her tone without a result", () => {
    const render = (slots?: Record<string, string>) => renderVoice(wolf.templates, { kind: "done", slots }, 0);
    expect(render({ task: "빌드" })).toBe("주인님, 빌드 완료입니다!");
    expect(render({ folder: "work" })).toBe("주인님, work 작업이 끝났어요. 수고하셨어요!");
    expect(render()).toBeNull();
  });
  it("wolf-maid failed keeps her tone without a result", () => {
    const render = (slots?: Record<string, string>) => renderVoice(wolf.templates, { kind: "failed", slots }, 0);
    expect(render({ task: "빌드" })).toBe("죄송해요, 주인님… 빌드 잘 안 됐어요. 다시 확인해 주세요");
    expect(render({ folder: "work" })).toBe("죄송해요, 주인님… work 작업에 문제가 생겼어요. 확인해 주세요");
    expect(render()).toBeNull();
  });
  it("wolf-maid lines cover every built-in plugin line id using only declared variables", () => {
    const builtIns = ["claude-code", "codex", "jungle", "orca", "reminders", "slack"];
    const declared = new Map<string, { pluginId: string; variables: string[] }>();
    for (const pluginId of builtIns) {
      const parsed = parseLines(JSON.parse(readFileSync(
        new URL(`../../../plugins/${pluginId}/lines.json`, import.meta.url), "utf8")), pluginId);
      expect(parsed.problems, pluginId).toEqual([]);
      for (const line of parsed.catalog.lines)
        declared.set(line.id, { pluginId, variables: [...line.variables] });
    }
    expect(wolf.problems).toEqual([]);
    expect(Object.keys(wolf.lines).sort()).toEqual([...declared.keys()].sort());
    // Re-running each catalog entry with the pack's variants through parseLines rejects
    // undeclared variables, invalid braces, and control characters in the pack sentences.
    for (const pluginId of builtIns) {
      const { catalog } = parseLines(JSON.parse(readFileSync(
        new URL(`../../../plugins/${pluginId}/lines.json`, import.meta.url), "utf8")), pluginId);
      const withPackVariants = catalog.lines.map((line) => ({ ...line, variants: wolf.lines[line.id] ?? [] }));
      expect(parseLines({ version: 1, lines: withPackVariants }, pluginId).problems, pluginId).toEqual([]);
    }
  });
});
