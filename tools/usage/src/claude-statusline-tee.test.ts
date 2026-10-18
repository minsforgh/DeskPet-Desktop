import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const teeScript = fileURLToPath(new URL("../claude-statusline-tee.mjs", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "deskpet-claude-tee-"));

// Fixed epoch values keep assertions independent of the real clock (2026-10-08 based).
const FIVE_RESET_S = Date.UTC(2026, 9, 8, 8, 0, 0) / 1000;
const WEEKLY_RESET_S = Date.UTC(2026, 9, 12, 0, 0, 0) / 1000;

const SNAPSHOT_NAME = "claude-rate-limits.json";

interface TeeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// The tee is always exercised as a child process with a fake HOME (USERPROFILE drives
// os.homedir on Windows), so it can never touch the real ~/.orca hook or ~/.deskpet.
function runTee(input: string, usageDir: string, fakeHome: string): Promise<TeeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [teeScript], {
      env: { ...process.env, DESKPET_USAGE_DIR: usageDir, USERPROFILE: fakeHome },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

function usageDir(name: string): string {
  const dir = join(tempRoot, name, "usage");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A realistic statusline payload: every field the tee must NOT persist sits next to rate_limits.
const fullPayload = JSON.stringify({
  hook_event_name: "Status",
  session_id: "sess-2b0d1f",
  transcript_path: "C:\\Users\\Example\\private\\sess-2b0d1f.jsonl",
  cwd: "C:\\Users\\Example\\secret-project",
  model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
  workspace: { current_dir: "C:\\Users\\Example\\secret-project", project_dir: "C:\\Users\\Example\\secret-project" },
  cost: { total_cost_usd: 1.25, total_duration_ms: 45000 },
  output_style: { name: "default" },
  email: "jungle@example.com",
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: FIVE_RESET_S },
    seven_day: { used_percentage: 41, resets_at: WEEKLY_RESET_S },
  },
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("claude-statusline-tee", () => {
  it("stores only the rate-limit numbers and leaves no other trace, quietly skipping the missing Orca hook", async () => {
    const dir = usageDir("full-payload");
    // USERPROFILE points at a directory that does not exist: the Orca hook lookup must be a
    // silent no-op (spawning the real hook is forbidden in tests).
    const run = await runTee(fullPayload, dir, join(tempRoot, "full-payload", "missing-home"));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");

    const snapshotPath = join(dir, SNAPSHOT_NAME);
    const raw = readFileSync(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual({
      capturedAt: expect.any(String),
      fiveHour: { usedPercent: 23, resetsAt: FIVE_RESET_S },
      weekly: { usedPercent: 41, resetsAt: WEEKLY_RESET_S },
    });
    expect((parsed as { capturedAt: string }).capturedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // None of the payload's non-rate-limit values may appear anywhere in the file.
    for (const forbidden of [
      "sess-2b0d1f",
      "session_id",
      "transcript",
      "private",
      "cwd",
      "secret-project",
      "opus",
      "model",
      "cost",
      "1.25",
      "example.com",
      "output_style",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // The atomic rename leaves no temp file behind.
    expect(readdirSync(dir)).toEqual([SNAPSHOT_NAME]);
  });

  it("keeps the previous snapshot untouched when rate_limits is absent or empty", async () => {
    const existing = `${JSON.stringify({
      capturedAt: "2026-10-08T00:00:00.000Z",
      fiveHour: { usedPercent: 7, resetsAt: 1700000000 },
      weekly: null,
    })}\n`;
    for (const [name, payload] of [
      ["no-rate-limits", JSON.stringify({ session_id: "sess-x", model: { id: "claude-sonnet-4-6" } })],
      ["empty-rate-limits", JSON.stringify({ rate_limits: {} })],
    ] as const) {
      const dir = usageDir(name);
      const snapshotPath = join(dir, SNAPSHOT_NAME);
      writeFileSync(snapshotPath, existing, "utf8");
      const run = await runTee(payload, dir, join(tempRoot, name, "missing-home"));
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("");
      expect(readFileSync(snapshotPath, "utf8")).toBe(existing);
    }
  });

  it("exits 0 with no output and no snapshot for malformed JSON", async () => {
    const dir = usageDir("broken-json");
    const run = await runTee("{not valid json", dir, join(tempRoot, "broken-json", "missing-home"));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(existsSync(join(dir, SNAPSHOT_NAME))).toBe(false);
  });

  it("records a payload with only one window as null for the other", async () => {
    const fiveOnly = usageDir("five-only");
    const runFive = await runTee(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 55, resets_at: FIVE_RESET_S } } }),
      fiveOnly,
      join(tempRoot, "five-only", "missing-home"),
    );
    expect(runFive.code).toBe(0);
    expect(JSON.parse(readFileSync(join(fiveOnly, SNAPSHOT_NAME), "utf8"))).toEqual({
      capturedAt: expect.any(String),
      fiveHour: { usedPercent: 55, resetsAt: FIVE_RESET_S },
      weekly: null,
    });

    const weeklyOnly = usageDir("weekly-only");
    const runWeekly = await runTee(
      JSON.stringify({ rate_limits: { seven_day: { used_percentage: 66, resets_at: WEEKLY_RESET_S } } }),
      weeklyOnly,
      join(tempRoot, "weekly-only", "missing-home"),
    );
    expect(runWeekly.code).toBe(0);
    expect(JSON.parse(readFileSync(join(weeklyOnly, SNAPSHOT_NAME), "utf8"))).toEqual({
      capturedAt: expect.any(String),
      fiveHour: null,
      weekly: { usedPercent: 66, resetsAt: WEEKLY_RESET_S },
    });
  });

  it("writes into DESKPET_USAGE_DIR instead of the home default", async () => {
    const dir = usageDir("env-dir");
    const fakeHome = join(tempRoot, "env-dir", "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    const run = await runTee(fullPayload, dir, fakeHome);
    expect(run.code).toBe(0);
    expect(existsSync(join(dir, SNAPSHOT_NAME))).toBe(true);
    expect(existsSync(join(fakeHome, ".deskpet"))).toBe(false);
  });
});
