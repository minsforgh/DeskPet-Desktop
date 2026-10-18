import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Element = { text: string; value: string | null; checked: boolean | null; disabled: boolean | null };
type Rule = { id: string; time: string; days?: number[]; text: string };
let app: DesktopApp | undefined;
let userData: string;
const running = (): DesktopApp => { if (!app) throw new Error("App is not running"); return app; };
const query = (selector: string): Promise<Element[]> => running().request({ cmd: "settingsQuery", selector }) as Promise<Element[]>;
const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
const set = (selector: string, value: string | boolean): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
const rules = async (): Promise<Rule[]> => {
  const json = JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as { plugins: { reminders: { rules: Rule[] } } };
  return json.plugins.reminders.rules;
};

afterEach(async () => {
  if (app) await app.dispose();
  if (userData) await cleanupTemporaryPath(userData, app ? [app] : []);
  app = undefined;
});

test("the 알림 tab saves one card, previews, fires, keeps another draft, and confirms deletion", async () => {
  userData = await mkdtemp(join(tmpdir(), "deskpet-reminder-tab-"));
  app = await DesktopApp.launch(userData, ["--event-port=0", "--character=placeholder"]);
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  await click("#tab-plugins");
  expect((await query("[data-plugin-id='reminders'] .reminder-tab-link"))[0]?.text).toBe("규칙은 [알림] 탭에서 편집");
  await click("[data-plugin-id='reminders'] .reminder-tab-link");
  expect((await query("#tab-reminders"))[0]?.text).toBe("알림");
  await click(".reminder-add");
  const first = ".reminder-card:first-child";
  expect((await query(`${first} .reminder-title`))[0]?.text).toBe("새 알림 · 아직 저장 안 됨");
  expect((await query(`${first} .reminder-save`))[0]?.disabled).toBe(true);
  await set(`${first} .reminder-period`, "am");
  await set(`${first} .reminder-hour`, "9");
  await set(`${first} .reminder-minute`, "0");
  await set(`${first} .reminder-day input[value='3']`, true);
  await set(`${first} .reminder-text`, "스탠드업 시간이에요");
  await click(`${first} .reminder-save`);
  await vi.waitFor(async () => { expect(await rules()).toMatchObject([{ time: "09:00", days: [3], text: "스탠드업 시간이에요" }]); },
    { timeout: 5_000, interval: 50 });
  const saved = await rules();
  expect(saved[0]?.id).toMatch(/^r-[0-9a-z]+(?:-[0-9a-z]+)?$/u);
  expect((await query(`${first} .reminder-title`))[0]?.text).toBe("저장됨");

  await running().request({ cmd: "setReminderClockForTest", atMs: new Date(2026, 9, 7, 8, 59).getTime() });
  await running().request({ cmd: "advanceReminderClockForTest", advanceMs: 60_000 });
  expect((await running().request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } }).bubble)
    .toMatchObject({ visible: true, text: "스탠드업 시간이에요" });
  await click(".reminder-add");
  await set(`${first} .reminder-text`, "저장 안 한 문구");
  await set(".reminder-card:nth-child(2) .reminder-text", "수정된 스탠드업");
  expect((await query(".reminder-card:nth-child(2) .reminder-title"))[0]?.text).toBe("● 변경 있음");
  await click(".reminder-card:nth-child(2) .reminder-save");
  await vi.waitFor(async () => { expect((await rules())[0]?.text).toBe("수정된 스탠드업"); }, { timeout: 5_000, interval: 50 });
  expect(await rules()).toHaveLength(1);
  expect((await query(`${first} .reminder-text`))[0]?.value).toBe("저장 안 한 문구");
  await click(`${first} .reminder-revert`);
  expect(await query(".reminder-card")).toHaveLength(1);
  await click(".reminder-card .reminder-remove");
  expect((await query(".reminder-confirm"))[0]?.text).toContain("이 알림을 삭제할까요?");
  await click(".reminder-confirm-delete");
  await vi.waitFor(async () => { expect(await rules()).toEqual([]); }, { timeout: 5_000, interval: 50 });
  expect(await query(".reminder-card")).toHaveLength(0);
}, 60_000);

test("preview speaks the unsaved current text without creating a rule", async () => {
  userData = await mkdtemp(join(tmpdir(), "deskpet-reminder-preview-"));
  app = await DesktopApp.launch(userData, ["--event-port=0", "--character=placeholder"]);
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  await click("#tab-reminders");
  await click(".reminder-add");
  await set(".reminder-text", "저장 전 문구");
  await click(".reminder-preview");
  await vi.waitFor(async () => {
    expect((await running().request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } }).bubble)
      .toMatchObject({ visible: true, text: "(미리보기) 저장 전 문구" });
  }, { timeout: 5_000, interval: 50 });
  await expect(readFile(join(userData, "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("a malformed stored rule shows why it is skipped and can be deleted", async () => {
  userData = await mkdtemp(join(tmpdir(), "deskpet-reminder-invalid-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false },
    plugins: { reminders: { rules: [{ id: "bad", time: "9시", text: "문구" }] } } }), "utf8");
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  await running().request({ cmd: "trayMenuClick", label: "설정…" });
  await click("#tab-reminders");
  expect((await query(".reminder-title"))[0]?.text).toBe("저장됨");
  expect((await query(".reminder-next"))[0]?.text).toContain("형식이 맞지 않아 울리지 않아요");
  await click(".reminder-remove");
  await click(".reminder-confirm-delete");
  await vi.waitFor(async () => { expect(await rules()).toEqual([]); }, { timeout: 5_000, interval: 50 });
}, 30_000);
