import { describe, expect, it } from "vitest";
import { inspectSpriteFootFrame, inspectSpriteFootFrames, type SpriteFootCheckInput } from "./sprite-foot-check.js";

function sheet(pixelFormat: "rgba" | "alpha", frames = 1) {
  const width = frames * 16;
  const pixels = new Uint8Array(width * 16 * (pixelFormat === "rgba" ? 4 : 1));
  const input: SpriteFootCheckInput = {
    pixels, pixelFormat, width, height: 16, cellSize: [16, 16], frames, anchor: [8, 14],
  };
  const pixel = (frame: number, x: number, y: number, alpha = 255): void => {
    const index = y * width + frame * 16 + x;
    pixels[pixelFormat === "rgba" ? index * 4 + 3 : index] = alpha;
  };
  const body = (frame: number, centerX = 8, bottomY = 14): void => {
    for (let y = bottomY - 4; y <= bottomY; y += 1)
      for (let x = centerX - 1; x <= centerX + 1; x += 1) pixel(frame, x, y);
  };
  return { input, pixel, body };
}

describe("sprite foot checker", () => {
  it.each(["rgba", "alpha"] as const)("accepts a grounded %s frame and counts upper decorations", (format) => {
    const { input, pixel, body } = sheet(format);
    body(0);
    pixel(0, 1, 1);
    expect(inspectSpriteFootFrame(input, 0)).toEqual({ frame: 1, issues: [], decorations: 1 });
  });

  it("reports vertical and horizontal foot offsets per frame", () => {
    const { input, body } = sheet("rgba", 2);
    body(0, 8, 9);
    body(1, 13);
    expect(inspectSpriteFootFrames(input)).toEqual([
      { frame: 1, issues: [{ frame: 1, reason: "foot y exceeds tolerance", measured: 9, expected: 14 }], decorations: 0 },
      { frame: 2, issues: [{ frame: 2, reason: "foot x exceeds tolerance", measured: 13, expected: 8 }], decorations: 0 },
    ]);
  });

  it("rejects an opaque foot-area speck but accepts one above the feet", () => {
    const { input, pixel, body } = sheet("alpha");
    body(0, 8, 9);
    pixel(0, 1, 1);
    pixel(0, 8, 14);
    expect(inspectSpriteFootFrame(input, 0)).toEqual({
      frame: 1,
      issues: [
        { frame: 1, reason: "foot y exceeds tolerance", measured: 9, expected: 14 },
        { frame: 1, reason: "발 근처 잡점", measured: "8,14" },
      ],
      decorations: 2,
    });
  });

  it("rejects a translucent pixel below the anchor tolerance", () => {
    const { input, pixel, body } = sheet("rgba");
    input.anchor = [8, 10];
    body(0, 8, 9);
    pixel(0, 8, 14, 1);
    expect(inspectSpriteFootFrame(input, 0).issues).toContainEqual({
      frame: 1, reason: "발 아래 반투명 잔여", measured: "8,14",
    });
  });

  it("reports a frame without a body", () => {
    const { input } = sheet("alpha");
    expect(inspectSpriteFootFrame(input, 0)).toEqual({
      frame: 1, issues: [{ frame: 1, reason: "empty frame", measured: "no body pixels" }], decorations: 0,
    });
  });
});
