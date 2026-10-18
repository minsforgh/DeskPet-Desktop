import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Platform = { y: number; x1: number; x2: number; windowId: string | null; displayId: number };
type State = { terrain: { source: "test" | "powershell" | "off"; windows: number;
  platforms: Platform[]; ready: boolean; pid?: number };
  displays: Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }>;
  contentRect: { width: number; height: number } };

let tempDir: string;
// A cold Windows run with Electron download took 23.57 s during this task;
// 60 s covers that maximum and child cleanup without a timing-dependent assertion.
beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-terrain-e2e-")); });
afterAll(async () => { if (tempDir) await cleanupTemporaryPath(tempDir); }, 60000);

test("injected windows expose only unoccluded tops above minimum width", async () => {
  const userData = join(tempDir, "injected");
  const app = await DesktopApp.launch(userData);
  try {
    const state = await app.request({ cmd: "state" }) as State;
    expect(state.terrain).toMatchObject({ source: "test", windows: 0, ready: true });
    const display = state.displays.find((item) => item.workArea.width >= 550 &&
      item.workArea.height >= state.contentRect.height + 150);
    if (!display) throw new Error("A display with room for the terrain fixture is required");
    const area = display.workArea;
    const x = area.x + 20;
    const y = area.y + Math.ceil(state.contentRect.height) + 50;
    const windows = [
      { id: "991234567", x: x + 200, y: y - 20, w: 100, h: 80, platform: false },
      { id: "991234568", x, y, w: 500, h: 100, platform: true },
      { id: "991234569", x: x + 510, y, w: 30, h: 100, platform: true },
    ];
    await app.request({ cmd: "terrainSetForTest", windows });
    const terrain = (await app.request({ cmd: "state" }) as State).terrain;
    expect(terrain.windows).toBe(3);
    expect(terrain.platforms.filter((platform) => platform.windowId === "991234568"))
      .toEqual([
        { y, x1: x, x2: x + 200, windowId: "991234568", displayId: display.id },
        { y, x1: x + 300, x2: x + 500, windowId: "991234568", displayId: display.id },
      ]);
    expect(terrain.platforms.some((platform) => platform.windowId === "991234567" ||
      platform.windowId === "991234569")).toBe(false);
    expect(terrain.platforms.some((platform) => platform.windowId === null)).toBe(true);
    const log = await readFile(join(userData, "logs", "deskpet.log"), "utf8");
    expect(log).not.toContain("991234567");
    expect(log).not.toContain("991234568");
    expect(log).not.toContain(`"x":${x}`);
    expect(log).not.toContain(".exe");
    await app.request({ cmd: "terrainOffForTest" });
    expect((await app.request({ cmd: "state" }) as State).terrain.source).toBe("off");
  } finally { await app.dispose(); }
}, 60000);

test("real PowerShell terrain initializes and exits with the app", async () => {
  const userData = join(tempDir, "powershell");
  const app = await DesktopApp.launch(userData, ["--terrain-source=powershell"]);
  let pid: number | undefined;
  try {
    const state = await app.request({ cmd: "state" }) as State;
    expect(state.terrain.source).toBe("powershell");
    expect(state.terrain.ready).toBe(true);
    expect(state.terrain.platforms.some((platform) => platform.windowId === null)).toBe(true);
    pid = state.terrain.pid;
    expect(pid).toBeGreaterThan(0);
    const log = await readFile(join(userData, "logs", "deskpet.log"), "utf8");
    expect(log).toContain("Terrain watcher started");
    expect(log).not.toMatch(/"(?:id|x|y|w|h)"\s*:/);
  } finally { await app.dispose(); }
  if (pid !== undefined) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    expect(alive).toBe(false);
  }
}, 60000);

test("real PowerShell terrain stops during full screen and restarts when it ends", async () => {
  const app = await DesktopApp.launch(join(tempDir, "powershell-fullscreen"), ["--terrain-source=powershell"]);
  try {
    await app.request({ cmd: "setFullscreenForTest", fullscreen: true });
    expect((await app.request({ cmd: "state" }) as State).terrain).toMatchObject({ source: "off", ready: false });
    await app.request({ cmd: "setFullscreenForTest", fullscreen: false });
    await vi.waitFor(async () => {
      const state = await app.request({ cmd: "state" }) as State;
      expect(state.terrain).toMatchObject({ source: "powershell", ready: true });
      expect(state.terrain.pid).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 100 });
  } finally { await app.dispose(); }
}, 60000);
