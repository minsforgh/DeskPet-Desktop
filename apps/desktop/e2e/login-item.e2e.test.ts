import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

// ADR-0010 §6: the [일반] toggle reaches setLoginItemSettings. The app uses a recording stand-in here, so no registry value is written.
type Element = { text: string; value: string | null; checked: boolean | null; disabled: boolean | null };
let tempDir: string;
let app: DesktopApp;
let userData: string;

const query = (selector: string): Promise<Element[]> => app.request({ cmd: "settingsQuery", selector }) as Promise<Element[]>;
const calls = async (): Promise<unknown> => ((await app.request({ cmd: "loginItemCallsForTest" })) as { calls: unknown }).calls;
const savedSettings = async (): Promise<unknown> => JSON.parse(await readFile(join(userData, "settings.json"), "utf8"));

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "deskpet-login-item-e2e-"));
  userData = join(tempDir, "data");
  app = await DesktopApp.launch(userData);
}, 60_000);

afterAll(async () => {
  try { await app?.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

test("the 일반 tab toggle calls setLoginItemSettings with the fixed name and records the choice", async () => {
  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => { expect(await query("#launch-at-login")).toHaveLength(1); }, { timeout: 10_000, interval: 50 });
  expect((await query("#launch-at-login"))[0]?.checked).toBe(false);
  expect(await calls()).toEqual([]);

  await app.request({ cmd: "settingsSet", selector: "#launch-at-login", value: true });
  await vi.waitFor(async () => { expect(await calls()).toEqual([{ openAtLogin: true, name: "DeskPet" }]); }, { timeout: 10_000, interval: 50 });
  await vi.waitFor(async () => { expect(await savedSettings()).toMatchObject({ launchAtLogin: true }); }, { timeout: 10_000, interval: 50 });

  await app.request({ cmd: "settingsSet", selector: "#launch-at-login", value: false });
  await vi.waitFor(async () => {
    expect(await calls()).toEqual([{ openAtLogin: true, name: "DeskPet" }, { openAtLogin: false, name: "DeskPet" }]);
  }, { timeout: 10_000, interval: 50 });
  await vi.waitFor(async () => { expect(await savedSettings()).toMatchObject({ launchAtLogin: false }); }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsClose" });
}, 60_000);
