import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseLines } from "@deskpet/core";
import { findHardcodedBubbleText, findLineIds } from "./line-hardcoding.js";

const root = resolve(import.meta.dirname, "..");
const builtIns = ["claude-code", "codex", "jungle", "orca", "reminders", "slack"];

const rejected: Array<[string, string]> = [
  ["static sentence", `ctx.emit({ source: "x", type: "notify", text: "끝났어" });`],
  ["template composition", "ctx.emit({ source: 'x', type: 'notify', text: `${task}이 끝났어` });"],
  ["concatenation", `ctx.emit({ source: "x", type: "notify", text: task + "이 끝났어" });`],
  ["helper with a sentence", `ctx.emit({ source: "x", type: "notify", text: message(title, "이 끝났어") });`],
  ["conditional sentences", `ctx.emit({ source: "x", type: "notify", text: ok ? "결정했어" : "실패했어" });`],
  ["fallback sentence", `ctx.emit({ source: "x", type: "notify", text: name ?? "이름 없음" });`],
  ["joined parts", `ctx.emit({ source: "x", type: "notify", text: ["안녕", name].join(" ") });`],
  ["constant sentence", `const SENTENCE = "상태 확인 불가"; ctx.emit({ source: "x", type: "notify", text: SENTENCE });`],
  ["event field assignment", `const event = { source: "x", type: "notify" }; event.text = "끝났어";`],
  ["Object.assign into an event", "Object.assign(event, { text: `${a} 완료`, mood: 'happy' });"],
  ["emit without type", `ctx.emit({ key: "k", text: "문장" });`],
  ["hook push", `args.push("--text", "끝났어");`],
  ["hook array", "const args = ['event', '--text', `${folder}: 끝났어`];"],
];
const allowed: Array<[string, string]> = [
  ["line event", `ctx.emit({ source: "x", type: "notify", line: { id: "x.done", vars: { task } } });`],
  ["variable text", `ctx.emit({ source: "x", type: "notify", text: body });`],
  ["text from a helper without sentences", `ctx.emit({ source: "x", type: "notify", text: preview(body, 120) });`],
  ["badge", `ctx.setBadge("x.status", { text: "확인 불가", tone: "warn" });`],
  ["badge variable", `const badge = { text: "완료", tone: "ok" };`],
  ["button label", `ctx.emit({ source: "x", type: "notify", line: { id: "x.a" }, actions: [{ label: "열기", action: "x.open" }] });`],
  ["log", `ctx.log.warn("스냅샷을 읽지 못했어");`],
  ["detail", `ctx.emit({ source: "x", type: "notify", line: { id: "x.a" }, detail: "작업 폴더: 상세 문장" });`],
  ["status event", `ctx.emit({ source: "x", type: "status", text: "상태" });`],
  ["empty text", `ctx.emit({ source: "x", type: "notify", text: "" });`],
  ["hook line args", "const args = ['event', '--line', `${source}.${id}`, '--detail', '상세'];"],
];

describe("hard-coded bubble text checker", () => {
  test.each(rejected)("rejects %s", (_name, source) => {
    expect(findHardcodedBubbleText(source).length).toBeGreaterThan(0);
  });
  test.each(allowed)("allows %s", (_name, source) => {
    expect(findHardcodedBubbleText(source)).toEqual([]);
  });
  test("reports the offending line", () => {
    expect(findHardcodedBubbleText(`const a = 1;\nctx.emit({\n  source: "x", type: "notify",\n  text: "문장",\n});`)
      .map(({ line }) => line)).toEqual([4]);
  });
  test("collects line ids including conditional branches", () => {
    expect(findLineIds(`f({ line: { id: ok ? "a.one" : "a.two" } }); g({ id: "ignored" });`)).toEqual(["a.one", "a.two"]);
    expect(findLineIds("f({ line: { id: `a.${kind}-x` } });")).toEqual(["a.*-x"]);
    expect(findLineIds(`h({ id: "done-task" });`, "hook.mjs", { anyIdProperty: true })).toEqual(["done-task"]);
  });
});

function sources(directory: string, extension: RegExp): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(path, extension);
    return extension.test(name) && !/\.test\.[cm]?[jt]s$/u.test(name) ? [path] : [];
  });
}

/** A used id may be a template pattern such as `slack.*`; it must match a declared id. */
const matches = (used: string, declared: string): boolean =>
  (!used.includes("*") ? used === declared : true) && used.split("*").reduce<number | undefined>((from, part, index, parts) => {
    if (from === undefined) return undefined;
    const at = index === 0 ? (declared.startsWith(part) ? 0 : -1) : declared.indexOf(part, from);
    if (at < 0 || (index === parts.length - 1 && !declared.endsWith(part))) return undefined;
    return at + part.length;
  }, 0) !== undefined;

const declaredIds = (id: string): string[] =>
  parseLines(JSON.parse(readFileSync(join(root, "plugins", id, "lines.json"), "utf8")), id).catalog.lines.map((line) => line.id);

describe("built-in plugins and hooks", () => {
  test("the six built-ins are exactly the plugins that have a manifest", () => {
    const dirs = readdirSync(join(root, "plugins")).filter((name) =>
      statSync(join(root, "plugins", name, "manifest.json"), { throwIfNoEntry: false }) !== undefined);
    expect(dirs.sort()).toEqual(builtIns);
  });

  test("no bubble text is hard-coded in plugin sources or hooks", () => {
    const files = [...builtIns.flatMap((id) => sources(join(root, "plugins", id, "src"), /\.[cm]?ts$/u)),
      ...sources(join(root, "docs", "hooks"), /\.mjs$/u)];
    expect(files.length).toBeGreaterThan(8);
    const problems = files.flatMap((file) => findHardcodedBubbleText(readFileSync(file, "utf8"), file)
      .map(({ line, reason }) => `${file.slice(root.length + 1)}:${line} ${reason}`));
    expect(problems).toEqual([]);
  });

  describe.each(builtIns)("%s", (id) => {
    test("manifest declares a valid lines.json", () => {
      const manifest = JSON.parse(readFileSync(join(root, "plugins", id, "manifest.json"), "utf8")) as
        { contributes?: { lines?: string } };
      expect(manifest.contributes?.lines).toBe("lines.json");
      const parsed = parseLines(JSON.parse(readFileSync(join(root, "plugins", id, "lines.json"), "utf8")), id);
      expect(parsed.problems).toEqual([]);
      expect(parsed.catalog.lines.length).toBeGreaterThan(0);
    });
    test("every line id used by the sources is declared", () => {
      const declared = declaredIds(id);
      const used = sources(join(root, "plugins", id, "src"), /\.[cm]?ts$/u)
        .flatMap((file) => findLineIds(readFileSync(file, "utf8"), file));
      expect(used.filter((line) => !declared.some((known) => matches(line, known)))).toEqual([]);
      if (id !== "claude-code" && id !== "codex") expect(used.length).toBeGreaterThan(0);
    });
  });

  test.each(["claude-code", "codex"])("%s hook line ids are declared", (id) => {
    const hook = readFileSync(join(root, "docs", "hooks", "hook-message.mjs"), "utf8");
    const used = findLineIds(hook, "hook-message.mjs", { anyIdProperty: true });
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((line) => !declaredIds(id).some((known) => matches(`${id}.${line}`, known)))).toEqual([]);
  });
});
