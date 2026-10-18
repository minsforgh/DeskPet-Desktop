import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const source = `export default {
  activate(ctx) {
    ctx.registerAction("wire.yes", async () => {
      try { const result = await ctx.orca.resolveGate("gate_1", "yes"); ctx.emit({ source: "wire", type: "status", text: "Gate " + result }); }
      catch (error) { ctx.emit({ source: "wire", type: "status", text: "Gate error: " + error.code }); }
    });
    ctx.registerAction("wire.open", async () => {
      await ctx.orca.openTerminal("term_coordinator");
      ctx.emit({ source: "wire", type: "status", text: "Terminal opened" });
    });
    ctx.schedule.every(30000, async () => {
      const [snapshot, second] = await Promise.all([ctx.orca.snapshot(), ctx.orca.snapshot()]);
      if (snapshot.availability !== second.availability) throw new Error("snapshot mismatch");
      for (const item of snapshot.notifications) {
        ctx.emit({ source: "wire", type: "notify", text: item.kind + ": " + item.title,
          ...(item.gateId ? { actions: [{ label: "yes", action: "wire.yes" },
            { label: "open", action: "wire.open" }] } : {}) });
      }
    });
  },
};`;

let root: string;
const apps: DesktopApp[] = [];
const statePath = () => join(root, "state.json");
const logPath = () => join(root, "argv.jsonl");
const userData = () => join(root, "user-data");
const pluginRoot = () => join(root, "plugins");
const scriptPath = () => join(root, "fake-orca-cli.mjs");
const fixtureState = async (value: { newWorker: boolean; gate: boolean; resolved: boolean; gateId: string; fail?: boolean }) =>
  writeFile(statePath(), JSON.stringify(value));
const calls = async (): Promise<string[][]> => (await readFile(logPath(), "utf8")).trim().split("\n")
  .filter(Boolean).map((line) => (JSON.parse(line) as { args: string[] }).args);
const events = async (app: DesktopApp): Promise<string[]> =>
  ((await app.request({ cmd: "events" })) as { events: Array<{ event: { text?: string } }> }).events
    .map(({ event }) => event.text ?? "");
const clock = new Map<DesktopApp, number>();
const poll = async (app: DesktopApp): Promise<void> => {
  const at = (clock.get(app) ?? -30_000) + 30_000;
  clock.set(app, at);
  await app.request({ cmd: "setOrcaTimeForTest", atMs: at });
  // Seven fake-CLI snapshots reached 5.02 s in the unit-file run on this PC;
  // the dev hook waits for the complete CLI read and renderer effect.
  expect((await app.requestRaw({ cmd: "advanceReminderClockForTest", advanceMs: 30_000 }, 10_000)).ok).toBe(true);
};
const status = (app: DesktopApp) => app.request({ cmd: "state" }) as Promise<{
  bubble: { visible: boolean; text: string | null; renderer: { buttons: Array<{ label: string }> } };
  pluginHost: { ready: boolean; plugins: Array<{ id: string; state: string }> };
}>;

async function launch(answer: "allow" | "deny", dataDir = userData()) {
  const app = await DesktopApp.launch(dataDir, [`--plugins-dir=${pluginRoot()}`, `--permission-answer=${answer}`]);
  apps.push(app);
  await app.request({ cmd: "setOrcaExecutableForTest", path: scriptPath() });
  return app;
}

test("Orca snapshot, durable ledger, and user gate action use only the fake CLI", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-orca-wire-"));
  await mkdir(join(pluginRoot(), "wire"), { recursive: true });
  await mkdir(userData());
  await copyFile(new URL("./fake-orca-cli.mjs", import.meta.url), scriptPath());
  await writeFile(logPath(), "");
  await fixtureState({ newWorker: false, gate: false, resolved: false, gateId: "gate_1" });
  await writeFile(join(pluginRoot(), "wire", "manifest.json"), JSON.stringify({
    id: "wire", name: "Wire", version: "0.0.0", apiVersion: "2", entry: "index.mjs",
    description: "e2e fixture", permissions: { orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true },
    contributes: { actions: ["wire.yes", "wire.open"] },
  }));
  await writeFile(join(pluginRoot(), "wire", "index.mjs"), source);
  let app = await launch("allow");
  expect((await app.requestRaw({ cmd: "setOrcaExecutableForTest", path: fileURLToPath(new URL("./fake-orca-cli.mjs", import.meta.url)) })).ok).toBe(false);
  expect((await app.requestRaw({ cmd: "setOrcaExecutableForTest", path: `${root}\\..\\${root.split(/[\\/]/).at(-1)}\\fake-orca-cli.mjs` })).ok).toBe(false);
  const link = join(root, "linked-dir");
  await symlink(root, link, "junction");
  expect((await app.requestRaw({ cmd: "setOrcaExecutableForTest", path: join(link, "fake-orca-cli.mjs") })).ok).toBe(false);
  await poll(app);
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
  expect((await events(app)).filter((text) => text.startsWith("worker-succeeded"))).toHaveLength(0);
  await fixtureState({ newWorker: true, gate: false, resolved: false, gateId: "gate_1" });
  await poll(app);
  await vi.waitFor(async () => {
    expect((await status(app)).bubble).toMatchObject({ visible: true, text: "worker-succeeded: Fixture task" });
  }, { timeout: 10_000, interval: 50 });
  expect((await events(app)).filter((text) => text === "worker-succeeded: Fixture task")).toHaveLength(1);
  await app.quit();
  app = await launch("allow");
  await poll(app);
  expect((await events(app)).filter((text) => text === "worker-succeeded: Fixture task")).toHaveLength(0);
  await fixtureState({ newWorker: true, gate: true, resolved: false, gateId: "gate_1" });
  await poll(app);
  await vi.waitFor(async () => {
    const bubble = (await status(app)).bubble;
    expect(bubble.visible).toBe(true);
    expect(bubble.renderer.buttons.map((button) => button.label)).toEqual(["yes", "open"]);
  }, { timeout: 10_000, interval: 50 });
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
  await app.request({ cmd: "bubbleAction", index: 0 });
  await vi.waitFor(async () => { expect(await events(app)).toContain("Gate resolved"); }, { timeout: 10_000, interval: 50 });
  await fixtureState({ newWorker: true, gate: true, resolved: false, gateId: "gate_2" });
  await poll(app);
  await vi.waitFor(async () => {
    const bubble = (await status(app)).bubble;
    expect(bubble.visible).toBe(true);
    expect(bubble.renderer.buttons.map((button) => button.label)).toEqual(["yes", "open"]);
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "bubbleAction", index: 1 });
  await vi.waitFor(async () => { expect(await events(app)).toContain("Terminal opened"); }, { timeout: 10_000, interval: 50 });
  const argv = await calls();
  expect(argv.filter((args) => args[1] === "gate-resolve")).toHaveLength(1);
  expect(argv.filter((args) => args[0] === "terminal" && args[1] === "switch")).toHaveLength(1);
  expect(argv.filter((args) => args[1] === "check")).toHaveLength(0);
  expect(argv.every((args) => ["run-list", "inbox", "task-list", "worker-list", "gate-list", "terminal show",
    "terminal switch", "gate-resolve"].includes(args[0] === "terminal" ? args.slice(0, 2).join(" ") : args[1] ?? ""))).toBe(true);
  const ledger = await readFile(join(userData(), "orca-notification-ledger.json"), "utf8");
  expect(ledger).toContain("ctx_new");
  expect(ledger).not.toContain("Fixture task");
  await app.quit();
  await writeFile(logPath(), "");
  const missingDir = join(root, "user-data-missing");
  await mkdir(missingDir);
  const missing = await launch("allow", missingDir);
  await missing.request({ cmd: "setOrcaExecutableForTest", path: null });
  await poll(missing);
  await vi.waitFor(async () => { expect(await events(missing)).toContain("unavailable: Orca 상태를 확인할 수 없어"); },
    { timeout: 10_000, interval: 50 });
  expect(await calls()).toHaveLength(0);
  await missing.quit();
  await writeFile(logPath(), "");
  const deniedDir = join(root, "user-data-denied");
  await mkdir(deniedDir);
  const denied = await launch("deny", deniedDir);
  expect((await status(denied)).pluginHost.plugins.find((plugin) => plugin.id === "wire")?.state).toBe("denied");
  expect(await calls()).toHaveLength(0);
}, 90_000);

afterAll(async () => {
  for (const app of apps) await app.dispose();
  if (root) await cleanupTemporaryPath(root, apps);
}, 45_000);
