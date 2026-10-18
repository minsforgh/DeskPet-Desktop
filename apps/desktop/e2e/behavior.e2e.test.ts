import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Entry = { text: string; value: string | null; disabled: boolean | null };
let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

function running(): DesktopApp {
  if (!app) throw new Error("The app is not running");
  return app;
}
const query = (selector: string): Promise<Entry[]> => running().request({ cmd: "settingsQuery", selector }) as Promise<Entry[]>;
const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
const set = (selector: string, value: string): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });

async function openBehavior(): Promise<void> {
  const state = await running().request({ cmd: "state" }) as { trayMenu: string[] };
  await running().request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await running().request({ cmd: "state" }) as { settings: { ready: boolean; visible: boolean } }).settings)
      .toMatchObject({ ready: true, visible: true });
  }, { timeout: 10_000, interval: 50 });
  await click("#tab-character");
  await click("#character-tab-behavior");
  await vi.waitFor(async () => { expect((await query("#behavior-sleepAfterMs"))[0]?.value).toBeTruthy(); },
    { timeout: 10_000, interval: 50 });
}

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("behavior tab saves walk speed and sleep time, applies them immediately, persists and restores defaults", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-behavior-e2e-"));
  const userData = join(root, "data");
  app = await DesktopApp.launch(userData, ["--terrain-source=off"]);
  launched.push(app);
  await running().request({ cmd: "clock", action: "pause" });
  await openBehavior();
  expect((await query("#character-tab-behavior"))[0]?.text).toBe("행동");
  expect((await query(".behavior-default"))[0]?.text).toContain("60 초");
  expect((await query("#behavior-sleepAfterMs"))[0]?.value).toBe("60");
  expect((await query("#behavior-climbChance"))[0]?.value).toBe("40");
  expect((await query(".behavior-help"))[0]?.text).toBe("앞을 막는 창을 오를지(아니면 돌아섬)");
  expect((await query("#behavior-descendChance"))[0]?.value).toBe("50");
  await set("#behavior-sleepAfterMs", "5");
  await set("#behavior-climbChance", "25");
  await set("#behavior-walkSpeedPxPerSecond", "42");
  expect((await query("#behavior-dirty"))[0]?.text).toBe("저장하지 않은 변경이 있어요");
  await click("#behavior-save");
  await vi.waitFor(async () => { expect((await query("#behavior-status"))[0]?.text).toBe("저장했어요"); },
    { timeout: 10_000, interval: 50 });
  expect((await query("#behavior-dirty"))[0]?.text).toBe("");
  const persisted = JSON.parse(await readFile(join(userData, "settings.json"), "utf8"));
  expect(persisted.characterBehavior.placeholder).toMatchObject({ sleepAfterMs: 5000, walkSpeedPxPerSecond: 42, climbChance: 0.25 });
  expect(persisted.characterBehavior.placeholder).not.toHaveProperty("descendChance");
  const position = await running().request({ cmd: "state" }) as {
    bounds: { x: number; width: number }; workArea: { x: number; width: number } };
  await running().request({ cmd: "moveBy", dx: Math.floor(position.workArea.x +
    (position.workArea.width - position.bounds.width) / 2) - position.bounds.x, dy: 0 });
  await running().request({ cmd: "setState", state: "walk" });
  const walkStart = await running().request({ cmd: "state" }) as { bounds: { x: number } };
  // tickAnimation caps each rendered movement step at 250 ms.
  for (let step = 0; step < 4; step += 1) await running().request({ cmd: "clock", advanceMs: 250 });
  const walkEnd = await running().request({ cmd: "state" }) as { bounds: { x: number } };
  expect(Math.abs(walkEnd.bounds.x - walkStart.bounds.x)).toBe(42);
  await running().request({ cmd: "setState", state: "idle" });
  const clock = await running().request({ cmd: "clock", advanceMs: 5_000 }) as { state: string };
  expect(clock.state).toBe("sleep");

  const rejected = await running().request({ cmd: "settingsPackCall", method: "behaviorSave",
    payload: { packId: "placeholder", behavior: { sleepAfterMs: 4999 } } }) as { ok: boolean };
  expect(rejected.ok).toBe(false);
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).characterBehavior.placeholder.sleepAfterMs).toBe(5000);

  await running().quit();
  app = await DesktopApp.launch(userData, ["--terrain-source=off"]);
  launched.push(app);
  await running().request({ cmd: "clock", action: "pause" });
  await openBehavior();
  expect((await query("#behavior-sleepAfterMs"))[0]?.value).toBe("5");
  expect((await query("#behavior-walkSpeedPxPerSecond"))[0]?.value).toBe("42");
  expect((await query("#behavior-climbChance"))[0]?.value).toBe("25");
  await set("#behavior-walkSpeedPxPerSecond", "43");
  await running().request({ cmd: "setSettingsConfirmAnswerForTest", answer: false });
  await click("#character-tab-info");
  expect((await running().request({ cmd: "settingsDump" }) as { html: string }).html)
    .toContain('id="character-tab-behavior" class="tab" aria-selected="true"');
  expect((await query("#behavior-walkSpeedPxPerSecond"))[0]?.value).toBe("43");
  await running().request({ cmd: "setSettingsConfirmAnswerForTest", answer: true });
  await click("#character-tab-info");
  await click("#character-tab-behavior");
  expect((await query("#behavior-walkSpeedPxPerSecond"))[0]?.value).toBe("42");
  await click("#behavior-reset");
  await vi.waitFor(async () => { expect((await query("#behavior-status"))[0]?.text).toBe("저장했어요"); },
    { timeout: 10_000, interval: 50 });
  expect((await query("#behavior-sleepAfterMs"))[0]?.value).toBe("60");
  expect((await query("#behavior-climbChance"))[0]?.value).toBe("40");
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).characterBehavior.placeholder).toBeUndefined();
}, 90_000);
