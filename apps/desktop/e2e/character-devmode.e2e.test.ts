import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const repoCharacters = resolve(import.meta.dirname, "../../../characters");
let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

async function openSettings(desktop: DesktopApp): Promise<void> {
  const state = await desktop.request({ cmd: "state" }) as { trayMenu: string[] };
  await desktop.request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await desktop.request({ cmd: "state" }) as { settings: { open: boolean; visible: boolean; ready: boolean } }).settings)
      .toMatchObject({ open: true, visible: true, ready: true });
  }, { timeout: 5_000, interval: 50 });
}

const call = (desktop: DesktopApp, method: string, payload?: unknown): Promise<unknown> =>
  desktop.request({ cmd: "settingsPackCall", method, payload });

async function sendInfo(desktop: DesktopApp, userData: string): Promise<number> {
  const auth = await desktop.eventServerAuth(userData);
  return new Promise((resolveStatus, rejectStatus) => {
    const post = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    post.on("error", rejectStatus);
    post.end(JSON.stringify({ source: "e2e", type: "notify", text: "원래 문구", voice: { kind: "info", slots: { message: "테스트" } } }));
  });
}

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("developer mode edits a copied built-in pack in place; off derives; a pack without manifest shows a short message", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-devmode-e2e-"));
  const userData = join(root, "data");
  const characters = join(root, "characters");
  await mkdir(characters);
  for (const id of ["placeholder", "wolf-maid"]) await cp(join(repoCharacters, id), join(characters, id), { recursive: true });
  await mkdir(join(characters, "mochi"));
  await mkdir(userData);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false }, developerMode: true }));
  const args = ["--event-port=0", `--characters-dir=${characters}`];
  app = await DesktopApp.launch(userData, args);
  launched.push(app);
  await openSettings(app);

  const list = await call(app, "packsList") as Array<{ id: string; valid: boolean; error?: string; directEdit?: boolean }>;
  const mochi = list.find(({ id }) => id === "mochi");
  expect(mochi).toMatchObject({ valid: false, error: "manifest.json 이 없어요" });
  expect(mochi?.error).not.toMatch(/ENOENT|lstat/u);
  expect(list.find(({ id }) => id === "wolf-maid")?.directEdit).toBe(true);

  const originalVoice = JSON.parse(await readFile(join(characters, "wolf-maid", "voice.json"), "utf8")) as
    Record<string, unknown>;
  expect(await call(app, "packSelect", { packId: "wolf-maid" })).toEqual({ ok: true, packId: "wolf-maid" });
  expect(await call(app, "packSaveVoice", { packId: "wolf-maid",
    voicePack: { version: 1, templates: { info: ["직접 고친 말투 {message}"] } } }))
    .toMatchObject({ ok: true, packId: "wolf-maid", derived: false });
  expect(JSON.parse(await readFile(join(characters, "wolf-maid", "voice.json"), "utf8")))
    .toEqual({ ...originalVoice, templates: { info: ["직접 고친 말투 {message}"] } });
  expect((await call(app, "packsList") as Array<{ id: string }>).some(({ id }) => id.endsWith("-mine"))).toBe(false);
  expect(await sendInfo(app, userData)).toBe(202);
  expect((await app.request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } }).bubble)
    .toMatchObject({ visible: true, text: "직접 고친 말투 테스트" });

  expect(await call(app, "saveDeveloperMode", { enabled: false })).toEqual({ ok: true });
  const before = await readFile(join(characters, "wolf-maid", "voice.json"), "utf8");
  expect(await call(app, "packSaveVoice", { packId: "wolf-maid",
    voicePack: { version: 1, templates: { info: ["파생 말투 {message}"] } } }))
    .toMatchObject({ ok: true, packId: "wolf-maid-mine", derived: true });
  expect(await readFile(join(characters, "wolf-maid", "voice.json"), "utf8")).toBe(before);
  expect(JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine", "voice.json"), "utf8")))
    .toEqual({ ...originalVoice, templates: { info: ["파생 말투 {message}"] } });
}, 90_000);
