import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Area = Point & { width: number; height: number };
type State = { ready: boolean; character: { loaded: boolean }; bounds: Area; contentRect: Area; foot: Point;
  display: { id: number; scaleFactor: number; workArea: Area }; savedPosition: unknown };

const children = new Set<DesktopApp>();
let tempDir: string;

async function launch(userData: string): Promise<{ app: DesktopApp; state: State }> {
  const app = await DesktopApp.launch(userData, ["--terrain-source=off"], false);
  children.add(app);
  return { app, state: await app.request({ cmd: "state" }) as State };
}

async function quit(app: DesktopApp): Promise<void> {
  await app.quit({ cmd: "trayMenuClick", label: "종료" });
  children.delete(app);
}

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-position-e2e-")); });
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, [...children]); }
});

test("foot position survives a clean exit and restart with the same userData", async () => {
  const userData = join(tempDir, "restart");
  const first = await launch(userData);
  await first.app.request({ cmd: "moveBy", dx: -80, dy: -60 });
  const moved = await first.app.request({ cmd: "state" }) as State;
  await quit(first.app);
  const disk = JSON.parse(await readFile(join(userData, "pet-position.json"), "utf8")) as { foot: Point };
  expect(disk.foot).toEqual(moved.foot);
  const second = await launch(userData);
  expect(second.state.foot).toEqual(moved.foot);
  expect(second.state.savedPosition).toMatchObject({ foot: moved.foot });
  await quit(second.app);
}, 45000);

test("corrupt saved JSON falls back to the primary work area", async () => {
  const userData = join(tempDir, "corrupt");
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "pet-position.json"), "{broken", "utf8");
  const { app, state } = await launch(userData);
  expect(state.character.loaded).toBe(true);
  expect(state.savedPosition).toBeNull();
  expect(state.contentRect.x + state.contentRect.width).toBe(state.display.workArea.x + state.display.workArea.width);
  expect(state.contentRect.y + state.contentRect.height).toBe(state.display.workArea.y + state.display.workArea.height);
  await quit(app);
}, 30000);

test("offscreen saved foot is fitted inside the nearest work area", async () => {
  const userData = join(tempDir, "offscreen");
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "pet-position.json"), JSON.stringify({ foot: { x: 100000, y: 100000 },
    display: { id: 999, bounds: { x: 90000, y: 90000, width: 1000, height: 1000 } } }));
  const { app, state } = await launch(userData);
  const { bounds, workArea } = { bounds: state.contentRect, workArea: state.display.workArea };
  expect(state.character.loaded).toBe(true);
  expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
  expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  await quit(app);
}, 30000);
