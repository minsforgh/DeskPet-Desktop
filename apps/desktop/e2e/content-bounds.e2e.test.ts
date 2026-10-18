import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type State = { bounds: Rect; contentRect: Rect; workArea: Rect; foot: Point;
  animationMovement: { direction: "left" | "right"; speedPxPerSecond: number } | null;
  displays: { workArea: Rect }[] };

const children = new Set<DesktopApp>();
const temporaryPaths: string[] = [];
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { for (const path of temporaryPaths) await cleanupTemporaryPath(path, [...children]); }
});

test("visible content reaches all work area edges through moveBy and drag and restores its foot", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deskpet-content-e2e-"));
  temporaryPaths.push(temporary);
  const userData = join(temporary, "userData");
  let app = await DesktopApp.launch(userData, ["--terrain-source=off"]);
  children.add(app);
  await app.request({ cmd: "clock", action: "pause" });
  await app.request({ cmd: "setState", state: "idle" });
  const initial = await app.request({ cmd: "state" }) as State;
  expect(initial.contentRect.x + initial.contentRect.width).toBeCloseTo(initial.workArea.x + initial.workArea.width, 0);
  expect(initial.contentRect.y + initial.contentRect.height).toBeCloseTo(initial.workArea.y + initial.workArea.height, 0);

  for (const axis of ["left", "right", "top", "bottom"] as const) {
    const horizontal = axis === "left" || axis === "right";
    const sign = axis === "left" || axis === "top" ? -1 : 1;
    const target = [...initial.displays].sort((a, b) => horizontal
      ? sign * ((b.workArea.x + (sign > 0 ? b.workArea.width : 0)) - (a.workArea.x + (sign > 0 ? a.workArea.width : 0)))
      : sign * ((b.workArea.y + (sign > 0 ? b.workArea.height : 0)) - (a.workArea.y + (sign > 0 ? a.workArea.height : 0))))[0];
    if (!target) throw new Error("No display available");
    const current = await app.request({ cmd: "state" }) as State;
    const center = { x: target.workArea.x + Math.floor(target.workArea.width / 2),
      y: target.workArea.y + Math.floor(target.workArea.height / 2) };
    await app.request({ cmd: "moveBy", dx: center.x - current.foot.x, dy: center.y - current.foot.y });
    const delta = sign * 1_000_000;
    await app.request({ cmd: "moveBy", dx: horizontal ? delta : 0, dy: horizontal ? 0 : delta });
    const moved = await app.request({ cmd: "state" }) as State;
    const edge = (rect: Rect): number => axis === "left" ? rect.x : axis === "right" ? rect.x + rect.width
      : axis === "top" ? rect.y : rect.y + rect.height;
    expect(Math.abs(edge(moved.contentRect) - edge(moved.workArea))).toBeLessThanOrEqual(1);
    expect(edge(moved.bounds)).not.toBe(edge(moved.workArea));

    await app.request({ cmd: "moveBy", dx: horizontal ? -delta / 2 : 0, dy: horizontal ? 0 : -delta / 2 });
    const beforeDrag = await app.request({ cmd: "state" }) as State;
    const cursor = { x: beforeDrag.bounds.x + Math.floor(beforeDrag.bounds.width / 2),
      y: beforeDrag.bounds.y + Math.floor(beforeDrag.bounds.height / 2) };
    await app.request({ cmd: "dragStart", cursor });
    await app.request({ cmd: "dragMove", cursor: { x: cursor.x + (horizontal ? delta : 0), y: cursor.y + (horizontal ? 0 : delta) } });
    await app.request({ cmd: "dragEnd" });
    const dragged = await app.request({ cmd: "state" }) as State;
    expect(Math.abs(edge(dragged.contentRect) - edge(dragged.workArea))).toBeLessThanOrEqual(1);
    expect(edge(dragged.bounds)).not.toBe(edge(dragged.workArea));
  }

  const atEdge = await app.request({ cmd: "state" }) as State;
  await app.quit();
  children.delete(app);
  app = await DesktopApp.launch(userData, ["--terrain-source=off"]);
  children.add(app);
  const restored = await app.request({ cmd: "state" }) as State;
  expect(restored.foot).toEqual(atEdge.foot);
  expect(restored.contentRect).toEqual(atEdge.contentRect);
  const localRect = (value: State): Rect => ({ x: value.contentRect.x - value.bounds.x,
    y: value.contentRect.y - value.bounds.y, width: value.contentRect.width, height: value.contentRect.height });
  expect(localRect(restored)).toEqual({ x: 50, y: 156, width: 143, height: 155 });
  await app.request({ cmd: "setCharacter", character: "placeholder-alt" });
  const alternate = await app.request({ cmd: "state" }) as State;
  expect(localRect(alternate)).toEqual({ x: 50, y: 150, width: 143, height: 161 });
  expect(alternate.contentRect.x).toBeGreaterThanOrEqual(alternate.workArea.x);
  expect(alternate.contentRect.y).toBeGreaterThanOrEqual(alternate.workArea.y);
  expect(alternate.contentRect.x + alternate.contentRect.width).toBeLessThanOrEqual(alternate.workArea.x + alternate.workArea.width);
  expect(alternate.contentRect.y + alternate.contentRect.height).toBeLessThanOrEqual(alternate.workArea.y + alternate.workArea.height);
  await app.request({ cmd: "setCharacter", character: "missing-pack" });
  const fallback = await app.request({ cmd: "state" }) as State;
  expect(localRect(fallback)).toEqual({ x: 38, y: 117, width: 180, height: 180 });
  await app.quit();
  children.delete(app);
}, 60000);

test("walking turns around when visible content reaches an edge, while hit testing and capture still work", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deskpet-content-walk-e2e-"));
  temporaryPaths.push(temporary);
  const app = await DesktopApp.launch(join(temporary, "userData"), ["--terrain-source=off"]);
  children.add(app);
  await app.request({ cmd: "clock", action: "pause" });
  await app.request({ cmd: "setState", state: "walk" });
  const walking = await app.request({ cmd: "state" }) as State;
  if (!walking.animationMovement) throw new Error("Walk has no movement");
  const direction = walking.animationMovement.direction;
  await app.request({ cmd: "moveBy", dx: direction === "left" ? -1_000_000 : 1_000_000, dy: 0 });
  const edge = await app.request({ cmd: "state" }) as State;
  const boundary = direction === "left" ? edge.workArea.x : edge.workArea.x + edge.workArea.width;
  expect(Math.abs((direction === "left" ? edge.contentRect.x : edge.contentRect.x + edge.contentRect.width) - boundary)).toBeLessThanOrEqual(1);
  const hit = await app.request({ cmd: "hitTest", x: 128, y: 137 }) as { interactive: boolean };
  expect(hit.interactive).toBe(true);
  const transparent = await app.request({ cmd: "hitTest", x: 0, y: 0 }) as { interactive: boolean };
  expect(transparent.interactive).toBe(false);
  const capture = await app.request({ cmd: "screenshot", path: join(temporary, "edge.png") }) as { width: number; height: number };
  expect(capture.width).toBeGreaterThan(0);
  expect(capture.height).toBeGreaterThan(0);
  await app.request({ cmd: "clock", action: "advanceMs", advanceMs: 250 });
  const turned = await app.request({ cmd: "state" }) as State;
  expect(turned.bounds.x).toBe(edge.bounds.x);
  await app.request({ cmd: "clock", action: "advanceMs", advanceMs: 250 });
  const inward = await app.request({ cmd: "state" }) as State;
  expect(direction === "left" ? inward.bounds.x > edge.bounds.x : inward.bounds.x < edge.bounds.x).toBe(true);
  await app.quit();
  children.delete(app);
}, 30000);
