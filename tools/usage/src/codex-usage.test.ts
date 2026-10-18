import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectCodexUsage, RECENT_FILE_LIMIT, TAIL_BYTES } from "../codex-usage.mjs";

type UsageSnapshot = NonNullable<Awaited<ReturnType<typeof collectCodexUsage>>>;

const tempRoot = mkdtempSync(join(tmpdir(), "deskpet-codex-usage-"));

// Fixed epoch values keep every assertion independent of the real clock.
// NOW_MS is 2026-10-08 11:20 KST; resets below are 15:30 KST and 2026-10-14 13:28 KST.
const NOW_MS = Date.UTC(2026, 9, 8, 2, 20, 0);
const PRIMARY_RESET_S = Date.UTC(2026, 9, 8, 6, 30, 0) / 1000;
const WEEKLY_RESET_S = Date.UTC(2026, 9, 14, 4, 28, 0) / 1000;

interface RawWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

const primary = (usedPercent: number, resetsAt: number = PRIMARY_RESET_S): RawWindow => ({
  used_percent: usedPercent,
  window_minutes: 300,
  resets_at: resetsAt,
});

const weekly = (usedPercent: number, resetsAt: number = WEEKLY_RESET_S): RawWindow => ({
  used_percent: usedPercent,
  window_minutes: 10080,
  resets_at: resetsAt,
});

const tokenLine = (timestamp: string, windows: { primary?: RawWindow; secondary?: RawWindow } = {}): string =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: windows } });

const noiseLine = (timestamp: string): string =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "agent_message", message: "..." } });

function sessionDir(name: string): string {
  const dir = join(tempRoot, name, "2026", "10", "08");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSession(dir: string, file: string, lines: string[], mtime: Date = new Date(NOW_MS)): string {
  const path = join(dir, file);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  utimesSync(path, mtime, mtime);
  return path;
}

function expectUsage(result: UsageSnapshot | null): UsageSnapshot {
  if (result === null) throw new Error("expected a usage record");
  return result;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("collectCodexUsage", () => {
  it("keeps the event with the latest timestamp across files", async () => {
    const dir = sessionDir("latest-across-files");
    writeSession(dir, "a.jsonl", [
      tokenLine("2026-10-08T02:19:00.000Z", { primary: primary(50), secondary: weekly(30) }),
    ]);
    writeSession(dir, "b.jsonl", [
      tokenLine("2026-10-08T02:10:00.000Z", { primary: primary(97), secondary: weekly(34) }),
    ]);
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.asOf).toBe("2026-10-08T02:19:00.000Z");
    expect(usage.fiveHour.usedPercent).toBe(50);
    expect(usage.weekly?.usedPercent).toBe(30);
  });

  it("prefers the latest timestamp even when the newest-modified file holds an older event", async () => {
    const dir = sessionDir("mtime-vs-timestamp");
    writeSession(
      dir,
      "newer-mtime.jsonl",
      [tokenLine("2026-10-08T01:00:00.000Z", { primary: primary(11) })],
      new Date(NOW_MS),
    );
    writeSession(
      dir,
      "older-mtime.jsonl",
      [tokenLine("2026-10-08T02:05:00.000Z", { primary: primary(22) })],
      new Date(NOW_MS - 3_600_000),
    );
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.asOf).toBe("2026-10-08T02:05:00.000Z");
    expect(usage.fiveHour.usedPercent).toBe(22);
  });

  it("scans back past broken lines and lines without usable rate limits", async () => {
    const dir = sessionDir("skip-lines");
    writeSession(dir, "a.jsonl", [
      tokenLine("2026-10-08T02:15:00.000Z", { primary: primary(41), secondary: weekly(12) }),
      "{not valid json",
      noiseLine("2026-10-08T02:15:10.000Z"),
      tokenLine("2026-10-08T02:15:20.000Z"),
      tokenLine("2026-10-08T02:15:30.000Z", { secondary: weekly(13) }),
    ]);
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.asOf).toBe("2026-10-08T02:15:00.000Z");
    expect(usage.fiveHour.usedPercent).toBe(41);
    expect(usage.weekly?.usedPercent).toBe(12);
  });

  it("marks windows whose reset time is in the past", async () => {
    const dir = sessionDir("reset-passed");
    writeSession(dir, "a.jsonl", [
      tokenLine("2026-10-08T02:19:00.000Z", {
        primary: primary(97, Date.UTC(2026, 9, 8, 1, 0, 0) / 1000),
        secondary: weekly(34, WEEKLY_RESET_S),
      }),
    ]);
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.fiveHour.resetPassed).toBe(true);
    expect(usage.fiveHour.resetsAt).toBe("2026-10-08T01:00:00.000Z");
    expect(usage.fiveHour.windowMinutes).toBe(300);
    expect(usage.weekly?.resetPassed).toBe(false);
    expect(usage.weekly?.resetsAt).toBe("2026-10-14T04:28:00.000Z");
    expect(usage.weekly?.windowMinutes).toBe(10080);
  });

  it("treats a reset exactly at now as not passed", async () => {
    const dir = sessionDir("reset-boundary");
    writeSession(dir, "a.jsonl", [
      tokenLine("2026-10-08T02:19:00.000Z", { primary: primary(5, NOW_MS / 1000) }),
    ]);
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.fiveHour.resetPassed).toBe(false);
  });

  it("returns null for a missing dir, an empty dir, and files without usable records", async () => {
    const dir = sessionDir("no-records");
    writeSession(dir, "noise.jsonl", [noiseLine("2026-10-08T02:00:00.000Z"), "{broken"]);
    await expect(collectCodexUsage({ sessionsDir: dir, now: NOW_MS })).resolves.toBeNull();
    await expect(collectCodexUsage({ sessionsDir: join(tempRoot, "missing"), now: NOW_MS })).resolves.toBeNull();
  });

  it("reads the tail of files larger than the tail budget", async () => {
    const dir = sessionDir("big-file");
    const filler = JSON.stringify({ type: "filler", padding: "x".repeat(1016) });
    const fillerCount = Math.ceil((TAIL_BYTES + 64 * 1024) / 1024);
    const path = writeSession(dir, "big.jsonl", [
      ...Array.from({ length: fillerCount }, () => filler),
      tokenLine("2026-10-08T02:18:00.000Z", { primary: primary(77), secondary: weekly(21) }),
    ]);
    expect(statSync(path).size).toBeGreaterThan(TAIL_BYTES);
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.asOf).toBe("2026-10-08T02:18:00.000Z");
    expect(usage.fiveHour.usedPercent).toBe(77);
  });

  it("ignores usable lines that fell outside the tail budget", async () => {
    const dir = sessionDir("big-file-head-only");
    const filler = JSON.stringify({ type: "filler", padding: "x".repeat(1016) });
    const fillerCount = Math.ceil((TAIL_BYTES + 64 * 1024) / 1024);
    const path = writeSession(dir, "big.jsonl", [
      tokenLine("2026-10-08T02:18:00.000Z", { primary: primary(77) }),
      ...Array.from({ length: fillerCount }, () => filler),
    ]);
    expect(statSync(path).size).toBeGreaterThan(TAIL_BYTES);
    await expect(collectCodexUsage({ sessionsDir: dir, now: NOW_MS })).resolves.toBeNull();
  });

  it("reads only the newest-modified files", async () => {
    const dir = sessionDir("file-limit");
    for (let index = 0; index < RECENT_FILE_LIMIT; index += 1) {
      writeSession(
        dir,
        `kept-${index}.jsonl`,
        [tokenLine(`2026-10-08T02:${String(index).padStart(2, "0")}:00.000Z`, { primary: primary(index) })],
        new Date(NOW_MS - index * 60_000),
      );
    }
    writeSession(
      dir,
      "excluded.jsonl",
      [tokenLine("2026-10-08T02:59:00.000Z", { primary: primary(99) })],
      new Date(NOW_MS - (RECENT_FILE_LIMIT + 1) * 60_000),
    );
    const usage = expectUsage(await collectCodexUsage({ sessionsDir: dir, now: NOW_MS }));
    expect(usage.asOf).toBe("2026-10-08T02:09:00.000Z");
    expect(usage.fiveHour.usedPercent).toBe(9);
  });
});
