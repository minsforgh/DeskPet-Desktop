import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type ProbeResult = {
  pid: number; helloMs: number | null; hello: unknown; activated: boolean; activateError: string | null;
  exit?: { code: number | null }; stdout: string[]; stderr: string[];
  idle?: { workingSetKb: number; privateKb: number; cpuPercent: number };
};

let app: DesktopApp;
let tempDir: string;
let pluginsDir: string;

const plugins: Record<string, string> = {
  hello: `export default {
    configSchema: { type: "object", properties: { greeting: { type: "string", default: "hi" } } },
    activate(ctx) { console.log("plugin-says-hello"); ctx.log.info("activated"); },
  };`,
  throws: `export default { activate() { throw new Error("activate-failed"); } };`,
  late: `export default { activate() { setTimeout(() => { throw new Error("late-crash"); }, 0); } };`,
  exits: `export default { activate() { setTimeout(() => process.exit(3), 0); } };`,
  badexport: `export default { notActivate() {} };`,
};

/** Runs one plugin in a real utilityProcess through the dev control command. */
async function run(id: string, extra: Record<string, unknown> = {}): Promise<ProbeResult> {
  const response = await app.requestRaw({ cmd: "runPluginForTest", root: pluginsDir, pluginId: id, ...extra }, 30_000);
  if (!response.ok) throw new Error(`runPluginForTest failed: ${response.error}`);
  return response.result as ProbeResult;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const gone = (pid: number): Promise<void> => vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 5000 });

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "deskpet-plugin-runner-e2e-"));
  pluginsDir = join(tempDir, "plugins");
  for (const [id, source] of Object.entries(plugins)) {
    const folder = join(pluginsDir, id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "manifest.json"), JSON.stringify({
      id, name: id, version: "0.0.0", apiVersion: "1", entry: "index.mjs", description: "e2e fixture",
      permissions: {}, contributes: {},
    }), "utf8");
    await writeFile(join(folder, "index.mjs"), source, "utf8");
  }
  app = await DesktopApp.launch(join(tempDir, "user-data"), ["--event-port=0"]);
}, 60_000);

afterAll(async () => {
  if (app) await app.dispose();
  await cleanupTemporaryPath(tempDir, app ? [app] : []);
}, 30_000);

test("a plugin process says hello and activates, and kill leaves no process behind", async () => {
  const result = await run("hello", { kill: true });
  expect(result.activated).toBe(true);
  expect(result.helloMs).toBeGreaterThan(0);
  expect(result.hello).toMatchObject({ configSchema: { properties: { greeting: { type: "string" } } } });
  expect(result.stdout).toContain("plugin-says-hello");
  expect(result.exit).toBeDefined();
  await gone(result.pid);
  expect(await app.request({ cmd: "state" })).toMatchObject({ ready: true });
});

test("an exception inside activate is reported and the process is still cleaned up", async () => {
  const result = await run("throws", { kill: true });
  expect(result.activated).toBe(false);
  expect(result.activateError).toBe("E_UNAVAILABLE");
  await gone(result.pid);
});

test("an entry without a valid definition fails before activate and the process exits", async () => {
  const result = await run("badexport");
  expect(result.activated).toBe(false);
  expect(result.helloMs).toBeNull();
  expect(result.exit?.code).toBe(1);
  expect(result.stderr.join("\n")).toContain("no default export");
  await gone(result.pid);
});

test("an uncaught exception in the plugin ends only that process and main receives the exit event", async () => {
  const result = await run("late");
  expect(result.exit?.code).not.toBe(0);
  expect(result.exit?.code).not.toBeNull();
  expect(result.stderr.join("\n")).toContain("late-crash");
  await gone(result.pid);
  expect(await app.request({ cmd: "state" })).toMatchObject({ ready: true });
});

test("process.exit in the plugin is reported with its exit code", async () => {
  const result = await run("exits");
  expect(result.exit).toEqual({ code: 3 });
  await gone(result.pid);
  expect(await app.request({ cmd: "state" })).toMatchObject({ ready: true });
});

test("a plugin id that is not a valid plugin is rejected by the command", async () => {
  const response = await app.requestRaw({ cmd: "runPluginForTest", root: pluginsDir, pluginId: "missing" });
  expect(response.ok).toBe(false);
  expect((await app.requestRaw({ cmd: "runPluginForTest", pluginId: "hello" })).ok).toBe(false);
});
