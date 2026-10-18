import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type PluginStatus = { id: string; name?: string; state: string; reason?: string; consecutiveErrors: number };
type AppState = {
  bubble: { visible: boolean; text: string | null } | null;
  trayMenu: string[];
  pluginHost: { ready: boolean; plugins: PluginStatus[]; permissionPrompt: { pluginId: string; lines: string[] } | null;
    pids: Record<string, number> };
};
type RecordedEvent = { source: string; type: string; key?: string; text?: string; priority?: string };
type Fixture = { id: string; source?: string; manifest?: Record<string, unknown>; rawManifest?: string };

let tempDir: string;
const stateOf = (app: DesktopApp): Promise<AppState> => app.request({ cmd: "state" }) as Promise<AppState>;
const pluginOf = async (app: DesktopApp, id: string): Promise<PluginStatus | undefined> =>
  (await stateOf(app)).pluginHost.plugins.find((item) => item.id === id);
const eventsOf = async (app: DesktopApp): Promise<RecordedEvent[]> =>
  ((await app.request({ cmd: "events" })) as { events: Array<{ event: RecordedEvent }> }).events.map(({ event }) => event);
const waitForState = (app: DesktopApp, id: string, state: string, timeout = 10_000): Promise<void> =>
  vi.waitFor(async () => { expect((await pluginOf(app, id))?.state).toBe(state); }, { timeout, interval: 50 });
const waitForEvent = (app: DesktopApp, match: (event: RecordedEvent) => boolean): Promise<void> =>
  vi.waitFor(async () => { expect((await eventsOf(app)).some(match)).toBe(true); }, { timeout: 10_000, interval: 50 });

async function writePlugins(root: string, fixtures: readonly Fixture[]): Promise<void> {
  for (const fixture of fixtures) {
    const folder = join(root, fixture.id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "manifest.json"), fixture.rawManifest ?? JSON.stringify({
      id: fixture.id, name: fixture.id[0]?.toUpperCase() + fixture.id.slice(1), version: "0.0.0", apiVersion: "1",
      entry: "index.mjs", description: "e2e fixture", permissions: {}, contributes: {}, ...fixture.manifest,
    }), "utf8");
    await writeFile(join(folder, "index.mjs"), fixture.source ?? "export default { activate() {} };", "utf8");
  }
}

const alpha: Fixture = { id: "alpha" };

/** Starts the app on its own plugin folder and user data; settings.json is written first when given. */
async function launch(name: string, fixtures: readonly Fixture[], options: { answer?: string; settings?: unknown; userData?: string } = {}):
Promise<{ app: DesktopApp; root: string; userData: string; auth: { port: number; token: string } }> {
  const root = join(tempDir, `${name}-plugins`);
  const userData = options.userData ?? join(tempDir, `${name}-user-data`);
  await writePlugins(root, fixtures);
  if (options.settings !== undefined) {
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, "settings.json"), JSON.stringify(options.settings), "utf8");
  }
  const app = await DesktopApp.launch(userData, ["--event-port=0", `--plugins-dir=${root}`,
    ...(options.answer ? [`--permission-answer=${options.answer}`] : [])]);
  return { app, root, userData, auth: await app.eventServerAuth(userData) };
}

async function post(auth: { port: number; token: string }, path: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${auth.port}${path}`, { method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }, body: "{}" });
  return response.status;
}

async function httpStatusPlugins(auth: { port: number; token: string }): Promise<PluginStatus[]> {
  const response = await fetch(`http://127.0.0.1:${auth.port}/status`, { headers: { Authorization: `Bearer ${auth.token}` } });
  return ((await response.json()) as { plugins: PluginStatus[] }).plugins;
}

/** A local HTTP server that records every request; the plugins' "https://allowed.test" is routed here by the dev control. */
async function startRecorder(): Promise<{ port: number; hits: Array<{ method: string; url: string; host: string | undefined }>; server: Server }> {
  const hits: Array<{ method: string; url: string; host: string | undefined }> = [];
  const server = createServer((request, response) => {
    hits.push({ method: request.method ?? "", url: request.url ?? "", host: request.headers["x-deskpet-original-host"] as string | undefined });
    request.resume();
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("recorder has no port");
  return { port: address.port, hits, server };
}

const nettySource = `export default {
  activate(ctx) {
    const report = (text) => ctx.emit({ source: "netty", type: "status", text });
    const attempt = async (label, url, init) => {
      try { const response = await ctx.fetch(url, init); report(label + ":" + response.status); }
      catch (error) { report(label + ":" + (error.code ?? error.name)); }
    };
    ctx.schedule.every(1000, async () => {
      await attempt("undeclared", "https://undeclared.test/x");
      await attempt("sched-post", "https://allowed.test/hook", { method: "POST", body: "x" });
      await attempt("sched-get", "https://allowed.test/hook");
    });
    ctx.registerAction("netty.post", async () => {
      await attempt("action-post", "https://allowed.test/hook", { method: "POST", body: "x" });
    });
  },
};`;
const netty: Fixture = { id: "netty", source: nettySource,
  manifest: { permissions: { network: ["allowed.test"] }, contributes: { actions: ["netty.post"] } } };

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-plugin-host-e2e-")); }, 30_000);

async function finish(apps: DesktopApp[]): Promise<void> {
  for (const app of apps) await app.dispose();
}

describe("discovery, validation and blocked network access", () => {
  let app: DesktopApp;
  let auth: { port: number; token: string };
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    recorder = await startRecorder();
    ({ app, auth } = await launch("net", [alpha, netty,
      { id: "badjson", rawManifest: "{" },
      { id: "apiv3", manifest: { apiVersion: "3" } },
      { id: "wrongid", manifest: { id: "someone-else" } }], { answer: "allow" }));
    await app.request({ cmd: "setFetchTargetForTest", port: recorder.port });
  }, 60_000);

  afterAll(async () => {
    await finish([app]);
    await new Promise<void>((resolve) => recorder.server.close(() => resolve()));
  }, 30_000);

  test("folders with a manifest load without any app change, and broken ones are reported without stopping the rest", async () => {
    const plugins = await httpStatusPlugins(auth);
    expect(plugins.map(({ id }) => id)).toEqual(["alpha", "apiv3", "badjson", "netty", "wrongid"]);
    expect(plugins.find(({ id }) => id === "alpha")).toMatchObject({ name: "Alpha", state: "running", consecutiveErrors: 0 });
    expect(plugins.find(({ id }) => id === "netty")).toMatchObject({ state: "running" });
    expect(plugins.find(({ id }) => id === "badjson")).toMatchObject({ state: "invalid", reason: "manifest is not valid JSON" });
    expect(plugins.find(({ id }) => id === "apiv3")).toMatchObject({ state: "invalid" });
    expect(plugins.find(({ id }) => id === "apiv3")?.reason).toContain("apiVersion");
    expect(plugins.find(({ id }) => id === "wrongid")).toMatchObject({ state: "invalid", reason: "manifest id differs from folder name" });
    // Invalid plugins never get a process.
    expect(Object.keys((await stateOf(app)).pluginHost.pids).sort()).toEqual(["alpha", "netty"]);
  });

  test("an undeclared host and a write from a schedule callback are blocked; a GET to a declared host is allowed", async () => {
    // schedule.every(1000) runs the callback; the dev clock moves it without real waiting.
    await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 1000 });
    await waitForEvent(app, (event) => event.source === "netty" && event.text === "sched-get:200");
    const texts = (await eventsOf(app)).filter((event) => event.source === "netty").map((event) => event.text);
    expect(texts).toEqual(["undeclared:E_PERMISSION", "sched-post:E_PERMISSION", "sched-get:200"]);
    // Only the allowed GET reached the network, and it carried the declared host.
    expect(recorder.hits).toEqual([{ method: "GET", url: "/hook", host: "allowed.test" }]);
  });

  test("a plugin action that is not on the allowlist is 404 over HTTP and never runs, while the core action still works", async () => {
    const before = recorder.hits.length;
    expect(await post(auth, "/action/netty.post")).toBe(404);
    expect(await post(auth, "/action/deskpet.ping")).toBe(200);
    expect(recorder.hits).toHaveLength(before);
    expect((await eventsOf(app)).some((event) => event.text?.startsWith("action-post"))).toBe(false);
  });
});

describe("a user-invoked action opens the write context", () => {
  let app: DesktopApp;
  let auth: { port: number; token: string };
  let recorder: Awaited<ReturnType<typeof startRecorder>>;

  beforeAll(async () => {
    recorder = await startRecorder();
    ({ app, auth } = await launch("net-allowed", [netty],
      { answer: "allow", settings: { doNotDisturb: { enabled: false }, httpActionAllowlist: ["netty.post"] } }));
    await app.request({ cmd: "setFetchTargetForTest", port: recorder.port });
  }, 60_000);

  afterAll(async () => {
    await finish([app]);
    await new Promise<void>((resolve) => recorder.server.close(() => resolve()));
  }, 30_000);

  test("an allowlisted action runs, and its POST is allowed inside the action", async () => {
    expect(await post(auth, "/action/netty.post")).toBe(200);
    await waitForEvent(app, (event) => event.source === "netty" && event.text === "action-post:200");
    expect(recorder.hits).toEqual([{ method: "POST", url: "/hook", host: "allowed.test" }]);
  });
});

describe("errors and process deaths", () => {
  let app: DesktopApp;
  let auth: { port: number; token: string };

  beforeAll(async () => {
    ({ app, auth } = await launch("crash", [alpha, { id: "crash", source: `export default {
      activate(ctx) { ctx.registerAction("crash.boom", () => { throw new Error("boom"); }); },
    };`, manifest: { contributes: { actions: ["crash.boom"] } } }],
    { answer: "allow", settings: { doNotDisturb: { enabled: false }, httpActionAllowlist: ["crash.boom"] } }));
  }, 60_000);

  afterAll(async () => { await finish([app]); }, 30_000);

  test("three failing action presses disable only that plugin, the pet tells the user, and the tray turns it back on", async () => {
    for (const expected of [500, 500, 500]) expect(await post(auth, "/action/crash.boom")).toBe(expected);
    await waitForState(app, "crash", "disabled");
    expect(await pluginOf(app, "crash")).toMatchObject({ state: "disabled", consecutiveErrors: 3, reason: "오류가 3번 이어졌습니다" });
    expect(await pluginOf(app, "alpha")).toMatchObject({ state: "running" });
    await waitForEvent(app, (event) => event.source === "deskpet" && event.key === "plugin-disabled:crash" &&
      event.type === "notify" && event.priority === "high");
    await vi.waitFor(async () => {
      const bubble = (await stateOf(app)).bubble;
      expect(bubble).toMatchObject({ visible: true });
      expect(bubble?.text).toBe('"Crash" 플러그인을 껐어요. 오류가 3번 이어졌어요');
    }, { timeout: 10_000, interval: 50 });
    // The app is alive and its registration is gone with the process.
    expect(await post(auth, "/action/crash.boom")).toBe(404);
    // The submenu shows one status line per plugin, and 다시 켜기 only for the disabled one.
    const menu = (await stateOf(app)).trayMenu;
    expect(menu).toContain("플러그인");
    expect(menu).toContain("Alpha: 실행 중");
    expect(menu).toContain("Crash: 꺼짐 (오류가 3번 이어졌습니다)");
    expect(menu).toContain("다시 켜기 (crash)");
    expect(menu).not.toContain("다시 켜기 (alpha)");
    await app.request({ cmd: "trayMenuClick", label: "다시 켜기 (crash)" });
    await waitForState(app, "crash", "running");
    const rebuilt = (await stateOf(app)).trayMenu;
    expect(rebuilt).toContain("Crash: 실행 중");
    expect(rebuilt).not.toContain("다시 켜기 (crash)");
    expect(await post(auth, "/action/crash.boom")).toBe(500);
  }, 30_000);
});

describe("a plugin that kills its own process", () => {
  let app: DesktopApp;

  const startLog = (id: string): string => join(tempDir, `${id}.log`);
  const starts = async (id: string): Promise<number[]> =>
    (await readFile(startLog(id), "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  const dying = (id: string, rule: string): Fixture => ({ id, source: `import { appendFileSync, readFileSync } from "node:fs";
    const log = ${JSON.stringify(startLog(id))};
    export default { activate() {
      appendFileSync(log, Date.now() + "\\n");
      const count = readFileSync(log, "utf8").split("\\n").filter(Boolean).length;
      if (${rule}) setTimeout(() => process.exit(1), 200);
    } };` });

  beforeAll(async () => {
    ({ app } = await launch("exits", [alpha, dying("exitonce", "count === 1"), dying("exitalways", "true")], { answer: "allow" }));
  }, 60_000);

  afterAll(async () => { await finish([app]); }, 30_000);

  test("a death after backoff is recovered, and a plugin that keeps dying is disabled after three, without touching the app", async () => {
    // exitonce dies once, comes back after the 1 s backoff and stays.
    await vi.waitFor(async () => { expect((await starts("exitonce")).length).toBe(2); }, { timeout: 15_000, interval: 50 });
    await waitForState(app, "exitonce", "running", 15_000);
    expect((await starts("exitonce")).length).toBe(2);
    // exitalways: restarts after 1 s, then 5 s (ADR-0005 §4), and the third death disables it.
    await waitForState(app, "exitalways", "disabled", 30_000);
    const times = await starts("exitalways");
    expect(times).toHaveLength(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(1000);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(5000);
    await waitForEvent(app, (event) => event.key === "plugin-disabled:exitalways");
    expect(await pluginOf(app, "alpha")).toMatchObject({ state: "running" });
    expect(await pluginOf(app, "exitonce")).toMatchObject({ state: "running" });
    expect(await app.request({ cmd: "state" })).toMatchObject({ ready: true });
  }, 60_000);
});

describe("the first-use permission window", () => {
  const permy = (networks: string[], marker: string): Fixture => ({ id: "permy",
    source: `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "ran");
      export default { activate() {} };`,
    manifest: { permissions: { network: networks } } });
  const shelly = (marker: string): Fixture => ({ id: "shelly",
    source: `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "ran");
      export default { activate() {} };`,
    manifest: { permissions: { shell: true } } });
  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  const grants = async (userData: string): Promise<Record<string, { decision: string; permissions: unknown }>> =>
    (JSON.parse(await readFile(join(userData, "plugin-grants.json"), "utf8")) as { grants: Record<string, { decision: string; permissions: unknown }> }).grants;
  const waitForPrompt = (app: DesktopApp, id: string): Promise<void> =>
    vi.waitFor(async () => { expect((await stateOf(app)).pluginHost.permissionPrompt?.pluginId).toBe(id); }, { timeout: 10_000, interval: 50 });

  test("nothing runs before the answer, windows come one at a time, answers are remembered, and more permissions ask again", async () => {
    const userData = join(tempDir, "perm-user-data");
    const permyMarker = join(tempDir, "permy.ran");
    const shellyMarker = join(tempDir, "shelly.ran");
    const fixtures = [alpha, permy(["a.test"], permyMarker), shelly(shellyMarker)];

    // First launch: the plugin with no permissions runs at once; the other two wait, and only the first has a window.
    let launched = await launch("perm", fixtures, { answer: "hold", userData });
    try {
      let state = await stateOf(launched.app);
      expect(state.pluginHost.plugins.map(({ id, state: s }) => [id, s])).toEqual([
        ["alpha", "running"], ["permy", "needs-permission"], ["shelly", "needs-permission"]]);
      await waitForPrompt(launched.app, "permy");
      state = await stateOf(launched.app);
      expect(state.pluginHost.permissionPrompt?.lines).toEqual(["인터넷 접속: a.test"]);
      expect(Object.keys(state.pluginHost.pids)).toEqual(["alpha"]);
      expect(await exists(permyMarker)).toBe(false);
      // The empty-permission plugin is only recorded; nothing is recorded for the two that are still waiting.
      expect(Object.keys(await grants(userData))).toEqual(["alpha"]);

      await launched.app.request({ cmd: "setPermissionAnswerForTest", answer: "allow", once: true });
      await waitForState(launched.app, "permy", "running");
      await waitForPrompt(launched.app, "shelly");
      state = await stateOf(launched.app);
      expect(state.pluginHost.permissionPrompt?.lines[0]).toContain("임의 명령 실행");
      expect(await pluginOf(launched.app, "shelly")).toMatchObject({ state: "needs-permission" });
      expect(await exists(shellyMarker)).toBe(false);
      expect(await exists(permyMarker)).toBe(true);

      await launched.app.request({ cmd: "setPermissionAnswerForTest", answer: "deny", once: true });
      await waitForState(launched.app, "shelly", "denied");
      expect(await exists(shellyMarker)).toBe(false);
      const recorded = await grants(userData);
      expect(recorded.permy?.decision).toBe("granted");
      expect(recorded.shelly?.decision).toBe("denied");
      expect(recorded.alpha?.decision).toBe("granted");
    } finally { await launched.app.dispose(); }

    // Second launch, same user data: nothing is asked again and the decisions hold.
    await rm(permyMarker);
    launched = await launch("perm", fixtures, { answer: "hold", userData });
    try {
      const state = await stateOf(launched.app);
      expect(state.pluginHost.permissionPrompt).toBeNull();
      expect(state.pluginHost.plugins.map(({ id, state: s }) => [id, s])).toEqual([
        ["alpha", "running"], ["permy", "running"], ["shelly", "denied"]]);
      expect(await exists(shellyMarker)).toBe(false);
    } finally { await launched.app.dispose(); }

    // A manifest that asks for more is asked again, and is not started with the new permissions meanwhile.
    await rm(permyMarker);
    launched = await launch("perm", fixtures.map((item) => item.id === "permy" ? permy(["a.test", "b.test"], permyMarker) : item),
      { answer: "hold", userData });
    try {
      await waitForPrompt(launched.app, "permy");
      expect((await stateOf(launched.app)).pluginHost.permissionPrompt?.lines).toEqual(["인터넷 접속: a.test, b.test"]);
      expect(await pluginOf(launched.app, "permy")).toMatchObject({ state: "needs-permission" });
      expect(await exists(permyMarker)).toBe(false);
      await launched.app.request({ cmd: "setPermissionAnswerForTest", answer: "allow", once: true });
      await waitForState(launched.app, "permy", "running");
      expect((await grants(userData)).permy?.permissions).toEqual({ network: ["a.test", "b.test"] });
    } finally { await launched.app.dispose(); }

    // Fewer permissions than recorded: no window, the record is only updated.
    await rm(permyMarker);
    launched = await launch("perm", fixtures, { answer: "hold", userData });
    try {
      expect((await stateOf(launched.app)).pluginHost.permissionPrompt).toBeNull();
      expect(await pluginOf(launched.app, "permy")).toMatchObject({ state: "running" });
      expect((await grants(userData)).permy?.permissions).toEqual({ network: ["a.test"] });
    } finally { await launched.app.dispose(); }
  }, 120_000);
});

describe("log file", () => {
  test("plugin logs reach userData/logs/deskpet.log masked, and the tray offers the logs folder", async () => {
    const chatty: Fixture = { id: "chatty", source: `export default { activate(ctx) {
      ctx.log.info("visited https://svc.test/a?token=QUERYSECRET1&page=2 with Bearer BEARERSECRET1");
      console.log("stdout-line Authorization: AUTHSECRET1");
    } };` };
    const { app, userData } = await launch("logfile", [chatty], { answer: "allow" });
    try {
      await waitForState(app, "chatty", "running");
      expect((await stateOf(app)).trayMenu).toContain("오류 기록 폴더 열기");
      const logPath = join(userData, "logs", "deskpet.log");
      await vi.waitFor(async () => { expect(await readFile(logPath, "utf8")).toContain("[plugin:chatty] stdout-line"); },
        { timeout: 10_000, interval: 50 });
      const text = await readFile(logPath, "utf8");
      expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z (INFO|WARN) \[plugin:chatty\] /m);
      expect(text).toContain("page=2");
      expect(text).not.toMatch(/QUERYSECRET1|BEARERSECRET1|AUTHSECRET1/);
    } finally { await app.dispose(); }
  }, 60_000);
});

afterAll(async () => {
  if (tempDir) await cleanupTemporaryPath(tempDir);
});
