import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";
import { getDefaultInteractions, type PetInteraction } from "../src/main/pet-menu.js";

// The default character (placeholder) has no interactions.json, so its menu phrases come from
// the shipped defaults in code; expected values are taken from there, never hardcoded.
const defaults = getDefaultInteractions();
const defaultPat = defaults[0] as PetInteraction;
const defaultTalk = defaults[1] as PetInteraction;
const patLine = defaultPat.lines[0];
const talkLine = defaultTalk.lines[0];
if (patLine === undefined || talkLine === undefined) throw new Error("shipped default interactions have no lines");

type State = {
  bubble: { visible: boolean; text: string | null; priority: string | null };
  queue: { pending: number };
  doNotDisturb: { enabled: boolean; fullscreen: boolean; scheduleTimer: boolean };
};

function send(port: number, token: string, text: string, priority = "normal", extra: Record<string, unknown> = {}): Promise<number> {
  const content = JSON.stringify({ source: "dnd-e2e", type: "notify", text, priority, ...extra });
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(content);
  });
}

function watcherCount(parentPid: number): number {
  const script = `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid} AND Name = 'powershell.exe'").Count`;
  return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }).trim());
}

test("tray do-not-disturb and fullscreen hold normal notices, pass urgent, and release one summary", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-dnd-e2e-"));
  const userDataDir = join(tempDir, "userData");
  let app: DesktopApp | undefined;
  try {
    app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
    const running = app;
    const pid = app.child.pid;
    if (pid === undefined) throw new Error("Electron process has no pid");
    const { port, token } = await app.eventServerAuth(userDataDir);
    const state = (): Promise<State> => running.request({ cmd: "state" }) as Promise<State>;
    const advance = (advanceMs: number): Promise<unknown> => running.request({ cmd: "clock", advanceMs });
    await app.request({ cmd: "clock", pause: true });
    expect((await state()).doNotDisturb.enabled).toBe(false);
    // DesktopApp.launch pins the fullscreen value to false so this holds even with a real
    // full-screen app running on the PC (2026-10-08).
    expect((await state()).doNotDisturb.fullscreen).toBe(false);
    expect(watcherCount(pid)).toBe(1);

    await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
    expect((await state()).doNotDisturb.enabled).toBe(true);
    expect(JSON.parse(await readFile(join(userDataDir, "settings.json"), "utf8"))).toEqual({ doNotDisturb: { enabled: true } });
    expect(await send(port, token, "보류 1")).toBe(202);
    expect(await send(port, token, "보류 2")).toBe(202);
    expect((await state()).bubble.visible).toBe(false);
    expect(await send(port, token, "급함", "urgent")).toBe(202);
    expect((await state()).bubble).toMatchObject({ visible: true, text: "급함", priority: "urgent" });
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
    expect((await state()).doNotDisturb.enabled).toBe(false);
    expect(JSON.parse(await readFile(join(userDataDir, "settings.json"), "utf8"))).toEqual({ doNotDisturb: { enabled: false } });
    expect((await state()).bubble.text).toContain("2개");
    expect((await state()).queue.pending).toBe(0);

    await advance(11_000);
    expect((await state()).bubble.visible).toBe(false);
    expect((await app.requestRaw({ cmd: "setFullscreenForTest", fullscreen: "yes" })).ok).toBe(false);
    await app.request({ cmd: "setFullscreenForTest", fullscreen: true });
    expect((await state()).doNotDisturb.fullscreen).toBe(true);
    expect(await send(port, token, "전체 화면 보류 1")).toBe(202);
    expect(await send(port, token, "전체 화면 보류 2")).toBe(202);
    expect((await state()).bubble.visible).toBe(false);
    expect(await send(port, token, "전체 화면 긴급", "urgent")).toBe(202);
    expect((await state()).bubble).toMatchObject({ visible: true, text: "전체 화면 긴급", priority: "urgent" });
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "setFullscreenForTest", fullscreen: false });
    expect((await state()).bubble.text).toContain("2개");
    expect((await state()).queue.pending).toBe(0);

    await app.quit();
    expect(watcherCount(pid)).toBe(0);
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(tempDir, app ? [app] : []);
  }
}, 30_000);

test("a directly pressed interaction shows during do-not-disturb and fullscreen while a forged external event stays held", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-dnd-direct-e2e-"));
  const userDataDir = join(tempDir, "userData");
  let app: DesktopApp | undefined;
  try {
    app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
    const running = app;
    const { port, token } = await app.eventServerAuth(userDataDir);
    const state = (): Promise<State> => running.request({ cmd: "state" }) as Promise<State>;
    const advance = (advanceMs: number): Promise<unknown> => running.request({ cmd: "clock", advanceMs });
    await app.request({ cmd: "clock", pause: true });

    // Do-not-disturb on. An external event carrying a forged "user direct" field is accepted
    // (the schema allows unknown fields) but still held: a JSON string key cannot forge the marker.
    await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
    expect((await state()).doNotDisturb.enabled).toBe(true);
    expect(await send(port, token, "위조 시도", "normal", { userDirect: true })).toBe(202);
    expect((await state()).bubble.visible).toBe(false);
    expect((await state()).queue.pending).toBe(1);

    // The user's own right-click press shows its line at once in the same state.
    await app.request({ cmd: "petMenuClickForTest", label: defaultPat.label });
    await vi.waitFor(async () => {
      expect((await state()).bubble).toMatchObject({ visible: true, text: patLine });
    }, { timeout: 10_000, interval: 50 });
    expect((await state()).queue.pending).toBe(1);
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "trayMenuClick", label: "방해 금지" });
    expect((await state()).bubble).toMatchObject({ visible: true, text: "위조 시도" });
    expect((await state()).queue.pending).toBe(0);

    // The fullscreen hold treats both the same way.
    await advance(11_000);
    expect((await state()).bubble.visible).toBe(false);
    await app.request({ cmd: "setFullscreenForTest", fullscreen: true });
    expect(await send(port, token, "전체 화면 위조", "normal", { userDirect: true })).toBe(202);
    expect((await state()).bubble.visible).toBe(false);
    expect((await state()).queue.pending).toBe(1);
    await app.request({ cmd: "petMenuClickForTest", label: defaultTalk.label });
    await vi.waitFor(async () => {
      expect((await state()).bubble).toMatchObject({ visible: true, text: talkLine });
    }, { timeout: 10_000, interval: 50 });
    await app.request({ cmd: "bubbleDismiss" });
    await app.request({ cmd: "setFullscreenForTest", fullscreen: false });
    expect((await state()).bubble).toMatchObject({ visible: true, text: "전체 화면 위조" });
    expect((await state()).queue.pending).toBe(0);

    await app.quit();
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(tempDir, app ? [app] : []);
  }
}, 30_000);
