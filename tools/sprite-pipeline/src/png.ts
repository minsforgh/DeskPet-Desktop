import { deflateSync, inflateSync } from "node:zlib";
import { CHARACTER_SHEET_MAX_BYTES, CHARACTER_SHEET_MAX_PIXELS } from "@deskpet/core";

export interface PngImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 255] ?? 0);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

export function writePng(image: PngImage): Buffer {
  const { width, height, pixels } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new Error("PNG writer requires positive dimensions and width * height * 4 RGBA bytes");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const cornerDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= cornerDistance ? left : aboveDistance <= cornerDistance ? above : upperLeft;
}

export function readPng(input: Uint8Array): PngImage {
  const bytes = Buffer.from(input);
  if (bytes.length > CHARACTER_SHEET_MAX_BYTES) throw new Error("PNG sheet exceeds 8 MiB file limit");
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("Invalid PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let seenHeader = false;
  let seenEnd = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error("Truncated PNG chunk data");
    const name = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const checksum = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== checksum) throw new Error(`PNG ${name} CRC mismatch`);
    offset += length + 12;
    if (name === "IHDR") {
      if (seenHeader || length !== 13) throw new Error("Invalid PNG IHDR");
      seenHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, compression=${data[10]}, filter=${data[11]}, interlace=${data[12]}; expected non-interlaced 8-bit RGB or RGBA`);
      }
      if (width < 1 || height < 1) throw new Error("Invalid PNG dimensions");
      if (width * height > CHARACTER_SHEET_MAX_PIXELS) throw new Error("PNG sheet exceeds pixel limit");
      channels = colorType === 6 ? 4 : 3;
    } else if (name === "IDAT") {
      if (!seenHeader) throw new Error("PNG IDAT before IHDR");
      compressed.push(data);
    } else if (name === "IEND") {
      seenEnd = true;
      break;
    } else if (name[0] === name[0]?.toUpperCase() && name !== "PLTE") {
      throw new Error(`Unsupported PNG critical chunk ${name}`);
    }
  }
  if (!seenHeader || !seenEnd || compressed.length === 0) throw new Error("PNG requires IHDR, IDAT, and IEND");
  const stride = width * channels;
  const expectedRawBytes = height * (stride + 1);
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedRawBytes });
  if (raw.length !== expectedRawBytes) throw new Error(`PNG decompressed size ${raw.length} does not match ${expectedRawBytes}`);
  const pixels = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(stride);
    const filter = raw[y * (stride + 1)] ?? 0;
    if (filter > 4) throw new Error(`Unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] ?? 0 : 0;
      const above = previous[x] ?? 0;
      const upperLeft = x >= channels ? previous[x - channels] ?? 0 : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      row[x] = ((raw[y * (stride + 1) + 1 + x] ?? 0) + predictor) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      pixels[target] = row[source] ?? 0;
      pixels[target + 1] = row[source + 1] ?? 0;
      pixels[target + 2] = row[source + 2] ?? 0;
      pixels[target + 3] = channels === 4 ? row[source + 3] ?? 0 : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}
