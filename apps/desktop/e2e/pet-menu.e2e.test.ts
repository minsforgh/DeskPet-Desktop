import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinInteraction } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";
import { getDefaultInteractions, type PetInteraction } from "../src/main/pet-menu.js";

let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];
let tempDir: string;

// placeholder has no interactions.json, so its menu phrases are the shipped defaults from code;
// wolf-maid's own phrases are read from the builtin pack file (M8 criterion 3).
const defaults = getDefaultInteractions();
const defaultLabels = defaults.map(({ label }) => label);
const defaultPat = defaults[0] as PetInteraction;
const defaultTalk = defaults[1] as PetInteraction;
const defaultScare = defaults[2] as PetInteraction;
const patLine = defaultPat.lines[0];
const talkLine = defaultTalk.lines[0];
if (patLine === undefined || talkLine === undefined) throw new Error("shipped default interactions have no lines");

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-pet-menu-e2e-")); }, 30000);
afterEach(async () => { if (app) await app.dispose(); app = undefined; }, 15000);
afterAll(async () => { if (tempDir) await cleanupTemporaryPath(tempDir, launched); });

async function launch(character: string, withPlugin = false, settings?: unknown): Promise<DesktopApp> {
  const name = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = join(tempDir, `${name}-plugins`);
  await mkdir(root, { recursive: true });
  const args = ["--event-port=0", `--character=${character}`, `--plugins-dir=${root}`];
  if (withPlugin) {
    await mkdir(join(root, "tray"), { recursive: true });
    await writeFile(join(root, "tray", "manifest.json"), JSON.stringify({
      id: "tray", name: "Tray", version: "0.0.0", apiVersion: "1", entry: "index.mjs", description: "e2e fixture", permissions: {},
      contributes: { actions: ["tray.hello"], trayItems: ["tray.item"] },
    }), "utf8");
    await writeFile(join(root, "tray", "index.mjs"),
      'export default { activate(ctx) { ctx.registerAction("tray.hello", () => {}); ctx.addTrayItem({ id: "tray.item", label: "플러그인 인사", action: "tray.hello" }); } };', "utf8");
  }
  const userData = join(tempDir, `${name}-user-data`);
  if (settings !== undefined) {
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, "settings.json"), JSON.stringify(settings), "utf8");
  }
  app = await DesktopApp.launch(userData, args);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  return app;
}

const labels = async (desktop: DesktopApp): Promise<string[]> =>
  ((await desktop.request({ cmd: "petMenuLabelsForTest" })) as { labels: string[] }).labels;
const bubbleText = async (desktop: DesktopApp): Promise<string | null> =>
  ((await desktop.request({ cmd: "state" })) as { bubble: { text: string | null } }).bubble.text;

test("the right-click menu offers interactions and system items, and a pat makes the pet react", async () => {
  const desktop = await launch("placeholder");
  expect(await labels(desktop)).toEqual([...defaultLabels, "-", "설정…", "방해 금지", "숨김", "오류 기록 폴더 열기", "종료"]);
  await desktop.request({ cmd: "petMenuClickForTest", label: defaultPat.label });
  await vi.waitFor(async () => { expect(await bubbleText(desktop)).toBe(patLine); }, { timeout: 10_000, interval: 50 });
  const events = ((await desktop.request({ cmd: "events" })) as { events: Array<{ event: { source: string; type?: string; key?: string; mood?: string; voice?: unknown } }> }).events;
  expect(events.some(({ event }) => event.source === "pet-menu" && event.key === "pet-menu.pat" && event.mood === "happy" && event.type === "notify" && event.voice === undefined)).toBe(true);
}, 60000);

test("an interaction pressed during the bubble gap speaks when the gap ends", async () => {
  const desktop = await launch("placeholder");
  await desktop.request({ cmd: "petMenuClickForTest", label: defaultPat.label });
  await vi.waitFor(async () => { expect(await bubbleText(desktop)).toBe(patLine); }, { timeout: 10_000, interval: 50 });
  await desktop.request({ cmd: "bubbleDismiss" });
  await desktop.request({ cmd: "clock", advanceMs: 500 });
  await desktop.request({ cmd: "petMenuClickForTest", label: defaultTalk.label });
  expect(await bubbleText(desktop)).toBeNull();
  await desktop.request({ cmd: "clock", advanceMs: 4_499 });
  expect(await bubbleText(desktop)).toBeNull();
  await desktop.request({ cmd: "clock", advanceMs: 1 });
  expect(await bubbleText(desktop)).toBe(talkLine);
}, 60_000);

test("a plugin's tray item is listed flat in the pet menu", async () => {
  const desktop = await launch("placeholder", true);
  await vi.waitFor(async () => { expect(await labels(desktop)).toContain("플러그인 인사"); }, { timeout: 10_000, interval: 50 });
  const menu = await labels(desktop);
  expect(menu.indexOf("플러그인 인사")).toBeGreaterThan(menu.indexOf(defaultScare.label));
  expect(menu.indexOf("플러그인 인사")).toBeLessThan(menu.indexOf("설정…"));
  expect(menu).toContain("Tray: 실행 중");
}, 60000);

test("with wolf-maid the pat is shown as written, without her tone", async () => {
  const desktop = await launch("wolf-maid");
  const pat = await builtinInteraction("wolf-maid", "pat");
  await desktop.request({ cmd: "petMenuClickForTest", label: pat.label });
  const patShown = pat.lines[0];
  if (patShown === undefined) throw new Error("wolf-maid pat has no line");
  await vi.waitFor(async () => { expect(await bubbleText(desktop)).toBe(patShown); }, { timeout: 10_000, interval: 50 });
}, 60000);

test("migrated settings decide the menu: hidden defaults are gone, added ones appear, and lines come round in turn", async () => {
  // The legacy settings list replaces the pack's interactions, so the remaining shipped rows
  // come from the code defaults, not from wolf-maid's file.
  const desktop = await launch("wolf-maid", false, { interactions: [
    { id: "pat", label: defaultPat.label, mood: "happy", speak: true, lines: [patLine], hidden: true },
    { id: "wave", label: "손 흔들기", mood: "happy", speak: true, lines: ["하나", "둘"] },
    { id: "bad id", label: "버려질 항목", mood: "happy", speak: true, lines: ["x"] },
  ] });
  expect(await labels(desktop)).toEqual([defaultTalk.label, defaultScare.label, "손 흔들기", "-", "설정…", "방해 금지", "숨김", "오류 기록 폴더 열기", "종료"]);
  await desktop.request({ cmd: "bubbleDismiss" });
  await desktop.request({ cmd: "clock", pause: true });
  await desktop.request({ cmd: "clock", advanceMs: 5_000 });
  await desktop.request({ cmd: "petMenuClickForTest", label: "손 흔들기" });
  await vi.waitFor(async () => { expect(await bubbleText(desktop)).toBe("하나"); }, { timeout: 10_000, interval: 50 });
}, 60000);
