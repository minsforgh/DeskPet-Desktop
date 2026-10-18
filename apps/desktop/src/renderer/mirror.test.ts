import { describe, expect, test } from "vitest";
import type { AnimationSnapshot } from "@deskpet/core";
import { mirroredHorizontalBounds, shouldMirror } from "./mirror.js";

const walking = (direction: "left" | "right"): AnimationSnapshot => ({
  state: "walk", frame: 0, movement: { direction, speedPxPerSecond: 30 },
});

describe("shouldMirror", () => {
  test("uses the current state's facing and the opposite movement direction", () => {
    expect(shouldMirror("walk", "right", walking("left"))).toBe(true);
    expect(shouldMirror("walk", "left", walking("right"))).toBe(true);
    expect(shouldMirror("walk", "right", walking("right"))).toBe(false);
    expect(shouldMirror("walk", "left", walking("left"))).toBe(false);
  });

  test("does not mirror front-facing art, missing movement, or another state", () => {
    expect(shouldMirror("walk", undefined, walking("left"))).toBe(false);
    expect(shouldMirror("walk", "right", { state: "walk", frame: 0, movement: null })).toBe(false);
    expect(shouldMirror("idle", "right", walking("left"))).toBe(false);
  });
});

test("reflected bounds use the anchor even when it is off center", () => {
  expect(mirroredHorizontalBounds({ left: 20, right: 50 }, 65)).toEqual({ left: 80, right: 110 });
  expect(mirroredHorizontalBounds({ left: 20, right: 50 }, 40)).toEqual({ left: 30, right: 60 });
  expect(mirroredHorizontalBounds({ left: 40, right: 41 }, 40)).toEqual({ left: 39, right: 40 });
});
