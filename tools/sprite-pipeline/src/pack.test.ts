import { describe, expect, it } from "vitest";
import { buildSheet, makePackFiles, parseFrameMetadata, parsePackSpec } from "./pack.js";
import { readPng, writePng, type PngImage } from "./png.js";

const source: PngImage = { width: 2, height: 2, pixels: Uint8Array.from([
  1, 2, 3, 255, 4, 5, 6, 255,
  7, 8, 9, 255, 10, 11, 12, 255,
]) };
const spec = {
  id: "test", name: "Test", cellSize: [4, 2], anchor: [2, 1], scale: 1, fallbacks: {},
  states: { idle: { frames: "frames/idle", offsetX: 1, loop: true } },
};

describe("character pack builder", () => {
  it("places frames into transparent gapless cells", () => {
    const sheet = buildSheet([source, source], [4, 2], 1);
    expect([sheet.width, sheet.height]).toEqual([8, 2]);
    for (const x of [0, 3, 4, 7]) expect(sheet.pixels[(x * 4) + 3]).toBe(0);
    expect([...sheet.pixels.subarray(4, 12)]).toEqual([...source.pixels.subarray(0, 8)]);
    expect(() => buildSheet([source], [2, 2], 1)).toThrow("does not fit");
  });

  it("derives fps and frame count from frames.json and validates the finished manifest", () => {
    const parsed = parsePackSpec(spec);
    expect(parseFrameMetadata({ states: { idle: { fps: 8, frames: 2 } } }, "idle")).toEqual({ fps: 8, frames: 2 });
    const files = makePackFiles(parsed, { idle: { fps: 8, frames: [writePng(source), writePng(source)] } });
    expect(JSON.parse(String(files[0]?.[1]))).toMatchObject({ apiVersion: "1", states: { idle: { fps: 8, frames: 2 } } });
    expect(readPng(files[1]?.[1] as Uint8Array).width).toBe(8);
    expect(() => parseFrameMetadata({ states: {} }, "idle")).toThrow("idle");
  });

  it("rejects invalid state names, facing, and missing idle", () => {
    expect(() => parsePackSpec({ ...spec, states: { ...spec.states, "bad/name": spec.states.idle } })).toThrow("unsafe state name");
    expect(() => parsePackSpec({ ...spec, states: { idle: { ...spec.states.idle, facing: "front" } } })).toThrow("facing");
    expect(() => parsePackSpec({ ...spec, states: {} })).toThrow("idle");
  });
});
