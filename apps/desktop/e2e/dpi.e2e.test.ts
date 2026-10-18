import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Rectangle = { x: number; y: number; width: number; height: number };
type State = { bounds: Rectangle; contentBounds: Rectangle; foot: { x: number; y: number };
  expectedSize: { width: number; height: number };
  animationMovement: { direction: "left" | "right"; speedPxPerSecond: number } | null;
  displays: { id: number; bounds: Rectangle; workArea: Rectangle; scaleFactor: number }[];
  rendererMetrics: { canvas: { width: number; height: number; clientWidth: number; clientHeight: number }; devicePixelRatio: number } };

const children = new Set<DesktopApp>();
let temporary: string;
afterAll(async () => {
  try { for (const child of children) await child.dispose(); }
  finally { if (temporary) await cleanupTemporaryPath(temporary, [...children]); }
});

test("mixed-DPI display round trips keep the pet's logical size (requires two different scales)", async (context) => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-dpi-e2e-"));
  const app = await DesktopApp.launch(join(temporary, "userData"), ["--terrain-source=off"]);
  children.add(app);
  const initial = await app.request({ cmd: "state" }) as State;
  console.log("DPI DISPLAYS", JSON.stringify(initial.displays));
  const pair = initial.displays.filter((display) => display.scaleFactor !== initial.displays[0]?.scaleFactor);
  const first = initial.displays[0];
  const second = pair[0];
  if (!first || !second) {
    console.log("SKIP mixed-DPI display round trips: fewer than two displays with different scale factors");
    context.skip();
    return;
  }
  expect(initial.bounds).toMatchObject(initial.expectedSize);
  expect(initial.contentBounds).toMatchObject(initial.expectedSize);
  const measure = async (display: typeof first, index: number): Promise<State> => {
    const before = await app.request({ cmd: "state" }) as State;
    const target = { x: display.workArea.x + Math.floor(display.workArea.width / 2),
      y: display.workArea.y + Math.floor(display.workArea.height / 2) };
    await app.request({ cmd: "moveBy", dx: target.x - before.foot.x, dy: target.y - before.foot.y });
    const state = await app.request({ cmd: "state" }) as State;
    const screenshot = await app.request({ cmd: "screenshot", path: join(temporary, `hop-${index}.png`) }) as { width: number; height: number };
    const drawn = await app.request({ cmd: "state" }) as State;
    console.log("DPI HOP", index, JSON.stringify({ display: display.id, bounds: drawn.bounds,
      contentBounds: drawn.contentBounds, foot: drawn.foot, renderer: drawn.rendererMetrics,
      screenshot }));
    expect(state.bounds).toMatchObject(initial.expectedSize);
    expect(state.contentBounds).toMatchObject(initial.expectedSize);
    expect(drawn.foot).toEqual(target);
    expect(drawn.rendererMetrics.canvas.clientWidth).toBe(initial.expectedSize.width);
    expect(drawn.rendererMetrics.canvas.clientHeight).toBe(initial.expectedSize.height);
    expect(drawn.rendererMetrics.canvas.width).toBe(Math.round(initial.expectedSize.width * drawn.rendererMetrics.devicePixelRatio));
    expect(drawn.rendererMetrics.canvas.height).toBe(Math.round(initial.expectedSize.height * drawn.rendererMetrics.devicePixelRatio));
    expect(screenshot.width).toBe(drawn.rendererMetrics.canvas.width);
    expect(screenshot.height).toBe(drawn.rendererMetrics.canvas.height);
    return state;
  };
  for (let index = 0; index < 20; index += 1) await measure(index % 2 === 0 ? second : first, index + 1);
  const final = await app.request({ cmd: "state" }) as State;
  expect(final.bounds).toMatchObject(initial.expectedSize);
  const ordered = [first, second].sort((a, b) => a.workArea.x - b.workArea.x);
  const left = ordered[0];
  const right = ordered[1];
  if (left && right && left.workArea.x + left.workArea.width === right.workArea.x) {
    await app.request({ cmd: "clock", action: "pause" });
    await app.request({ cmd: "setState", state: "walk" });
    const walking = await app.request({ cmd: "state" }) as State;
    expect(walking.animationMovement).not.toBeNull();
    if (walking.animationMovement) {
      const direction = walking.animationMovement.direction;
      const source = direction === "right" ? left : right;
      const boundary = right.workArea.x;
      const targetFoot = { x: boundary + (direction === "right" ? -3 : 3),
        y: source.workArea.y + Math.floor(source.workArea.height / 2) };
      await app.request({ cmd: "moveBy", dx: targetFoot.x - walking.foot.x, dy: targetFoot.y - walking.foot.y });
      const beforeWalk = await app.request({ cmd: "state" }) as State;
      await app.request({ cmd: "clock", action: "advanceMs", advanceMs: 1000 });
      const afterWalk = await app.request({ cmd: "state" }) as State;
      console.log("DPI WALK", JSON.stringify({ before: beforeWalk.bounds, after: afterWalk.bounds,
        beforeFoot: beforeWalk.foot, afterFoot: afterWalk.foot, direction }));
      expect(afterWalk.foot.x).toBe(direction === "right" ? boundary + 4 : boundary - 4);
      expect(afterWalk.bounds).toMatchObject(initial.expectedSize);
      expect(afterWalk.contentBounds).toMatchObject(initial.expectedSize);
    }
  }
  await app.quit();
  children.delete(app);
}, 90000);
