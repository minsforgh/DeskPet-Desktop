import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Element = { text: string; value: string | null; disabled: boolean | null };
type AppState = { character: { id: string; state: string }; bubble: { visible: boolean; text: string | null } | null;
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
const set = (selector: string, value: string | boolean): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
const texts = async (selector: string): Promise<string[]> => (await query(selector)).map(({ text }) => text);
const waitForText = (selector: string, expected: string): Promise<void> =>
  vi.waitFor(async () => { expect(await texts(selector)).toContain(expected); }, { timeout: 10_000, interval: 50 });
const pressMenu = (label: string): Promise<unknown> => running().request({ cmd: "petMenuClickForTest", label });
const sequence = (id: string): string => `.sq-row[data-id='${id}']`;
const step = (id: string, number: number): string => `${sequence(id)} .sq-steps > .sq-step:nth-child(${number})`;

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "deskpet-sequence-editor-e2e-")); }, 30_000);
afterEach(async () => { if (app) { const finished = app; app = undefined; await finished.dispose(); } }, 20_000);
afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

const launch = async (userData: string, args: string[]): Promise<void> => {
  app = await DesktopApp.launch(userData, ["--event-port=0", ...args]);
  launched.push(app);
  await running().request({ cmd: "clock", pause: true });
};

test("a greeting made in the 동작 tab and linked to an interaction survives switching to wolf-maid-mine and a restart", async () => {
  const userData = join(root, "data");
  await launch(userData, ["--character=wolf-maid"]);
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => { expect((await state()).settings).toMatchObject({ open: true, visible: true, ready: true }); },
    { timeout: 10_000, interval: 50 });
  await click("#tab-character");
  await click("#character-tab-sequences");
  await vi.waitFor(async () => { expect(await query("#sq-add")).toHaveLength(1); }, { timeout: 10_000, interval: 50 });

  await click("#sq-add");
  await set(`${sequence("sequence-1")} .sq-id`, "greet");
  await set(`${sequence("greet")} .sq-label`, "인사");
  await set(`${step("greet", 1)} .sq-play`, "happy");
  await set(`${step("greet", 1)} .sq-sec`, "1");
  await set(`${step("greet", 1)} .sq-say`, "어서 오세요, 주인님.");
  await click(`${sequence("greet")} .sq-add-step`);
  await set(`${step("greet", 2)} .sq-play`, "talk");
  await set(`${step("greet", 2)} .sq-say`, "오늘도 잘 부탁드려요!");
  const petBeforePreview = (await state()).character.state;
  await click(`${sequence("greet")} .sq-preview`);
  await waitForText(`${sequence("greet")} .sq-preview-state`, "happy");
  await waitForText(`${sequence("greet")} .sq-preview-say`, "어서 오세요, 주인님.");
  await waitForText(`${sequence("greet")} .sq-preview-state`, "talk");
  await waitForText(`${sequence("greet")} .sq-preview-say`, "오늘도 잘 부탁드려요!");
  await waitForText(`${sequence("greet")} .sq-preview-state`, "끝남");
  expect((await state()).character.state).toBe(petBeforePreview);
  await waitForText("#sq-dirty", "저장하지 않은 변경이 있어요");
  expect((await state()).settings?.dirty).toBe(true);
  await click("#sq-save");
  await waitForText("#pack-status", "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요");
  await vi.waitFor(async () => { expect((await state()).character.id).toBe("wolf-maid-mine"); }, { timeout: 10_000, interval: 50 });
  expect((await state()).settings?.dirty).toBe(false);

  await click("#character-tab-interactions");
  await vi.waitFor(async () => { expect(await query(".ix-row")).toHaveLength(3); }, { timeout: 10_000, interval: 50 });
  await click("#ix-add");
  await set(".ix-row[data-id='custom-1'] .ix-label", "인사");
  expect(await texts(".ix-row[data-id='custom-1'] .ix-sequence option")).toEqual(["없음", "인사"]);
  await set(".ix-row[data-id='custom-1'] .ix-sequence", "greet");
  await click("#ix-save");
  await waitForText("#ix-status", "저장했어요");

  const packDir = join(userData, "characters", "wolf-maid-mine");
  expect(JSON.parse(await readFile(join(packDir, "sequences.json"), "utf8"))).toEqual({ version: 1, sequences: [{ id: "greet", label: "인사",
    steps: [{ play: "happy", ms: 1_000, say: "어서 오세요, 주인님." }, { play: "talk", say: "오늘도 잘 부탁드려요!" }] }] });
  expect(JSON.parse(await readFile(join(packDir, "interactions.json"), "utf8")))
    .toMatchObject({ items: [{ id: "pat" }, { id: "talk" }, { id: "scare" }, { id: "custom-1", label: "인사", sequence: "greet" }] });

  const playGreeting = async (): Promise<void> => {
    await pressMenu("인사");
    await vi.waitFor(async () => { expect(await state()).toMatchObject({ character: { state: "happy" },
      bubble: { visible: true, text: "어서 오세요, 주인님." } }); }, { timeout: 10_000, interval: 50 });
    await running().request({ cmd: "clock", advanceMs: 1_000 });
    expect(await state()).toMatchObject({ character: { state: "talk" }, bubble: { text: "오늘도 잘 부탁드려요!" } });
  };
  await playGreeting();

  const finished = running();
  app = undefined;
  await finished.dispose();
  await launch(userData, []);
  await vi.waitFor(async () => { expect((await state()).character.id).toBe("wolf-maid-mine"); }, { timeout: 10_000, interval: 50 });
  await playGreeting();
}, 120_000);
