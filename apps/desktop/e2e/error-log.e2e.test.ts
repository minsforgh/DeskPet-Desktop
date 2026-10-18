import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

// ADR-0010 §7: main and renderer failures reach logs/errors.log (masked) while the app keeps running.
const TOKEN = "0123456789abcdef".repeat(4);
let tempDir: string;
let app: DesktopApp;
let errorsPath: string;

const readErrors = async (): Promise<string> => readFile(errorsPath, "utf8").catch(() => "");
const waitForLine = (needle: string | RegExp): Promise<void> => vi.waitFor(async () => {
  const text = await readErrors();
  expect(typeof needle === "string" ? text.includes(needle) : needle.test(text)).toBe(true);
}, { timeout: 10_000, interval: 50 });

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "deskpet-error-log-e2e-"));
  const plugins = join(tempDir, "plugins");
  const folder = join(plugins, "crashy");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id: "crashy", name: "Crashy", version: "0.0.0", apiVersion: "1",
    entry: "index.mjs", description: "e2e fixture", permissions: {}, contributes: {} }), "utf8");
  await writeFile(join(folder, "index.mjs"),
    `export default { activate() { console.error("plugin-stderr token=${TOKEN}"); setInterval(() => {}, 1000); } };`, "utf8");
  const userData = join(tempDir, "data");
  errorsPath = join(userData, "logs", "errors.log");
  app = await DesktopApp.launch(userData, ["--event-port=0", `--plugins-dir=${plugins}`, "--permission-answer=allow"]);
}, 60_000);

afterAll(async () => {
  try { await app?.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

test("a main-process exception is recorded, masked, and the app keeps running", async () => {
  const home = homedir();
  await app.request({ cmd: "mainErrorForTest", kind: "throw", message: `thrown ${TOKEN} at ${home}\\secret\\file.js` });
  await waitForLine("main:uncaughtException Error: thrown");
  const text = await readErrors();
  expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR main:uncaughtException /m);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(home);
  expect(text).toContain("~\\secret\\file.js");
  expect(app.child.exitCode).toBeNull();
  expect(await app.request({ cmd: "state" })).toMatchObject({ ready: true });
});

test("an unhandled rejection is recorded and the app keeps running", async () => {
  await app.request({ cmd: "mainErrorForTest", kind: "reject", message: "rejected-on-purpose" });
  await waitForLine("main:unhandledRejection Error: rejected-on-purpose");
  expect(app.child.exitCode).toBeNull();
});

test("a console error from the pet page is recorded with the page name only", async () => {
  await app.request({ cmd: "rendererConsoleErrorForTest", message: `renderer-complaint ${TOKEN}` });
  await waitForLine(/renderer:error window=pet source=\S+ renderer-complaint \*\*\*/);
  expect(await readErrors()).not.toContain(TOKEN);
});

test("a plugin process that dies is recorded with its masked stderr", async () => {
  const pid = await vi.waitFor(async () => {
    const state = await app.request({ cmd: "state" }) as { pluginHost: { pids: Record<string, number> } };
    const found = state.pluginHost.pids.crashy;
    expect(found).toBeTypeOf("number");
    return found as number;
  }, { timeout: 15_000, interval: 100 });
  process.kill(pid);
  await waitForLine(/plugin:exit id=crashy code=\S+ stderr=/);
  const text = await readErrors();
  expect(text).toContain("plugin-stderr token=***");
  expect(text).not.toContain(TOKEN);
  expect(app.child.exitCode).toBeNull();
});

const GONE_LINE = /renderer:gone window=pet reason=\S+ exitCode=-?\d+/;
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a renderer crash is recorded and the app keeps answering", async () => {
  // D-083: under load Electron sometimes crashes the renderer without ever emitting render-process-gone (about 1 in 10
  // runs with two busy cores), so no line can appear. Only in that case (main answers, renderer process dead) relaunch once.
  const crashOnce = async (target: DesktopApp, path: string): Promise<{ logged: boolean; missing: unknown }> => {
    const result = await target.request({ cmd: "crashRendererForTest" }) as { pid?: number };
    try {
      await vi.waitFor(async () => {
        expect(GONE_LINE.test(await readFile(path, "utf8").catch(() => ""))).toBe(true);
      }, { timeout: 10_000, interval: 50 });
      return { logged: true, missing: undefined };
    } catch (error) {
      const answering = target.child.exitCode === null && typeof await target.request({ cmd: "events" }) === "object";
      const rendererDead = typeof result.pid !== "number" || !isAlive(result.pid);
      if (answering && rendererDead) return { logged: false, missing: error };
      throw error;
    }
  };
  const fail = async (target: DesktopApp, path: string, error: unknown): Promise<never> => {
    const lines = (await readFile(path, "utf8").catch(() => "")).split("\n").map((line) => line.slice(0, 160));
    throw new Error([String(error), `errors.log=${JSON.stringify(lines)}`, `app output=${JSON.stringify(target.diagnostics)}`].join("\n"), { cause: error });
  };

  let target = app;
  let path = errorsPath;
  let retryDir: string | undefined;
  try {
    let outcome = await crashOnce(target, path).catch((error) => fail(target, path, error));
    if (!outcome.logged) {
      console.warn("[e2e] Electron did not emit render-process-gone (D-083); relaunching once");
      retryDir = await mkdtemp(join(tmpdir(), "deskpet-error-log-e2e-retry-"));
      const userData = join(retryDir, "data");
      path = join(userData, "logs", "errors.log");
      target = await DesktopApp.launch(userData, ["--event-port=0", `--plugins-dir=${join(tempDir, "plugins")}`, "--permission-answer=allow"]);
      outcome = await crashOnce(target, path).catch((error) => fail(target, path, error));
      if (!outcome.logged) await fail(target, path, outcome.missing);
    }
    expect(target.child.exitCode).toBeNull();
    expect(await target.request({ cmd: "events" })).toBeTypeOf("object");
  } finally {
    if (target !== app) {
      try { await target.dispose(); }
      finally { if (retryDir) await cleanupTemporaryPath(retryDir, [target]); }
    }
  }
// Alone this test took 125-280 ms; with two busy-loop cores 156-499 ms, and the 2 of 25 runs that relaunched took 11.2-11.3 s
// (10 s wait + about 1.2 s launch and crash). Worst case is 2 waits + launch + dispose, so 30 s.
}, 30_000);
