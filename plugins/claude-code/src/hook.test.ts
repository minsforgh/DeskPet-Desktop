import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { lineVariantText, type LineVariant } from "@deskpet/core";

const runNode = promisify(execFile);

const hookModuleUrl = (file: string): string => new URL(`../../../docs/hooks/${file}`, import.meta.url).href;

async function buildArgs(input: unknown, fallbackCwd?: string): Promise<string[]> {
  const modulePath = hookModuleUrl("send-claude-code-event.mjs");
  const expression = `import(${JSON.stringify(modulePath)}).then(({buildDeskpetEventArgs}) => process.stdout.write(JSON.stringify(buildDeskpetEventArgs(JSON.parse(process.argv[1]), process.argv[2]))))`;
  const result = await runNode(process.execPath, ["--input-type=module", "-e", expression, JSON.stringify(input), fallbackCwd ?? ""]);
  return JSON.parse(result.stdout) as string[];
}

async function buildArgsWithOptions(input: unknown, options: unknown, fallbackCwd?: string): Promise<string[]> {
  const modulePath = hookModuleUrl("send-claude-code-event.mjs");
  const expression = `import(${JSON.stringify(modulePath)}).then(({buildDeskpetEventArgs}) => process.stdout.write(JSON.stringify(buildDeskpetEventArgs(JSON.parse(process.argv[1]), process.argv[2], JSON.parse(process.argv[3])))))`;
  const result = await runNode(process.execPath, ["--input-type=module", "-e", expression, JSON.stringify(input), fallbackCwd ?? "", JSON.stringify(options)]);
  return JSON.parse(result.stdout) as string[];
}

/** Evaluates `body` (an arrow receiving (module, case)) for every JSON case in one subprocess. */
async function evalCases<T>(file: string, body: string, cases: unknown[]): Promise<T[]> {
  const expression = `import(${JSON.stringify(hookModuleUrl(file))}).then((m) => process.stdout.write(JSON.stringify(process.argv.slice(1).map((raw) => (${body})(m, JSON.parse(raw))))))`;
  const result = await runNode(process.execPath, ["--input-type=module", "-e", expression, ...cases.map((oneCase) => JSON.stringify(oneCase))]);
  return JSON.parse(result.stdout) as T[];
}

const tempRoot = mkdtempSync(join(tmpdir(), "deskpet-hook-test-"));
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "index.js");
const projectsDir = join(tempRoot, "home", ".claude", "projects");
const projectDir = join(projectsDir, "proj");
mkdirSync(projectDir, { recursive: true });

const userLine = (promptId: string, content: unknown): string =>
  JSON.stringify({ type: "user", promptId, message: { role: "user", content } });
const lastPromptLine = (lastPrompt: string): string =>
  JSON.stringify({ type: "last-prompt", lastPrompt, sessionId: "s-1" });
const assistantLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "중간 응답" }] } });
const taskPrompt = "이번엔 훅 메시지 구현해 줘";
type SelectedLine = { id: string; vars: Record<string, string> };
const catalogs = Object.fromEntries(["claude-code", "codex"].map((source) => [source,
  JSON.parse(readFileSync(join(workspaceRoot, "plugins", source, "lines.json"), "utf8")) as {
    lines: Array<{ id: string; kind: string; variables: string[]; variants: LineVariant[] }>;
  },
]));

function renderSelected(selected: SelectedLine, source = "claude-code"): string {
  const catalog = catalogs[source];
  const line = catalog?.lines.find((entry) => entry.id === `${source}.${selected.id}`);
  expect(line, `${source}.${selected.id} must be declared`).toBeDefined();
  const first = line?.variants[0];
  let result = first === undefined ? "" : lineVariantText(first);
  for (const [name, value] of Object.entries(selected.vars)) result = result.replaceAll(`{${name}}`, value);
  return result;
}

const transcriptLines = [
  userLine("p-0", "이전 프롬프트"),
  userLine("p-1", [{ type: "tool_result", tool_use_id: "t-1", content: "도구 결과" }]),
  assistantLine,
  userLine("p-1", taskPrompt),
  lastPromptLine("마지막 프롬프트 대체"),
];
const transcriptPath = join(projectDir, "session.jsonl");
writeFileSync(transcriptPath, `${transcriptLines.join("\n")}\n`, "utf8");

const toolsOnlyPath = join(projectDir, "tools-only.jsonl");
writeFileSync(toolsOnlyPath, `${[
  userLine("p-1", [{ type: "tool_result", tool_use_id: "t-1", content: "도구 결과만 있음" }]),
  lastPromptLine("도구 결과만 있을 때 대체"),
].join("\n")}\n`, "utf8");

const noTaskPath = join(projectDir, "no-task.jsonl");
writeFileSync(noTaskPath, `${[assistantLine, userLine("p-9", "다른 프롬프트")].join("\n")}\n`, "utf8");

const transcriptCase = (transcriptPathForCase: string, promptId?: string): unknown => ({
  input: { transcript_path: transcriptPathForCase, ...(promptId === undefined ? {} : { prompt_id: promptId }) },
  root: projectsDir,
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Claude Code hook event arguments", () => {
  it("maps a Stop hook to a completed event with the full working path", async () => {
    await expect(buildArgs({ hook_event_name: "Stop", cwd: "C:\\work\\deskpet" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.done-default", "--mood", "happy", "--detail", "C:\\work\\deskpet",
      "--var", "folder=deskpet",
    ]);
  });

  it("maps a notification without documented fields to safe defaults", async () => {
    await expect(buildArgs({}, "C:\\work\\unknown")).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "unknown",
      "--line", "claude-code.waiting-default", "--mood", "worried", "--detail", "C:\\work\\unknown",
      "--var", "folder=unknown",
    ]);
  });

  it("treats the Codex agent-turn-complete payload as a completion", async () => {
    await expect(buildArgs({ type: "agent-turn-complete", cwd: "C:\\work\\codex-task" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "codex-task",
      "--line", "claude-code.done-default", "--mood", "happy", "--detail", "C:\\work\\codex-task",
      "--var", "folder=codex-task",
    ]);
  });

  it("reads a JSON object from the last command-line argument and ignores anything else", async () => {
    const modulePath = hookModuleUrl("send-claude-code-event.mjs");
    const expression = `import(${JSON.stringify(modulePath)}).then(({payloadFromArgument}) => process.stdout.write(JSON.stringify([payloadFromArgument(process.argv[1]), payloadFromArgument(process.argv[2]), payloadFromArgument(process.argv[3]), payloadFromArgument(undefined)])))`;
    const result = await runNode(process.execPath, ["--input-type=module", "-e", expression, '{"type":"agent-turn-complete"}', "[1]", "not json"]);
    expect(JSON.parse(result.stdout)).toEqual([{ type: "agent-turn-complete" }, null, null, null]);
  });

  it("uses Codex input-messages and last-assistant-message in the completion phrase", async () => {
    await expect(buildArgs({
      type: "agent-turn-complete",
      cwd: "C:\\work\\codex-task",
      "input-messages": ["첫 요청", "", "저장소 좀 정리해 줘"],
      "last-assistant-message": "정리 완료",
    })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "codex-task",
      "--line", "claude-code.done-task-result", "--mood", "happy",
      "--detail", "C:\\work\\codex-task\n시킨 일: 저장소 좀 정리해 줘\n결과: 정리 완료",
      "--var", "folder=codex-task", "--var", "task=저장소 좀 정리해 줘", "--var", "result=정리 완료",
    ]);
  });

  it("uses a transcript task passed via options for a Stop payload", async () => {
    await expect(buildArgsWithOptions(
      { hook_event_name: "Stop", cwd: "C:\\work\\deskpet", prompt_id: "p-1", last_assistant_message: "ok" },
      { task: taskPrompt },
    )).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.done-task-result", "--mood", "happy",
      "--detail", `C:\\work\\deskpet\n시킨 일: ${taskPrompt}\n결과: ok`,
      "--var", "folder=deskpet", "--var", `task=${taskPrompt}`, "--var", "result=ok",
    ]);
  });

  it("uses a string Notification message in the wait phrase", async () => {
    await expect(buildArgs({ hook_event_name: "Notification", cwd: "C:\\work\\deskpet", message: "Bash 사용 허가를 기다려요" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.waiting-message", "--mood", "worried", "--detail", "C:\\work\\deskpet",
      "--var", "folder=deskpet", "--var", "message=Bash 사용 허가를 기다려요",
    ]);
  });

  it("keeps the default wait phrase when the Notification message is empty", async () => {
    await expect(buildArgs({ hook_event_name: "Notification", cwd: "C:\\work\\deskpet", message: "" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.waiting-default", "--mood", "worried", "--detail", "C:\\work\\deskpet",
      "--var", "folder=deskpet",
    ]);
  });
});

describe("line kind mapping", () => {
  it("sends declared IDs and exact variables for every phrase and source", async () => {
    const cases = [
      { input: { hook_event_name: "Stop", last_assistant_message: "끝" }, task: "할 일", id: "done-task-result", vars: ["folder=deskpet", "task=할 일", "result=끝"], kind: "done" },
      { input: { hook_event_name: "Stop" }, task: "할 일", id: "done-task", vars: ["folder=deskpet", "task=할 일"], kind: "done" },
      { input: { hook_event_name: "Stop", last_assistant_message: "끝" }, id: "done-result", vars: ["folder=deskpet", "result=끝"], kind: "done" },
      { input: { hook_event_name: "Stop" }, id: "done-default", vars: ["folder=deskpet"], kind: "done" },
      ...(["waiting", "failed", "info"] as const).flatMap((kind) => {
        const hook_event_name = kind === "waiting" ? "Notification" : kind === "failed" ? "StopFailure" : "SubagentStop";
        return [
          { input: { hook_event_name, message: "입력 요청" }, id: `${kind}-message`, vars: ["folder=deskpet", "message=입력 요청"], kind },
          { input: { hook_event_name }, id: `${kind}-default`, vars: ["folder=deskpet"], kind },
        ];
      }),
    ];
    for (const source of ["claude-code", "codex"]) {
      const actual = await evalCases<string[]>("send-claude-code-event.mjs",
        "(m, c) => m.buildDeskpetEventArgs(c.input, c.cwd, { source: c.source, task: c.task })",
        cases.map((oneCase) => ({ ...oneCase, source, cwd: "C:\\work\\deskpet" })));
      for (const [index, args] of actual.entries()) {
        const expected = cases[index];
        if (expected === undefined) throw new Error("Missing phrase case");
        const id = args[args.indexOf("--line") + 1];
        expect(id).toBe(`${source}.${expected.id}`);
        const line = catalogs[source]?.lines.find((item) => item.id === id);
        expect(line).toMatchObject({ kind: expected.kind, variables: expected.vars.map((variable) => variable.split("=")[0]) });
        expect(args.filter((arg, position) => args[position - 1] === "--var")).toEqual(expected.vars);
      }
    }
  });

  it("maps every event branch to a declared --line id", async () => {
    const cases = [
      { input: { hook_event_name: "Stop" }, expected: "done-default" },
      { input: { event: "finished" }, expected: "done-default" },
      { input: { type: "agent-turn-complete" }, expected: "done-default" },
      { input: { notification_type: "turn-complete" }, expected: "done-default" },
      { input: { hook_event_name: "Notification" }, expected: "waiting-default" },
      { input: {}, expected: "waiting-default" },
      { input: { hook_event_name: "StopFailure" }, expected: "failed-default" },
      { input: { type: "task-failed" }, expected: "failed-default" },
      { input: { hook_event_name: "PermissionError" }, expected: "failed-default" },
      { input: { hook_event_name: "SubagentStop" }, expected: "info-default" },
      { input: { type: "turn-started" }, expected: "info-default" },
    ];
    const results = await evalCases<string>("send-claude-code-event.mjs",
      "(m, c) => { const args = m.buildDeskpetEventArgs(c.input); return args[args.indexOf(\"--line\") + 1]; }",
      cases);
    expect(results).toEqual(cases.map((oneCase) => `claude-code.${oneCase.expected}`));
  });

  it("keeps the existing default wait phrase and worried mood on a failed event", async () => {
    await expect(buildArgs({ hook_event_name: "StopFailure", cwd: "C:\\work\\deskpet" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.failed-default", "--mood", "worried", "--detail", "C:\\work\\deskpet",
      "--var", "folder=deskpet",
    ]);
  });

  it("marks other notifying events as info while the phrase stays the default wait one", async () => {
    await expect(buildArgs({ hook_event_name: "SubagentStop", cwd: "C:\\work\\deskpet" })).resolves.toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.info-default", "--mood", "worried", "--detail", "C:\\work\\deskpet",
      "--var", "folder=deskpet",
    ]);
  });
});

describe("line variables in built arguments", () => {
  it("truncates a long task to the phrase budget and preserves detail", async () => {
    const args = await buildArgsWithOptions({ hook_event_name: "Stop", cwd: "C:\\work\\deskpet" }, { task: "일".repeat(600) });
    expect(args[args.indexOf("--line") + 1]).toBe("claude-code.done-task");
    expect(args[args.indexOf("--detail") + 1]).toBe(`C:\\work\\deskpet\n시킨 일: ${"일".repeat(299)}…`);
    const variable = args[args.indexOf("--var", args.indexOf("--var") + 1) + 1] ?? "";
    expect(variable).toBe(`task=${"일".repeat(70)}…`);
    expect([...variable.slice("task=".length)]).toHaveLength(71);
  });

  it("omits the message slot when only control characters remain", async () => {
    const args = await buildArgs({ hook_event_name: "Notification", cwd: "C:\\work\\deskpet", message: "\u0000\u0001" });
    expect(args.some((one) => one.startsWith("message="))).toBe(false);
    expect(args).toContain("folder=deskpet");
    expect(args[args.indexOf("--line") + 1]).toBe("claude-code.waiting-default");
  });
});

describe("hook-message firstLine", () => {
  it("strips markdown markers and collapses whitespace", async () => {
    const cases = [
      { text: "## 제목\n본문", expected: "제목" },
      { text: "### 깊은 제목", expected: "깊은 제목" },
      { text: "**굵게**", expected: "굵게" },
      { text: "*기울임*", expected: "기울임" },
      { text: "- 목록 항목", expected: "목록 항목" },
      { text: "```js\nconst x = 1;\n```", expected: "js" },
      { text: "```\ncode\n```", expected: "" },
      { text: "`코드`", expected: "코드" },
      { text: "> 인용 문장", expected: "인용 문장" },
      { text: "1. 첫 번째 단계", expected: "첫 번째 단계" },
      { text: "3) 닫는 괄호 목록", expected: "닫는 괄호 목록" },
      { text: "- **굵게 목록**", expected: "굵게 목록" },
      { text: "- **M5 기준 14** 훅 알림 문구를 구현해 줘", expected: "M5 기준 14 훅 알림 문구를 구현해 줘" },
      { text: "**굵게**: 설명이 뒤따름", expected: "굵게: 설명이 뒤따름" },
      { text: "_snake_case 는 그대로", expected: "_snake_case 는 그대로" },
      { text: "\r\n\r\n  공백과   줄바꿈  \n둘째 줄", expected: "공백과 줄바꿈" },
      { text: "", expected: "" },
      { text: "   \n  \t  ", expected: "" },
    ];
    const results = await evalCases("hook-message.mjs", "(m, c) => m.firstLine(c.text)", cases);
    expect(results).toEqual(cases.map((oneCase) => oneCase.expected));
  });
});

describe("hook-message fit", () => {
  it("keeps text within the limit and cuts beyond it in code points", async () => {
    const results = await evalCases<string>("hook-message.mjs", "(m, c) => m.fit(c.text, c.max)", [
      { text: "가".repeat(80), max: 80 },
      { text: "가".repeat(81), max: 80 },
      { text: "😀".repeat(85), max: 80 },
      { text: "abc", max: 80 },
    ]);
    const [exact, overByOne, emoji, short] = results;
    expect(exact).toBe("가".repeat(80));
    expect(overByOne).toBe(`${"가".repeat(79)}…`);
    expect(emoji).toBe(`${"😀".repeat(79)}…`);
    expect([...(emoji ?? "")]).toHaveLength(80);
    expect(short).toBe("abc");
  });
});

describe("hook-message selectLine", () => {
  it("applies every phrase rule", async () => {
    const results = await evalCases<SelectedLine>("hook-message.mjs", "(m, c) => m.selectLine(c)", [
      { folder: "deskpet", task: "버그 고쳐 줘", result: "수정 완료", kind: "done" },
      { folder: "deskpet", task: "버그 고쳐 줘", kind: "done" },
      { folder: "deskpet", result: "수정 완료", kind: "done" },
      { folder: "deskpet", kind: "done" },
      { folder: "deskpet", message: "Bash 사용 허가가 필요해요", kind: "wait" },
      { folder: "deskpet", message: "", kind: "wait" },
      { folder: "deskpet", kind: "wait" },
    ]);
    expect(results.map((selected) => renderSelected(selected))).toEqual([
      "deskpet: 버그 고쳐 줘 → 수정 완료",
      "deskpet: 버그 고쳐 줘",
      "deskpet: 수정 완료",
      "deskpet 작업이 끝났어요",
      "deskpet: Bash 사용 허가가 필요해요",
      "deskpet이 입력을 기다려요",
      "deskpet이 입력을 기다려요",
    ]);
  });

  it("caps the task at 24 code points and gives the remaining budget to the result", async () => {
    const results = await evalCases<SelectedLine>("hook-message.mjs", "(m, c) => m.selectLine(c)", [
      { folder: "f", task: "이".repeat(30), result: "결과", kind: "done" },
      { folder: "f", task: "t", result: "r".repeat(73), kind: "done" },
      { folder: "f", task: "t", result: "r".repeat(74), kind: "done" },
    ]);
    const [longTaskCut, resultExact, resultOver] = results.map((selected) => renderSelected(selected));
    expect(longTaskCut).toBe(`f: ${"이".repeat(23)}… → 결과`);
    expect(resultExact).toBe(`f: t → ${"r".repeat(73)}`);
    expect([...(resultExact ?? "")]).toHaveLength(80);
    expect(resultOver).toBe(`f: t → ${"r".repeat(72)}…`);
    expect([...(resultOver ?? "")]).toHaveLength(80);
  });

  it("uses the task line when a long folder leaves no room for a result", async () => {
    const [selected] = await evalCases<SelectedLine>("hook-message.mjs", "(m, c) => m.selectLine(c)", [
      { folder: "f".repeat(55), task: "t".repeat(30), result: "done", kind: "done" },
    ]);
    expect(selected?.id).toBe("done-task");
    if (selected === undefined) throw new Error("Missing selected line");
    expect(renderSelected(selected)).toBe(`${"f".repeat(55)}: ${"t".repeat(22)}…`);
  });

  it("fits the wait message to exactly 80 code points", async () => {
    const results = await evalCases<SelectedLine>("hook-message.mjs", "(m, c) => m.selectLine(c)", [
      { folder: "f", message: "m".repeat(77), kind: "wait" },
      { folder: "f", message: "m".repeat(78), kind: "wait" },
    ]);
    const [exact, overByOne] = results.map((selected) => renderSelected(selected));
    expect(exact).toBe(`f: ${"m".repeat(77)}`);
    expect([...(exact ?? "")]).toHaveLength(80);
    expect(overByOne).toBe(`f: ${"m".repeat(76)}…`);
    expect([...(overByOne ?? "")]).toHaveLength(80);
  });
});

describe("hook-message composeDetail", () => {
  it("builds the multi-line detail with present lines only", async () => {
    const results = await evalCases("hook-message.mjs", "(m, c) => m.composeDetail(c.cwd, c)", [
      { cwd: "C:\\work\\deskpet" },
      { cwd: "C:\\w", task: "시킨 일", result: "결과" },
    ]);
    expect(results).toEqual(["C:\\work\\deskpet", "C:\\w\n시킨 일: 시킨 일\n결과: 결과"]);
  });
});

describe("hook-message variableValue", () => {
  it("applies the cleanup rules and the voice slot validation limits", async () => {
    const cases = [
      { value: "- **M5 기준 15** 어투 훅을 구현해 줘", expected: "M5 기준 15 어투 훅을 구현해 줘" },
      { value: "첫 줄 내용\n둘째 줄 내용", expected: "첫 줄 내용" },
      { value: "가\u0001나\t다", expected: "가 나 다" },
      { value: "a\u007Fb", expected: "a b" },
      { value: "c\u009Fd", expected: "c d" },
      { value: "가".repeat(500), expected: "가".repeat(500) },
      { value: "가".repeat(501), expected: `${"가".repeat(499)}…` },
      { value: "😀".repeat(501), expected: `${"😀".repeat(499)}…` },
      { value: 42, expected: "" },
      { value: undefined, expected: "" },
      { value: "", expected: "" },
      { value: "```", expected: "" },
    ];
    const results = await evalCases<string>("hook-message.mjs", "(m, c) => m.variableValue(c.value)", cases);
    expect(results).toEqual(cases.map((oneCase) => oneCase.expected));
    for (const result of results) expect([...result ?? ""].length).toBeLessThanOrEqual(500);
  });
});

describe("readTaskFromTranscript", () => {
  it("finds the task by prompt id, skipping tool-result lines", async () => {
    const results = await evalCases("send-claude-code-event.mjs", "(m, c) => m.readTaskFromTranscript(c.input, { allowedRoot: c.root }) ?? null", [
      transcriptCase(transcriptPath, "p-1"),
      transcriptCase(toolsOnlyPath, "p-1"),
      transcriptCase(transcriptPath),
      transcriptCase(noTaskPath),
    ]);
    expect(results).toEqual([taskPrompt, "도구 결과만 있을 때 대체", "마지막 프롬프트 대체", null]);
  });

  it("rejects paths outside the allowed root, parent traversal, wrong extensions, and missing files", async () => {
    const outsidePath = join(tempRoot, "outside", "session.jsonl");
    mkdirSync(join(tempRoot, "outside"), { recursive: true });
    writeFileSync(outsidePath, `${transcriptLines.join("\n")}\n`, "utf8");
    const wrongExtensionPath = join(projectDir, "session.txt");
    writeFileSync(wrongExtensionPath, `${transcriptLines.join("\n")}\n`, "utf8");
    const traversalPath = join(projectsDir, "proj", "..", "..", "..", "..", "outside", "session.jsonl");
    const results = await evalCases("send-claude-code-event.mjs", "(m, c) => m.readTaskFromTranscript(c.input, { allowedRoot: c.root }) ?? null", [
      transcriptCase(outsidePath, "p-1"),
      transcriptCase(traversalPath, "p-1"),
      transcriptCase(wrongExtensionPath, "p-1"),
      transcriptCase(join(projectDir, "missing.jsonl"), "p-1"),
    ]);
    expect(results).toEqual([null, null, null, null]);
  });

  it("reads only the tail of files larger than 1 MiB", async () => {
    const bigPath = join(projectDir, "big.jsonl");
    writeFileSync(bigPath, `${[
      JSON.stringify({ type: "last-prompt", lastPrompt: "STALE", pad: "x".repeat(1_100_000) }),
      userLine("p-big", "끝부분에 있는 시킨 일"),
      lastPromptLine("FRESH"),
    ].join("\n")}\n`, "utf8");
    expect(statSync(bigPath).size).toBeGreaterThan(1024 * 1024);
    const results = await evalCases("send-claude-code-event.mjs", "(m, c) => m.readTaskFromTranscript(c.input, { allowedRoot: c.root }) ?? null", [
      transcriptCase(bigPath, "p-big"),
      transcriptCase(bigPath),
    ]);
    expect(results).toEqual(["끝부분에 있는 시킨 일", "FRESH"]);
  });

  it("rejects a junction inside the allowed root that points outside", async (context) => {
    const outsideDir = join(tempRoot, "outside-junction");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "session.jsonl"), `${transcriptLines.join("\n")}\n`, "utf8");
    const junctionPath = join(projectsDir, "link-junction");
    let junctionError = "";
    try {
      symlinkSync(realpathSync(outsideDir), junctionPath, "junction");
    } catch (error) {
      junctionError = String(error);
    }
    context.skip(junctionError !== "", `junction creation unsupported on this PC: ${junctionError}`);
    const [result] = await evalCases("send-claude-code-event.mjs", "(m, c) => m.readTaskFromTranscript(c.input, { allowedRoot: c.root }) ?? null", [
      transcriptCase(join(junctionPath, "session.jsonl"), "p-1"),
    ]);
    expect(result).toBeNull();
  });

  it("rejects a file symlink inside the allowed root that points outside", async (context) => {
    const outsideDir = join(tempRoot, "outside-symlink");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "session.jsonl"), `${transcriptLines.join("\n")}\n`, "utf8");
    const linkPath = join(projectsDir, "link-file.jsonl");
    let linkError = "";
    try {
      symlinkSync(realpathSync(join(outsideDir, "session.jsonl")), linkPath, "file");
    } catch (error) {
      linkError = String(error);
    }
    context.skip(linkError !== "", `file symlink creation unsupported on this PC: ${linkError}`);
    const [result] = await evalCases("send-claude-code-event.mjs", "(m, c) => m.readTaskFromTranscript(c.input, { allowedRoot: c.root }) ?? null", [
      transcriptCase(linkPath, "p-1"),
    ]);
    expect(result).toBeNull();
  });
});

describe("send-claude-code-event end to end", () => {
  it("runs the script with a stub CLI and a temporary transcript", async () => {
    const stubPath = join(tempRoot, "stub-cli.mjs");
    writeFileSync(stubPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf8");
    const payload = {
      session_id: "s-e2e",
      transcript_path: transcriptPath,
      cwd: "C:\\work\\deskpet",
      prompt_id: "p-1",
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "ok",
    };
    const result = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = execFile(process.execPath, [fileURLToPath(hookModuleUrl("send-claude-code-event.mjs"))], {
        env: { ...process.env, DESKPET_CLI: stubPath, DESKPET_TRANSCRIPT_ROOT: projectsDir },
      }, (error, stdout) => {
        if (error === null) resolvePromise(stdout);
        else rejectPromise(error);
      });
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    });
    expect(JSON.parse(result)).toEqual([
      "event", "--source", "claude-code", "--type", "notify", "--key", "deskpet",
      "--line", "claude-code.done-task-result", "--mood", "happy",
      "--detail", `C:\\work\\deskpet\n시킨 일: ${taskPrompt}\n결과: ok`,
      "--var", "folder=deskpet", "--var", `task=${taskPrompt}`, "--var", "result=ok",
    ]);
  });
});

describe("Codex notify wrapper end to end", () => {
  it("keeps the configured wrapper path and sends Codex events with the same message fields", async () => {
    const stubPath = join(tempRoot, "codex-stub-cli.mjs");
    const originalPath = join(tempRoot, "original-notify.mjs");
    const capturePath = join(tempRoot, "codex-event.json");
    const originalCapturePath = join(tempRoot, "original-notify.json");
    writeFileSync(stubPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DESKPET_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n", "utf8");
    writeFileSync(originalPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.ORIGINAL_CAPTURE_PATH, process.argv[2]);\n", "utf8");
    const payload = JSON.stringify({ type: "agent-turn-complete", cwd: "C:\\work\\codex-task",
      "input-messages": ["organize repository"], "last-assistant-message": "done" });
    await runNode(process.execPath, [fileURLToPath(hookModuleUrl("codex-notify-wrapper.mjs")),
      process.execPath, originalPath, payload], { env: { ...process.env, DESKPET_CLI: stubPath,
        DESKPET_CAPTURE_PATH: capturePath, ORIGINAL_CAPTURE_PATH: originalCapturePath } });
    expect(JSON.parse(readFileSync(originalCapturePath, "utf8"))).toEqual(JSON.parse(payload));
    const args = JSON.parse(readFileSync(capturePath, "utf8")) as string[];
    expect(args.slice(0, 7)).toEqual(["event", "--source", "codex", "--type", "notify", "--key", "codex-task"]);
    expect(args[args.indexOf("--line") + 1]).toBe("codex.done-task-result");
    expect(args).toContain("task=organize repository");
    expect(args).toContain("result=done");
    expect(args).toContain("folder=codex-task");
  });
});

describe("hook fallback on malformed payloads", () => {
  it("does not throw and keeps the line argument shape", async () => {
    const inputs = [
      null,
      { message: 42, last_assistant_message: ["배열"], "input-messages": "문자열" },
      { type: 7, cwd: 3 },
      { hook_event_name: "Notification", message: "\u0000" },
    ];
    const results = await evalCases<string[]>("send-claude-code-event.mjs",
      "(m, c) => m.buildDeskpetEventArgs(c, \"C:\\\\work\\\\x\")", inputs);
    expect(results).toHaveLength(inputs.length);
    for (const args of results) {
      expect(args.slice(0, 6)).toEqual(["event", "--source", "claude-code", "--type", "notify", "--key"]);
      expect(catalogs["claude-code"]?.lines.some((line) => line.id === args[args.indexOf("--line") + 1])).toBe(true);
      expect(args).not.toContain("--text");
      expect(args).not.toContain("--voice");
      for (let index = args.indexOf("--var"); index !== -1; index = args.indexOf("--var", index + 1)) {
        expect(args[index + 1] ?? "").toMatch(/^(task|result|folder|message)=.+$/u);
      }
    }
  });
});

describe("line arguments against the real CLI parser", () => {
  it("accepts the hook's arguments for every line kind without option rejection", async () => {
    // Same build step and measurement as packages/cli/src/usage.test.ts: `pnpm --filter
    // @deskpet/cli build` took at most 2.7 s on this Windows workspace; 20 s covers cold caches.
    execFileSync("pnpm", ["--filter", "@deskpet/cli", "build"], {
      cwd: workspaceRoot, shell: process.platform === "win32", stdio: "pipe",
    });
    const dataDir = join(tempRoot, "cli-parse");
    mkdirSync(dataDir, { recursive: true });
    // A valid auth file whose pid sits at the Windows ceiling (4194304) and is never allocated
    // makes the CLI fail right after argument parsing and line validation, before network I/O.
    writeFileSync(join(dataDir, "event-server.json"),
      JSON.stringify({ port: 1, token: "t".repeat(64), pid: 4194304 }), "utf8");
    const payloads = [
      { hook_event_name: "Stop", cwd: "C:\\work\\deskpet", last_assistant_message: "ok" },
      { hook_event_name: "Notification", cwd: "C:\\work\\deskpet", message: "권한이 필요해요" },
      { hook_event_name: "StopFailure", cwd: "C:\\work\\deskpet" },
      { hook_event_name: "SubagentStop", cwd: "C:\\work\\deskpet" },
    ];
    for (const payload of payloads) {
      const args = await buildArgs(payload);
      let failure = "";
      try {
        await runNode(process.execPath, [cliEntry, ...args, "--user-data-dir", dataDir]);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const label = JSON.stringify(payload);
      expect(failure, label).not.toMatch(
        /알 수 없는 (옵션|인자)|--line 값|--var 이름|--var는|중복|옵션 값이 없습니다|사용법:/u,
      );
      expect(failure, label).toContain("DeskPet 앱 프로세스가 실행 중이지 않습니다");
    }
  }, 30_000);
});

describe("resolveCliPath", () => {
  const resolveCase = async (scriptDir: string, env: Record<string, string>, existing: string[]): Promise<string> => {
    const expression = `import(${JSON.stringify(hookModuleUrl("send-claude-code-event.mjs"))}).then(({resolveCliPath}) => { const [dir, env, existing] = process.argv.slice(1).map((raw) => JSON.parse(raw)); process.stdout.write(resolveCliPath(dir, env, (path) => existing.includes(path.replaceAll("\\\\", "/")))); })`;
    const result = await runNode(process.execPath, ["--input-type=module", "-e", expression, JSON.stringify(scriptDir), JSON.stringify(env), JSON.stringify(existing)]);
    return result.stdout.replaceAll("\\", "/");
  };
  const root = "C:/app/resources";

  it("DESKPET_CLI 가 가장 먼저다", async () => {
    expect(await resolveCase(`${root}/hooks`, { DESKPET_CLI: "D:/x/cli.js" }, [`${root}/cli/index.js`])).toBe("D:/x/cli.js");
  });

  it("설치본 배치(../cli/index.js)를 저장소 배치보다 먼저 본다", async () => {
    expect(await resolveCase(`${root}/hooks`, {}, [`${root}/cli/index.js`, "C:/packages/cli/dist/index.js"])).toBe(`${root}/cli/index.js`);
  });

  it("설치본 CLI 가 없으면 저장소 배치를 쓰고, 둘 다 없으면 저장소 경로를 오류 메시지용으로 돌려준다", async () => {
    expect(await resolveCase("C:/repo/docs/hooks", {}, ["C:/repo/packages/cli/dist/index.js"])).toBe("C:/repo/packages/cli/dist/index.js");
    expect(await resolveCase("C:/repo/docs/hooks", {}, [])).toBe("C:/repo/packages/cli/dist/index.js");
  });
});
