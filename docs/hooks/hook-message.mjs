// Pure text helpers for hook notifications (M5 criterion 14: rule-based, no language model).
// All lengths are counted in Unicode code points, matching packages/core text validation.

// One-line bubble budget from the M5 spec (~80 chars). Line rendering caps at 120.
export const TEXT_MAX_CODE_POINTS = 80;
// In "folder: task -> result" the task gets at most 24 code points; the remaining budget goes to the result.
export const TASK_MAX_CODE_POINTS = 24;
// Detail line budgets from the M5 spec. The bubble does not show --detail yet.
export const DETAIL_TASK_MAX_CODE_POINTS = 300;
export const DETAIL_RESULT_MAX_CODE_POINTS = 500;
// Variable budget matches the app's line variable validation (packages/core petEventSchema):
// at most 500 Unicode code points and no control characters (C0, DEL, C1).
export const VARIABLE_MAX_CODE_POINTS = 500;

/** First non-empty line with leading markdown markers stripped and whitespace collapsed to single spaces. */
export function firstLine(text) {
  if (typeof text !== "string") return "";
  const rawLine = text.split(/\r?\n/u).find((line) => line.trim() !== "") ?? "";
  let line = rawLine.trim();
  for (;;) {
    const next = line
      // Block markers that need following whitespace: headings, bullets, quotes, ordered lists.
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^[*+-]\s+/u, "")
      .replace(/^>\s?/u, "")
      .replace(/^\d+[.)]\s+/u, "")
      // Emphasis or code opening at the start of the line; the pair may close mid-line.
      .replace(/^`+([^`]*)`+/u, "$1")
      .replace(/^\*\*(.+?)\*\*/u, "$1")
      .replace(/^\*(.+?)\*/u, "$1");
    if (next === line) break;
    line = next;
  }
  // Leftover unmatched markers at the edges, e.g. a bare code fence "```js".
  line = line.replace(/^[*`]+/u, "").replace(/[*`]+$/u, "");
  return line.replace(/\s+/gu, " ").trim();
}

/** Truncates to at most `max` code points; a cut becomes max - 1 code points plus "…". */
export function fit(text, max) {
  if (typeof text !== "string" || max <= 0) return "";
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function countCodePoints(text) {
  return [...text].length;
}

/**
 * Variable value for --line phrases: the firstLine cleanup (markdown stripped, whitespace
 * collapsed), remaining control characters folded to spaces, then capped at
 * VARIABLE_MAX_CODE_POINTS. Returns "" when nothing usable remains, so the caller omits the --var.
 */
export function variableValue(value) {
  if (typeof value !== "string") return "";
  const cleaned = firstLine(value)
    // \p{Cc} is exactly C0 (U+0000-U+001F), DEL, and C1 (U+007F-U+009F): the characters the
    // app's line variable pattern rejects.
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned === "" ? "" : fit(cleaned, VARIABLE_MAX_CODE_POINTS);
}

function cleanLine(text) {
  return firstLine(typeof text === "string" ? text : "");
}

/** Selects a declared line and trims its variables to the old one-line phrase budget. */
export function selectLine({ folder, task, result, kind, message }) {
  const folderName = typeof folder === "string" && folder !== "" ? folder : "작업 폴더";
  if (kind !== "done") {
    const messageLine = variableValue(message);
    const suffix = kind === "failed" ? "failed" : kind === "info" ? "info" : "waiting";
    if (messageLine !== "") return { id: `${suffix}-message`, vars: { folder: folderName,
      message: fit(messageLine, TEXT_MAX_CODE_POINTS - countCodePoints(`${folderName}: `)) } };
    return { id: `${suffix}-default`, vars: { folder: folderName } };
  }
  const taskLine = variableValue(task);
  const resultLine = variableValue(result);
  if (taskLine !== "" && resultLine !== "") {
    const taskFit = fit(taskLine, TASK_MAX_CODE_POINTS);
    const prefix = `${folderName}: ${taskFit} → `;
    const resultBudget = TEXT_MAX_CODE_POINTS - countCodePoints(prefix);
    if (resultBudget <= 0) return { id: "done-task", vars: { folder: folderName,
      task: fit(taskFit, TEXT_MAX_CODE_POINTS - countCodePoints(`${folderName}: `)) } };
    return { id: "done-task-result", vars: { folder: folderName, task: taskFit, result: fit(resultLine, resultBudget) } };
  }
  if (taskLine !== "") return { id: "done-task", vars: { folder: folderName,
    task: fit(taskLine, TEXT_MAX_CODE_POINTS - countCodePoints(`${folderName}: `)) } };
  if (resultLine !== "") return { id: "done-result", vars: { folder: folderName,
    result: fit(resultLine, TEXT_MAX_CODE_POINTS - countCodePoints(`${folderName}: `)) } };
  return { id: "done-default", vars: { folder: folderName } };
}

/** Multi-line --detail: full working folder path, then "시킨 일:" / "결과:" lines when present. */
export function composeDetail(cwd, { task, result } = {}) {
  const lines = [typeof cwd === "string" ? cwd : ""];
  const taskLine = cleanLine(task);
  if (taskLine !== "") lines.push(`시킨 일: ${fit(taskLine, DETAIL_TASK_MAX_CODE_POINTS)}`);
  const resultLine = cleanLine(result);
  if (resultLine !== "") lines.push(`결과: ${fit(resultLine, DETAIL_RESULT_MAX_CODE_POINTS)}`);
  return lines.join("\n");
}

/**
 * Picks the task from parsed transcript lines: the user line whose promptId matches the payload
 * and whose message.content is a plain string (tool results use an array and are skipped),
 * falling back to the last "last-prompt" line. Returns undefined when nothing is found.
 */
export function taskFromTranscriptLines(lines, promptId) {
  let promptTask = "";
  let lastPromptTask = "";
  for (const line of lines) {
    if (typeof line !== "string" || line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type === "user" && promptId !== undefined && entry.promptId === promptId) {
      const message = entry.message;
      if (message !== null && typeof message === "object" && !Array.isArray(message) &&
          typeof message.content === "string" && message.content.trim() !== "") {
        promptTask = message.content;
      }
    }
    if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string" && entry.lastPrompt.trim() !== "") {
      lastPromptTask = entry.lastPrompt;
    }
  }
  if (promptTask !== "") return promptTask;
  if (lastPromptTask !== "") return lastPromptTask;
  return undefined;
}

/** Codex task: the last non-empty string of input-messages. */
export function taskFromCodexPayload(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const messages = input["input-messages"];
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}
