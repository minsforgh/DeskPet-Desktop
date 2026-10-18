import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { DesktopApp } from "./desktop-app.js";
import { FAKE, launchJungle, logPathOf, startFakeLms, stageJunglePlugin, type FakeLms } from "./helpers/fake-lms.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

let temporary: string;
let lms: FakeLms;
let app: DesktopApp;
let userData: string;

const readLog = (): Promise<string> => readFile(logPathOf(userData), "utf8").catch(() => "");
const pollLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.includes("[plugin:jungle] jungle: poll kind="));
const apiHits = (): typeof lms.hits => lms.hits.filter((hit) => hit.path.startsWith("/api/"));
const FORBIDDEN = [FAKE.cookie, FAKE.cohortName, FAKE.cohortId, FAKE.attendanceId, FAKE.status, "2099-01-01",
  "Set-Cookie", "SESSION="];

type JungleState = { character: { state: string }; bubble: { visible: boolean; text: string | null;
  renderer: { buttons: Array<{ label: string }> } } };
type CheckerSnapshot = { windows: Array<{ pluginId: string; id: string; url: string; visible: boolean; partition: string }>;
  externalOpens: number };

async function action(target: DesktopApp, dataDir: string, id: string): Promise<void> {
  const { port, token } = await target.eventServerAuth(dataDir);
  const response = await fetch(`http://127.0.0.1:${port}/action/${id}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
}

/** Triggers an immediate poll through the user-action endpoint and returns the poll lines it added. */
async function checkNow(): Promise<string[]> {
  const before = pollLines(await readLog()).length;
  const { port, token } = await app.eventServerAuth(userData);
  const response = await fetch(`http://127.0.0.1:${port}/action/jungle.check-now`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  await vi.waitFor(async () => expect(pollLines(await readLog()).length).toBeGreaterThan(before),
    { timeout: 15_000, interval: 100 });
  return pollLines(await readLog()).slice(before);
}

function expectNoValues(text: string): void {
  for (const value of FORBIDDEN) expect(text, `log leaks ${value}`).not.toContain(value);
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-jungle-log-e2e-"));
  lms = await startFakeLms();
  const root = join(temporary, "plugins");
  userData = join(temporary, "user-data");
  await stageJunglePlugin(root);
  await copyFile(resolve(import.meta.dirname, "../../../plugins/jungle/lines.json"), join(root, "jungle", "lines.json"));
  app = await launchJungle(userData, root, lms.port, ["jungle.check-now"]);
}, 60_000);

afterAll(async () => {
  try { await app?.dispose(); }
  finally {
    await lms.close();
    await cleanupTemporaryPath(temporary);
  }
});

describe("jungle plugin log", () => {
  test("A: the first automatic poll logs status values only", async () => {
    // The first poll fires about 5 s after activation; wait on the log, not a fixed delay. That poll creates the
    // checker window, whose check-in page (the cookie source) loads after the first requests, so it is needsLogin.
    // The next poll, triggered by the user action, runs with the cookie in the plugin partition.
    await vi.waitFor(async () => expect(pollLines(await readLog()).length).toBeGreaterThan(0),
      { timeout: 30_000, interval: 200 });
    await vi.waitFor(() => expect(lms.hits.some((hit) => hit.path === "/check-in")).toBe(true),
      { timeout: 10_000, interval: 50 });
    await checkNow();
    await vi.waitFor(async () => {
      const text = await readLog();
      expect(text).toMatch(/\[plugin:jungle\] jungle: poll kind=ok phase=/);
      expect(text).toContain("[window] jungle/lms-checker getJson status=200");
    }, { timeout: 30_000, interval: 200 });
    expectNoValues(await readLog());
    const api = apiHits();
    expect(api.length).toBeGreaterThanOrEqual(2);
    expect(api.every((hit) => hit.method === "GET" && hit.accept === "application/json")).toBe(true);
    // Only the very first request (before the home page set the cookie) may lack it.
    expect(api.slice(1).every((hit) => hit.cookie.includes(`SESSION=${FAKE.cookie}`))).toBe(true);
    expect(api.at(-1)?.cookie).toContain(`SESSION=${FAKE.cookie}`);
    expect(lms.hits.every((hit) => hit.method === "GET")).toBe(true);
  }, 60_000);

  test("B: a 401 from cohorts logs needsLogin without values", async () => {
    lms.mode = "unauthorized";
    const added = await checkNow();
    expect(added.some((line) => line.includes("poll kind=needsLogin"))).toBe(true);
    expectNoValues(await readLog());
  }, 30_000);

  test("C: a 500 from today logs kind=error without values", async () => {
    lms.mode = "todayError";
    const added = await checkNow();
    expect(added.some((line) => line.includes("poll kind=error"))).toBe(true);
    expectNoValues(await readLog());
    expect(lms.hits.every((hit) => hit.method === "GET")).toBe(true);
  }, 30_000);
});

test("login loss reaches the bubble and attendance replaces the only app window", async () => {
  lms.mode = "ok";
  const dataDir = join(temporary, "user-data-attendance");
  const root = join(temporary, "plugins");
  const target = await launchJungle(dataDir, root, lms.port, ["jungle.check-now", "jungle.open-attendance"]);
  const localLog = (): Promise<string> => readFile(logPathOf(dataDir), "utf8").catch(() => "");
  const localPoll = async (id = "jungle.check-now"): Promise<string[]> => {
    const before = pollLines(await localLog()).length;
    await action(target, dataDir, id);
    await vi.waitFor(async () => expect(pollLines(await localLog()).length).toBeGreaterThan(before),
      { timeout: 15_000, interval: 100 });
    return pollLines(await localLog()).slice(before);
  };
  const state = (): Promise<JungleState> => target.request({ cmd: "state" }) as Promise<JungleState>;
  const windows = (): Promise<CheckerSnapshot> => target.request({ cmd: "checkerWindowsForTest" }) as Promise<CheckerSnapshot>;
  const dismissBubble = async (): Promise<void> => {
    if ((await state()).bubble.visible) await target.request({ cmd: "bubbleDismiss" });
    await target.request({ cmd: "clock", advanceMs: 5_000 });
  };
  try {
    await vi.waitFor(async () => expect(await target.request({ cmd: "checkerExecuteForTest", pluginId: "jungle",
      windowId: "lms-checker", code: "document.cookie" })).toContain(`SESSION=${FAKE.cookie}`),
    { timeout: 30_000, interval: 100 });
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    await target.request({ cmd: "clock", pause: true });
    for (let index = 0; index < 3; index += 1) await dismissBubble();
    expect((await state()).bubble.visible).toBe(false);

    const okText = /^(학습 중이에요\. 종료는 23시부터 누를 수 있어요\(.+ 뒤\)|학습 종료를 누를 수 있어요\. 04시까지 .+ 남았어요)$/;
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    await vi.waitFor(async () => expect((await state()).bubble.text).toMatch(okText), { timeout: 10_000, interval: 50 });
    await dismissBubble();
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    await vi.waitFor(async () => expect((await state()).bubble.text).toMatch(okText), { timeout: 10_000, interval: 50 });
    await dismissBubble();

    lms.mode = "unauthorized";
    expect((await localPoll()).some((line) => line.includes("kind=needsLogin"))).toBe(true);
    await vi.waitFor(async () => {
      expect((await state()).bubble).toMatchObject({ visible: true, text: "LMS 로그인이 풀렸어" });
    }, { timeout: 10_000, interval: 50 });
    expect((await state()).bubble.renderer.buttons.map((button) => button.label)).toEqual(["로그인"]);
    await dismissBubble();
    await localPoll();
    await vi.waitFor(async () => expect((await state()).bubble).toMatchObject({
      visible: true, text: "LMS 로그인이 풀렸어",
    }), { timeout: 10_000, interval: 50 });
    expect((await state()).bubble.renderer.buttons.map((button) => button.label)).toEqual(["로그인"]);
    await dismissBubble();

    lms.mode = "ok";
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    await vi.waitFor(async () => expect((await state()).bubble.text)
      .toBe("로그인 확인했어요. 이제 출석을 지켜볼게요"), { timeout: 10_000, interval: 50 });

    const before = lms.hits.filter((hit) => hit.path === "/check-in").length;
    await action(target, dataDir, "jungle.open-attendance");
    await vi.waitFor(() => expect(lms.hits.filter((hit) => hit.path === "/check-in").length)
      .toBe(before + 1), { timeout: 10_000, interval: 50 });
    expect(lms.hits.filter((hit) => hit.path === "/check-in").at(-1)?.cookie).toContain(`SESSION=${FAKE.cookie}`);
    await vi.waitFor(async () => expect((await windows()).windows.find((window) => window.id === "lms-checker")?.url)
      .toBe("https://jungle-lms.krafton.com/check-in"), { timeout: 10_000, interval: 50 });
    const first = await windows();
    expect(first.externalOpens).toBe(0);
    expect(first.windows).toHaveLength(1);
    expect(first.windows[0]).toMatchObject({
      pluginId: "jungle", url: "https://jungle-lms.krafton.com/check-in", visible: true,
      partition: "persist:deskpet-plugin-jungle",
    });
    await target.request({ cmd: "checkerCloseForTest", pluginId: "jungle", windowId: "lms-checker" });
    expect((await windows()).windows.find((window) => window.id === "lms-checker")?.visible).toBe(false);
    await action(target, dataDir, "jungle.open-attendance");
    expect((await windows()).windows).toHaveLength(1);
    expect((await windows()).windows.find((window) => window.id === "lms-checker")?.visible).toBe(true);
    await vi.waitFor(() => expect(lms.hits.filter((hit) => hit.path === "/check-in")).toHaveLength(before + 2),
      { timeout: 10_000, interval: 50 });
    expect((await windows()).externalOpens).toBe(0);
    expectNoValues(await localLog());
  } finally { await target.dispose(); }
}, 90_000);

test("login action replaces the checker and automatically reports recovery once", async () => {
  lms.mode = "ok";
  const dataDir = join(temporary, "user-data-relogin");
  const root = join(temporary, "plugins");
  const target = await launchJungle(dataDir, root, lms.port,
    ["jungle.check-now", "jungle.show-login", "jungle.open-attendance"]);
  const localLog = (): Promise<string> => readFile(logPathOf(dataDir), "utf8").catch(() => "");
  const localPoll = async (): Promise<string[]> => {
    const before = pollLines(await localLog()).length;
    await action(target, dataDir, "jungle.check-now");
    await vi.waitFor(async () => expect(pollLines(await localLog()).length).toBeGreaterThan(before),
      { timeout: 15_000, interval: 100 });
    return pollLines(await localLog()).slice(before);
  };
  const state = (): Promise<JungleState> => target.request({ cmd: "state" }) as Promise<JungleState>;
  const windows = (): Promise<CheckerSnapshot> => target.request({ cmd: "checkerWindowsForTest" }) as Promise<CheckerSnapshot>;
  try {
    await vi.waitFor(async () => expect((await windows()).windows.find((window) => window.id === "lms-checker")?.url)
      .toBe("https://jungle-lms.krafton.com/check-in"), { timeout: 30_000, interval: 100 });
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    await target.request({ cmd: "clock", pause: true });
    for (let index = 0; index < 3; index += 1) {
      if ((await state()).bubble.visible) await target.request({ cmd: "bubbleDismiss" });
      await target.request({ cmd: "clock", advanceMs: 5_000 });
    }
    expect((await state()).bubble.visible).toBe(false);

    lms.expireSession();
    expect((await localPoll()).some((line) => line.includes("kind=needsLogin"))).toBe(true);
    await vi.waitFor(async () => expect((await state()).bubble)
      .toMatchObject({ visible: true, text: "LMS 로그인이 풀렸어" }), { timeout: 10_000, interval: 50 });
    expect((await state()).bubble.renderer.buttons.map((button) => button.label)).toEqual(["로그인"]);
    expect((await windows()).windows.find((window) => window.id === "lms-checker")?.url)
      .toBe("https://jungle-lms.krafton.com/check-in");

    await action(target, dataDir, "jungle.show-login");
    await vi.waitFor(async () => expect((await windows()).windows.find((window) => window.id === "lms-checker"))
      .toMatchObject({ visible: true, url: "https://jungle-lms.krafton.com/login" }),
    { timeout: 10_000, interval: 50 });
    expect((await windows()).windows).toHaveLength(1);
    await target.request({ cmd: "bubbleDismiss" });
    await target.request({ cmd: "clock", advanceMs: 5_000 });
    expect((await state()).bubble.visible).toBe(false);
    expect(await target.request({ cmd: "checkerExecuteForTest", pluginId: "jungle", windowId: "lms-checker",
      code: "fetch('/login/complete', { credentials: 'include' }).then(response => response.status)" })).toBe(200);
    await vi.waitFor(async () => {
      expect(pollLines(await localLog()).at(-1)).toContain("kind=ok");
      expect((await state()).bubble.text).toBe("로그인 확인했어요. 이제 출석을 지켜볼게요");
    }, { timeout: 20_000, interval: 100 });
    await target.request({ cmd: "bubbleDismiss" });
    await target.request({ cmd: "clock", advanceMs: 5_000 });
    expect((await localPoll()).some((line) => line.includes("kind=ok"))).toBe(true);
    expect((await state()).bubble.text).not.toBe("로그인 확인했어요. 이제 출석을 지켜볼게요");
    const before = lms.hits.filter((hit) => hit.path === "/check-in").length;
    await action(target, dataDir, "jungle.open-attendance");
    await vi.waitFor(() => expect(lms.hits.filter((hit) => hit.path === "/check-in").length)
      .toBeGreaterThan(before), { timeout: 10_000, interval: 50 });
    // The server sees the request before the navigation commits, and getURL() is "" until then (about 1 in 3 runs).
    await vi.waitFor(async () => expect((await windows()).windows).toMatchObject([{
      id: "lms-checker", visible: true, url: "https://jungle-lms.krafton.com/check-in",
    }]), { timeout: 10_000, interval: 50 });
    expect((await windows()).windows).toHaveLength(1);
    expectNoValues(await localLog());
  } finally { await target.dispose(); }
}, 90_000);
