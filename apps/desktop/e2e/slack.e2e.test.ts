import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { parseLines, renderLine } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { fakeSlackServer } from "./fake-slack-server.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const APP_TOKEN = "xapp-e2e-secret-123";
const REPLACEMENT_TOKEN = "xapp-e2e-replacement-789";
const USER_TOKEN = "xoxp-e2e-secret-456";
const BODY = "private slack preview";
const catalog = parseLines(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../plugins/slack/lines.json"), "utf8")), "slack").catalog;
type State = { bubble: { visible: boolean; text: string | null;
  renderer: { buttons: Array<{ label: string }> } } | null;
  queue: { pending: number }; doNotDisturb: { enabled: boolean } };

let root: string;
let app: DesktopApp | undefined;
let server: Awaited<ReturnType<typeof fakeSlackServer>> | undefined;
const state = (): Promise<State> => {
  if (!app) throw new Error("App is not running");
  return app.request({ cmd: "state" }) as Promise<State>;
};
const eventTexts = async (): Promise<string[]> => {
  if (!app) throw new Error("App is not running");
  const result = await app.request({ cmd: "events" }) as { events: Array<{ event: {
    text?: string; line?: { id: string; vars?: Record<string, string> } } }> };
  return result.events.map(({ event }) => event.line
    ? renderLine(catalog, event.line.id, event.line.vars) ?? "" : event.text ?? "");
};
const waitFor = (predicate: () => Promise<void>): Promise<void> =>
  vi.waitFor(predicate, { timeout: 10_000, interval: 50 });
const send = (event: Record<string, unknown>, id: string): void => {
  server?.send({ type: "events_api", envelope_id: id,
    payload: { event: { type: "message", channel: "CNEWS", channel_type: "channel",
      user: "UOTHER", ts: id, event_id: id, ...event } } });
};

test("real Slack plugin settings, received bubbles, action, grouping, DND and auth error", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-slack-e2e-"));
  const plugins = join(root, "plugins");
  const plugin = join(plugins, "slack");
  const userData = join(root, "user-data");
  await mkdir(join(plugin, "dist"), { recursive: true });
  await mkdir(userData, { recursive: true });
  const source = resolve(import.meta.dirname, "../../../plugins/slack");
  await copyFile(join(source, "manifest.json"), join(plugin, "manifest.json"));
  await copyFile(join(source, "lines.json"), join(plugin, "lines.json"));
  await copyFile(join(source, "dist", "index.js"), join(plugin, "dist", "index.js"));
  server = await fakeSlackServer();
  app = await DesktopApp.launch(userData,
    [`--plugins-dir=${plugins}`, "--permission-answer=hold"]);
  await app.request({ cmd: "setSlackTransportForTest", port: server.port });
  await app.request({ cmd: "setPermissionAnswerForTest", answer: "allow", once: true });
  await app.request({ cmd: "clock", pause: true });
  await waitFor(async () => { expect(await eventTexts()).toContain("Slack 토큰 확인 필요"); });
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });

  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await app.request({ cmd: "settingsClick", selector: "#tab-plugins" });
  const card = "[data-plugin-id='slack']";
  await waitFor(async () => {
    expect((await app?.request({ cmd: "settingsQuery", selector: `${card} .plugin-line` }) as Array<{ text: string }>)[0]?.text)
      .toBe("Slack: 실행 중 · Slack 토큰 확인 필요");
  });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='appToken'] input`, value: APP_TOKEN });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='userToken'] input`, value: USER_TOKEN });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='memberId'] input`, value: "UOWN" });
  await app.request({ cmd: "settingsClick", selector: `${card} [data-field='channelIds'] .array-add` });
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='channelIds'] .row input`, value: "CNEWS" });
  await app.request({ cmd: "settingsClick", selector: `${card} .plugin-save` });
  await waitFor(async () => { expect(server?.sockets.size).toBe(1); });
  await waitFor(async () => {
    expect((await app?.request({ cmd: "settingsQuery", selector: `${card} .plugin-status` }) as Array<{ text: string }>)[0]?.text)
      .toBe("저장했어요");
  });

  send({ text: BODY + " <@UOWN>" }, "ev-mention");
  await waitFor(async () => {
    expect((await state()).bubble).toMatchObject({ visible: true, text: "Tester · #general\n" + BODY + " @UOWN" });
  });
  expect((await state()).bubble?.renderer.buttons.map(({ label }) => label)).toEqual(["Slack 에서 열기"]);
  const delivered = await app.request({ cmd: "events" }) as { events: Array<{ event: {
    key?: string; actions?: Array<{ label: string; action: string; args: unknown }> } }> };
  expect(delivered.events.find(({ event }) => event.key === "ev-mention")?.event.actions)
    .toEqual([{ label: "Slack 에서 열기", action: "slack.open",
      args: { team: "TTEAM", channel: "CNEWS" } }]);
  const beforeOpen = await app.request({ cmd: "checkerWindowsForTest" }) as { externalOpens: number };
  await app.request({ cmd: "bubbleAction", index: 0 });
  await waitFor(async () => {
    const after = await app?.request({ cmd: "checkerWindowsForTest" }) as {
      externalOpens: number; externalUrls: string[] };
    expect(after.externalOpens).toBe(beforeOpen.externalOpens + 1);
    expect(after.externalUrls.at(-1)).toBe("https://app.slack.com/client/TTEAM/CNEWS");
  });
  await app.request({ cmd: "clock", advanceMs: 5_000 });

  const before = (await eventTexts()).length;
  send({ text: "my message", user: "UOWN" }, "ev-self");
  send({ text: "bot message", bot_id: "B123" }, "ev-bot");
  send({ text: "DM hello", channel: "DCHAT", channel_type: "im" }, "ev-dm");
  await waitFor(async () => { expect((await eventTexts()).some((text) => text.includes("DM hello"))).toBe(true); });
  expect((await eventTexts()).length).toBe(before + 1);
  expect((await state()).bubble?.text).toBe("Tester · DM\nDM hello");
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });

  send({ text: "batch one" }, "ev-batch-1");
  send({ text: "batch two" }, "ev-batch-2");
  send({ text: "batch three" }, "ev-batch-3");
  send({ text: "batch four" }, "ev-batch-4");
  await waitFor(async () => { expect((await state()).queue.pending).toBeGreaterThanOrEqual(3); });
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await waitFor(async () => { expect((await state()).bubble?.text).toBe("slack 알림 3개"); });
  await app.request({ cmd: "bubbleDismiss" });

  await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
  send({ text: "held message" }, "ev-held");
  await waitFor(async () => { expect((await state()).queue.pending).toBe(1); });
  expect((await state()).bubble?.visible).toBe(false);
  await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
  await waitFor(async () => { expect((await state()).bubble?.text).toBe("Tester · #general\nheld message"); });

  const auth = await app.eventServerAuth(userData);
  const response = await fetch(`http://127.0.0.1:${auth.port}/status`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  const persisted = [await readFile(join(userData, "settings.json"), "utf8"),
    await readFile(join(userData, "logs", "deskpet.log"), "utf8").catch(() => ""),
    await readFile(join(userData, "errors.log"), "utf8").catch(() => ""),
    await response.text()].join("\n");
  for (const forbidden of [APP_TOKEN, USER_TOKEN, BODY]) expect(persisted).not.toContain(forbidden);
  expect(server.hits.filter(({ path }) => path.startsWith("/api/users.info"))).toHaveLength(1);
  expect(server.hits.filter(({ path }) => path.startsWith("/api/conversations.info"))).toHaveLength(1);

  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  server.setOpenError("invalid_auth");
  const warningsBefore = (await eventTexts()).filter((text) => text === "Slack 토큰 확인 필요").length;
  await app.request({ cmd: "settingsSet", selector: `${card} [data-field='appToken'] input`, value: REPLACEMENT_TOKEN });
  await app.request({ cmd: "settingsClick", selector: `${card} .plugin-save` });
  await waitFor(async () => {
    expect((await eventTexts()).filter((text) => text === "Slack 토큰 확인 필요")).toHaveLength(warningsBefore + 1);
  });
  expect((await state()).bubble?.text).toBe("Slack 토큰 확인 필요");
  expect(server.hits.filter(({ path }) => path === "/api/apps.connections.open")).toHaveLength(2);
  const finalStatus = await fetch(`http://127.0.0.1:${auth.port}/status`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  const finalStatusBody = await finalStatus.text();
  expect((JSON.parse(finalStatusBody) as { plugins: Array<{ id: string; badge?: string }> }).plugins
    .find(({ id }) => id === "slack")?.badge).toBe("Slack 토큰 확인 필요");
  const finalStatusText = [finalStatusBody, await readFile(join(userData, "settings.json"), "utf8"),
    await readFile(join(userData, "logs", "deskpet.log"), "utf8").catch(() => ""),
    await readFile(join(userData, "errors.log"), "utf8").catch(() => "")].join("\n");
  for (const forbidden of [APP_TOKEN, REPLACEMENT_TOKEN, USER_TOKEN, BODY])
    expect(finalStatusText).not.toContain(forbidden);

  await app.quit();
}, 90_000);

afterAll(async () => {
  if (app) await app.dispose();
  if (server) await server.close();
  if (root) await cleanupTemporaryPath(root, app ? [app] : []);
}, 45_000);
