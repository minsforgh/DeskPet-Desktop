// CLI that prints Codex and Claude rate-limit usage and optionally rewrites the "| Codex 주간 |"
// and "| Claude 주간 |" rows of docs/progress/STATUS.md. Output carries rate_limits fields and
// timestamps only.
// Usage: node tools/usage/collect.mjs [--text] [--write-status <STATUS.md>] [sessionsDir]

import { readFile, writeFile } from "node:fs/promises";
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { collectClaudeUsage } from "./claude-usage.mjs";
import { collectCodexUsage } from "./codex-usage.mjs";

// KST is a fixed UTC+9 offset with no daylight saving time.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATUS_ROW_PREFIX = "| Codex 주간 |";
const CLAUDE_ROW_PREFIX = "| Claude 주간 |";
const CLAUDE_UNAVAILABLE = {
  status: "unavailable",
  reason: "스냅샷 없음: 상태줄 수집 설정 필요(tools/usage/README.md)",
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** KST wall-clock text for `iso`. `withDate` prepends "M/D" for multi-day (weekly) windows. */
function formatKst(iso, withDate) {
  const shifted = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())} KST`;
  return withDate ? `${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()} ${time}` : time;
}

function windowPhrase(label, window, withDate) {
  if (window === null) return null;
  const reset = window.resetPassed
    ? "리셋 지남, 값 낡음"
    : `리셋 ${formatKst(window.resetsAt, withDate)}`;
  return `${label} ${window.usedPercent}% (${reset})`;
}

/**
 * One-line Korean summary, e.g.
 * "Codex 5시간 97% (리셋 15:02 KST), 주간 34% (리셋 10/14 13:28 KST) · 기준 11:20 KST".
 * @param {import("./codex-usage.mjs").UsageSnapshot | null} usage
 * @returns {string}
 */
export function formatUsageText(usage) {
  if (usage === null) return "Codex 사용률 기록 없음";
  const phrases = [
    windowPhrase("5시간", usage.fiveHour, usage.fiveHour.windowMinutes >= 1440),
    windowPhrase("주간", usage.weekly, usage.weekly !== null && usage.weekly.windowMinutes >= 1440),
  ];
  return `Codex ${phrases.filter((phrase) => phrase !== null).join(", ")} · 기준 ${formatKst(usage.asOf, false)}`;
}

/**
 * One-line Korean summary for Claude, e.g.
 * "Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST".
 * @param {import("./claude-usage.mjs").ClaudeUsageSnapshot | null} usage
 * @returns {string}
 */
export function formatClaudeText(usage) {
  if (usage === null) return "Claude 미확인";
  const phrases = [windowPhrase("5시간", usage.fiveHour, false), windowPhrase("주간", usage.weekly, true)];
  const present = phrases.filter((phrase) => phrase !== null);
  if (present.length === 0) return "Claude 미확인";
  return `Claude ${present.join(", ")} · 기준 ${formatKst(usage.asOf, false)}`;
}

/**
 * Replacement row for the STATUS.md resource table:
 * "| Codex 주간 | <summary> | <weekly reset KST> |".
 * @param {import("./codex-usage.mjs").UsageSnapshot | null} usage
 * @returns {string}
 */
export function statusRow(usage) {
  if (usage === null) return `${STATUS_ROW_PREFIX} 기록 없음 | 미확인 |`;
  const resetCell = usage.weekly === null ? "미확인" : formatKst(usage.weekly.resetsAt, true);
  return `${STATUS_ROW_PREFIX} ${formatUsageText(usage)} | ${resetCell} |`;
}

/**
 * Replaces only the first "| Codex 주간 |" row in `content`, byte-for-byte preserving
 * every other line and line ending. Returns null when the row is absent.
 * @param {string} content
 * @param {import("./codex-usage.mjs").UsageSnapshot | null} usage
 * @returns {string | null}
 */
export function replaceStatusRow(content, usage) {
  const pattern = /^\| Codex 주간 \|[^\r\n]*/m;
  if (!pattern.test(content)) return null;
  return content.replace(pattern, statusRow(usage));
}

/**
 * Replacement row for the STATUS.md resource table:
 * "| Claude 주간 | <summary> | <weekly reset KST> |".
 * @param {import("./claude-usage.mjs").ClaudeUsageSnapshot | null} usage
 * @returns {string}
 */
export function claudeStatusRow(usage) {
  if (usage === null) return `${CLAUDE_ROW_PREFIX} 미확인 | 미확인 |`;
  const resetCell = usage.weekly === null ? "미확인" : formatKst(usage.weekly.resetsAt, true);
  return `${CLAUDE_ROW_PREFIX} ${formatClaudeText(usage)} | ${resetCell} |`;
}

/**
 * Replaces only the first "| Claude 주간 |" row in `content`, byte-for-byte preserving every
 * other line and line ending. The "| Claude Opus 주간 |" row never matches: the pattern
 * requires "주간" right after "Claude ". Returns null when the row is absent.
 * @param {string} content
 * @param {import("./claude-usage.mjs").ClaudeUsageSnapshot | null} usage
 * @returns {string | null}
 */
export function replaceClaudeStatusRow(content, usage) {
  const pattern = /^\| Claude 주간 \|[^\r\n]*/m;
  if (!pattern.test(content)) return null;
  return content.replace(pattern, claudeStatusRow(usage));
}

/**
 * @param {string[]} argv
 * @returns {{text: boolean, writeStatus: string | null, sessionsDir: string | null}}
 */
export function parseArguments(argv) {
  const options = { text: false, writeStatus: null, sessionsDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--text") {
      options.text = true;
    } else if (argument === "--write-status") {
      index += 1;
      const value = argv[index];
      if (value === undefined || value === "") throw new Error("--write-status 옵션에는 STATUS.md 경로가 필요합니다.");
      options.writeStatus = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    } else if (options.sessionsDir === null) {
      options.sessionsDir = argument;
    } else {
      throw new Error(`인자를 이해할 수 없습니다: ${argument}`);
    }
  }
  return options;
}

/**
 * Rewrites the "| Codex 주간 |" and "| Claude 주간 |" rows that exist in the status file; a
 * missing row is skipped, and only when both are absent is this an error.
 * @param {string} statusPath
 * @param {import("./codex-usage.mjs").UsageSnapshot | null} codexUsage
 * @param {import("./claude-usage.mjs").ClaudeUsageSnapshot | null} claudeUsage
 * @returns {Promise<boolean>}
 */
async function writeStatusRows(statusPath, codexUsage, claudeUsage) {
  let content;
  try {
    content = await readFile(statusPath, "utf8");
  } catch {
    console.error(`'${statusPath}' 파일을 읽을 수 없습니다.`);
    process.exitCode = 1;
    return false;
  }
  const codexUpdated = replaceStatusRow(content, codexUsage);
  const claudeUpdated = replaceClaudeStatusRow(codexUpdated ?? content, claudeUsage);
  if (codexUpdated === null && claudeUpdated === null) {
    console.error(`'${statusPath}'에 '| Codex 주간 |' 또는 '| Claude 주간 |' 줄이 없어 파일을 수정하지 않았습니다.`);
    process.exitCode = 1;
    return false;
  }
  await writeFile(statusPath, claudeUpdated ?? codexUpdated, "utf8");
  return true;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const codexUsage = await collectCodexUsage(
    options.sessionsDir === null ? {} : { sessionsDir: options.sessionsDir },
  );
  const claudeUsage = await collectClaudeUsage();
  if (options.writeStatus !== null && !(await writeStatusRows(options.writeStatus, codexUsage, claudeUsage))) return;
  console.log(
    options.text
      ? `${formatUsageText(codexUsage)}\n${formatClaudeText(claudeUsage)}`
      : JSON.stringify({ codex: codexUsage, claude: claudeUsage ?? CLAUDE_UNAVAILABLE }, null, 2),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
