/* global console, process */

// Codex allows a single `notify` program. This wrapper runs the program that was configured before
// (kept as the first argument) and also sends the same payload to DeskPet.
//
//   notify = ["node", "<repo>/docs/hooks/codex-notify-wrapper.mjs", "<original program>", "<original args>..."]
//
// Codex appends the JSON payload as the last argument; it is forwarded to the original program untouched.
// The shared sender selects a codex.* line ID and its declared variables for DeskPet.

import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [original, ...originalArgs] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

let status = 0;
if (original !== undefined) {
  const result = spawnSync(original, originalArgs, { stdio: "inherit", windowsHide: true });
  if (result.error) console.error(`원래 notify 프로그램을 실행하지 못했습니다: ${result.error.message}`);
  else status = result.status ?? 0;
}

// DeskPet being off or failing must never change the original program's outcome.
spawnSync(process.execPath, [resolve(here, "send-claude-code-event.mjs"), "--source", "codex", ...originalArgs.slice(-1)], {
  stdio: "ignore",
  windowsHide: true,
});

process.exitCode = status;
