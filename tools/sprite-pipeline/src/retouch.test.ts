import { describe, expect, it } from "vitest";
import type { PngImage } from "./png.js";
import { parseEdits, parsePalette, retouch, summarize } from "./retouch.js";

const paletteData = { colors: [{ name: "black", hex: "#000000", role: "outline" }, { name: "white", hex: "#ffffff", role: "light" }] };
const palette = parsePalette(paletteData);
const image = (pixels: number[]): PngImage => ({ width: pixels.length / 4, height: 1, pixels: Uint8Array.from(pixels) });

describe("retouch palette and edit validation", () => {
  it.each(["#000000", "#abcdef", "#AbC123", "#FFFFFF"])("accepts six-digit hex %s through the actual parser", (hex) => {
    expect(parsePalette({ colors: [{ name: "ink", hex, role: "test" }] })[0]?.hex).toBe(hex.toLowerCase());
  });
  it.each(["ffffff", "#fff", "#fffffff", "#gg0000", "#123456\n", " #123456", "#123456ff"])("rejects malformed hex %j", (hex) => {
    expect(() => parsePalette({ colors: [{ name: "ink", hex, role: "test" }] })).toThrow("#RRGGBB");
  });
  it("rejects empty, overfull, duplicate, reserved and undocumented palette entries", () => {
    expect(() => parsePalette({ colors: [] })).toThrow("1–16");
    expect(() => parsePalette({ colors: Array.from({ length: 17 }, () => paletteData.colors[0]) })).toThrow("1–16");
    expect(() => parsePalette({ colors: [paletteData.colors[0], paletteData.colors[0]] })).toThrow("duplicated");
    expect(() => parsePalette({ colors: [{ name: "ink", hex: "#000000", role: "x" }, { name: "other", hex: "#000000", role: "x" }] })).toThrow("hex is duplicated");
    expect(() => parsePalette({ colors: [{ name: "transparent", hex: "#000000", role: "x" }] })).toThrow("reserved");
    expect(() => parsePalette({ colors: [{ name: "ink", hex: "#000000" }] })).toThrow("role");
  });
  it.each([
    [{ x: 2, y: 0, color: "black", note: "bounds" }, "outside"],
    [{ x: -1, y: 0, color: "black", note: "negative" }, ".x"],
    [{ x: 0, y: 0.5, color: "black", note: "fraction" }, ".y"],
    [{ x: 0, y: 0, color: "unknown", note: "color" }, "unknown palette"],
    [{ x: 0, y: 0, color: "black" }, ".note"],
    [{ type: "rect", region: { x: 0, y: 0, width: 3, height: 1 }, color: "black", note: "bounds" }, "outside"],
    [{ type: "replace", from: "unknown", color: "white", note: "color" }, ".from"],
    [{ type: "pixel", x: 0, y: 0, colour: "black", color: "black", note: "typo" }, "unknown field"],
    [{ type: "circle", color: "black", note: "shape" }, ".type"],
  ])("rejects invalid edit %# with location", (edit, error) => {
    expect(() => parseEdits({ edits: [edit] }, palette, 2, 1)).toThrow(String(error));
  });
});

describe("retouch pixels", () => {
  it("uses squared RGB distance, first-entry ties, and clears hidden transparent RGB without changing the source", () => {
    const colors = parsePalette({ colors: [{ name: "a", hex: "#000000", role: "a" }, { name: "b", hex: "#020000", role: "b" }] });
    const source = image([1, 0, 0, 255, 2, 0, 0, 255, 255, 9, 1, 0]);
    const result = retouch(source, colors, []);
    expect([...result.pixels]).toEqual([0, 0, 0, 255, 2, 0, 0, 255, 0, 0, 0, 0]);
    expect(source.pixels[0]).toBe(1);
  });
  it("applies pixel, rectangle, bounded replacement and transparency sequentially", () => {
    const source = image([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const edits = parseEdits({ edits: [
      { type: "rect", region: { x: 0, y: 0, width: 3, height: 1 }, color: "white", note: "fill" },
      { type: "replace", from: "white", color: "black", region: { x: 1, y: 0, width: 1, height: 1 }, note: "bounded" },
      { x: 2, y: 0, color: "transparent", note: "erase" },
      { type: "replace", from: "black", color: "transparent", note: "global" },
    ] }, palette, 3, 1);
    const result = retouch(source, palette, edits);
    expect([...result.pixels]).toEqual([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(summarize(result, palette)).toMatchObject({ colors: 1, transparentPixels: 2, palette: [{ name: "white", pixels: 1 }] });
  });
  it("rejects partial alpha and detects non-palette output", () => {
    expect(() => retouch(image([0, 0, 0, 128]), palette, [])).toThrow("partial alpha 128");
    expect(() => summarize(image([1, 0, 0, 255]), palette)).toThrow("not opaque palette");
    expect(() => summarize(image([0, 0, 0, 1]), palette)).toThrow("not opaque palette");
  });
});
