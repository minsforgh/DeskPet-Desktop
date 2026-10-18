import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const cliScript = resolve(import.meta.dirname, "../../../packages/cli/dist/index.js");

function runCli(userDataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliScript, "status", "--user-data-dir", userDataDir],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", rejectRun);
    // "exit" can arrive before the last stdout/stderr chunk under load; "close" waits for both streams to end.
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

// This two-instance test took 3.072 s alone on Windows; a full-suite Electron exit has reached 11.1 s.
// Allow 30 s for the first app's startup, second launch, and clean exit under that measured contention.
test("a failed second instance and its exit preserve the first instance's CLI address", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-event-owner-e2e-"));
  const userDataDir = join(tempDir, "user-data");
  let first: DesktopApp | undefined;
  try {
    first = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
    const { port } = await first.eventServerAuth(userDataDir);
    const original = await first.readEventServerFile(userDataDir);
    expect(original.pid).toBe(first.child.pid);
    expect((await runCli(userDataDir)).code).toBe(0);

    await expect(DesktopApp.launch(userDataDir, [`--event-port=${port}`]))
      .rejects.toThrow("Electron exited while starting: 0");
    expect(first.child.exitCode).toBeNull();
    expect(await first.readEventServerFile(userDataDir)).toEqual(original);
    expect((await runCli(userDataDir)).code).toBe(0);
  } finally {
    try { if (first) await first.dispose(); }
    finally { await cleanupTemporaryPath(tempDir, first ? [first] : []); }
  }
}, 30000);
