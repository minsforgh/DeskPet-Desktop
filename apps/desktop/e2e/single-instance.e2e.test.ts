import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const desktopRoot = resolve(import.meta.dirname, "..");
const electronPath: unknown = createRequire(import.meta.url)("electron");

async function launchDuplicate(userDataDir: string): Promise<number | null> {
  if (typeof electronPath !== "string") throw new Error("Electron binary unavailable");
  const child = spawn(electronPath, [desktopRoot, `--dev-control=${randomUUID().replaceAll("-", "")}`,
    `--user-data-dir=${userDataDir}`, "--event-port=0"], { stdio: "ignore" });
  try {
    return await new Promise<number | null>((resolveExit, rejectExit) => {
      // One isolated Windows duplicate launch took 438 ms, but a loaded full-suite Electron exit has reached 11.1 s,
      // so 10 s was inside the measured range; 25 s still fails a duplicate that really stays alive.
      const timeout = setTimeout(() => { child.kill(); rejectExit(new Error("Duplicate Electron instance did not exit")); }, 25_000);
      child.once("error", (error) => { clearTimeout(timeout); rejectExit(error); });
      child.once("exit", (code) => { clearTimeout(timeout); resolveExit(code); });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test("a second app with the same userData exits while the first keeps its event server", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-single-instance-e2e-"));
  const userDataDir = join(tempDir, "shared");
  let first: DesktopApp | undefined;
  try {
    first = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
    const auth = await first.eventServerAuth(userDataDir);
    const original = await readFile(join(userDataDir, "event-server.json"), "utf8");
    expect((await first.readEventServerFile(userDataDir)).pid).toBe(first.child.pid);

    await first.request({ cmd: "tray", action: "hide" });
    expect(await first.request({ cmd: "state" })).toMatchObject({ visible: false });

    expect(await launchDuplicate(userDataDir)).toBe(0);
    // ADR-0010 §2: the duplicate asks the running instance to show its pet instead of vanishing silently.
    await vi.waitFor(async () => { expect(await first?.request({ cmd: "state" })).toMatchObject({ visible: true }); }, { timeout: 10_000 });

    expect(first.child.exitCode).toBeNull();
    expect(await first.eventServerAuth(userDataDir)).toEqual(auth);
    expect(await readFile(join(userDataDir, "event-server.json"), "utf8")).toBe(original);
    const response = await fetch(`http://127.0.0.1:${auth.port}/status`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ eventServer: { port: auth.port } });
    expect(await first.request({ cmd: "state" })).toMatchObject({ ready: true, visible: true });
  } finally {
    try { await first?.dispose(); }
    finally { await cleanupTemporaryPath(tempDir, first ? [first] : []); }
  }
}, 60_000);

test("apps with different userData directories run at the same time", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-separate-instances-e2e-"));
  const firstDir = join(tempDir, "first");
  const secondDir = join(tempDir, "second");
  let first: DesktopApp | undefined;
  let second: DesktopApp | undefined;
  try {
    first = await DesktopApp.launch(firstDir, ["--event-port=0"]);
    second = await DesktopApp.launch(secondDir, ["--event-port=0"]);
    const firstAuth = await first.eventServerAuth(firstDir);
    const secondAuth = await second.eventServerAuth(secondDir);
    expect(firstAuth.port).not.toBe(secondAuth.port);
    expect(firstAuth.token).not.toBe(secondAuth.token);
    expect((await first.readEventServerFile(firstDir)).pid).toBe(first.child.pid);
    expect((await second.readEventServerFile(secondDir)).pid).toBe(second.child.pid);
    expect(await first.request({ cmd: "state" })).toMatchObject({ ready: true, visible: true });
    expect(await second.request({ cmd: "state" })).toMatchObject({ ready: true, visible: true });
  } finally {
    try { await second?.dispose(); }
    finally {
      try { await first?.dispose(); }
      finally { await cleanupTemporaryPath(tempDir, [first, second].filter((app): app is DesktopApp => app !== undefined)); }
    }
  }
}, 30_000);
