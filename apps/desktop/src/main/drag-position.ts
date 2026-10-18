import { clampWindowForMovement, displayForPoint, type DisplayArea, type Point, type Rectangle } from "./position.js";

export function dragWindowPosition(grabOffset: Point, cursor: Point,
  content: Rectangle, displays: readonly DisplayArea[]): Point {
  const candidate = { x: cursor.x - grabOffset.x, y: cursor.y - grabOffset.y };
  const target = displayForPoint(cursor, displays);
  return clampWindowForMovement(candidate, content, target, displays);
}
