// Claude rate-limit usage reader for the usage collector (ops tool, 2026-10-08). Reads only the
// snapshot written by claude-statusline-tee.mjs; that file holds rate-limit numbers and a
// timestamp and nothing else, so no session content can leak through here.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const SNAPSHOT_NAME = "claude-rate-limits.json";

/**
 * @typedef {object} ClaudeUsageWindow
 * @property {number} usedPercent
 * @property {string} resetsAt ISO timestamp (UTC)
 * @property {boolean} resetPassed true when the recorded reset time is already in the past
 */

/**
 * @typedef {object} ClaudeUsageSnapshot
 * @property {string} asOf ISO timestamp captured by the statusline tee
 * @property {ClaudeUsageWindow | null} fiveHour null when the window was absent in the payload
 * @property {ClaudeUsageWindow | null} weekly null when the window was absent in the payload
 */

function isStoredWindow(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    typeof value.resetsAt === "number" &&
    Number.isFinite(value.resetsAt)
  );
}

function toWindow(stored, nowMs) {
  return {
    usedPercent: stored.usedPercent,
    resetsAt: new Date(stored.resetsAt * 1000).toISOString(),
    resetPassed: stored.resetsAt * 1000 < nowMs,
  };
}

/**
 * Latest Claude rate-limit snapshot recorded by the statusline tee. A missing, corrupt, or
 * window-less snapshot means there is no record: null.
 * @param {{usageDir?: string, now?: Date | number | string}} [options]
 * @returns {Promise<ClaudeUsageSnapshot | null>}
 */
export async function collectClaudeUsage(options = {}) {
  const override = process.env.DESKPET_USAGE_DIR;
  const usageDir =
    options.usageDir ?? (override !== undefined && override !== "" ? override : join(homedir(), ".deskpet", "usage"));
  const nowMs = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  let raw;
  try {
    raw = await readFile(join(usageDir, SNAPSHOT_NAME), "utf8");
  } catch {
    return null; // No snapshot yet (or unreadable): the collector reports Claude as unavailable.
  }
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const capturedAt = Date.parse(typeof stored?.capturedAt === "string" ? stored.capturedAt : "");
  if (Number.isNaN(capturedAt)) return null;
  const fiveHour = isStoredWindow(stored.fiveHour) ? toWindow(stored.fiveHour, nowMs) : null;
  const weekly = isStoredWindow(stored.weekly) ? toWindow(stored.weekly, nowMs) : null;
  if (fiveHour === null && weekly === null) return null;
  return { asOf: new Date(capturedAt).toISOString(), fiveHour, weekly };
}
