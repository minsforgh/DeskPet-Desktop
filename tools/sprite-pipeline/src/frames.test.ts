import { describe, expect, it } from "vitest";
import { buildFrame, buildStrip, buildStripPreview, parseOp, parseParts, parseSpecPaths, parseStates, validateFrame } from "./frames.js";
import type { PngImage } from "./png.js";
import { parsePalette, type PaletteColor } from "./retouch.js";

const K = [0, 0, 0, 255];
const W = [255, 255, 255, 255];
const R = [255, 0, 0, 255];
const T = [0, 0, 0, 0];

const palette: PaletteColor[] = parsePalette({ colors: [
  { name: "black", hex: "#000000", role: "outline" },
  { name: "white", hex: "#ffffff", role: "body" },
  { name: "red", hex: "#ff0000", role: "accent" },
] });

const partsData = {
  image: "base.png",
  size: [8, 8],
  parts: { ear: { box: [6, 0, 7, 1], note: "test ear" }, legs: { box: [0, 6, 7, 7], note: "legs and feet" } },
  anchor: { "foot-row": 7, "foot-center-x": 3.5 },
};
const parts = parseParts(partsData);

function image(rows: number[][][]): PngImage {
  return { width: rows[0]?.length ?? 0, height: rows.length, pixels: Uint8Array.from(rows.flat(2)) };
}

const base = image([
  [T, T, T, T, T, T, R, R],
  [T, T, T, T, T, T, R, R],
  [T, T, W, W, W, W, T, T],
  [T, T, W, W, W, W, T, T],
  [T, T, W, W, W, W, T, T],
  [T, T, W, W, W, W, T, T],
  [T, T, K, K, K, K, T, T],
  [T, T, K, K, K, K, T, T],
]);

const pixel = (source: PngImage, x: number, y: number): number[] => [...source.pixels.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4)];

const states = (value: Record<string, unknown>): unknown => value;
const ops = (list: unknown[]): unknown => ({ blink: { fps: 2, frames: [{ note: "frame", ops: list }] } });
const shift = (dx: number, fill?: string): ReturnType<typeof parseOp> => parseOp(fill === undefined ? { type: "shift", region: "ear", dx, dy: 0, note: "twitch" } : { type: "shift", region: "ear", dx, dy: 0, fill, note: "twitch" }, "op", palette, parts);

describe("frames spec parsing", () => {
  it("requires the four documented spec fields", () => {
    expect(() => parseSpecPaths({ base: "b.png", palette: "p.json", parts: "q.json", states: {} })).not.toThrow();
    expect(() => parseSpecPaths({ base: "b.png", palette: "p.json", states: {} })).toThrow("spec.parts must be a nonempty string");
    expect(() => parseSpecPaths({ base: "b.png", palette: "p.json", parts: "q.json", states: {}, extra: 1 })).toThrow("unknown field extra");
    expect(() => parseSpecPaths({ base: "", palette: "p.json", parts: "q.json", states: {} })).toThrow("spec.base");
  });
  it("accepts a parts.json part name wherever a region object fits", () => {
    const byName = parseOp({ type: "shift", region: "ear", dx: 0, dy: 0, note: "twitch" }, "op", palette, parts);
    const byBox = parseOp({ type: "shift", region: { x: 6, y: 0, width: 2, height: 2 }, dx: 0, dy: 0, note: "twitch" }, "op", palette, parts);
    expect(byName).toEqual(byBox);
    const rect = parseOp({ type: "rect", region: "legs", color: "black", note: "paint" }, "op", palette, parts);
    expect(rect).toMatchObject({ type: "rect", region: { x: 0, y: 6, width: 8, height: 2 } });
  });
  it.each([
    [{ type: "shift", region: "tail", dx: 0, dy: 0, note: "x" }, "unknown part tail"],
    [{ type: "rect", region: "ear", color: "blue", note: "x" }, "unknown palette color blue"],
    [{ type: "rect", region: { x: 6, y: 0, width: 3, height: 2 }, color: "white", note: "x" }, "outside 8x8 canvas"],
    [{ x: 8, y: 0, color: "white", note: "x" }, "outside 8x8 canvas"],
    [{ type: "shift", region: "ear", dx: "1", dy: 0, note: "x" }, ".dx must be an integer"],
    [{ type: "shift", region: "ear", dx: 0, dy: 0, fill: "transparent", note: "x" }, ".fill"],
    [{ type: "shift", region: "ear", dx: 0, dy: 0 }, ".note"],
    [{ type: "shift", region: "ear", dx: 0, dy: 0, note: "x", extra: 1 }, "unknown field"],
  ])("rejects invalid op %# with a located message", (op, error) => {
    expect(() => parseStates(ops([op]), palette, parts)).toThrow(String(error));
  });
  it.each([
    [states({}), "at least one state"],
    [states({ blink: { fps: 0, frames: [{ note: "n", ops: [] }] } }), ".fps"],
    [states({ blink: { fps: 2, frames: [] } }), "nonempty array"],
    [states({ blink: { fps: 2, frames: [{ ops: [] }] } }), ".note"],
    [states({ blink: { fps: 2, frames: [{ note: "n" }] } }), "ops must be an array"],
    [states({ "bad/name": { fps: 2, frames: [{ note: "n", ops: [] }] } }), "plain filename stem"],
    [states({ blink: { fps: 2, extra: true, frames: [{ note: "n", ops: [] }] } }), "unknown field"],
  ])("rejects invalid state shape %#", (value, error) => {
    expect(() => parseStates(value, palette, parts)).toThrow(String(error));
  });
  it("requires a legs part and a usable anchor in parts.json", () => {
    expect(() => parseParts({ image: "b.png", size: [8, 8], parts: { legs: { box: [0, 6, 7, 7] } }, anchor: { "foot-row": 7, "foot-center-x": 3.5 } })).not.toThrow();
    expect(() => parseParts({ image: "b.png", size: [8, 8], parts: { ear: { box: [6, 0, 7, 1] } }, anchor: { "foot-row": 7, "foot-center-x": 3.5 } })).toThrow("legs");
    expect(() => parseParts({ image: "b.png", size: [8, 8], parts: { legs: { box: [0, 6, 8, 7] } }, anchor: { "foot-row": 7, "foot-center-x": 3.5 } })).toThrow("outside 8x8 canvas");
    expect(() => parseParts({ image: "b.png", size: [8, 8], parts: { legs: { box: [0, 6, 7, 7] } }, anchor: { "foot-row": 8, "foot-center-x": 3.5 } })).toThrow("foot-row");
  });
});

describe("shift and frame building", () => {
  it("moves pixels, drops destinations outside the image, and vacates with transparency", () => {
    const frame = buildFrame(base, palette, [shift(1)]);
    expect(pixel(frame, 7, 0)).toEqual(R);
    expect(pixel(frame, 6, 0)).toEqual(T);
    expect(pixel(frame, 5, 0)).toEqual(T);
    expect(frame.pixels).toHaveLength(base.pixels.length);
  });
  it("keeps destinations that land outside the region but inside the image", () => {
    const frame = buildFrame(base, palette, [shift(-1)]);
    expect(pixel(frame, 5, 0)).toEqual(R);
    expect(pixel(frame, 6, 0)).toEqual(R);
    expect(pixel(frame, 7, 0)).toEqual(T);
  });
  it("fills vacated cells with the named palette color instead of transparency", () => {
    const frame = buildFrame(base, palette, [shift(1, "white")]);
    expect(pixel(frame, 6, 0)).toEqual(W);
    expect(pixel(frame, 7, 0)).toEqual(R);
  });
  it("drops every pixel when the whole region moves off the canvas", () => {
    const frame = buildFrame(base, palette, [shift(6)]);
    expect(pixel(frame, 6, 0)).toEqual(T);
    expect(pixel(frame, 7, 0)).toEqual(T);
  });
  it("applies rect edits before a following shift in array order", () => {
    const rect = parseOp({ type: "rect", region: "ear", color: "white", note: "flatten" }, "op", palette, parts);
    const frame = buildFrame(base, palette, [rect, shift(1)]);
    expect(pixel(frame, 6, 0)).toEqual(T);
    expect(pixel(frame, 7, 0)).toEqual(W);
  });
  it("starts every frame from the base instead of accumulating edits", () => {
    const moved = buildFrame(base, palette, [shift(-1)]);
    expect(buildFrame(base, palette, [shift(-1)])).toEqual(moved);
    const untouched = buildFrame(base, palette, []);
    expect([...untouched.pixels]).toEqual([...base.pixels]);
    expect([...untouched.pixels]).not.toEqual([...moved.pixels]);
  });
  it("rejects partial alpha and off-anchor feet with state and frame context", () => {
    expect(validateFrame(base, palette, parts, 'state "x" frame 1 (x/frame-01.png)')).toBe(3);
    const translucent: PngImage = { width: 8, height: 8, pixels: base.pixels.slice() };
    translucent.pixels.set([255, 0, 0, 128], (0 * 8 + 6) * 4);
    expect(() => validateFrame(translucent, palette, parts, 'state "x" frame 1 (x/frame-01.png)')).toThrow(/state "x" frame 1.*not opaque palette/);
    const raised = buildFrame(base, palette, [parseOp({ type: "shift", region: { x: 0, y: 6, width: 8, height: 2 }, dx: 0, dy: -1, note: "lift" }, "op", palette, parts)]);
    expect(() => validateFrame(raised, palette, parts, 'state "y" frame 2 (y/frame-02.png)')).toThrow(/state "y" frame 2.*lowest opaque row 6 does not match anchor foot-row 7/);
    const sideways = buildFrame(base, palette, [parseOp({ type: "shift", region: { x: 2, y: 6, width: 4, height: 2 }, dx: 4, dy: 0, note: "slide" }, "op", palette, parts)]);
    expect(() => validateFrame(sideways, palette, parts, 'state "z" frame 1 (z/frame-01.png)')).toThrow(/foot center x 6\.5.*foot-center-x 3\.5/);
  });
  it("builds a gapless strip and a two-background preview", () => {
    const frames = [buildFrame(base, palette, []), buildFrame(base, palette, [shift(-1)])];
    const strip = buildStrip(frames);
    expect([strip.width, strip.height]).toEqual([16, 8]);
    expect(pixel(strip, 6, 0)).toEqual(R);
    expect(pixel(strip, 8 + 5, 0)).toEqual(R);
    expect(pixel(strip, 8 + 7, 0)).toEqual(T);
    const preview = buildStripPreview(strip, 2);
    expect([preview.width, preview.height]).toEqual([32, 40]);
    expect(pixel(preview, 0, 0)).toEqual([232, 232, 232, 255]);
    expect(pixel(preview, 12, 2)).toEqual(R);
    expect(pixel(preview, 0, 16)).toEqual([128, 128, 128, 255]);
    expect(pixel(preview, 0, 24)).toEqual([40, 40, 40, 255]);
    expect(pixel(preview, 12, 26)).toEqual(R);
  });
});

describe("shift with only", () => {
  const whole = { x: 0, y: 0, width: 8, height: 8 };
  const only = (dx: number, names: string[], extra: Record<string, unknown> = {}): ReturnType<typeof parseOp> =>
    parseOp({ type: "shift", region: whole, dx, dy: 0, only: names, note: "move red only", ...extra }, "op", palette, parts);

  it("moves only the listed colors and leaves the others where they are", () => {
    const result = buildFrame(base, palette, [only(-1, ["red"])]);
    expect(pixel(result, 5, 0)).toEqual(R);
    expect(pixel(result, 6, 0)).toEqual(R);
    expect(pixel(result, 7, 0)).toEqual(T);
    expect(pixel(result, 2, 2)).toEqual(W);
    expect(pixel(result, 2, 6)).toEqual(K);
  });

  it("passes behind pixels that stay put and clears the cell it left", () => {
    const result = buildFrame(base, palette, [only(-4, ["red"])]);
    // The red pixels at x6-7 would land on x2-3 (transparent in rows 0-1), so they show there.
    expect(pixel(result, 2, 0)).toEqual(R);
    expect(pixel(result, 6, 0)).toEqual(T);
    const behind = buildFrame(base, palette, [only(-4, ["red"], { region: { x: 0, y: 0, width: 8, height: 8 } }), only(0, ["white"])]);
    expect(pixel(behind, 2, 2)).toEqual(W);
    const covered = buildFrame(image([[R, W], [T, T]]), palette, [parseOp({ type: "shift", region: { x: 0, y: 0, width: 2, height: 1 }, dx: 1, dy: 0, only: ["red"], note: "behind white" }, "op", palette, parseParts({ image: "b.png", size: [2, 2], parts: { legs: { box: [0, 0, 1, 1], note: "x" } }, anchor: { "foot-row": 1, "foot-center-x": 0.5 } }))]);
    expect(pixel(covered, 1, 0)).toEqual(W);
    expect(pixel(covered, 0, 0)).toEqual(T);
  });

  it("rejects an empty list and unknown color names", () => {
    expect(() => only(1, [])).toThrow(".only must be a nonempty array");
    expect(() => only(1, ["blue"])).toThrow("unknown palette color blue");
  });
});

describe("shift-set", () => {
  const move = (x: number, dx: number): Record<string, unknown> => ({ region: { x, y: 6, width: 2, height: 2 }, dx, dy: 0, only: ["black"] });
  const set = (moves: unknown[]): ReturnType<typeof parseOp> => parseOp({ type: "shift-set", moves, note: "step" }, "op", palette, parts);

  it("reads every move from the same original, so a pixel is never moved twice", () => {
    const result = buildFrame(base, palette, [set([move(2, 2), move(4, 2)])]);
    expect(pixel(result, 2, 6)).toEqual(T);
    expect(pixel(result, 3, 6)).toEqual(T);
    expect(pixel(result, 4, 6)).toEqual(K);
    expect(pixel(result, 5, 6)).toEqual(K);
    expect(pixel(result, 6, 6)).toEqual(K);
    expect(pixel(result, 7, 6)).toEqual(K);
    // The same two moves as separate shifts move the first pixels twice and leave a hole.
    const separate = buildFrame(base, palette, [parseOp({ type: "shift", ...move(2, 2), note: "a" }, "op", palette, parts), parseOp({ type: "shift", ...move(4, 2), note: "b" }, "op", palette, parts)]);
    expect(pixel(separate, 4, 6)).toEqual(T);
  });

  it("lets an earlier move win where two moves land on the same cell", () => {
    const result = buildFrame(base, palette, [set([{ region: { x: 6, y: 0, width: 2, height: 2 }, dx: -4, dy: 0, only: ["red"] }, { region: { x: 2, y: 6, width: 2, height: 2 }, dx: 0, dy: -6, only: ["black"] }])]);
    expect(pixel(result, 2, 0)).toEqual(R);
    expect(pixel(result, 3, 0)).toEqual(R);
  });

  it("requires only and rejects fill and an empty moves list", () => {
    expect(() => set([{ region: { x: 2, y: 6, width: 2, height: 2 }, dx: 1, dy: 0 }])).toThrow("only is required");
    expect(() => set([])).toThrow("moves must be a nonempty array");
    expect(() => set([{ ...move(2, 1), fill: "white" }])).toThrow("fill is not supported");
  });
});
