import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { claudeStatusRow, formatClaudeText, formatUsageText, replaceClaudeStatusRow, replaceStatusRow, statusRow } from "../collect.mjs";

interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
  resetPassed: boolean;
}

interface UsageSnapshot {
  asOf: string;
  fiveHour: UsageWindow;
  weekly: UsageWindow | null;
}

interface ClaudeUsageWindow {
  usedPercent: number;
  resetsAt: string;
  resetPassed: boolean;
}

interface ClaudeUsageSnapshot {
  asOf: string;
  fiveHour: ClaudeUsageWindow | null;
  weekly: ClaudeUsageWindow | null;
}

const runNode = promisify(execFile);
const collectCli = fileURLToPath(new URL("../collect.mjs", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "deskpet-usage-cli-"));

// 97% five-hour (reset 15:02 KST) and 34% weekly (reset 10/14 13:28 KST) as of 11:20 KST,
// matching the example in the task spec.
const snapshot: UsageSnapshot = {
  asOf: "2026-10-08T02:20:02.748Z",
  fiveHour: { usedPercent: 97, windowMinutes: 300, resetsAt: "2026-10-08T06:02:00.000Z", resetPassed: false },
  weekly: { usedPercent: 34, windowMinutes: 10080, resetsAt: "2026-10-14T04:28:00.000Z", resetPassed: false },
};

// Claude example from the task spec: 23% five-hour (reset 17:00 KST) and 41% weekly
// (reset 10/12 09:00 KST) as of 14:30 KST.
const claudeSnapshot: ClaudeUsageSnapshot = {
  asOf: "2026-10-08T05:30:00.000Z",
  fiveHour: { usedPercent: 23, resetsAt: "2026-10-08T08:00:00.000Z", resetPassed: false },
  weekly: { usedPercent: 41, resetsAt: "2026-10-12T00:00:00.000Z", resetPassed: false },
};

// What the CLI reports for writeClaudeSnapshotFile(): the same numbers with 2099 resets so the
// subprocess, which uses the real clock, always sees resetPassed false.
const cliClaudeSnapshot: ClaudeUsageSnapshot = {
  asOf: "2026-10-08T05:30:00.000Z",
  fiveHour: { usedPercent: 23, resetsAt: "2099-10-08T08:00:00.000Z", resetPassed: false },
  weekly: { usedPercent: 41, resetsAt: "2099-10-12T00:00:00.000Z", resetPassed: false },
};

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// DESKPET_USAGE_DIR is always pinned to a temp dir so the CLI never picks up a real snapshot
// from the developer's home, and so each test controls whether Claude data exists.
async function runCollect(usageDir: string, ...args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await runNode(process.execPath, [collectCli, ...args], {
      encoding: "utf8",
      env: { ...process.env, DESKPET_USAGE_DIR: usageDir },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function emptyUsageDir(name: string): string {
  const dir = join(tempRoot, name, "usage");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The on-disk snapshot written by the statusline tee: raw epoch seconds, resets far in 2099
// so the CLI subprocess (which uses the real clock) stays deterministic.
function writeClaudeSnapshotFile(usageDir: string): void {
  writeFileSync(
    join(usageDir, "claude-rate-limits.json"),
    `${JSON.stringify({
      capturedAt: "2026-10-08T05:30:00.000Z",
      fiveHour: { usedPercent: 23, resetsAt: Date.UTC(2099, 9, 8, 8, 0, 0) / 1000 },
      weekly: { usedPercent: 41, resetsAt: Date.UTC(2099, 9, 12, 0, 0, 0) / 1000 },
    })}\n`,
    "utf8",
  );
}

const tokenLine = (timestamp: string): string =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {},
      rate_limits: {
        // Resets far from any plausible real clock keep subprocess output deterministic.
        primary: { used_percent: 97, window_minutes: 300, resets_at: Date.UTC(2099, 9, 8, 6, 2, 0) / 1000 },
        secondary: { used_percent: 34, window_minutes: 10080, resets_at: Date.UTC(2000, 0, 1, 0, 0, 0) / 1000 },
      },
    },
  });

const statusTable = [
  "| 항목 | 사용률 | 리셋 |",
  "|---|---|---|",
  "| Claude 주간 | 미확인 | 미확인 |",
  "| Claude Opus 주간 | 수동 기록 | 미확인 |",
  "| Codex 주간 | 낡은 수동 기록 | 미확인 |",
  "| GLM(Z.ai) 5시간 | 소진 | 5시간 창 |",
].join("\n");

function writeSessions(name: string): string {
  const sessions = join(tempRoot, name, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout.jsonl"), `${tokenLine("2026-10-08T02:20:02.748Z")}\n`, "utf8");
  return sessions;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("formatUsageText", () => {
  it("formats both windows with KST resets and the as-of time", () => {
    expect(formatUsageText(snapshot)).toBe(
      "Codex 5시간 97% (리셋 15:02 KST), 주간 34% (리셋 10/14 13:28 KST) · 기준 11:20 KST",
    );
  });

  it("marks passed resets as stale", () => {
    const passed = { ...snapshot, fiveHour: { ...snapshot.fiveHour, resetPassed: true } };
    expect(formatUsageText(passed)).toBe(
      "Codex 5시간 97% (리셋 지남, 값 낡음), 주간 34% (리셋 10/14 13:28 KST) · 기준 11:20 KST",
    );
  });

  it("omits a missing weekly window and reports no records", () => {
    expect(formatUsageText({ ...snapshot, weekly: null })).toBe(
      "Codex 5시간 97% (리셋 15:02 KST) · 기준 11:20 KST",
    );
    expect(formatUsageText(null)).toBe("Codex 사용률 기록 없음");
  });
});

describe("formatClaudeText", () => {
  it("formats both windows with KST resets and the as-of time", () => {
    expect(formatClaudeText(claudeSnapshot)).toBe(
      "Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST",
    );
  });

  it("marks passed resets as stale", () => {
    const passed: ClaudeUsageSnapshot = {
      ...claudeSnapshot,
      weekly: { usedPercent: 41, resetsAt: "2026-10-12T00:00:00.000Z", resetPassed: true },
    };
    expect(formatClaudeText(passed)).toBe(
      "Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 지남, 값 낡음) · 기준 14:30 KST",
    );
  });

  it("omits a missing window and reports unknown without a snapshot", () => {
    expect(formatClaudeText({ ...claudeSnapshot, weekly: null })).toBe(
      "Claude 5시간 23% (리셋 17:00 KST) · 기준 14:30 KST",
    );
    expect(formatClaudeText({ ...claudeSnapshot, fiveHour: null })).toBe(
      "Claude 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST",
    );
    expect(formatClaudeText(null)).toBe("Claude 미확인");
  });
});

describe("STATUS.md row replacement", () => {
  it("replaces only the Codex weekly row, keeping every other line and ending", () => {
    const content = `${statusTable}\n`;
    const updated = replaceStatusRow(content, snapshot);
    expect(updated).toBe(
      [
        "| 항목 | 사용률 | 리셋 |",
        "|---|---|---|",
        "| Claude 주간 | 미확인 | 미확인 |",
        "| Claude Opus 주간 | 수동 기록 | 미확인 |",
        "| Codex 주간 | Codex 5시간 97% (리셋 15:02 KST), 주간 34% (리셋 10/14 13:28 KST) · 기준 11:20 KST | 10/14 13:28 KST |",
        "| GLM(Z.ai) 5시간 | 소진 | 5시간 창 |",
        "",
      ].join("\n"),
    );
  });

  it("keeps CRLF endings of untouched lines", () => {
    const content = `${statusTable.split("\n").join("\r\n")}\r\n`;
    const updated = replaceStatusRow(content, snapshot);
    expect(updated).toContain("| Claude 주간 | 미확인 | 미확인 |\r\n");
    expect(updated).toContain("| GLM(Z.ai) 5시간 | 소진 | 5시간 창 |\r\n");
    expect(updated).not.toContain("\r\r");
  });

  it("writes a fallback row for no records and returns null without the marker row", () => {
    expect(statusRow(null)).toBe("| Codex 주간 | 기록 없음 | 미확인 |");
    expect(replaceStatusRow("nothing to update\n", snapshot)).toBeNull();
  });

  it("replaces only the Claude weekly row and never the Claude Opus row", () => {
    const updated = replaceClaudeStatusRow(`${statusTable}\n`, claudeSnapshot);
    expect(updated).toBe(
      [
        "| 항목 | 사용률 | 리셋 |",
        "|---|---|---|",
        "| Claude 주간 | Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST | 10/12 09:00 KST |",
        "| Claude Opus 주간 | 수동 기록 | 미확인 |",
        "| Codex 주간 | 낡은 수동 기록 | 미확인 |",
        "| GLM(Z.ai) 5시간 | 소진 | 5시간 창 |",
        "",
      ].join("\n"),
    );
  });

  it("writes a fallback Claude row for no snapshot and returns null without the marker row", () => {
    expect(claudeStatusRow(null)).toBe("| Claude 주간 | 미확인 | 미확인 |");
    expect(claudeStatusRow({ ...claudeSnapshot, weekly: null })).toBe(
      "| Claude 주간 | Claude 5시간 23% (리셋 17:00 KST) · 기준 14:30 KST | 미확인 |",
    );
    expect(replaceClaudeStatusRow("nothing to update\n", claudeSnapshot)).toBeNull();
  });
});

describe("collect CLI", () => {
  it("prints JSON with the codex snapshot and the claude snapshot", async () => {
    const usageDir = emptyUsageDir("json-mode");
    writeClaudeSnapshotFile(usageDir);
    const run = await runCollect(usageDir, writeSessions("json-mode"));
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      codex: UsageSnapshot | null;
      claude: ClaudeUsageSnapshot | { status: string; reason: string };
    };
    expect(parsed.codex?.asOf).toBe("2026-10-08T02:20:02.748Z");
    expect(parsed.codex?.fiveHour?.usedPercent).toBe(97);
    expect(parsed.claude).toEqual(cliClaudeSnapshot);
  });

  it("prints the unavailable claude stub with a README pointer when no snapshot exists", async () => {
    const run = await runCollect(emptyUsageDir("json-no-snapshot"), writeSessions("json-no-snapshot"));
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { claude: { status: string; reason: string } };
    expect(parsed.claude.status).toBe("unavailable");
    expect(parsed.claude.reason).toContain("tools/usage/README.md");
  });

  it("prints a Claude summary line after the Codex line in --text mode", async () => {
    const usageDir = emptyUsageDir("text-mode");
    writeClaudeSnapshotFile(usageDir);
    const run = await runCollect(usageDir, writeSessions("text-mode"), "--text");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      "Codex 5시간 97% (리셋 15:02 KST), 주간 34% (리셋 지남, 값 낡음) · 기준 11:20 KST",
      "Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST",
    ]);
  });

  it("prints Claude 미확인 in --text mode without a snapshot", async () => {
    const run = await runCollect(emptyUsageDir("text-no-snapshot"), writeSessions("text-no-snapshot"), "--text");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trimEnd().split("\n")[1]).toBe("Claude 미확인");
  });

  it("rewrites the Codex and Claude weekly rows of the status file", async () => {
    const usageDir = emptyUsageDir("write-mode");
    writeClaudeSnapshotFile(usageDir);
    const statusPath = join(tempRoot, "write-mode", "STATUS.md");
    writeFileSync(statusPath, `${statusTable}\n`, "utf8");
    const run = await runCollect(usageDir, writeSessions("write-mode"), "--write-status", statusPath);
    expect(run.exitCode).toBe(0);
    const lines = readFileSync(statusPath, "utf8").split("\n");
    expect(lines[2]).toBe(
      "| Claude 주간 | Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST | 10/12 09:00 KST |",
    );
    expect(lines[3]).toBe("| Claude Opus 주간 | 수동 기록 | 미확인 |");
    expect(lines[4]).toBe(
      "| Codex 주간 | Codex 5시간 97% (리셋 15:02 KST), 주간 34% (리셋 지남, 값 낡음) · 기준 11:20 KST | 1/1 09:00 KST |",
    );
    expect(lines.length).toBe(7);
    expect(lines[0]).toBe("| 항목 | 사용률 | 리셋 |");
    expect(lines[5]).toBe("| GLM(Z.ai) 5시간 | 소진 | 5시간 창 |");
    expect(lines[6]).toBe("");
  });

  it("skips a missing Claude row and still rewrites the Codex row", async () => {
    const statusPath = join(tempRoot, "write-codex-only", "STATUS.md");
    mkdirSync(join(tempRoot, "write-codex-only"), { recursive: true });
    writeFileSync(statusPath, "| 항목 | 사용률 | 리셋 |\n|---|---|---|\n| Codex 주간 | 낡은 기록 | 미확인 |\n", "utf8");
    const run = await runCollect(
      emptyUsageDir("write-codex-only"),
      writeSessions("write-codex-only"),
      "--write-status",
      statusPath,
    );
    expect(run.exitCode).toBe(0);
    const lines = readFileSync(statusPath, "utf8").split("\n");
    expect(lines[2]).toMatch(/^\| Codex 주간 \| Codex 5시간 97%/);
  });

  it("leaves the file untouched and exits 1 when both marker rows are missing", async () => {
    const statusPath = join(tempRoot, "missing-rows", "STATUS.md");
    mkdirSync(join(tempRoot, "missing-rows"), { recursive: true });
    const original = "| 항목 | 사용률 |\n|---|---|\n| Claude Opus 주간 | 수동 기록 |\n";
    writeFileSync(statusPath, original, "utf8");
    const run = await runCollect(
      emptyUsageDir("missing-rows"),
      writeSessions("missing-rows"),
      "--write-status",
      statusPath,
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("줄이 없어");
    expect(readFileSync(statusPath, "utf8")).toBe(original);
  });
});
