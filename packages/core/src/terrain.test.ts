import { describe, expect, it } from "vitest";
import { calculatePlatforms, calculateTerrain, displayUnionBounds, findCrossedPlatform, findStandingPlatform, floorAtX, isWallSideVisible } from "./index.js";
import type { TerrainDisplay, TerrainWindow } from "./index.js";

const size = { width: 80, height: 60 };
const display: TerrainDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  workArea: { x: 0, y: 0, width: 800, height: 560 },
};
const window = (id: string, x: number, y: number, w: number, h = 200,
  platform = true): TerrainWindow => ({ id, x, y, w, h, platform });
const tops = (windows: TerrainWindow[], displays: TerrainDisplay[] = [display], visibleSize = size) =>
  calculatePlatforms(windows, displays, visibleSize).filter((platform) => platform.windowId !== null);

describe("terrain platforms", () => {
  it("subtracts only top windows that cover the lower window's top, including excluded apps", () => {
    const lower = window("lower", 100, 300, 300);
    expect(tops([window("partial", 180, 250, 80, 100), lower]))
      .toEqual([
        { y: 250, x1: 180, x2: 260, windowId: "partial", displayId: 1 },
        { y: 300, x1: 100, x2: 180, windowId: "lower", displayId: 1 },
        { y: 300, x1: 260, x2: 400, windowId: "lower", displayId: 1 },
      ]);
    expect(tops([window("cover", 90, 250, 320, 100), lower]).some((item) => item.windowId === "lower"))
      .toBe(false);
    expect(tops([window("excluded", 180, 250, 80, 100, false), lower]))
      .toEqual([
        { y: 300, x1: 100, x2: 180, windowId: "lower", displayId: 1 },
        { y: 300, x1: 260, x2: 400, windowId: "lower", displayId: 1 },
      ]);
    expect(tops([window("above", 180, 100, 80, 100), lower])
      .find((item) => item.windowId === "lower"))
      .toEqual({ y: 300, x1: 100, x2: 400, windowId: "lower", displayId: 1 });
  });

  it("keeps widths at the minimum and clips visible sections to the work area", () => {
    expect(tops([window("short", 10, 200, 47), window("exact", 100, 200, 48)]))
      .toEqual([{ y: 200, x1: 100, x2: 148, windowId: "exact", displayId: 1 }]);
    expect(tops([window("wide", 0, 200, 99)], [display], { width: 200, height: 60 }))
      .toEqual([]);
    expect(tops([window("wide", -100, 200, 150)]))
      .toEqual([{ y: 200, x1: 0, x2: 50, windowId: "wide", displayId: 1 }]);
  });

  it("requires headroom and treats a full-screen window as occlusion only", () => {
    expect(tops([window("maximized", 0, 0, 800, 560), window("near-top", 100, 59, 100)]))
      .toEqual([]);
    expect(tops([window("headroom", 100, 60, 100)]))
      .toEqual([{ y: 60, x1: 100, x2: 200, windowId: "headroom", displayId: 1 }]);
    expect(tops([window("fullscreen", 1, 1, 798, 598), window("behind", 100, 200, 200)]))
      .toEqual([]);
  });

  it("builds floors for side-by-side, stacked, and staggered monitors", () => {
    const right: TerrainDisplay = {
      id: 2,
      bounds: { x: 800, y: 0, width: 600, height: 500 },
      workArea: { x: 800, y: 0, width: 600, height: 480 },
    };
    const side = calculatePlatforms([], [display, right], size);
    expect(side).toEqual([
      { y: 480, x1: 800, x2: 1400, windowId: null, displayId: 2 },
      { y: 560, x1: 0, x2: 800, windowId: null, displayId: 1 },
    ]);
    expect(floorAtX(side, 799)?.displayId).toBe(1);
    expect(floorAtX(side, 800)?.displayId).toBe(2);
    expect(floorAtX(side, 1400)).toBeNull();

    const below: TerrainDisplay = {
      id: 3,
      bounds: { x: 0, y: 600, width: 800, height: 400 },
      workArea: { x: 0, y: 600, width: 800, height: 380 },
    };
    expect(calculatePlatforms([], [display, below], size))
      .toEqual([{ y: 980, x1: 0, x2: 800, windowId: null, displayId: 3 }]);

    const staggered: TerrainDisplay = {
      id: 4,
      bounds: { x: 400, y: 600, width: 800, height: 400 },
      workArea: { x: 400, y: 600, width: 800, height: 380 },
    };
    const floors = calculatePlatforms([], [display, staggered], size);
    expect(floors).toEqual([
      { y: 560, x1: 0, x2: 400, windowId: null, displayId: 1 },
      { y: 980, x1: 400, x2: 1200, windowId: null, displayId: 4 },
    ]);
    expect(floorAtX(floors, 100)?.y).toBe(560);
    expect(floorAtX(floors, 500)?.y).toBe(980);
    expect(displayUnionBounds([display, staggered]))
      .toEqual({ x: 0, y: 0, width: 1200, height: 1000 });
    expect(displayUnionBounds([])).toBeNull();
  });

  it("finds standing and crossed platforms by foot, without landing on upward motion", () => {
    const platforms = calculatePlatforms([window("higher", 100, 200, 200, 100),
      window("lower", 100, 400, 200, 100)], [display], size);
    expect(findStandingPlatform(platforms, { x: 150, y: 202 })?.windowId).toBe("higher");
    expect(findStandingPlatform(platforms, { x: 150, y: 203 })).toBeNull();
    expect(findStandingPlatform(platforms, { x: 300, y: 200 })).toBeNull();
    expect(findCrossedPlatform(platforms, 150, 100, 500)?.windowId).toBe("higher");
    expect(findCrossedPlatform(platforms, 150, 200, 201)?.windowId).toBe("higher");
    expect(findCrossedPlatform(platforms, 150, 100, 200)).toBeNull();
    expect(findCrossedPlatform(platforms, 150, 500, 100)).toBeNull();
    expect(findCrossedPlatform(platforms, 350, 100, 500)).toBeNull();
  });

  it("rejects invalid dimensions and keeps only the first 256 windows", () => {
    expect(() => calculatePlatforms([window("bad", 0, 100, -1)], [display], size)).toThrow(RangeError);
    expect(() => calculatePlatforms([window("bad", Number.NaN, 100, 100)], [display], size)).toThrow(RangeError);
    expect(() => calculatePlatforms([], [{ ...display, workArea: { ...display.workArea, height: -1 } }], size))
      .toThrow(RangeError);
    expect(() => calculatePlatforms([], [display], { width: Infinity, height: 60 })).toThrow(RangeError);
    const windows = Array.from({ length: 256 }, (_, index) => window(`excluded-${index}`, 0, 100, 0, 0, false));
    windows.push(window("ignored", 100, 200, 100));
    expect(tops(windows)).toEqual([]);
  });
});

describe("terrain walls", () => {
  const walls = (windows: TerrainWindow[]) => calculateTerrain(windows, [display], size).walls;

  it("keeps calculatePlatforms unchanged and reports the whole window body as a wall", () => {
    const windows = [window("a", 100, 200, 300, 250)];
    expect(calculateTerrain(windows, [display], size).platforms).toEqual(calculatePlatforms(windows, [display], size));
    expect(walls(windows)).toEqual([{ windowId: "a", displayId: 1, x1: 100, x2: 400, y1: 200, y2: 450 }]);
  });

  it("cuts higher windows out of the body, including excluded apps, and skips windows without a platform", () => {
    const lower = window("lower", 100, 300, 300, 200);
    expect(walls([window("cover", 90, 250, 320, 300, false), lower])).toEqual([]);
    expect(walls([window("side", 250, 250, 100, 300, false), lower]))
      .toEqual([{ windowId: "lower", displayId: 1, x1: 100, x2: 250, y1: 300, y2: 500 },
        { windowId: "lower", displayId: 1, x1: 350, x2: 400, y1: 300, y2: 500 }]);
    expect(walls([window("top", 150, 100, 100, 250, false), lower]))
      .toContainEqual({ windowId: "lower", displayId: 1, x1: 100, x2: 400, y1: 350, y2: 500 });
    expect(walls([window("none", 100, 200, 300, 250, false)])).toEqual([]);
    expect(walls([window("full", 0, 0, 800, 600)])).toEqual([]);
  });
});

describe("isWallSideVisible", () => {
  const sides = (windows: TerrainWindow[]) => calculateTerrain(windows, [display], size).walls;
  it("is true on a visible side within the window height and false outside or behind a higher window", () => {
    const walls = sides([window("top", 150, 250, 100, 100), window("low", 100, 200, 300, 300)]);
    expect(isWallSideVisible(walls, "low", 100, 300)).toBe(true);
    expect(isWallSideVisible(walls, "low", 400, 300)).toBe(true);
    expect(isWallSideVisible(walls, "low", 100, 199)).toBe(false);
    expect(isWallSideVisible(walls, "low", 100, 199, 2)).toBe(true);
    expect(isWallSideVisible(walls, "low", 100, 501)).toBe(false);
    expect(isWallSideVisible(walls, "gone", 100, 300)).toBe(false);
  });
  it("is false where a higher window covers the side", () => {
    const walls = sides([window("cover", 50, 250, 100, 100), window("low", 100, 200, 300, 300)]);
    expect(isWallSideVisible(walls, "low", 100, 220)).toBe(true);
    expect(isWallSideVisible(walls, "low", 100, 300)).toBe(false);
    expect(isWallSideVisible(walls, "low", 100, 400)).toBe(true);
  });
});
