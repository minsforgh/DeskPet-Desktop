import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinPackName } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Element = { text: string; value: string | null; disabled: boolean | null };
type AppState = { character: { id: string; loaded: boolean }; trayMenu: string[];
  settings: { open: boolean; visible: boolean; ready: boolean; dirty: boolean } | null };
let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

function running(): DesktopApp {
  if (!app) throw new Error("The app is not running");
  return app;
}

const state = (): Promise<AppState> => running().request({ cmd: "state" }) as Promise<AppState>;
const query = (selector: string): Promise<Element[]> => running().request({ cmd: "settingsQuery", selector }) as Promise<Element[]>;
const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
const set = (selector: string, value: string): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
const texts = async (selector: string): Promise<string[]> => (await query(selector)).map(({ text }) => text);
const waitForText = (selector: string, expected: string): Promise<void> =>
  vi.waitFor(async () => { expect(await texts(selector)).toContain(expected); }, { timeout: 10_000, interval: 50 });

async function openSettings(): Promise<void> {
  const menu = (await state()).trayMenu;
  await running().request({ cmd: "trayMenuClick", label: menu[3] });
  await vi.waitFor(async () => { expect((await state()).settings).toMatchObject({ open: true, visible: true, ready: true }); },
    { timeout: 10_000, interval: 50 });
  await click("#tab-character");
}

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("character tab selects and persists a pack, derives edited metadata, then deletes the current pack", async () => {
  const builtinName = await builtinPackName("wolf-maid");
  root = await mkdtemp(join(tmpdir(), "deskpet-settings-character-e2e-"));
  const userData = join(root, "data");
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  await openSettings();
  expect(await texts("#tab-general, #tab-character, #tab-plugins")).toEqual(["일반", "캐릭터", "플러그인"]);
  await click(".pack-list-item[data-pack-id='wolf-maid']");
  expect(await texts("#pack-header h2")).toEqual([builtinName]);
  expect((await state()).character.id).toBe("placeholder");
  await click("#pack-use");
  await vi.waitFor(async () => { expect((await state()).character).toMatchObject({ id: "wolf-maid", loaded: true }); },
    { timeout: 10_000, interval: 50 });
  await waitForText(".pack-list-item[data-pack-id='wolf-maid'] .pack-current", " ●");
  expect((await query("#pack-use"))[0]?.disabled).toBe(true);

  await running().quit();
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  expect((await state()).character.id).toBe("wolf-maid");
  await openSettings();
  await click(".pack-list-item[data-pack-id='wolf-maid']");
  await click("#character-tab-info");
  await set("#pack-meta-name", "내 늑대 메이드 (내 버전)");
  await waitForText("#pack-meta-dirty", "저장하지 않은 변경이 있어요");
  expect((await state()).settings?.dirty).toBe(true);
  await click("#pack-meta-save");
  await waitForText("#pack-status", "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요");
  expect((await state()).settings?.dirty).toBe(false);
  expect(await texts(".pack-list-item[data-pack-id='wolf-maid-mine']")).toContain("내 늑대 메이드 (내 버전) ●내 팩");
  expect(await texts(".pack-list-item[data-pack-id='wolf-maid-mine'] .pack-current")).toEqual([" ●"]);
  expect((await state()).character.id).toBe("wolf-maid-mine");
  expect(JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine", "manifest.json"), "utf8")))
    .toMatchObject({ name: "내 늑대 메이드 (내 버전)", extends: "wolf-maid" });

  await running().request({ cmd: "setPackDeleteAnswerForTest", answer: true });
  await click("#pack-delete");
  await waitForText("#pack-status", "팩을 삭제했어요");
  expect(await query(".pack-list-item[data-pack-id='wolf-maid-mine']")).toEqual([]);
  expect(await texts(".pack-list-item[data-pack-id='placeholder'] .pack-current")).toEqual([" ●"]);
  expect((await state()).character.id).toBe("placeholder");
}, 90_000);
