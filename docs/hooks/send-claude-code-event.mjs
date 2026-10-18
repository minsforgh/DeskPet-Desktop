/* global console, process */

import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { composeDetail, selectLine, variableValue, taskFromCodexPayload, taskFromTranscriptLines } from "./hook-message.mjs";

function objectValue(input, names) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function eventKind(input) {
  return objectValue(input, ["hook_event_name", "event", "type", "notification_type"]);
}

function isCompletion(input) {
  const kind = eventKind(input);
  // Claude Code: "Stop". Codex notify: "agent-turn-complete".
  return typeof kind === "string" && /^(stop|finished)$|complete/iu.test(kind);
}

// Line kind follows the existing event branches: completion events are done, Notification and
// the no-kind default keep the wait phrase (waiting), failure-looking names become failed, and
// any other notifying event is info.
function voiceKind(input) {
  if (isCompletion(input)) return "done";
  const kind = (eventKind(input) ?? "").toLowerCase();
  if (kind !== "" && /(?:fail|error)/u.test(kind)) return "failed";
  return kind === "" || kind === "notification" ? "waiting" : "info";
}

// Transcript tail budget (1 MiB, M5 spec). Session dumps observed on 2026-10-08 were a few
// hundred KiB at most, so 1 MiB covers the interesting recent lines while keeping reads bounded.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/** Reads the last maxBytes of the file as lines, dropping the first line when the window starts mid-line. */
function readTailLines(filePath, maxBytes) {
  const { size } = statSync(filePath);
  const start = Math.max(0, size - maxBytes);
  const file = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(file, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      const newline = text.indexOf("\n");
      // The whole window is one partial line: every line in it is truncated, so drop it all.
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text.split(/\r?\n/u);
  } finally {
    closeSync(file);
  }
}

/**
 * Extracts the task from a Claude Code transcript. Only a `.jsonl` file inside
 * `options.allowedRoot` (default `<homedir>/.claude/projects`) is read, checked on the
 * realpath so "..", links, other drives, and paths outside the allowed root are rejected.
 * Any failure (missing file, permission, JSON error) returns undefined so the hook continues
 * without a task instead of failing.
 */
export function readTaskFromTranscript(input, options = {}) {
  try {
    const transcriptPath = objectValue(input, ["transcript_path"]);
    if (transcriptPath === undefined) return undefined;
    const root = realpathSync(options.allowedRoot ?? join(homedir(), ".claude", "projects"));
    const real = realpathSync(transcriptPath);
    if (extname(real).toLowerCase() !== ".jsonl") return undefined;
    const relativePath = relative(root, real);
    if (relativePath === "" || isAbsolute(relativePath) || relativePath.split(sep)[0] === "..") return undefined;
    if (!statSync(real).isFile()) return undefined;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id !== "" ? input.prompt_id : undefined;
    return taskFromTranscriptLines(readTailLines(real, TRANSCRIPT_TAIL_BYTES), promptId);
  } catch {
    return undefined;
  }
}

export function buildDeskpetEventArgs(input, fallbackCwd = process.cwd(), options = {}) {
  const cwd = resolve(objectValue(input, ["cwd", "working_directory", "workdir"]) ?? fallbackCwd);
  const folder = basename(cwd) || "작업 폴더";
  const completion = isCompletion(input);
  // options.task comes from transcript I/O done by send(); payload-only fields stay pure here.
  const task = typeof options.task === "string" && options.task.trim() !== ""
    ? options.task
    : taskFromCodexPayload(input);
  const result = objectValue(input, ["last_assistant_message", "last-assistant-message"]);
  // The Claude Code Notification field layout is unverified; a string `message` is used when
  // present and the default phrase otherwise.
  const message = completion ? undefined : objectValue(input, ["message"]);
  const source = options.source ?? "claude-code";
  const selected = selectLine({ folder, task, result, message, kind: voiceKind(input) });
  const args = [
    "event", "--source", source, "--type", "notify", "--key", folder,
    "--line", `${source}.${selected.id}`,
    "--mood", completion ? "happy" : "worried", "--detail", composeDetail(cwd, { task, result }),
  ];
  for (const [name, value] of Object.entries(selected.vars)) {
    const variable = variableValue(value);
    if (variable !== "") args.push("--var", `${name}=${variable}`);
  }
  return args;
}

/** Codex passes its payload as the last command-line argument; Claude Code passes it on stdin. */
export function payloadFromArgument(argument) {
  if (argument === undefined) return undefined;
  try {
    const parsed = JSON.parse(argument);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the CLI: DESKPET_CLI first, then the installed layout (resources/hooks -> resources/cli/index.js),
 * then the repository layout (docs/hooks -> packages/cli/dist/index.js). Falls back to the repository path
 * when none exists so the spawn error names a real location.
 */
export function resolveCliPath(scriptDir, env = process.env, exists = existsSync) {
  if (env.DESKPET_CLI) return env.DESKPET_CLI;
  const candidates = [resolve(scriptDir, "../cli/index.js"), resolve(scriptDir, "../../packages/cli/dist/index.js")];
  return candidates.find((candidate) => exists(candidate)) ?? candidates[1];
}

/** Runs the DeskPet CLI with this Node, so no PATH entry or .cmd shim is needed (Node refuses to spawn .cmd without a shell). */
function send(input, source = "claude-code") {
  const cli = resolveCliPath(dirname(fileURLToPath(import.meta.url)));
  // Reading the transcript is I/O, so it happens here and the result is passed as options.
  // Prompt and response content goes only into the spawned event argv, never into logs.
  const options = { source, task: readTaskFromTranscript(input, { allowedRoot: process.env.DESKPET_TRANSCRIPT_ROOT }) };
  const result = spawnSync(process.execPath, [cli, ...buildDeskpetEventArgs(input, process.cwd(), options)], { stdio: "inherit", windowsHide: true });
  if (result.error) {
    console.error(`DeskPet 이벤트를 보내지 못했습니다: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fromArgument = payloadFromArgument(process.argv.at(-1));
  const source = process.argv[2] === "--source" && process.argv[3] === "codex" ? "codex" : "claude-code";
  if (process.argv.length > 2 && fromArgument !== undefined) send(fromArgument, source);
  else {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let input = {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
      } catch {
        // Hooks must not fail because an optional payload is malformed.
      }
      send(input, source);
    });
  }
}
