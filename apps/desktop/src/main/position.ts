export type Point = { x: number; y: number };
export type Rectangle = Point & { width: number; height: number };
export type DisplayArea = { id: number; bounds: Rectangle; workArea: Rectangle; scaleFactor: number };
export type SavedPosition = { foot: Point; display: { id: number; bounds: Rectangle } };

export function hasSize(rectangle: Rectangle, size: { width: number; height: number }): boolean {
  return rectangle.width === size.width && rectangle.height === size.height;
}

const MAX_COORDINATE = 1_000_000;
function finitePoint(value: unknown): value is Point {
  return typeof value === "object" && value !== null && "x" in value && "y" in value &&
    typeof value.x === "number" && typeof value.y === "number" &&
    Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Math.abs(value.x) <= MAX_COORDINATE && Math.abs(value.y) <= MAX_COORDINATE;
}

function finiteRectangle(value: unknown): value is Rectangle {
  return finitePoint(value) && "width" in value && "height" in value &&
    typeof value.width === "number" && typeof value.height === "number" &&
    Number.isFinite(value.width) && Number.isFinite(value.height) &&
    value.width > 0 && value.height > 0 && value.width <= MAX_COORDINATE && value.height <= MAX_COORDINATE;
}

export function parseSavedPosition(value: unknown): SavedPosition | null {
  if (typeof value !== "object" || value === null || !("foot" in value) || !("display" in value) ||
      !finitePoint(value.foot) || typeof value.display !== "object" || value.display === null ||
      !("id" in value.display) || !("bounds" in value.display) ||
      typeof value.display.id !== "number" || !Number.isSafeInteger(value.display.id) ||
      !finiteRectangle(value.display.bounds)) return null;
  return { foot: { x: value.foot.x, y: value.foot.y },
    display: { id: value.display.id, bounds: { ...value.display.bounds } } };
}

export function footOffset(size: { width: number; height: number }, anchorY: number, anchorX = size.width / 2): Point {
  return { x: anchorX, y: anchorY };
}

export function footFromWindow(window: Point, offset: Point): Point {
  return { x: window.x + offset.x, y: window.y + offset.y };
}

export function windowFromFoot(foot: Point, offset: Point): Point {
  return { x: Math.round(foot.x - offset.x), y: Math.round(foot.y - offset.y) };
}

function distanceSquared(point: Point, rectangle: Rectangle): number {
  const dx = point.x < rectangle.x ? rectangle.x - point.x :
    point.x > rectangle.x + rectangle.width ? point.x - rectangle.x - rectangle.width : 0;
  const dy = point.y < rectangle.y ? rectangle.y - point.y :
    point.y > rectangle.y + rectangle.height ? point.y - rectangle.y - rectangle.height : 0;
  return dx * dx + dy * dy;
}

export function displayForPoint(point: Point, displays: readonly DisplayArea[]): DisplayArea {
  if (displays.length === 0) throw new Error("No displays available");
  return displays.reduce((closest, display) =>
    distanceSquared(point, display.workArea) < distanceSquared(point, closest.workArea) ? display : closest);
}

export function contentOnScreen(window: Point, content: Rectangle): Rectangle {
  return { x: window.x + content.x, y: window.y + content.y, width: content.width, height: content.height };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.max(minimum, Math.min(value, Math.max(minimum, maximum))));
}

export function clampWindowToDisplay(window: Point, content: Rectangle, display: DisplayArea): Point {
  const area = display.workArea;
  return {
    x: clamp(window.x, area.x - content.x, area.x + area.width - content.x - content.width),
    y: clamp(window.y, area.y - content.y, area.y + area.height - content.y - content.height),
  };
}

export function clampWindowForMovement(window: Point, content: Rectangle,
  display: DisplayArea, displays: readonly DisplayArea[]): Point {
  const area = display.workArea;
  let left = area.x;
  let right = area.x + area.width;
  let top = area.y;
  let bottom = area.y + area.height;
  let changed = true;
  while (changed) {
    changed = false;
    for (const other of displays) {
      const next = other.workArea;
      const overlap = Math.min(area.y + area.height, next.y + next.height) - Math.max(area.y, next.y);
      if (overlap >= content.height && next.x <= right && next.x + next.width >= left &&
          (next.x < left || next.x + next.width > right)) {
        left = Math.min(left, next.x);
        right = Math.max(right, next.x + next.width);
        changed = true;
      }
      const horizontalOverlap = Math.min(area.x + area.width, next.x + next.width) - Math.max(area.x, next.x);
      if (horizontalOverlap >= content.width && next.y <= bottom && next.y + next.height >= top &&
          (next.y < top || next.y + next.height > bottom)) {
        top = Math.min(top, next.y);
        bottom = Math.max(bottom, next.y + next.height);
        changed = true;
      }
    }
  }
  return {
    x: clamp(window.x, left - content.x, right - content.x - content.width),
    y: clamp(window.y, top - content.y, bottom - content.y - content.height),
  };
}

export function placeFoot(foot: Point, offset: Point, content: Rectangle,
  displays: readonly DisplayArea[]): { window: Point; display: DisplayArea } {
  const display = displayForPoint(foot, displays);
  return { window: clampWindowForMovement(windowFromFoot(foot, offset), content, display, displays), display };
}
