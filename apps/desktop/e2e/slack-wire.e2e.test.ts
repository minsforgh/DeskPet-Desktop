import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { fakeSlackServer } from "./fake-slack-server.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const APP_TOKEN = "xapp-fake-secret-123";
const USER_TOKEN = "xoxp-fake-secret-456";
const SOCKET_URL = "wss://wss-primary.slack.com/link/test?ticket=fake-ticket";
const source = `let connection;
export default {
  configSchema: { type: "object", properties: {
    appToken: { type: "string", title: "앱 토큰", secret: true },
    userToken: { type: "string", title: "사용자 토큰", secret: true },
  } },
  async activate(ctx) {
    connection = await ctx.slack.connect({ appTokenSecret: "appToken",
      onEvent(message) { ctx.emit({ source: "wire", type: "notify", text: String(message.event.text) }); },
      onStatus(status) { ctx.emit({ source: "wire", type: "status", text: status }); },
    });
    ctx.onConfigChange(async () => {
      try {
        const result = await ctx.slack.get({ userTokenSecret: "userToken", method: "users.info", query: { user: "U123" } });
        ctx.emit({ source: "wire", type: "status", text: "get:" + result.status });
      } catch (error) { ctx.emit({ source: "wire", type: "status", text: "get-error:" + error.code }); }
    });
    ctx.registerAction("wire.fail", () => { throw new Error("fixture failure"); });
  },
  deactivate() { connection?.dispose(); },
};`;

let root: string;
const apps: DesktopApp[] = [];
const servers: Awaited<ReturnType<typeof fakeSlackServer>>[] = [];

async function launch(name: string, answer: "hold" | "deny") {
  const folder = join(root, name);
  const pluginDir = join(folder, "plugins", "wire");
  const userData = join(folder, "user-data");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ httpActionAllowlist: ["wire.fail"] }));
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({
    id: "wire", name: "Wire", version: "0.0.0", apiVersion: "2", entry: "index.mjs",
    description: "e2e fixture", permissions: { secrets: true, network: ["slack.com"], socketMode: ["slack.com"] },
    contributes: { actions: ["wire.fail"] },
  }));
  await writeFile(join(pluginDir, "index.mjs"), source);
  const app = await DesktopApp.launch(userData,
    [`--plugins-dir=${join(folder, "plugins")}`, `--permission-answer=${answer}`]);
  apps.push(app);
  return { app, userData };
}

const state = (app: DesktopApp) => app.request({ cmd: "state" }) as Promise<{
  bubble: { visible: boolean; text: string | null } | null;
  pluginHost: { plugins: Array<{ id: string; state: string }> };
}>;
const events = async (app: DesktopApp): Promise<string[]> =>
  ((await app.request({ cmd: "events" })) as { events: Array<{ event: { text?: string } }> }).events
    .map(({ event }) => event.text ?? "");
const waitForText = (app: DesktopApp, text: string) => vi.waitFor(async () => {
  expect(await events(app)).toContain(text);
}, { timeout: 10_000, interval: 50 });

async function saveTokens(app: DesktopApp) {
  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await app.request({ cmd: "settingsClick", selector: "#tab-plugins" });
  const card = "[data-plugin-id='wire']";
  await vi.waitFor(async () => {
    expect((await app.request({ cmd: "settingsQuery", selector: `${card} .plugin-line` }) as Array<{ text: string }>)[0]?.text)
      .toBe("Wire: 실행 중");
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='appToken'] input`, value: APP_TOKEN });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='userToken'] input`, value: USER_TOKEN });
  await app.request({ cmd: "settingsClick", selector: `${card} .plugin-save` });
  await vi.waitFor(async () => {
    expect((await app.request({ cmd: "settingsQuery", selector: `${card} .plugin-status` }) as Array<{ text: string }>)[0]?.text)
      .toBe("저장했어요");
  }, { timeout: 10_000, interval: 50 });
}

describe("v2 Slack wire through the desktop app", () => {
  test("receives events, acknowledges them, proxies GET and closes on app exit", async () => {
    root = await mkdtemp(join(tmpdir(), "deskpet-slack-wire-"));
    const server = await fakeSlackServer(); servers.push(server);
    const { app, userData } = await launch("allowed", "hold");
    await app.request({ cmd: "setSlackTransportForTest", port: server.port });
    await app.request({ cmd: "setPermissionAnswerForTest", answer: "allow", once: true });
    await waitForText(app, "token-required");
    await saveTokens(app);
    await vi.waitFor(() => expect(server.sockets.size).toBe(1), { timeout: 10_000, interval: 50 });
    server.send({ type: "hello" });
    server.send({ type: "events_api", envelope_id: "env-1", payload: { event: { type: "message", text: "가짜 Slack 메시지" } } });
    await waitForText(app, "가짜 Slack 메시지");
    await vi.waitFor(async () => {
      expect((await state(app)).bubble).toMatchObject({ visible: true, text: "가짜 Slack 메시지" });
      expect(server.acks).toContainEqual({ envelope_id: "env-1" });
    }, { timeout: 10_000, interval: 50 });
    expect(server.hits.find((hit) => hit.path === "/api/apps.connections.open")).toMatchObject({
      method: "POST", authorization: `Bearer ${APP_TOKEN}`,
    });
    expect(server.hits.find((hit) => hit.method === "UPGRADE")?.path).toBe("/wss-primary.slack.com/link/test?ticket=fake-ticket");
    expect(server.hits.find((hit) => hit.path.startsWith("/api/users.info"))).toMatchObject({
      method: "GET", authorization: `Bearer ${USER_TOKEN}`,
    });
    const auth = await app.eventServerAuth(userData);
    const statusResponse = await fetch(`http://127.0.0.1:${auth.port}/status`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const leaked = [app.diagnostics, await readFile(join(userData, "settings.json"), "utf8"),
      await statusResponse.text(), await readFile(join(userData, "errors.log"), "utf8").catch(() => ""),
      await readFile(join(userData, "logs", "deskpet.log"), "utf8").catch(() => "")].join("\n");
    for (const secret of [APP_TOKEN, USER_TOKEN, SOCKET_URL]) expect(leaked).not.toContain(secret);
    const tokenRequiredBefore = (await events(app)).filter((text) => text === "token-required").length;
    await app.request({ cmd: "settingsClick", selector: "[data-plugin-id='wire'] [data-field='appToken'] .secret-clear" });
    await vi.waitFor(async () => {
      expect(server.closed).toBeGreaterThan(0);
      expect((await events(app)).filter((text) => text === "token-required").length).toBeGreaterThan(tokenRequiredBefore);
    }, { timeout: 10_000, interval: 50 });
    await app.request({ cmd: "settingsSet", selector: "[data-plugin-id='wire'] [data-field='appToken'] input", value: APP_TOKEN });
    await app.request({ cmd: "settingsClick", selector: "[data-plugin-id='wire'] .plugin-save" });
    await vi.waitFor(() => expect(server.sockets.size).toBe(1), { timeout: 10_000, interval: 50 });
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${auth.port}/action/wire.fail`, {
        method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }, body: "{}",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    await vi.waitFor(async () => {
      expect((await state(app)).pluginHost.plugins.find((plugin) => plugin.id === "wire")?.state).toBe("disabled");
      expect(server.closed).toBeGreaterThan(1);
    }, { timeout: 10_000, interval: 50 });
    await app.quit();
  }, 60_000);

  test("invalid authentication stops retrying, and denied permission makes no POST", async () => {
    const server = await fakeSlackServer(); servers.push(server);
    server.setOpenError("invalid_auth");
    const { app } = await launch("invalid", "hold");
    await app.request({ cmd: "setSlackTransportForTest", port: server.port });
    await app.request({ cmd: "setPermissionAnswerForTest", answer: "allow", once: true });
    await waitForText(app, "token-required");
    const initialStatuses = (await events(app)).filter((text) => text === "token-required").length;
    await saveTokens(app);
    await vi.waitFor(async () => {
      expect(server.hits.filter((hit) => hit.path === "/api/apps.connections.open")).toHaveLength(1);
      expect((await events(app)).filter((text) => text === "token-required").length).toBeGreaterThan(initialStatuses);
    },
      { timeout: 10_000, interval: 50 });
    expect(server.hits.filter((hit) => hit.path === "/api/apps.connections.open")).toHaveLength(1);
    const deniedServer = await fakeSlackServer(); servers.push(deniedServer);
    const denied = await launch("denied", "deny");
    await denied.app.request({ cmd: "setSlackTransportForTest", port: deniedServer.port });
    expect((await state(denied.app)).pluginHost.plugins.find((plugin) => plugin.id === "wire")?.state).toBe("denied");
    expect(deniedServer.hits).toHaveLength(0);
  }, 60_000);

  afterAll(async () => {
    for (const app of apps) await app.dispose();
    for (const server of servers) await server.close();
    if (root) await cleanupTemporaryPath(root, apps);
  }, 45_000);
});
