import { expect, test } from "vitest";
import { dragWindowPosition } from "./drag-position.js";
import type { DisplayArea, Point } from "./position.js";

const primary: DisplayArea = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const left: DisplayArea = { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 0, width: 1280, height: 984 }, scaleFactor: 1.5 };
const size = { x: 0, y: 0, width: 256, height: 256 };
const offset: Point = { x: 128, y: 128 };

test("dragging 300px below the bottom edge then to the top reaches the work area top", () => {
  expect(dragWindowPosition(offset, { x: 600, y: 1340 }, size, [primary]))
    .toEqual({ x: 472, y: 784 });
  expect(dragWindowPosition(offset, { x: 600, y: 0 }, size, [primary]))
    .toEqual({ x: 472, y: primary.workArea.y });
});

test("left, right, and top limits do not change the original grab offset", () => {
  expect(dragWindowPosition(offset, { x: -300, y: 500 }, size, [primary]).x).toBe(0);
  expect(dragWindowPosition(offset, { x: 1920 + 300, y: 500 }, size, [primary]).x).toBe(1664);
  expect(dragWindowPosition(offset, { x: 500, y: -300 }, size, [primary]).y).toBe(0);
  expect(dragWindowPosition(offset, { x: 500, y: 500 }, size, [primary]))
    .toEqual({ x: 372, y: 372 });
  expect(dragWindowPosition(offset, { x: 0, y: 0 }, size, [primary]))
    .toEqual({ x: 0, y: 0 });
});

test("drag position crosses displays with different scales using the same grab point", () => {
  expect(dragWindowPosition(offset, { x: 10, y: 400 }, size, [primary, left]))
    .toEqual({ x: -118, y: 272 });
  expect(dragWindowPosition(offset, { x: -500, y: 400 }, size, [primary, left]))
    .toEqual({ x: -628, y: 272 });
  expect(dragWindowPosition(offset, { x: 500, y: 400 }, size, [primary, left]))
    .toEqual({ x: 372, y: 272 });
});

test("leaving the screen and returning does not accumulate a 300px offset", () => {
  const cursor = { x: 700, y: 520 };
  const grab = { x: 128, y: 128 };
  expect(dragWindowPosition(grab, { x: cursor.x, y: -300 }, size, [primary]).y).toBe(0);
  expect(dragWindowPosition(grab, { x: cursor.x, y: 400 }, size, [primary]).y).toBe(272);
  expect(dragWindowPosition(grab, { x: cursor.x, y: 0 }, size, [primary]).y).toBe(0);
  expect(dragWindowPosition(grab, cursor, size, [primary])).toEqual({ x: 572, y: 392 });
});
