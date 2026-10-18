// Claude Code statusLine tee (ops tool, 2026-10-08). Reads the statusline JSON from stdin,
// stores only the rate_limits numbers as a snapshot for the usage collector, then forwards the
// raw stdin bytes to the existing Orca statusline hook so its usage display keeps working.
// Spec: https://code.claude.com/docs/en/statusline — subscription logins carry
// rate_limits.five_hour / .seven_day with used_percentage (0~100) and resets_at (epoch seconds);
// windows may be absent and API-key logins have no rate_limits at all.
// This script prints nothing and always exits 0: a statusline helper must never leak errors.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_NAME = "claude-rate-limits.json";

// The whole tee must finish within 1 s (task spec); an unstuck-able pipe must not hold the
// statusline back, so this failsafe force-exits quietly once the budget is gone.
const TOTAL_BUDGET_MS = 1_000;

function isWindow(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.used_percentage === "number" &&
    Number.isFinite(value.used_percentage) &&
    typeof value.resets_at === "number" &&
    Number.isFinite(value.resets_at)
  );
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("error", finish);
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}

function snapshotPaths() {
  const override = process.env.DESKPET_USAGE_DIR;
  const dir = override !== undefined && override !== "" ? override : join(homedir(), ".deskpet", "usage");
  return { dir, file: join(dir, SNAPSHOT_NAME) };
}

// Stores {capturedAt, fiveHour, weekly} with numeric fields only. When rate_limits is absent
// (API key login) or has no usable window, the previous snapshot is left untouched.
async function writeSnapshot(payload) {
  const limits = payload?.rate_limits;
  if (typeof limits !== "object" || limits === null) return false;
  const pick = (raw) => (isWindow(raw) ? { usedPercent: raw.used_percentage, resetsAt: raw.resets_at } : null);
  const fiveHour = pick(limits.five_hour);
  const weekly = pick(limits.seven_day);
  if (fiveHour === null && weekly === null) return false;
  const { dir, file } = snapshotPaths();
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `${SNAPSHOT_NAME}.${process.pid}.tmp`);
  const snapshot = { capturedAt: new Date().toISOString(), fiveHour, weekly };
  await writeFile(temp, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(temp, file);
  return true;
}

// Forwards the original stdin bytes to the Orca statusline hook when it exists. Windows runs it
// through `cmd /c` with the inherited environment; the exit code and output are ignored and the
// child is unreferenced so a slow hook cannot delay this script.
function forwardToOrca(input) {
  const script = join(homedir(), ".orca", "agent-hooks", "claude-statusline.cmd");
  stat(script).then(
    (info) => {
      if (!info.isFile()) return;
      const child =
        process.platform === "win32"
          ? spawn("cmd", ["/c", script], { stdio: ["pipe", "ignore", "ignore"] })
          : spawn(script, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.unref();
      child.stdin.end(input);
    },
    () => {},
  );
}

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input.toString("utf8"));
  } catch {
    return; // Malformed statusline JSON: exit quietly without forwarding.
  }
  try {
    await writeSnapshot(payload);
  } catch {
    // An unwritable snapshot location keeps the previous file; never fail the statusline.
  }
  forwardToOrca(input);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failsafe = setTimeout(() => process.exit(0), TOTAL_BUDGET_MS);
  failsafe.unref();
  main().catch(() => {});
}
