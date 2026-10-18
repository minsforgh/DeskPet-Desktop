// Codex rate-limit usage collector for the STATUS.md resource table (ops tool, 2026-10-08).
// Reads only rate_limits fields and timestamps from session files; session content is never
// read beyond the token_count line shape or emitted anywhere.

import { Buffer } from "node:buffer";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Measured on this PC (2026-10-08): session files are 1.7~2.4 MB and the newest token_count
// line sits near the end of each file. Reading the newest 10 files x last 512 KB covers the
// latest event with bounded I/O even while several workers append at once (task spec values).
export const RECENT_FILE_LIMIT = 10;
export const TAIL_BYTES = 512 * 1024;

/**
 * @typedef {object} RawWindow
 * @property {number} used_percent
 * @property {number} window_minutes
 * @property {number} resets_at epoch seconds
 */

/**
 * @typedef {object} UsageWindow
 * @property {number} usedPercent
 * @property {number} windowMinutes
 * @property {string} resetsAt ISO timestamp (UTC)
 * @property {boolean} resetPassed true when the recorded reset time is already in the past
 */

/**
 * @typedef {object} UsageSnapshot
 * @property {string} asOf ISO timestamp of the newest event used
 * @property {UsageWindow} fiveHour
 * @property {UsageWindow | null} weekly null when the record has no secondary window
 */

function isRawWindow(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.used_percent === "number" &&
    typeof value.window_minutes === "number" &&
    typeof value.resets_at === "number"
  );
}

async function listSessionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Symlinks are neither file nor directory here, so a linked path cannot escape the sessions dir.
    if (entry.isDirectory()) files.push(...(await listSessionFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function readTail(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Newest usable token_count event in `tail`, scanning back to front.
 * Broken lines (including a tail-truncated first line), lines without rate_limits,
 * and lines without a primary window are skipped. Returns null when the tail has none.
 */
function newestEventFromTail(tail) {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index].trim();
    if (raw === "") continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    const payload = event?.payload;
    const limits = payload?.type === "token_count" ? payload.rate_limits : undefined;
    const primary = limits?.primary;
    if (!isRawWindow(primary)) continue;
    const at = Date.parse(typeof event.timestamp === "string" ? event.timestamp : "");
    if (Number.isNaN(at)) continue;
    const secondary = isRawWindow(limits.secondary) ? limits.secondary : null;
    return { at, primary, secondary };
  }
  return null;
}

function toWindow(raw, nowMs) {
  return {
    usedPercent: raw.used_percent,
    windowMinutes: raw.window_minutes,
    resetsAt: new Date(raw.resets_at * 1000).toISOString(),
    resetPassed: raw.resets_at * 1000 < nowMs,
  };
}

/**
 * Newest Codex rate-limit snapshot across the most recently modified session files.
 * The limit is account-wide, so parallel worker sessions all count: the winner is the
 * event with the latest timestamp, not the newest file on disk.
 * @param {{sessionsDir?: string, now?: Date | number | string}} [options]
 * @returns {Promise<UsageSnapshot | null>} null when no usable record exists.
 */
export async function collectCodexUsage(options = {}) {
  const sessionsDir = options.sessionsDir ?? join(homedir(), ".codex", "sessions");
  const nowMs = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  let files;
  try {
    files = await listSessionFiles(sessionsDir);
  } catch {
    return null; // A missing or unreadable sessions dir means there is no record.
  }
  const withMtime = [];
  for (const path of files) {
    try {
      const { mtimeMs } = await stat(path);
      withMtime.push({ path, mtimeMs });
    } catch {
      // A file that disappears between listing and stating contributes nothing.
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let newest = null;
  for (const { path } of withMtime.slice(0, RECENT_FILE_LIMIT)) {
    let event;
    try {
      event = newestEventFromTail(await readTail(path));
    } catch {
      continue; // Locked or unreadable files are skipped.
    }
    if (event !== null && (newest === null || event.at > newest.at)) newest = event;
  }
  if (newest === null) return null;
  return {
    asOf: new Date(newest.at).toISOString(),
    fiveHour: toWindow(newest.primary, nowMs),
    weekly: newest.secondary === null ? null : toWindow(newest.secondary, nowMs),
  };
}
