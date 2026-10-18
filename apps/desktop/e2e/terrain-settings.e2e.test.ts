import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Entry = { text: string; value: string | null; checked: boolean | null; disabled: boolean | null };
type State = { foot: Point; contentRect: Rect; displays: { id: number; workArea: Rect }[];
  movement: { state: string; platformWindowId: string | null };
  terrain: { source: string; windows: number; ready: boolean; enabled: boolean; excludedCount: number; sourceCreations: number } };
type SaveResult = { ok: boolean; message?: string; view?: { enabled: boolean; excludedApps: string[] } };

const children = new Set<DesktopApp>();
const temporaryPaths: string[] = [];
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { for (const path of temporaryPaths) await cleanupTemporaryPath(path, [...children]); }
});

async function launch(userData?: string): Promise<{ app: DesktopApp; userData: string }> {
  const directory = userData ? undefined : await mkdtemp(join(tmpdir(), "deskpet-terrain-settings-e2e-"));
  if (directory) temporaryPaths.push(directory);
  const dataDir = userData ?? join(directory ?? "", "userData");
  const app = await DesktopApp.launch(dataDir);
  children.add(app);
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "setState", state: "idle" });
  return { app, userData: dataDir };
}

async function stop(app: DesktopApp): Promise<void> {
  await app.quit();
  children.delete(app);
}

const state = (app: DesktopApp): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const advance = (app: DesktopApp, advanceMs: number): Promise<unknown> => app.request({ cmd: "clock", advanceMs });
const query = (app: DesktopApp, selector: string): Promise<Entry[]> => app.request({ cmd: "settingsQuery", selector }) as Promise<Entry[]>;
const click = (app: DesktopApp, selector: string): Promise<unknown> => app.request({ cmd: "settingsClick", selector });
const set = (app: DesktopApp, selector: string, value: string | boolean): Promise<unknown> =>
  app.request({ cmd: "settingsSet", selector, value });
const call = (app: DesktopApp, method: string, payload?: unknown): Promise<SaveResult> =>
  app.request({ cmd: "settingsPackCall", method, payload }) as Promise<SaveResult>;
const readSettings = async (userData: string) => JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as
  { terrain?: { enabled: boolean; excludedApps: string[] }; characterBehavior?: Record<string, Record<string, number>> };

async function moveFoot(app: DesktopApp, foot: Point): Promise<State> {
  const before = await state(app);
  await app.request({ cmd: "moveBy", dx: foot.x - before.foot.x, dy: foot.y - before.foot.y });
  return state(app);
}

async function fixture(app: DesktopApp) {
  const initial = await state(app);
  const display = [...initial.displays].sort((a, b) => a.workArea.x - b.workArea.x)
    .find(({ workArea }) => workArea.width > 600 && workArea.height > initial.contentRect.height + 260);
  if (!display) throw new Error("A display with space for movement is required");
  const area = display.workArea;
  const platform = { id: "991234701", x: area.x + 80, y: area.y + Math.round(area.height * 0.7), w: 320, h: 100, platform: true };
  return { area, platform };
}

async function openSettings(app: DesktopApp): Promise<void> {
  const current = await app.request({ cmd: "state" }) as { trayMenu: string[] };
  await app.request({ cmd: "trayMenuClick", label: current.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await app.request({ cmd: "state" }) as { settings: { ready: boolean; visible: boolean } }).settings)
      .toMatchObject({ ready: true, visible: true });
  }, { timeout: 10_000, interval: 50 });
}

async function openBehavior(app: DesktopApp): Promise<void> {
  await openSettings(app);
  await click(app, "#tab-character");
  await click(app, "#character-tab-behavior");
  await vi.waitFor(async () => { expect((await query(app, "#behavior-climbChance"))[0]?.value).toBeTruthy(); },
    { timeout: 10_000, interval: 50 });
}

const saved = (app: DesktopApp, status: string, text = "저장했어요"): Promise<void> =>
  vi.waitFor(async () => { expect((await query(app, status))[0]?.text).toBe(text); }, { timeout: 10_000, interval: 50 });

async function walkRight(app: DesktopApp, from: Point): Promise<void> {
  await moveFoot(app, from);
  await app.request({ cmd: "setState", state: "walk" });
  await app.request({ cmd: "setMovementDirection", direction: "right" });
  await advance(app, 100);
}

test("behavior tab saves climb 0% and descend 100%, applies without restart, persists and resets", async () => {
  const { app, userData } = await launch();
  let running = app;
  try {
    const { area, platform } = await fixture(app);
    await openBehavior(app);
    expect((await query(app, "#behavior-climbChance"))[0]?.value).toBe("40");
    expect((await query(app, "#behavior-descendChance"))[0]?.value).toBe("50");
    expect((await query(app, ".behavior-default")).map((entry) => entry.text).join("|")).toContain("팩 기본값: 40 %");
    expect((await query(app, "#behavior-terrain-group"))[0]?.text).toBe("화면 위 이동");
    for (const [key, value] of [["jumpMaxHeight", "150"], ["climbSpeed", "120"], ["jumpClearance", "24"], ["gravity", "2000"], ["gapJumpDistance", "200"], ["gapJumpChance", "50"]])
      expect((await query(app, `#behavior-${key}`))[0]?.value).toBe(value);
    const helps = (await query(app, ".behavior-help")).map((entry) => entry.text);
    expect(helps).toContain("창 끝에서 이 거리 안의 다음 창으로 점프해 건너감(0 이면 안 함)");
    expect(helps).toContain("건너갈 창이 있을 때 뛰어넘을지(아니면 내려가기 확률로)");
    await set(app, "#behavior-climbChance", "0");
    await set(app, "#behavior-descendChance", "100");
    await set(app, "#behavior-climbSpeed", "200");
    await set(app, "#behavior-gravity", "3000");
    await set(app, "#behavior-gapJumpDistance", "350");
    await set(app, "#behavior-gapJumpChance", "25");
    await click(app, "#behavior-save");
    await saved(app, "#behavior-status");
    expect((await readSettings(userData)).characterBehavior?.placeholder)
      .toMatchObject({ climbChance: 0, descendChance: 1, climbSpeed: 200, gravity: 3000, gapJumpDistance: 350, gapJumpChance: 0.25 });
    expect((await readSettings(userData)).characterBehavior?.placeholder).not.toHaveProperty("jumpMaxHeight");
    expect((await call(app, "behaviorSave", { packId: "placeholder", behavior: { gravity: 199 } })).ok).toBe(false);
    expect((await call(app, "behaviorSave", { packId: "placeholder", behavior: { jumpMaxHeight: 2001 } })).ok).toBe(false);
    expect((await call(app, "behaviorSave", { packId: "placeholder", behavior: { gapJumpDistance: 1001 } })).ok).toBe(false);
    expect((await call(app, "behaviorSave", { packId: "placeholder", behavior: { gapJumpChance: 1.1 } })).ok).toBe(false);

    // Cliff: always descends (no restart after saving). The drop to the floor is higher than the
    // jump threshold, so the pet climbs down the window side (ADR-0009 17, D-054).
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await walkRight(app, { x: platform.x + platform.w - 2, y: platform.y });
    expect(area.y + area.height - platform.y).toBeGreaterThan(150);
    expect((await state(app)).movement.state).toBe("climbing-down");
    // Climbing down runs at the saved climb speed (200 px/s), so wait for the whole drop plus landing.
    await advance(app, Math.ceil((area.y + area.height - platform.y) / 200 * 1_000) + 1_000);
    expect((await state(app)).foot.y).toBe(area.y + area.height);

    // Wall: never climbs, so the pet turns around on the platform.
    const wall = { ...platform, id: "991234702", x: platform.x + platform.w, y: platform.y - 60 };
    await app.request({ cmd: "terrainSetForTest", windows: [platform, wall] });
    await walkRight(app, { x: platform.x + platform.w - 2, y: platform.y });
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });

    // The values survive a restart and are used by the new process.
    await stop(app);
    const next = await launch(userData);
    running = next.app;
    await openBehavior(running);
    expect((await query(running, "#behavior-climbChance"))[0]?.value).toBe("0");
    expect((await query(running, "#behavior-descendChance"))[0]?.value).toBe("100");
    expect((await query(running, "#behavior-gapJumpDistance"))[0]?.value).toBe("350");
    expect((await query(running, "#behavior-gapJumpChance"))[0]?.value).toBe("25");
    const again = await fixture(running);
    await running.request({ cmd: "terrainSetForTest", windows: [again.platform] });
    await walkRight(running, { x: again.platform.x + again.platform.w - 2, y: again.platform.y });
    expect((await state(running)).movement.state).toBe("climbing-down");

    // Out-of-range values are refused by main; 12.5 % keeps its decimal.
    expect((await call(running, "behaviorSave", { packId: "placeholder", behavior: { climbChance: 1.5 } })).ok).toBe(false);
    expect((await call(running, "behaviorSave", { packId: "placeholder", behavior: { descendChance: -0.1 } })).ok).toBe(false);
    await set(running, "#behavior-climbChance", "12.5");
    await click(running, "#behavior-save");
    await saved(running, "#behavior-status");
    expect((await readSettings(userData)).characterBehavior?.placeholder?.climbChance).toBe(0.125);
    expect((await query(running, "#behavior-climbChance"))[0]?.value).toBe("12.5");

    // Back to the pack defaults.
    await click(running, "#behavior-reset");
    await saved(running, "#behavior-status");
    expect((await query(running, "#behavior-climbChance"))[0]?.value).toBe("40");
    expect((await query(running, "#behavior-descendChance"))[0]?.value).toBe("50");
    expect((await readSettings(userData)).characterBehavior?.placeholder).toBeUndefined();
  } finally { await running.dispose(); children.delete(running); }
}, 120000);

test("the general tab turns terrain movement off and on, and the pet follows without restart", async () => {
  const { app, userData } = await launch();
  try {
    const { area, platform } = await fixture(app);
    await openSettings(app);
    expect((await query(app, "#terrain-enabled"))[0]).toMatchObject({ checked: true, disabled: false });
    const info = (await query(app, "#terrain-info"))[0]?.text ?? "";
    expect(info).toContain("읽는 정보: 창의 위치·크기, 제외 목록이 있을 때 실행 파일 이름");
    expect(info).toContain("읽지 않는 정보: 창 제목·내용·경로");
    expect((await state(app)).terrain).toMatchObject({ source: "test", enabled: true });
    await app.request({ cmd: "terrainSetForTest", windows: [platform] });
    await moveFoot(app, { x: platform.x + 120, y: platform.y - 80 });
    await advance(app, 1_000);
    expect((await state(app)).movement).toMatchObject({ state: "grounded", platformWindowId: platform.id });

    await set(app, "#terrain-enabled", false);
    await click(app, "#terrain-save");
    await saved(app, "#terrain-status");
    expect((await readSettings(userData)).terrain).toEqual({ enabled: false, excludedApps: [] });
    expect((await state(app)).terrain).toMatchObject({ source: "off", enabled: false, windows: 0 });

    // M7 rule: a released pet stays where it is.
    const hanging = await moveFoot(app, { x: platform.x + 120, y: area.y + 120 });
    expect(hanging.movement.state).toBe("grounded");
    await advance(app, 1_500);
    expect((await state(app)).foot).toEqual(hanging.foot);

    await set(app, "#terrain-enabled", true);
    await click(app, "#terrain-save");
    await saved(app, "#terrain-status");
    expect((await state(app)).terrain).toMatchObject({ source: "test", enabled: true });
    expect((await readSettings(userData)).terrain?.enabled).toBe(true);
    await vi.waitFor(async () => { expect((await state(app)).movement.state).toBe("falling"); }, { timeout: 5_000, interval: 50 });
    await advance(app, 2_000);
    expect((await state(app)).foot.y).toBe(area.y + area.height);
  } finally { await app.dispose(); children.delete(app); }
}, 120000);

test("excluded apps rebuild the watcher with the new list, expose only a count, and main validates names", async () => {
  const { app, userData } = await launch();
  try {
    await openSettings(app);
    const before = (await state(app)).terrain;
    expect(before.excludedCount).toBe(0);

    await set(app, "#terrain-exclude-input", "Chrome.exe");
    await click(app, "#terrain-exclude-add");
    await set(app, "#terrain-exclude-input", "chrome.EXE");
    await click(app, "#terrain-exclude-add");
    expect((await query(app, "#terrain-status"))[0]?.text).toBe("이미 목록에 있어요");
    await set(app, "#terrain-exclude-input", "bad/name.exe");
    await click(app, "#terrain-exclude-add");
    expect((await query(app, "#terrain-status"))[0]?.text).toContain("영문·숫자");
    await set(app, "#terrain-exclude-input", "Code.exe");
    await click(app, "#terrain-exclude-add");
    expect((await query(app, ".terrain-excluded-name")).map((entry) => entry.text)).toEqual(["Chrome.exe", "Code.exe"]);
    expect((await query(app, ".terrain-excluded")).length).toBe(2);
    expect((await query(app, ".terrain-dirty-note")).some((entry) => entry.text === "저장하지 않은 변경이 있어요")).toBe(true);
    expect((await state(app)).terrain.excludedCount).toBe(0);

    await click(app, "#terrain-save");
    await saved(app, "#terrain-status");
    let terrain = (await state(app)).terrain;
    expect(terrain).toMatchObject({ excludedCount: 2, sourceCreations: before.sourceCreations + 1 });
    expect((await readSettings(userData)).terrain?.excludedApps).toEqual(["Chrome.exe", "Code.exe"]);
    // Names are not in the state the dev control returns, nor in the log.
    expect(JSON.stringify(await state(app)).toLowerCase()).not.toContain("chrome");
    expect(await readFile(join(userData, "logs", "deskpet.log"), "utf8")).not.toMatch(/chrome|code\.exe/i);

    // Saving with the same list does not rebuild the watcher.
    await click(app, "#terrain-save");
    await saved(app, "#terrain-status");
    expect((await state(app)).terrain.sourceCreations).toBe(terrain.sourceCreations);

    await click(app, ".terrain-excluded-remove");
    await click(app, "#terrain-save");
    await saved(app, "#terrain-status");
    terrain = (await state(app)).terrain;
    expect(terrain.excludedCount).toBe(1);
    expect((await readSettings(userData)).terrain?.excludedApps).toEqual(["Code.exe"]);

    // Main validates again, whatever the page allowed.
    const bad = [["a/b.exe"], ["한글.exe"], [""], ["x".repeat(65)], ["a\nb.exe"], [5], "Chrome.exe",
      Array.from({ length: 65 }, (_, index) => `app${index}.exe`)];
    for (const excludedApps of bad)
      expect((await call(app, "terrainSave", { enabled: true, excludedApps })).ok).toBe(false);
    for (const payload of [null, {}, { enabled: "yes", excludedApps: [] }, { enabled: true }, { excludedApps: [] }])
      expect((await call(app, "terrainSave", payload)).ok).toBe(false);
    expect((await state(app)).terrain).toMatchObject({ excludedCount: 1, sourceCreations: terrain.sourceCreations });
    expect((await readSettings(userData)).terrain?.excludedApps).toEqual(["Code.exe"]);

    const sixtyFour = Array.from({ length: 64 }, (_, index) => `app${index}.exe`);
    const accepted = await call(app, "terrainSave", { enabled: true, excludedApps: sixtyFour });
    expect(accepted.ok).toBe(true);
    expect((await state(app)).terrain.excludedCount).toBe(64);
    expect((await call(app, "terrainSave", { enabled: true, excludedApps: [...sixtyFour, "app64.exe"] })).ok).toBe(false);
    expect((await state(app)).terrain.excludedCount).toBe(64);

    // The window can load its own list back (the one place names are sent out).
    expect(await call(app, "terrainLoad")).toMatchObject({ enabled: true, excludedApps: sixtyFour });
  } finally { await app.dispose(); children.delete(app); }
}, 120000);
