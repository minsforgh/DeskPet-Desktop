import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectClaudeUsage } from "../claude-usage.mjs";

type ClaudeUsageSnapshot = NonNullable<Awaited<ReturnType<typeof collectClaudeUsage>>>;

const tempRoot = mkdtempSync(join(tmpdir(), "deskpet-claude-usage-"));

// Fixed epoch values keep every assertion independent of the real clock.
// NOW_MS is 2026-10-08 14:30 KST; resets below are 17:00 KST and 10/12 09:00 KST.
const NOW_MS = Date.UTC(2026, 9, 8, 5, 30, 0);
const FIVE_RESET_S = Date.UTC(2026, 9, 8, 8, 0, 0) / 1000;
const WEEKLY_RESET_S = Date.UTC(2026, 9, 12, 0, 0, 0) / 1000;

function writeSnapshot(name: string, content: string): string {
  const usageDir = join(tempRoot, name);
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(join(usageDir, "claude-rate-limits.json"), content, "utf8");
  return usageDir;
}

function expectUsage(result: ClaudeUsageSnapshot | null): ClaudeUsageSnapshot {
  if (result === null) throw new Error("expected a usage record");
  return result;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("collectClaudeUsage", () => {
  it("converts the stored snapshot into ISO resets and the captured as-of time", async () => {
    const usageDir = writeSnapshot(
      "valid",
      `${JSON.stringify({
        capturedAt: "2026-10-08T05:30:00.123Z",
        fiveHour: { usedPercent: 23, resetsAt: FIVE_RESET_S },
        weekly: { usedPercent: 41, resetsAt: WEEKLY_RESET_S },
      })}\n`,
    );
    const usage = expectUsage(await collectClaudeUsage({ usageDir, now: NOW_MS }));
    expect(usage).toEqual({
      asOf: "2026-10-08T05:30:00.123Z",
      fiveHour: { usedPercent: 23, resetsAt: "2026-10-08T08:00:00.000Z", resetPassed: false },
      weekly: { usedPercent: 41, resetsAt: "2026-10-12T00:00:00.000Z", resetPassed: false },
    });
  });

  it("marks windows whose reset time is in the past and treats reset-at-now as not passed", async () => {
    const usageDir = writeSnapshot(
      "passed",
      `${JSON.stringify({
        capturedAt: "2026-10-08T05:30:00.000Z",
        fiveHour: { usedPercent: 23, resetsAt: Date.UTC(2026, 9, 8, 1, 0, 0) / 1000 },
        weekly: { usedPercent: 41, resetsAt: NOW_MS / 1000 },
      })}\n`,
    );
    const usage = expectUsage(await collectClaudeUsage({ usageDir, now: NOW_MS }));
    expect(usage.fiveHour?.resetPassed).toBe(true);
    expect(usage.weekly?.resetPassed).toBe(false);
  });

  it("keeps a missing window as null", async () => {
    const usageDir = writeSnapshot(
      "weekly-only",
      `${JSON.stringify({
        capturedAt: "2026-10-08T05:30:00.000Z",
        fiveHour: null,
        weekly: { usedPercent: 41, resetsAt: WEEKLY_RESET_S },
      })}\n`,
    );
    const usage = expectUsage(await collectClaudeUsage({ usageDir, now: NOW_MS }));
    expect(usage.fiveHour).toBeNull();
    expect(usage.weekly?.usedPercent).toBe(41);
  });

  it("returns null for a missing file, broken JSON, a bad timestamp, or no usable window", async () => {
    await expect(collectClaudeUsage({ usageDir: join(tempRoot, "missing"), now: NOW_MS })).resolves.toBeNull();
    const broken = writeSnapshot("broken", "{not valid json\n");
    await expect(collectClaudeUsage({ usageDir: broken, now: NOW_MS })).resolves.toBeNull();
    const badTime = writeSnapshot(
      "bad-time",
      `${JSON.stringify({ capturedAt: "yesterday", fiveHour: { usedPercent: 1, resetsAt: FIVE_RESET_S } })}\n`,
    );
    await expect(collectClaudeUsage({ usageDir: badTime, now: NOW_MS })).resolves.toBeNull();
    const noWindows = writeSnapshot(
      "no-windows",
      `${JSON.stringify({ capturedAt: "2026-10-08T05:30:00.000Z", fiveHour: null, weekly: null })}\n`,
    );
    await expect(collectClaudeUsage({ usageDir: noWindows, now: NOW_MS })).resolves.toBeNull();
  });
});
