export type TerrainRectangle = { x: number; y: number; width: number; height: number };
export type TerrainWindow = { id: string; x: number; y: number; w: number; h: number; platform: boolean };
export type TerrainDisplay = { id: number; bounds: TerrainRectangle; workArea: TerrainRectangle };
export type TerrainPlatform = { y: number; x1: number; x2: number; windowId: string | null; displayId: number };
export type TerrainPoint = { x: number; y: number };
/** A visible piece of a window body after higher windows are cut out; the walls a walking pet can hit. */
export type TerrainWall = { windowId: string; displayId: number; x1: number; x2: number; y1: number; y2: number };
export type Terrain = { platforms: TerrainPlatform[]; walls: TerrainWall[] };

const MAX_WINDOWS = 256;
const MIN_PLATFORM_WIDTH = 48;
const FULLSCREEN_TOLERANCE = 1;

type Interval = { x1: number; x2: number };

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validRectangle(rectangle: TerrainRectangle): boolean {
  return finite(rectangle.x) && finite(rectangle.y) && finite(rectangle.width) &&
    finite(rectangle.height) && rectangle.width >= 0 && rectangle.height >= 0 &&
    finite(rectangle.x + rectangle.width) && finite(rectangle.y + rectangle.height);
}

function validateInputs(windows: readonly TerrainWindow[], displays: readonly TerrainDisplay[],
  visibleSize: { width: number; height: number }): void {
  if (!finite(visibleSize.width) || !finite(visibleSize.height) ||
      visibleSize.width < 0 || visibleSize.height < 0) throw new RangeError("Invalid visible size");
  for (const display of displays) {
    if (!Number.isSafeInteger(display.id) || !validRectangle(display.bounds) ||
        !validRectangle(display.workArea)) throw new RangeError("Invalid display area");
  }
  for (const window of windows.slice(0, MAX_WINDOWS)) {
    if (!finite(window.x) || !finite(window.y) || !finite(window.w) || !finite(window.h) ||
        window.w < 0 || window.h < 0 || !finite(window.x + window.w) ||
        !finite(window.y + window.h)) throw new RangeError("Invalid terrain window");
  }
}

function subtract(intervals: readonly Interval[], covered: Interval): Interval[] {
  const result: Interval[] = [];
  for (const interval of intervals) {
    if (covered.x2 <= interval.x1 || covered.x1 >= interval.x2) {
      result.push(interval);
      continue;
    }
    if (covered.x1 > interval.x1) result.push({ x1: interval.x1, x2: covered.x1 });
    if (covered.x2 < interval.x2) result.push({ x1: covered.x2, x2: interval.x2 });
  }
  return result;
}

function coversDisplay(window: TerrainWindow, display: TerrainDisplay): boolean {
  const { bounds } = display;
  return window.x <= bounds.x + FULLSCREEN_TOLERANCE &&
    window.y <= bounds.y + FULLSCREEN_TOLERANCE &&
    window.x + window.w >= bounds.x + bounds.width - FULLSCREEN_TOLERANCE &&
    window.y + window.h >= bounds.y + bounds.height - FULLSCREEN_TOLERANCE;
}

function subtractRectangle(pieces: readonly TerrainRectangle[], covered: TerrainRectangle): TerrainRectangle[] {
  const result: TerrainRectangle[] = [];
  const cx2 = covered.x + covered.width;
  const cy2 = covered.y + covered.height;
  for (const piece of pieces) {
    const px2 = piece.x + piece.width;
    const py2 = piece.y + piece.height;
    if (cx2 <= piece.x || covered.x >= px2 || cy2 <= piece.y || covered.y >= py2) {
      result.push(piece);
      continue;
    }
    const top = Math.max(piece.y, covered.y);
    const bottom = Math.min(py2, cy2);
    if (covered.y > piece.y) result.push({ x: piece.x, y: piece.y, width: piece.width, height: covered.y - piece.y });
    if (cy2 < py2) result.push({ x: piece.x, y: cy2, width: piece.width, height: py2 - cy2 });
    if (covered.x > piece.x) result.push({ x: piece.x, y: top, width: covered.x - piece.x, height: bottom - top });
    if (cx2 < px2) result.push({ x: cx2, y: top, width: px2 - cx2, height: bottom - top });
  }
  return result;
}

function floorPlatforms(displays: readonly TerrainDisplay[]): TerrainPlatform[] {
  const platforms: TerrainPlatform[] = [];
  for (const [index, display] of displays.entries()) {
    const area = display.workArea;
    if (area.width === 0 || area.height === 0) continue;
    const bottom = area.y + area.height;
    let intervals: Interval[] = [{ x1: area.x, x2: area.x + area.width }];
    for (const [otherIndex, other] of displays.entries()) {
      if (otherIndex === index || other.workArea.width === 0 || other.workArea.height === 0) continue;
      const otherBottom = other.workArea.y + other.workArea.height;
      if (otherBottom > bottom || (otherBottom === bottom && otherIndex < index)) {
        intervals = subtract(intervals,
          { x1: other.workArea.x, x2: other.workArea.x + other.workArea.width });
      }
    }
    for (const interval of intervals) {
      platforms.push({ y: bottom, ...interval, windowId: null, displayId: display.id });
    }
  }
  return platforms;
}

/**
 * Calculate visible window tops and the lowest work-area floor in each screen column, plus the visible window
 * bodies a walking pet treats as walls (ADR-0009 §17). `platforms` is what `calculatePlatforms` returns.
 */
export function calculateTerrain(windows: readonly TerrainWindow[], displays: readonly TerrainDisplay[],
  visibleSize: { width: number; height: number }): Terrain {
  validateInputs(windows, displays, visibleSize);
  const selectedWindows = windows.slice(0, MAX_WINDOWS);
  const platforms = floorPlatforms(displays);
  const walls: TerrainWall[] = [];
  const minimumWidth = Math.max(MIN_PLATFORM_WIDTH, visibleSize.width / 2);
  for (const [index, window] of selectedWindows.entries()) {
    if (!window.platform || window.w === 0 || window.h === 0 ||
        displays.some((display) => coversDisplay(window, display))) continue;
    for (const display of displays) {
      const area = display.workArea;
      if (window.y - visibleSize.height < area.y || window.y >= area.y + area.height ||
          window.y < area.y) continue;
      const clipped = { x1: Math.max(window.x, area.x),
        x2: Math.min(window.x + window.w, area.x + area.width) };
      if (clipped.x2 <= clipped.x1) continue;
      if (!walls.some((wall) => wall.windowId === window.id)) {
        let pieces: TerrainRectangle[] = [{ x: window.x, y: window.y, width: window.w, height: window.h }];
        for (const above of selectedWindows.slice(0, index)) {
          pieces = subtractRectangle(pieces, { x: above.x, y: above.y, width: above.w, height: above.h });
        }
        for (const piece of pieces) {
          if (piece.width > 0 && piece.height > 0) walls.push({ windowId: window.id, displayId: display.id,
            x1: piece.x, x2: piece.x + piece.width, y1: piece.y, y2: piece.y + piece.height });
        }
      }
      let intervals: Interval[] = [clipped];
      for (const above of selectedWindows.slice(0, index)) {
        if (above.y <= window.y && window.y < above.y + above.h) {
          intervals = subtract(intervals, { x1: above.x, x2: above.x + above.w });
        }
      }
      for (const interval of intervals) {
        if (interval.x2 - interval.x1 >= minimumWidth) {
          platforms.push({ y: window.y, ...interval, windowId: window.id, displayId: display.id });
        }
      }
    }
  }
  return { platforms: platforms.sort((a, b) => a.y - b.y || a.x1 - b.x1 || a.x2 - b.x2), walls };
}

/** Calculate visible window tops and the lowest work-area floor in each screen column. */
export function calculatePlatforms(windows: readonly TerrainWindow[], displays: readonly TerrainDisplay[],
  visibleSize: { width: number; height: number }): TerrainPlatform[] {
  return calculateTerrain(windows, displays, visibleSize).platforms;
}

export function findStandingPlatform(platforms: readonly TerrainPlatform[], foot: TerrainPoint): TerrainPlatform | null {
  if (!finite(foot.x) || !finite(foot.y)) throw new RangeError("Invalid foot position");
  let nearest: TerrainPlatform | null = null;
  for (const platform of platforms) {
    if (platform.x1 <= foot.x && foot.x < platform.x2 && Math.abs(platform.y - foot.y) <= 2 &&
        (nearest === null || Math.abs(platform.y - foot.y) < Math.abs(nearest.y - foot.y))) nearest = platform;
  }
  return nearest;
}

export function findCrossedPlatform(platforms: readonly TerrainPlatform[], x: number,
  prevY: number, nextY: number): TerrainPlatform | null {
  if (!finite(x) || !finite(prevY) || !finite(nextY)) throw new RangeError("Invalid crossing");
  let first: TerrainPlatform | null = null;
  for (const platform of platforms) {
    if (platform.x1 <= x && x < platform.x2 && prevY <= platform.y && platform.y < nextY &&
        (first === null || platform.y < first.y)) first = platform;
  }
  return first;
}

/**
 * Whether the side of a window at `x` is visible at height `y` (ADR-0009 §19): some visible body piece of the window
 * spans `y` (within `tolerance`) and has an edge within 1 DIP of `x`. Above, below or behind a higher window it is false.
 */
export function isWallSideVisible(walls: readonly TerrainWall[], windowId: string, x: number, y: number,
  tolerance = 0): boolean {
  if (!finite(x) || !finite(y)) throw new RangeError("Invalid wall query");
  return walls.some((wall) => wall.windowId === windowId && wall.y1 - tolerance <= y && y <= wall.y2 + tolerance &&
    (Math.abs(wall.x1 - x) < 1 || Math.abs(wall.x2 - x) < 1));
}

export function floorAtX(platforms: readonly TerrainPlatform[], x: number): TerrainPlatform | null {
  if (!finite(x)) throw new RangeError("Invalid screen column");
  let floor: TerrainPlatform | null = null;
  for (const platform of platforms) {
    if (platform.windowId === null && platform.x1 <= x && x < platform.x2 &&
        (floor === null || platform.y > floor.y)) floor = platform;
  }
  return floor;
}

/** Bounding extent of all physical display rectangles; individual gaps remain outside the union. */
export function displayUnionBounds(displays: readonly TerrainDisplay[]): TerrainRectangle | null {
  if (displays.length === 0) return null;
  for (const display of displays) {
    if (!Number.isSafeInteger(display.id) || !validRectangle(display.bounds) ||
        !validRectangle(display.workArea)) throw new RangeError("Invalid display area");
  }
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
