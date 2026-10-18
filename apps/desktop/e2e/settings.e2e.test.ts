import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinPackName, builtinVariants, builtinVoice, renderedVoice } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";
import { renderVoiceParts } from "@deskpet/core";

type Element = { text: string; value: string | null; checked: boolean | null; disabled: boolean | null };
type State = {
  bubble: { visible: boolean; text: string | null } | null;
  doNotDisturb: { enabled: boolean };
  trayDoNotDisturbChecked: boolean | null;
  trayMenu: string[];
  settings: { open: boolean; ready: boolean; loading: boolean; title: string | null; visible: boolean } | null;
  windowCount: number;
  visible: boolean;
};

let tempDir: string;
let app: DesktopApp | undefined;
let launched = 0;

function running(): DesktopApp {
  if (!app) throw new Error("The app is not launched");
  return app;
}

const stateOf = (): Promise<State> => running().request({ cmd: "state" }) as Promise<State>;
const query = (selector: string): Promise<Element[]> => running().request({ cmd: "settingsQuery", selector }) as Promise<Element[]>;
const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
const set = (selector: string, value: string | boolean): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
const texts = async (selector: string): Promise<string[]> => (await query(selector)).map((element) => element.text);
const values = async (selector: string): Promise<Array<string | null>> => (await query(selector)).map((element) => element.value);
const waitForText = (selector: string, expected: string): Promise<void> =>
  vi.waitFor(async () => { expect(await texts(selector)).toContain(expected); }, { timeout: 10_000, interval: 50 });
const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

async function launch(options: { plugins?: Record<string, { manifest?: Record<string, unknown>; source: string }>; settings?: unknown;
  args?: string[] } = {}): Promise<string> {
  launched += 1;
  const userData = join(tempDir, `user-data-${launched}`);
  await mkdir(userData, { recursive: true });
  if (options.settings !== undefined) await writeFile(join(userData, "settings.json"), JSON.stringify(options.settings), "utf8");
  const args = ["--event-port=0", ...(options.args ?? [])];
  if (options.plugins) {
    const root = join(tempDir, `plugins-${launched}`);
    for (const [id, plugin] of Object.entries(options.plugins)) {
      await mkdir(join(root, id), { recursive: true });
      await writeFile(join(root, id, "manifest.json"), JSON.stringify({ id, name: id, version: "0.0.0", apiVersion: "1", entry: "index.mjs",
        description: "e2e fixture", permissions: {}, contributes: {}, ...plugin.manifest }), "utf8");
      await writeFile(join(root, id, "index.mjs"), plugin.source, "utf8");
    }
    args.push(`--plugins-dir=${root}`);
  }
  app = await DesktopApp.launch(userData, args);
  return userData;
}

/** The tray's 설정… item, as the user presses it; the call returns once the window has drawn its first view. */
async function openSettings(): Promise<void> {
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  expect((await stateOf()).settings).toMatchObject({ open: true, ready: true, loading: false, title: "DeskPet 설정" });
}

const openPluginsTab = async (): Promise<void> => { await click("#tab-plugins"); };

test("Claude Code and Codex have separate plugin cards and enabled settings", async () => {
  const userData = await launch();
  await openSettings();
  await openPluginsTab();
  const claude = "[data-plugin-id='claude-code']";
  const codex = "[data-plugin-id='codex']";
  await waitForText(`${claude} .plugin-line`, "Claude Code: 실행 중");
  await waitForText(`${codex} .plugin-line`, "Codex: 실행 중");
  expect(await texts(`${claude} [data-field='enabled'] .field-title`)).toEqual(["Claude Code 알림 사용"]);
  expect(await texts(`${codex} [data-field='enabled'] .field-title`)).toEqual(["Codex 알림 사용"]);
  await set(`${codex} [data-field='enabled'] input`, false);
  await click(`${codex} .plugin-save`);
  await waitForText(`${codex} .plugin-status`, "저장했어요");
  expect((await readJson(join(userData, "settings.json"))).plugins).toEqual({ codex: { enabled: false } });
  expect(await query(`${claude} [data-field='enabled'] input`)).toMatchObject([{ checked: true }]);
}, 45_000);
const secretSource = (title: string): string => `export default {
  configSchema: { type: "object", required: ["label"], properties: {
    label: { type: "string", title: ${JSON.stringify(title)}, description: "<i>설명</i>" },
    token: { type: "string", title: "<b>토큰</b>", secret: true },
  } },
  activate() {},
};`;

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-settings-e2e-")); }, 30_000);
afterEach(async () => { if (app) await app.dispose(); }, 20_000);
afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
}, 45_000);

test("do-not-disturb saved in the window reaches settings.json and the tray checkbox; a bad time is a field error", async () => {
  const userData = await launch();
  await openSettings();
  expect(await query("#dnd-enabled")).toMatchObject([{ checked: false }]);
  await set("#dnd-enabled", true);
  await click("#dnd-add");
  await set(".dnd-row .dnd-start", "22:00");
  await set(".dnd-row .dnd-end", "07:00");
  await click("#general-save");
  await waitForText("#general-status", "저장했어요");
  expect((await readJson(join(userData, "settings.json"))).doNotDisturb).toEqual({ enabled: true, schedule: [{ start: "22:00", end: "07:00" }] });
  expect(await stateOf()).toMatchObject({ doNotDisturb: { enabled: true }, trayDoNotDisturbChecked: true });

  // The same state the tray toggle uses: toggling there is seen in the open window.
  await running().request({ cmd: "trayMenuClick", label: "방해 금지" });
  expect(await stateOf()).toMatchObject({ doNotDisturb: { enabled: false }, trayDoNotDisturbChecked: false });
  await vi.waitFor(async () => { expect(await query("#dnd-enabled")).toMatchObject([{ checked: false }]); }, { timeout: 5_000, interval: 50 });

  await set(".dnd-row .dnd-end", "7:00");
  await click("#general-save");
  await waitForText("#general-status", "저장하지 못했어요. 표시된 항목을 고치세요");
  expect(await texts(".dnd-row .field-error")).toEqual(["", "HH:MM 형식(예: 22:00)으로 입력하세요"]);
  expect(await running().request({ cmd: "settingsQuery", selector: ".dnd-row .dnd-end[aria-invalid='true']" })).toHaveLength(1);
  expect((await readJson(join(userData, "settings.json"))).doNotDisturb).toEqual({ enabled: false, schedule: [{ start: "22:00", end: "07:00" }] });

  // Removing the only row and saving clears the schedule.
  await click(".dnd-row .row-remove");
  await click("#general-save");
  await vi.waitFor(async () => {
    expect((await readJson(join(userData, "settings.json"))).doNotDisturb).toEqual({ enabled: false });
  }, { timeout: 5_000, interval: 50 });
}, 45_000);

test("a secret never comes back to the renderer and is stored only encrypted under the plugin's name", async () => {
  const secret = "SECRET-VALUE-12345";
  const userData = await launch({ args: ["--permission-answer=allow"], plugins: {
    vault: { manifest: { permissions: { secrets: true } }, source: secretSource("<u>라벨</u>") },
    plain: { source: secretSource("라벨") },
  } });
  await openSettings();
  await openPluginsTab();
  const vault = "[data-plugin-id='vault']";
  await waitForText(`${vault} .plugin-line`, "vault: 실행 중");
  // Titles and descriptions from a plugin are text, never markup.
  expect(await texts(`${vault} [data-field='label'] .field-title`)).toEqual(["<u>라벨</u>"]);
  expect(await query(`${vault} u, ${vault} b, ${vault} i`)).toEqual([]);
  expect(await texts(`${vault} [data-field='token'] .field-title`)).toEqual(["<b>토큰</b>"]);
  expect(await texts(`${vault} .secret-state`)).toEqual(["없음"]);
  // Without the secrets permission the password box is disabled.
  expect(await query("[data-plugin-id='plain'] input[type='password']")).toMatchObject([{ disabled: true }]);

  await set(`${vault} input[type='password']`, secret);
  await click(`${vault} .plugin-save`);
  await waitForText(`${vault} .plugin-status`, "저장하지 못했어요. 표시된 항목을 고치세요");
  expect(await texts(`${vault} [data-field='label'] .field-error`)).toEqual(["필수 항목입니다"]);
  await expect(readFile(join(userData, "plugin-secrets.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  await set(`${vault} [data-field='label'] input`, "내 계정");
  await click(`${vault} .plugin-save`);
  await waitForText(`${vault} .plugin-status`, "저장했어요");
  expect(await texts(`${vault} .secret-state`)).toEqual(["저장됨"]);
  expect(await query(`${vault} input[type='password']`)).toMatchObject([{ value: "" }]);
  const dump = JSON.stringify(await running().request({ cmd: "settingsDump" }));
  expect(dump).not.toContain(secret);
  const stored = await readFile(join(userData, "plugin-secrets.json"), "utf8");
  expect(stored).not.toContain(secret);
  expect(Object.keys((JSON.parse(stored) as { entries: Record<string, Record<string, string>> }).entries.vault ?? {})).toEqual(["token"]);
  const settings = await readFile(join(userData, "settings.json"), "utf8");
  expect(settings).not.toContain(secret);
  expect(JSON.parse(settings)).toMatchObject({ plugins: { vault: { label: "내 계정" } } });
  expect(JSON.parse(settings).plugins.vault).not.toHaveProperty("token");
  expect(running().diagnostics).not.toContain(secret);

  await click(`${vault} .secret-clear`);
  await waitForText(`${vault} .secret-state`, "없음");
  expect((JSON.parse(await readFile(join(userData, "plugin-secrets.json"), "utf8")) as { entries: Record<string, unknown> }).entries).toEqual({});
}, 45_000);

test("plugins that are denied show their status instead of a form", async () => {
  await launch({ args: ["--permission-answer=deny"], plugins: {
    vault: { manifest: { permissions: { secrets: true } }, source: secretSource("라벨") },
    broken: { manifest: { entry: "missing.mjs" }, source: "export default { activate() {} };" },
  } });
  await openSettings();
  await openPluginsTab();
  expect(await texts("[data-plugin-id='vault'] .plugin-line")).toEqual(["vault: 허용 안 함"]);
  expect(await texts("[data-plugin-id='vault'] .plugin-notice")).toEqual(["허용하지 않은 플러그인이라 설정할 수 없습니다"]);
  expect(await query("[data-plugin-id='vault'] form")).toEqual([]);
  expect(await query("[data-plugin-id='broken'] form")).toEqual([]);
}, 45_000);

const waitForClean = (selector: string): Promise<void> =>
  vi.waitFor(async () => { expect(await texts(selector)).toEqual([""]); }, { timeout: 5_000, interval: 50 });

test("a changed form flags unsaved changes until it is saved or reverted", async () => {
  await launch();
  await openSettings();
  // General: a change shows the note; putting the value back clears it without saving.
  expect(await texts("#general .dirty-note")).toEqual([""]);
  await set("#dnd-enabled", true);
  await waitForText("#general .dirty-note", "저장하지 않은 변경이 있어요");
  await set("#dnd-enabled", false);
  await waitForClean("#general .dirty-note");
  // Saving what the form holds clears the note too.
  await set("#dnd-enabled", true);
  await waitForText("#general .dirty-note", "저장하지 않은 변경이 있어요");
  await click("#general-save");
  await waitForText("#general-status", "저장했어요");
  await waitForClean("#general .dirty-note");

  await click("#tab-reminders");
  await click(".reminder-add");
  await waitForText(".reminder-title", "새 알림 · 아직 저장 안 됨");
  await click(".reminder-revert");
  expect(await query(".reminder-card")).toEqual([]);
}, 45_000);

test("closing asks when there are unsaved changes and closes at once otherwise", async () => {
  await launch();
  await openSettings();
  // A clean form closes immediately: no dialog answers itself here, so a wrongly shown dialog would leave the window open.
  await running().request({ cmd: "settingsClose" });
  await vi.waitFor(async () => { expect((await stateOf()).settings).toMatchObject({ open: false }); }, { timeout: 5_000, interval: 50 });

  // Dirty close, keeping the window: the form still works afterwards.
  await openSettings();
  await set("#dnd-enabled", true);
  await waitForText("#general .dirty-note", "저장하지 않은 변경이 있어요");
  await running().request({ cmd: "setSettingsCloseAnswerForTest", answer: "edit" });
  await running().request({ cmd: "settingsClose" });
  expect((await stateOf()).settings).toMatchObject({ open: true, dirty: true });
  await click("#general-save");
  await waitForText("#general-status", "저장했어요");
  await waitForClean("#general .dirty-note");

  // Dirty close again, this time confirming: the window closes and the change is discarded.
  await set("#dnd-enabled", false);
  await waitForText("#general .dirty-note", "저장하지 않은 변경이 있어요");
  await running().request({ cmd: "setSettingsCloseAnswerForTest", answer: "close" });
  await running().request({ cmd: "settingsClose" });
  await vi.waitFor(async () => { expect((await stateOf()).settings).toMatchObject({ open: false }); }, { timeout: 5_000, interval: 50 });
}, 45_000);

test("an unanswered close is reported by the e2e helper without showing a native dialog", async () => {
  const isolated = await DesktopApp.launch(join(tempDir, `user-data-unanswered-${++launched}`));
  try {
    await isolated.request({ cmd: "trayMenuClick", label: "설정…" });
    await isolated.request({ cmd: "settingsSet", selector: "#dnd-enabled", value: true });
    await vi.waitFor(async () => {
      expect((await isolated.request({ cmd: "state" }) as { settings: { dirty: boolean } }).settings.dirty).toBe(true);
    }, { timeout: 5_000, interval: 50 });
    await isolated.requestRaw({ cmd: "settingsClose" });
    await vi.waitFor(async () => {
      const response = await isolated.requestRaw({ cmd: "state" });
      expect(response.unexpectedDialog).toBe("settings close");
    }, { timeout: 5_000, interval: 50 });
    await expect(isolated.request({ cmd: "state" })).rejects.toThrow("Unexpected native dialog: settings close");
  } finally { await isolated.forceStop(); }
}, 30_000);

test("the settings window opens only once, closing it leaves the app running, and it can open again", async () => {
  await launch();
  const before = (await stateOf()).windowCount;
  await openSettings();
  expect((await stateOf()).windowCount).toBe(before + 1);
  await openSettings();
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  expect((await stateOf()).windowCount).toBe(before + 1);
  expect((await stateOf()).trayMenu).toContain("설정…");

  await running().request({ cmd: "settingsClose" });
  await vi.waitFor(async () => { expect((await stateOf()).settings).toMatchObject({ open: false }); }, { timeout: 5_000, interval: 50 });
  const closed = await stateOf();
  expect(closed.windowCount).toBe(before);
  expect(closed.visible).toBe(true);

  await openSettings();
  expect((await stateOf()).windowCount).toBe(before + 1);
  await running().quit();
}, 45_000);

test("the 어투 tab shows wolf-maid's templates, previews without sending, and sends only on the button", async () => {
  // wolf-maid's name and templates are the builtin pack's own data; expected values are read
  // from the pack file and rendered with renderVoice (M8 criterion 3).
  const name = await builtinPackName("wolf-maid");
  const templates = await builtinVoice("wolf-maid");
  const firstDone = builtinVariants(templates, "done")[0];
  if (firstDone === undefined) throw new Error("wolf-maid has no done variants");
  const firstVariant = templates.done?.[0];
  if (firstVariant === undefined) throw new Error("wolf-maid has no done variants");
  const retypedSample = renderedVoice(templates, "done", { task: "빌드", result: "테스트 통과" });
  const preview = (task: string): string => {
    const result = renderVoiceParts(templates, { kind: "done", slots: { task, result: "테스트 통과" } }, 0);
    if (!result) throw new Error("wolf-maid done preview is empty");
    return result.parts ? [result.parts.prefix, result.parts.content, result.parts.suffix].filter(Boolean).join("\n") : result.text;
  };
  await launch({ args: ["--character=wolf-maid"] });
  await openSettings();
  // Opening the window and visiting the tab says nothing to the pet.
  await click("#tab-character");
  await click("#character-tab-voice");
  await waitForText("#voice-character", `현재 캐릭터: ${name}`);
  expect(await texts(".voice-kind")).toHaveLength(7);
  // The editor shows each structured field in its own input.
  if (typeof firstVariant === "string")
    expect(await values(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-variant-input"))
      .toEqual([firstDone]);
  else {
    expect(await values(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-prefix"))
      .toEqual([firstVariant.prefix]);
    expect(await values(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-content"))
      .toEqual([firstVariant.content]);
    expect(await values(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-suffix"))
      .toEqual([firstVariant.suffix]);
  }
  expect(await texts("#voice-problems")).toEqual([]);
  expect((await stateOf()).bubble).toMatchObject({ visible: false, text: null });

  // The sample's slots render every variant as a preview below its row; retyping a slot rerenders it.
  const firstPreview = ".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-row-preview";
  await waitForText(firstPreview, preview("빌드 정리"));
  await set("#voice-editor-slot-task", "빌드");
  await waitForText(firstPreview, preview("빌드"));
  expect((await stateOf()).bubble).toMatchObject({ visible: false, text: null });

  // Only the row's send button says it to the pet.
  const send = ".voice-kind[data-kind='done'] .voice-variant[data-index='0'] button:last-of-type";
  expect(await texts(send)).toEqual(["▶ 펫에게 보내기"]);
  await click(send);
  await vi.waitFor(async () => { expect((await stateOf()).bubble).toMatchObject({ visible: true, text: retypedSample }); },
    { timeout: 10_000, interval: 50 });
}, 60_000);

test("the 어투 tab says a character without templates falls back to the default sentences", async () => {
  await launch({ args: ["--character=placeholder"] });
  await openSettings();
  await click("#tab-character");
  await click("#character-tab-voice");
  await waitForText("#voice-empty", "이 캐릭터는 어투 템플릿이 없어요. 알림은 보낸 쪽의 기본 문구로 나와요.");
  expect(await texts(".voice-none")).toHaveLength(7);
  await set("#voice-slot-task", "빌드");
  await click("#voice-preview");
  await waitForText("#voice-result", "템플릿이 없거나 슬롯이 비어 보낸 문구가 그대로 나가요");
}, 45_000);
