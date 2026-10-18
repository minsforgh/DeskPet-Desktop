import { expect, test } from "vitest";
import { clampWindowForMovement, clampWindowToDisplay, contentOnScreen, displayForPoint, footFromWindow, footOffset, hasSize, parseSavedPosition, placeFoot,
  windowFromFoot, type DisplayArea } from "./position.js";

const primary: DisplayArea = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const left: DisplayArea = { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 0, width: 1280, height: 984 }, scaleFactor: 1.25 };
const above: DisplayArea = { id: 3, bounds: { x: 0, y: -900, width: 1600, height: 900 },
  workArea: { x: 0, y: -900, width: 1600, height: 860 }, scaleFactor: 1.5 };
const full = { x: 0, y: 0, width: 256, height: 256 };
const content = { x: 78, y: 85, width: 100, height: 155 };

test("logical window size ignores monitor scale and rejects either changed dimension", () => {
  const size = { width: 256, height: 256 };
  for (const display of [primary, left, above]) {
    const position = placeFoot({ x: display.workArea.x + 500, y: display.workArea.y + 500 },
      { x: 128, y: 224 }, full, [display]).window;
    expect(hasSize({ ...position, ...size }, size)).toBe(true);
  }
  expect(hasSize({ x: 0, y: 0, width: 320, height: 256 }, size)).toBe(false);
  expect(hasSize({ x: 0, y: 0, width: 256, height: 320 }, size)).toBe(false);
});

test("movement crosses adjacent displays without snapping by the window width", () => {
  const right: DisplayArea = { id: 4, bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1392 }, scaleFactor: 1.5 };
  expect(clampWindowForMovement({ x: 1870, y: 300 }, full, primary, [primary, right]))
    .toEqual({ x: 1870, y: 300 });
  expect(clampWindowForMovement({ x: 1930, y: 300 }, full, right, [primary, right]))
    .toEqual({ x: 1930, y: 300 });
  expect(clampWindowForMovement({ x: 9999, y: 300 }, full, right, [primary, right]).x).toBe(4224);
  const separated = { ...right, workArea: { ...right.workArea, x: 2000 } };
  expect(clampWindowForMovement({ x: 1870, y: 300 }, full, primary, [primary, separated]).x).toBe(1664);
});

test("one display clamps a window inside its work area", () => {
  expect(clampWindowToDisplay({ x: 9999, y: -200 }, full, primary))
    .toEqual({ x: 1664, y: 0 });
});

test("left and right displays include negative coordinates and different scales", () => {
  expect(displayForPoint({ x: -100, y: 500 }, [primary, left]).id).toBe(2);
  expect(placeFoot({ x: -200, y: 500 }, { x: 128, y: 224 }, full, [primary, left]))
    .toMatchObject({ display: { id: 2, scaleFactor: 1.25 }, window: { x: -328, y: 276 } });
  expect(displayForPoint({ x: 200, y: 500 }, [primary, left]).id).toBe(1);
});

test("stacked displays select above and below by work area", () => {
  expect(displayForPoint({ x: 800, y: -300 }, [primary, above]).id).toBe(3);
  expect(displayForPoint({ x: 800, y: 300 }, [primary, above]).id).toBe(1);
});

test("a removed display sends saved feet to the nearest remaining work area", () => {
  const placed = placeFoot({ x: -1000, y: 500 }, { x: 128, y: 224 }, full, [primary]);
  expect(placed.window).toEqual({ x: 0, y: 276 });
});

test("content reaches each edge while the window may extend past it", () => {
  const cases = [
    { candidate: { x: -1000, y: 300 }, expected: { x: -78, y: 300 }, edge: "left" },
    { candidate: { x: 10000, y: 300 }, expected: { x: 1742, y: 300 }, edge: "right" },
    { candidate: { x: 300, y: -1000 }, expected: { x: 300, y: -85 }, edge: "top" },
    { candidate: { x: 300, y: 10000 }, expected: { x: 300, y: 800 }, edge: "bottom" },
  ] as const;
  for (const { candidate, expected, edge } of cases) {
    const positioned = clampWindowToDisplay(candidate, content, primary);
    expect(positioned).toEqual(expected);
    const visible = contentOnScreen(positioned, content);
    const coordinate = edge === "left" ? visible.x : edge === "right" ? visible.x + visible.width
      : edge === "top" ? visible.y : visible.y + visible.height;
    const boundary = edge === "left" ? primary.workArea.x : edge === "right" ? primary.workArea.x + primary.workArea.width
      : edge === "top" ? primary.workArea.y : primary.workArea.y + primary.workArea.height;
    expect(coordinate).toBe(boundary);
    expect(visible.x).toBeGreaterThanOrEqual(primary.workArea.x);
    expect(visible.y).toBeGreaterThanOrEqual(primary.workArea.y);
    expect(visible.x + visible.width).toBeLessThanOrEqual(primary.workArea.x + primary.workArea.width);
    expect(visible.y + visible.height).toBeLessThanOrEqual(primary.workArea.y + primary.workArea.height);
  }
});

test("content crosses side-by-side and stacked displays at different scales", () => {
  const stacked = { ...above, workArea: { ...above.workArea, height: 900 } };
  expect(clampWindowForMovement({ x: -200, y: 300 }, content, primary, [primary, left])).toEqual({ x: -200, y: 300 });
  expect(clampWindowForMovement({ x: 100, y: -200 }, content, primary, [primary, stacked])).toEqual({ x: 100, y: -200 });
  expect(clampWindowForMovement({ x: -10000, y: 300 }, content, left, [primary, left]).x).toBe(-1358);
  expect(clampWindowForMovement({ x: 100, y: -10000 }, content, stacked, [primary, stacked]).y).toBe(-985);
  expect(placeFoot({ x: 10, y: 400 }, { x: 128, y: 224 }, content, [primary, left]).window)
    .toEqual({ x: -118, y: 176 });
  expect(placeFoot({ x: 200, y: 10 }, { x: 128, y: 224 }, content, [primary, stacked]).window)
    .toEqual({ x: 72, y: -214 });
});

test("oversized content aligns its top left to the work area without an inverted clamp", () => {
  const huge = { x: 20, y: 30, width: 3000, height: 2000 };
  expect(clampWindowToDisplay({ x: 9999, y: 9999 }, huge, primary)).toEqual({ x: -20, y: -30 });
});

test("foot and window conversion preserves a position across character sizes", () => {
  const foot = footFromWindow({ x: 100, y: 200 }, footOffset({ width: 256, height: 256 }, 224));
  expect(foot).toEqual({ x: 228, y: 424 });
  expect(windowFromFoot(foot, footOffset({ width: 128, height: 128 }, 112))).toEqual({ x: 164, y: 312 });
});

test("saved position rejects invalid shapes and out of range values", () => {
  const valid = { foot: { x: -50, y: 200 }, display: { id: 1, bounds: primary.bounds } };
  expect(parseSavedPosition(valid)).toEqual(valid);
  for (const invalid of [{}, { ...valid, foot: { x: "bad", y: 0 } },
    { ...valid, foot: { x: Infinity, y: 0 } }, { ...valid, foot: { x: 1e12, y: 0 } },
    { ...valid, display: { id: 1, bounds: { ...primary.bounds, width: -1 } } }]) {
    expect(parseSavedPosition(invalid)).toBeNull();
  }
});
