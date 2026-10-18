import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { readPng, writePng } from "./png.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function replaceChunk(png: Buffer, name: string, data: Buffer): Buffer {
  let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === name) {
      const body = Buffer.concat([Buffer.from(name), data]);
      const chunk = Buffer.alloc(body.length + 8);
      chunk.writeUInt32BE(data.length, 0);
      body.copy(chunk, 4);
      chunk.writeUInt32BE(crc32(body), chunk.length - 4);
      return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset + size + 12)]);
    }
    offset += size + 12;
  }
  throw new Error(`Missing PNG chunk ${name}`);
}

describe("PNG codec", () => {
  it("round trips RGBA pixels including transparent colors", () => {
    const pixels = Uint8Array.from([255, 0, 0, 255, 1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255]);
    expect(readPng(writePng({ width: 2, height: 2, pixels }))).toEqual({ width: 2, height: 2, pixels });
  });

  it("reads 8-bit RGB pixels", () => {
    let png = writePng({ width: 1, height: 1, pixels: Uint8Array.from([1, 2, 3, 255]) });
    const header = Buffer.from(png.subarray(16, 29));
    header[9] = 2;
    png = replaceChunk(png, "IHDR", header);
    png = replaceChunk(png, "IDAT", deflateSync(Buffer.from([0, 1, 2, 3])));
    expect(readPng(png)).toEqual({ width: 1, height: 1, pixels: Uint8Array.from([1, 2, 3, 255]) });
  });

  it("reports unsupported color types clearly", () => {
    const png = writePng({ width: 1, height: 1, pixels: Uint8Array.from([1, 2, 3, 255]) });
    const header = Buffer.from(png.subarray(16, 29));
    header[9] = 0;
    expect(() => readPng(replaceChunk(png, "IHDR", header))).toThrow(/Unsupported PNG format:.*colorType=0/);
  });

  it("bounds file size, declared dimensions, and decompressed output", () => {
    expect(() => readPng(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow(/8 MiB/);
    const png = writePng({ width: 1, height: 1, pixels: Uint8Array.from([1, 2, 3, 255]) });
    const largeHeader = Buffer.from(png.subarray(16, 29));
    largeHeader.writeUInt32BE(4097, 0);
    largeHeader.writeUInt32BE(4097, 4);
    expect(() => readPng(replaceChunk(png, "IHDR", largeHeader))).toThrow(/pixel limit/);
    const expanded = replaceChunk(png, "IDAT", deflateSync(Buffer.alloc(6)));
    expect(() => readPng(expanded)).toThrow();
  });
});
