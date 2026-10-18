import { createHash } from "node:crypto";
import { readdir, readFile, mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const builtins = resolve(import.meta.dirname, "../../../characters");
let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

async function hashPack(id: string): Promise<string> {
  const digest = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      digest.update(entry.name);
      if (entry.isDirectory()) await visit(path);
      else digest.update(await readFile(path));
    }
  }
  await visit(join(builtins, id));
  return digest.digest("hex");
}

async function openSettings(desktop: DesktopApp): Promise<void> {
  const state = await desktop.request({ cmd: "state" }) as { trayMenu: string[] };
  expect(state.trayMenu[3]).toBeTruthy();
  await desktop.request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await desktop.request({ cmd: "state" }) as { settings: { open: boolean; visible: boolean; ready: boolean } }).settings)
      .toMatchObject({ open: true, visible: true, ready: true });
  }, { timeout: 5_000, interval: 50 });
}

async function packCall(desktop: DesktopApp, method: string, payload?: unknown): Promise<unknown> {
  return desktop.request({ cmd: "settingsPackCall", method, payload });
}

async function sendInfo(desktop: DesktopApp, userData: string): Promise<number> {
  const auth = await desktop.eventServerAuth(userData);
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "e2e", type: "notify", text: "원래 문구", voice: { kind: "info", slots: { message: "테스트" } } }));
  });
}

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("settings preload persists selection, saves a derived voice, and deletes the current pack", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-character-packs-e2e-"));
  const userData = join(root, "data");
  const before = await hashPack("wolf-maid");
  const originalVoice = JSON.parse(await readFile(join(builtins, "wolf-maid", "voice.json"), "utf8")) as
    Record<string, unknown>;
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  await openSettings(app);
  expect(await packCall(app, "packsList")).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "wolf-maid", source: "builtin", valid: true, current: false }),
  ]));
  expect(await packCall(app, "packSelect", { packId: "wolf-maid" })).toEqual({ ok: true, packId: "wolf-maid" });
  expect((await app.request({ cmd: "state" }) as { character: { id: string; loaded: boolean } }).character)
    .toMatchObject({ id: "wolf-maid", loaded: true });
  await app.quit();
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  expect((await app.request({ cmd: "state" }) as { character: { id: string; loaded: boolean } }).character)
    .toMatchObject({ id: "wolf-maid", loaded: true });
  await openSettings(app);
  expect(await packCall(app, "packSaveVoice", { packId: "wolf-maid",
    voicePack: { version: 1, templates: { info: ["저장된 말투 {message}"] } } }))
    .toMatchObject({ ok: true, packId: "wolf-maid-mine", derived: true });
  expect((await app.request({ cmd: "state" }) as { character: { id: string } }).character.id).toBe("wolf-maid-mine");
  expect(await hashPack("wolf-maid")).toBe(before);
  expect(JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine", "voice.json"), "utf8")))
    .toEqual({ ...originalVoice, templates: { info: ["저장된 말투 {message}"] } });
  expect(await sendInfo(app, userData)).toBe(202);
  expect((await app.request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } }).bubble)
    .toMatchObject({ visible: true, text: "저장된 말투 테스트" });
  await app.request({ cmd: "setPackDeleteAnswerForTest", answer: true });
  expect(await packCall(app, "packDelete", { packId: "wolf-maid-mine" })).toEqual({ ok: true, deleted: true });
  expect((await app.request({ cmd: "state" }) as { character: { id: string; loaded: boolean } }).character)
    .toMatchObject({ id: "placeholder", loaded: true });
}, 90_000);
