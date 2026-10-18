import { expect, test } from "vitest";
import { pointerToCanvasPixel, startsDrag } from "./pointer.js";

test("DIP pointer positions map to canvas pixels at 100, 125 and 150 percent", () => {
  for (const scale of [1, 1.25, 1.5]) {
    expect(pointerToCanvasPixel({ x: 128, y: 137 }, { width: 256 * scale, height: 256 * scale },
      { width: 256, height: 256 })).toEqual({ x: 128 * scale, y: Math.floor(137 * scale) });
    expect(pointerToCanvasPixel({ x: 256, y: 20 }, { width: 256 * scale, height: 256 * scale },
      { width: 256, height: 256 })).toBeNull();
  }
});

test("only the primary pointer's left button starts a drag", () => {
  expect(startsDrag({ button: 0, isPrimary: true })).toBe(true);
  expect(startsDrag({ button: 2, isPrimary: true })).toBe(false);
  expect(startsDrag({ button: 1, isPrimary: true })).toBe(false);
  expect(startsDrag({ button: 0, isPrimary: false })).toBe(false);
});
