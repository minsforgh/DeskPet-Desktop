import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Hit = { host: string; path: string; method: string; cookie: string; accept: string };
type WindowState = { pluginId: string; id: string; url: string; visible: boolean; title: string;
  partition: string; navigationBlocks: number; popupBlocks: number };
type Snapshot = { windows: WindowState[]; externalOpens: number };

let temporary: string;
let server: Server;
let port: number;
const hits: Hit[] = [];
// Focused Windows/Electron 44.5.1 runs completed the whole restart scenario in 2.6 s;
// failed navigation and cookie runs took 16 s at most. These bounds cover each observed step.
const events = async (app: DesktopApp): Promise<string[]> =>
  ((await app.request({ cmd: "events" })) as { events: Array<{ event: { text?: string } }> }).events
    .flatMap(({ event }) => event.text === undefined ? [] : [event.text]);
const snapshot = (app: DesktopApp): Promise<Snapshot> => app.request({ cmd: "checkerWindowsForTest" }) as Promise<Snapshot>;
const execute = async (app: DesktopApp, code: string): Promise<void> => {
  expect(await app.request({ cmd: "checkerExecuteForTest", pluginId: "one", windowId: "checker", code }))
    .toBe("executed");
};
const waitForEvent = (app: DesktopApp, text: string): Promise<void> =>
  vi.waitFor(async () => expect(await events(app)).toContain(text), { timeout: 10_000, interval: 50 });
const waitForWindow = (app: DesktopApp, id: string, count = 1): Promise<void> =>
  vi.waitFor(async () => expect((await snapshot(app)).windows.filter((window) => window.id === id)).toHaveLength(count),
    { timeout: 10_000, interval: 50 });

const source = (id: string): string => `let checker;
const report = (ctx, text) => ctx.emit({ source: "${id}", type: "status", text });
export default { async activate(ctx) {
  checker = await ctx.windows.create("checker", { url: "https://allowed.test/home", title: "Login" });
  ctx.registerAction("${id}.json", async () => {
    try { const result = await checker.getJson("/api?plugin=${id}&secret=QUERY_SECRET");
      report(ctx, "${id}:json:" + result.status + ":" + JSON.stringify(result.body)); }
    catch (error) { report(ctx, "${id}:json:" + error.code); }
  });
  ctx.registerAction("${id}.redirectJson", async () => {
    try { const result = await checker.getJson("/api-redirect"); report(ctx, "${id}:redirectJson:" + result.status); }
    catch (error) { report(ctx, "${id}:redirectJson:" + error.code); }
  });
  ctx.registerAction("${id}.show", async () => { await checker.show(); report(ctx, "${id}:shown"); });
  ctx.registerAction("${id}.bad", async () => {
    try { await ctx.windows.create("checker", { url: "https://outside.test/home" }); }
    catch (error) { report(ctx, "${id}:bad:" + error.code); }
  });
  ctx.registerAction("${id}.missing", async () => {
    try { await ctx.windows.create("missing", { url: "https://allowed.test/home" }); }
    catch (error) { report(ctx, "${id}:missing:" + error.code); }
  });
  ctx.registerAction("${id}.recreate", async () => {
    checker = await ctx.windows.create("checker", { url: "https://allowed.test/home" });
    report(ctx, "${id}:recreated");
  });
} };`;

async function fixture(root: string, id: string): Promise<void> {
  const folder = join(root, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: "1",
    entry: "index.mjs", description: "checker test", permissions: { windows: ["checker"], network: ["allowed.test", "second.test"],
      openExternal: ["https://allowed.test/page"] },
    contributes: { actions: [`${id}.json`, `${id}.redirectJson`, `${id}.show`, `${id}.bad`, `${id}.missing`, `${id}.recreate`] } }));
  await writeFile(join(folder, "index.mjs"), source(id));
}

async function launch(userData: string, root: string): Promise<DesktopApp> {
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false },
    httpActionAllowlist: ["one.json", "one.redirectJson", "one.show", "one.bad", "one.missing", "one.recreate",
      "two.json", "two.redirectJson", "two.show", "two.bad", "two.missing", "two.recreate"] }));
  return DesktopApp.launch(userData, ["--event-port=0", `--plugins-dir=${root}`, "--permission-answer=allow",
    `--host-resolver-rules=MAP * 127.0.0.1:${port}`]);
}

async function action(app: DesktopApp, userData: string, id: string): Promise<void> {
  const { port: eventPort, token } = await app.eventServerAuth(userData);
  const response = await fetch(`http://127.0.0.1:${eventPort}/action/${id}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-checker-e2e-"));
  server = createServer({ pfx: await readFile(join(import.meta.dirname, "checker-cert.pfx")), passphrase: "test-only" },
    (request, response) => {
      const host = request.headers.host ?? "";
      const path = request.url ?? "/";
      hits.push({ host, path, method: request.method ?? "", cookie: request.headers.cookie ?? "",
        accept: request.headers.accept ?? "" });
      if (path === "/home") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<a id="pop" href="https://allowed.test/page" target="_blank">open</a>`);
      } else if (path === "/redirect") {
        response.writeHead(302, { Location: "https://outside.test/page" }); response.end();
      } else if (path === "/redirect-allowed") {
        response.writeHead(302, { Location: "https://second.test/page" }); response.end();
      } else if (path === "/api-redirect") {
        response.writeHead(302, { Location: "https://allowed.test/redirect-target" }); response.end();
      } else if (path.startsWith("/api")) {
        const owner = new URL(path, "https://allowed.test").searchParams.get("plugin");
        response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `owner=${owner}; Max-Age=3600; SameSite=None; Secure` });
        response.end(JSON.stringify({ ok: true, cookie: request.headers.cookie ?? "" }));
      } else { response.writeHead(200); response.end("ok"); }
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("HTTPS server has no port");
  port = address.port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTemporaryPath(temporary);
});

describe("checker windows", () => {
  test("enforces navigation and popup guards, GET and cookie partition, and survives a renderer crash", async () => {
    const root = join(temporary, "plugins");
    const userData = join(temporary, "user-data");
    await fixture(root, "one");
    await fixture(root, "two");
    const app = await launch(userData, root);
    try {
      await waitForWindow(app, "checker", 2);
      await vi.waitFor(async () => expect((await snapshot(app)).windows.every((window) =>
        window.url === "https://allowed.test/home")).toBe(true), { timeout: 10_000, interval: 50 });
      const initial = await snapshot(app);
      expect(initial.windows).toHaveLength(2);
      expect(initial.windows.every((window) => !window.visible && window.url === "https://allowed.test/home")).toBe(true);
      expect(initial.windows.find((window) => window.pluginId === "one")?.partition).toBe("persist:deskpet-plugin-one");
      expect(initial.windows.find((window) => window.pluginId === "one")?.title).toBe("[one] Login — allowed.test");
      await action(app, userData, "one.bad");
      await waitForEvent(app, "one:bad:E_PERMISSION");
      await action(app, userData, "one.missing");
      await waitForEvent(app, "one:missing:E_PERMISSION");
      expect((await snapshot(app)).windows).toHaveLength(2);
      await action(app, userData, "one.json");
      await waitForEvent(app, 'one:json:200:{"ok":true,"cookie":""}');
      await action(app, userData, "one.json");
      await waitForEvent(app, 'one:json:200:{"ok":true,"cookie":"owner=one"}');
      await action(app, userData, "two.json");
      await waitForEvent(app, 'two:json:200:{"ok":true,"cookie":""}');
      expect(hits.filter((hit) => hit.path.startsWith("/api")).every((hit) => hit.method === "GET")).toBe(true);
      expect(hits.filter((hit) => hit.path.startsWith("/api")).every((hit) => hit.accept === "application/json")).toBe(true);
      let guardsBefore = (await snapshot(app)).windows.find((window) => window.pluginId === "one")?.navigationBlocks ?? 0;
      await execute(app, "location.href = 'https://outside.test/page'; 'executed'");
      await vi.waitFor(async () => {
        const window = (await snapshot(app)).windows.find((item) => item.pluginId === "one");
        expect(window?.navigationBlocks).toBeGreaterThan(guardsBefore);
        expect(window?.url).toBe("https://allowed.test/home");
      }, { timeout: 5000, interval: 50 });
      const homesBeforeBlank = hits.filter((hit) => hit.path === "/home").length;
      await execute(app, "location.href = 'about:blank'; 'executed'");
      await vi.waitFor(async () => {
        expect(hits.filter((hit) => hit.path === "/home").length).toBeGreaterThan(homesBeforeBlank);
        expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.url)
          .toBe("https://allowed.test/home");
      }, { timeout: 5000, interval: 50 });
      guardsBefore = (await snapshot(app)).windows.find((window) => window.pluginId === "one")?.navigationBlocks ?? 0;
      await execute(app, "location.href = 'https://allowed.test/redirect'; 'executed'");
      await vi.waitFor(async () => {
        const window = (await snapshot(app)).windows.find((item) => item.pluginId === "one");
        expect(window?.navigationBlocks).toBeGreaterThan(guardsBefore);
        expect(window?.url).toBe("https://allowed.test/home");
      }, { timeout: 5000, interval: 50 });
      guardsBefore = (await snapshot(app)).windows.find((window) => window.pluginId === "one")?.navigationBlocks ?? 0;
      await execute(app, "const frame = document.createElement('iframe'); frame.src = 'https://outside.test/page'; document.body.append(frame); 'executed'");
      await vi.waitFor(async () => {
        const window = (await snapshot(app)).windows.find((item) => item.pluginId === "one");
        expect(window?.navigationBlocks).toBeGreaterThan(guardsBefore);
        expect(window?.url).toBe("https://allowed.test/home");
      }, { timeout: 5000, interval: 50 });
      await action(app, userData, "one.redirectJson");
      await waitForEvent(app, "one:redirectJson:302");
      expect(hits.some((hit) => hit.path === "/redirect-target")).toBe(false);
      await execute(app, "location.href = 'https://allowed.test/redirect-allowed'; 'executed'");
      await vi.waitFor(async () => expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.url)
        .toBe("https://second.test/page"), { timeout: 5000, interval: 50 });
      const apiBefore = hits.filter((hit) => hit.path.startsWith("/api")).length;
      await action(app, userData, "one.json");
      await vi.waitFor(() => expect(hits.filter((hit) => hit.path.startsWith("/api")).length)
        .toBeGreaterThan(apiBefore), { timeout: 5000, interval: 50 });
      expect(hits.filter((hit) => hit.path.startsWith("/api")).at(-1)?.host).toBe("allowed.test");
      await execute(app, "location.href = 'https://allowed.test/home'; 'executed'");
      await vi.waitFor(async () => expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.url)
        .toBe("https://allowed.test/home"), { timeout: 5000, interval: 50 });
      await action(app, userData, "one.show");
      await waitForEvent(app, "one:shown");
      const popupsBefore = (await snapshot(app)).windows.find((window) => window.pluginId === "one")?.popupBlocks ?? 0;
      await execute(app, "window.open('https://outside.test/page'); document.querySelector('#pop').click(); document.title='Fake'; 'executed'");
      await vi.waitFor(async () => expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.popupBlocks)
        .toBeGreaterThan(popupsBefore), { timeout: 5000, interval: 50 });
      expect((await snapshot(app)).externalOpens).toBe(0);
      expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.title)
        .toBe("[one] Login — allowed.test");
      expect(hits.some((hit) => hit.host.startsWith("outside.test"))).toBe(false);
      await app.request({ cmd: "checkerCloseForTest", pluginId: "one", windowId: "checker" });
      expect((await snapshot(app)).windows.find((window) => window.pluginId === "one")?.visible).toBe(false);
      await app.request({ cmd: "checkerCrashForTest", pluginId: "one", windowId: "checker" });
      await waitForWindow(app, "checker", 1);
      await action(app, userData, "one.json");
      await waitForEvent(app, "one:json:E_UNAVAILABLE");
      await action(app, userData, "one.recreate");
      await waitForEvent(app, "one:recreated");
      await waitForWindow(app, "checker", 2);
      const state = await app.request({ cmd: "state" }) as { pluginHost: { pids: Record<string, number> } };
      const onePid = state.pluginHost.pids.one;
      if (onePid === undefined) throw new Error("Plugin one has no process");
      process.kill(onePid, "SIGKILL");
      await vi.waitFor(async () => {
        const windows = (await snapshot(app)).windows;
        expect(windows.some((window) => window.pluginId === "one")).toBe(false);
        expect(windows.some((window) => window.pluginId === "two")).toBe(true);
      }, { timeout: 5000, interval: 50 });
      expect(app.child.exitCode).toBeNull();
      expect(app.diagnostics).not.toContain("QUERY_SECRET");
      expect(app.diagnostics).not.toContain("owner=one");
      await app.quit();
      const restarted = await launch(userData, root);
      try {
        await waitForWindow(restarted, "checker", 2);
        await action(restarted, userData, "one.json");
        await waitForEvent(restarted, 'one:json:200:{"ok":true,"cookie":"owner=one"}');
        await action(restarted, userData, "two.json");
        await waitForEvent(restarted, 'two:json:200:{"ok":true,"cookie":"owner=two"}');
        await restarted.quit();
      } finally { await restarted.forceStop(); }
    } catch (error) {
      await app.forceStop();
      throw new Error(`${String(error)}; exit=${app.child.exitCode}; signal=${app.child.signalCode}; hits=${JSON.stringify(hits.slice(-8))}; diagnostics=${app.diagnostics}`, { cause: error });
    }
  }, 30_000);
});
