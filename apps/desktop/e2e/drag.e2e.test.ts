import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Area = Point & { width: number; height: number };
type State = { bounds: Area; contentRect: Area; workArea: Area; foot: Point; savedPosition: { foot: Point } | null; state: string };

let app: DesktopApp;
let temporary: string;

async function state(): Promise<State> { return app.request({ cmd: "state" }) as Promise<State>; }
async function dragMove(cursor: Point): Promise<State> {
  await app.request({ cmd: "dragMove", cursor });
  return state();
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-drag-e2e-"));
  app = await DesktopApp.launch(join(temporary, "user-data"), ["--terrain-source=off"]);
  await app.request({ cmd: "clock", action: "pause" });
  await app.request({ cmd: "setState", state: "idle" });
}, 30000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (temporary) await cleanupTemporaryPath(temporary, app ? [app] : []); }
});

test("dragging below the work area then to its top saves the foot and returns to idle", async () => {
  const initial = await state();
  const area = initial.workArea;
  const desired = { x: area.x + Math.floor((area.width - initial.bounds.width) / 2),
    y: area.y + Math.floor((area.height - initial.bounds.height) / 2) };
  await app.request({ cmd: "moveBy", dx: desired.x - initial.bounds.x, dy: desired.y - initial.bounds.y });
  const centered = await state();
  const cursor = { x: centered.bounds.x + Math.floor(centered.bounds.width / 2),
    y: centered.bounds.y + Math.floor(centered.bounds.height / 2) };
  expect((await app.request({ cmd: "dragStart", cursor }) as { state: string }).state).toBe("drag");
  const below = await dragMove({ x: cursor.x, y: area.y + area.height + 300 });
  expect(below.contentRect.y + below.contentRect.height).toBe(area.y + area.height);
  const top = await dragMove({ x: cursor.x, y: area.y });
  expect(top.contentRect.y).toBe(area.y);
  expect(top.state).toBe("drag");
  const ended = await app.request({ cmd: "dragEnd" }) as { state: string; foot: Point };
  expect(ended.state).toBe("idle");
  const saved = await state();
  expect(saved.savedPosition?.foot).toEqual(ended.foot);
  const disk = JSON.parse(await readFile(join(temporary, "user-data", "pet-position.json"), "utf8")) as { foot: Point };
  expect(disk.foot).toEqual(ended.foot);
}, 30000);

test("an offscreen overshoot and return cannot leave a strip above the pet", async () => {
  const initial = await state();
  const area = initial.workArea;
  const desiredY = area.y + Math.floor((area.height - initial.bounds.height) / 2);
  await app.request({ cmd: "moveBy", dx: 0, dy: desiredY - initial.bounds.y });
  const before = await state();
  const grab = Math.floor(before.bounds.height / 2);
  const cursor = { x: before.bounds.x + Math.floor(before.bounds.width / 2), y: before.bounds.y + grab };
  await app.request({ cmd: "dragStart", cursor });
  expect((await dragMove({ x: cursor.x, y: area.y - 300 })).contentRect.y).toBe(area.y);
  await dragMove({ x: cursor.x, y: desiredY });
  const returned = await dragMove({ x: cursor.x, y: area.y });
  expect(returned.contentRect.y).toBe(area.y);
  await app.request({ cmd: "dragEnd" });
}, 30000);
