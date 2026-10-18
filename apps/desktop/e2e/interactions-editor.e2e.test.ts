import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinInteraction } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";
import { getDefaultInteractions, type PetInteraction } from "../src/main/pet-menu.js";

type Element = { text: string; value: string | null; disabled: boolean | null };
type AppState = { character: { id: string; state: string; loaded: boolean }; trayMenu: string[];
  bubble: { visible: boolean; text: string | null } | null;
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
const menuLabels = async (): Promise<string[]> => ((await running().request({ cmd: "petMenuLabelsForTest" })) as { labels: string[] }).labels;
const pressMenu = (label: string): Promise<unknown> => running().request({ cmd: "petMenuClickForTest", label });
const row = (id: string): string => `.ix-row[data-id='${id}']`;

// The editor opens on placeholder (no interactions.json), so its rows are the shipped defaults
// from code; expected phrases are taken from there, never hardcoded (M8 criterion 3).
const defaults = getDefaultInteractions();
const defaultPat = defaults[0] as PetInteraction;
const defaultScare = defaults[2] as PetInteraction;
const patLabel = defaultPat.label;
const patLine = defaultPat.lines[0];
if (patLine === undefined) throw new Error("shipped default interactions have no lines");

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "deskpet-interactions-editor-e2e-")); }, 30_000);
afterEach(async () => { if (app) { const finished = app; app = undefined; await finished.dispose(); } }, 20_000);
afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

/** The tray's 설정… item, a paused clock, and the 상호작용 sub-tab showing the three shipped rows. */
const openInteractions = async (args: string[] = []): Promise<string> => {
  const userData = join(root, `data-${launched.length + 1}`);
  app = await DesktopApp.launch(userData, ["--event-port=0", ...args]);
  launched.push(app);
  await running().request({ cmd: "clock", pause: true });
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => { expect((await state()).settings).toMatchObject({ open: true, visible: true, ready: true }); },
    { timeout: 10_000, interval: 50 });
  await click("#tab-character");
  await click("#character-tab-interactions");
  await vi.waitFor(async () => { expect(await query(".ix-row")).toHaveLength(3); }, { timeout: 10_000, interval: 50 });
  return userData;
};

const saveInteractions = async (): Promise<void> => {
  await click("#ix-save");
  await waitForText("#ix-status", "저장했어요");
};

/** Saving a builtin pack derives the '(내 버전)' pack and switches the character to it. */
const waitForDerivedPack = async (id: string): Promise<void> => {
  await waitForText("#pack-status", "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요");
  await vi.waitFor(async () => { expect((await state()).character.id).toBe(id); }, { timeout: 10_000, interval: 50 });
};

test("editing pat's play to surprised saves it and right-click plays surprised", async () => {
  const userData = await openInteractions();
  await click(`${row("pat")} .ix-toggle`);
  expect((await texts(`${row("pat")} .ix-play-box`))[0]).toContain("재생 동작");
  expect((await texts(`${row("pat")} .ix-play option`))).toContain("surprised");
  await set(`${row("pat")} .ix-play`, "surprised");
  await saveInteractions();
  await waitForDerivedPack("placeholder-mine");
  const saved = JSON.parse(await readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8"));
  expect(saved.items[0]).toMatchObject({ id: "pat", play: "surprised" });
  await pressMenu(patLabel);
  await vi.waitFor(async () => {
    expect((await state()).character).toMatchObject({ state: "surprised" });
  }, { timeout: 10_000, interval: 50 });
}, 60_000);

test("editing the builtin pack's interactions derives a pack; the menu shows and speaks the edited and new lines", async () => {
  const userData = await openInteractions();
  expect((await state()).character.id).toBe("placeholder");
  await click(`${row("pat")} .ix-toggle`);
  await set(`${row("pat")} .ix-line`, "고친 쓰다듬기 대사");
  await click("#ix-add");
  await set(`${row("custom-1")} .ix-label`, "손 흔들기");
  await set(`${row("custom-1")} .ix-line`, "새 대사예요");
  await waitForText("#ix-dirty", "저장하지 않은 변경이 있어요");
  expect((await state()).settings?.dirty).toBe(true);
  await saveInteractions();
  await waitForDerivedPack("placeholder-mine");
  expect((await state()).settings?.dirty).toBe(false);
  expect(JSON.parse(await readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")))
    .toMatchObject({ items: [{ id: "pat", lines: ["고친 쓰다듬기 대사"] }, { id: "talk" }, { id: "scare" }, { id: "custom-1", label: "손 흔들기" }] });

  expect(await menuLabels()).toEqual(expect.arrayContaining([patLabel, "손 흔들기"]));
  await pressMenu(patLabel);
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: "고친 쓰다듬기 대사" }); },
    { timeout: 10_000, interval: 50 });
  await running().request({ cmd: "bubbleDismiss" });
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  await pressMenu("손 흔들기");
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: "새 대사예요" }); },
    { timeout: 10_000, interval: 50 });
}, 90_000);

test("a line written in the 상호작용 tab comes out as written, even for wolf-maid", async () => {
  const userData = await openInteractions(["--character=wolf-maid"]);
  await click(`${row("pat")} .ix-toggle`);
  await set(`${row("pat")} .ix-line`, "내가 쓴 대사");
  expect(await texts("#ix-dirty")).toEqual(["저장하지 않은 변경이 있어요"]);
  expect((await state()).settings).toMatchObject({ dirty: true });
  await saveInteractions();
  await waitForDerivedPack("wolf-maid-mine");
  expect((await state()).settings).toMatchObject({ dirty: false });
  expect(JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine", "interactions.json"), "utf8")))
    .toMatchObject({ items: [{ id: "pat", lines: ["내가 쓴 대사"] }, { id: "talk" }, { id: "scare" }] });
  // The derived pack keeps wolf-maid's own label for the row.
  const wolfPatLabel = (await builtinInteraction("wolf-maid", "pat")).label;
  await pressMenu(wolfPatLabel);
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: "내가 쓴 대사" }); },
    { timeout: 10_000, interval: 50 });
}, 60_000);

test("turning the bubble off leaves only the expression", async () => {
  await openInteractions();
  await set(`${row("scare")} .ix-speak`, false);
  await saveInteractions();
  await waitForDerivedPack("placeholder-mine");
  await pressMenu(defaultScare.label);
  await vi.waitFor(async () => {
    expect(await state()).toMatchObject({ character: { state: "surprised" }, bubble: { visible: false, text: null } });
  }, { timeout: 10_000, interval: 50 });
}, 60_000);

test("a new interaction appears in the menu, and its lines come round in turn", async () => {
  const userData = await openInteractions();
  await click("#ix-add");
  await set(`${row("custom-1")} .ix-label`, "손 흔들기");
  await set(`${row("custom-1")} .ix-line`, "하나");
  await click(`${row("custom-1")} .ix-add-line`);
  await set(`${row("custom-1")} .ix-line-row:nth-child(2) .ix-line`, "둘");
  await saveInteractions();
  await waitForDerivedPack("placeholder-mine");
  expect((await menuLabels()).slice(0, 5)).toEqual([...defaults.map(({ label }) => label), "손 흔들기", "-"]);
  expect(JSON.parse(await readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")))
    .toMatchObject({ items: [{ id: "pat" }, { id: "talk" }, { id: "scare" }, { id: "custom-1", label: "손 흔들기", lines: ["하나", "둘"] }] });
  await pressMenu("손 흔들기");
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: "하나" }); }, { timeout: 10_000, interval: 50 });
  await running().request({ cmd: "bubbleDismiss" });
  // Dismissal opens a 5 s inter-bubble gap on the paused delivery clock (BUBBLE_INTERVAL_MS, delivery.ts);
  // advancing exactly 5 s lets the second press show its bubble.
  await running().request({ cmd: "clock", advanceMs: 5_000 });
  // The runner also spaces presses of one interaction at least 500 ms apart on the real clock
  // (INTERACTION_MIN_INTERVAL_MS, pet-menu.ts), so keep pressing until the second press is taken.
  await vi.waitFor(async () => {
    const bubble = (await state()).bubble;
    if (bubble?.text !== "둘") await pressMenu("손 흔들기");
    expect(bubble).toMatchObject({ visible: true, text: "둘" });
  }, { timeout: 10_000, interval: 400 });
}, 60_000);

test("a shipped interaction can be hidden and brought back to its original line", async () => {
  const userData = await openInteractions();
  await click(`${row("pat")} .ix-toggle`);
  await set(`${row("pat")} .ix-line`, "바꾼 대사");
  await click(`${row("pat")} .ix-hide`);
  await saveInteractions();
  await waitForDerivedPack("placeholder-mine");
  expect(await menuLabels()).not.toContain(patLabel);
  expect(JSON.parse(await readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")))
    .toMatchObject({ hidden: ["pat"] });
  // The hidden item sits below the list with a 다시 보이기 button, as the user sees it.
  await vi.waitFor(async () => {
    expect((await texts(".ix-hidden-row[data-id='pat']"))[0]).toContain(patLabel);
  }, { timeout: 10_000, interval: 50 });
  expect(await texts(".ix-hidden-row[data-id='pat'] .ix-show")).toEqual(["다시 보이기"]);

  await click(".ix-hidden-row[data-id='pat'] .ix-show");
  await click(`${row("pat")} .ix-toggle`);
  expect(await query(`${row("pat")} .ix-line`)).toMatchObject([{ value: "바꾼 대사" }]);
  await click(`${row("pat")} .ix-reset`);
  expect(await query(`${row("pat")} .ix-line`)).toMatchObject([{ value: patLine }]);
  await saveInteractions();
  expect(await menuLabels()).toContain(patLabel);
  expect(JSON.parse(await readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")))
    .toMatchObject({ items: [{ id: "pat", lines: [patLine] }, { id: "talk" }, { id: "scare" }], hidden: [] });
  await pressMenu(patLabel);
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: patLine }); },
    { timeout: 10_000, interval: 50 });
}, 60_000);

test("a too-long line is a row error and nothing is saved; 펫에게 보내기 runs the row as it is", async () => {
  const userData = await openInteractions();
  await click(`${row("talk")} .ix-toggle`);
  await set(`${row("talk")} .ix-line`, "가".repeat(121));
  await click("#ix-save");
  await waitForText("#ix-status", "저장하지 못했어요. 표시된 항목을 고치세요");
  expect(await texts(`${row("talk")} .ix-error`)).toEqual(["대사는 120자 이하여야 해요"]);
  // The refused save derives no pack, so nothing was written.
  expect((await state()).character.id).toBe("placeholder");
  await expect(readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await set(`${row("talk")} .ix-line`, "눌러 본 대사");
  await click(`${row("talk")} .ix-try`);
  await vi.waitFor(async () => { expect((await state()).bubble).toMatchObject({ visible: true, text: "눌러 본 대사" }); },
    { timeout: 10_000, interval: 50 });
  await expect(readFile(join(userData, "characters", "placeholder-mine", "interactions.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);

test("leaving unsaved interactions asks before changing tabs or packs", async () => {
  await openInteractions();
  await set(`${row("pat")} .ix-line`, "저장 전 대사");
  await waitForText("#ix-dirty", "저장하지 않은 변경이 있어요");
  await running().request({ cmd: "setSettingsConfirmAnswerForTest", answer: false });
  await click("#character-tab-info");
  expect((await query("#ix-dirty"))[0]?.text).toBe("저장하지 않은 변경이 있어요");
  expect(await query("#character-tab-interactions[aria-selected='true']")).toHaveLength(1);
  await click(".pack-list-item[data-pack-id='wolf-maid']");
  expect(await query(".pack-list-item[data-pack-id='placeholder'][aria-selected='true']")).toHaveLength(1);
  await running().request({ cmd: "setSettingsConfirmAnswerForTest", answer: true });
  await click("#character-tab-info");
  expect(await query("#character-tab-info[aria-selected='true']")).toHaveLength(1);
  await vi.waitFor(async () => { expect((await query("#pack-meta-name"))[0]?.value).toBeTruthy(); },
    { timeout: 10_000, interval: 50 });
  expect((await state()).settings?.dirty).toBe(false);
}, 60_000);
