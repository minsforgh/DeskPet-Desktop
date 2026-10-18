import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { nativeImage } from "electron";
import { isAbsolute, parse, relative, resolve, sep, join } from "node:path";
import { CHARACTER_SHEET_MAX_BYTES, CHARACTER_SHEET_MAX_PIXELS, inspectSpriteFootFrame,
  type SpriteFootIssue } from "@deskpet/core";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHECK_MAX_PIXELS = 4_194_304;
// Windows dev-sheets e2e with the 8-frame placeholder took 1.36 s end to end on 2026-10-09;
// 60 s leaves time for editing while bounding how long a selected file remains applicable.
const TOKEN_LIFETIME_MS = 60_000;
export const stateNamePattern = /^[a-z][a-z0-9-]{0,31}$/u;
const reserved = new Set(["__proto__", "constructor", "prototype"]);

export function validNewStateName(name: unknown): name is string {
  return typeof name === "string" && stateNamePattern.test(name) && !reserved.has(name);
}

export function newSheetPath(name: string): string {
  return `sheets/${name}-${randomBytes(4).toString("hex")}.png`;
}

export interface CheckedSheet {
  bytes: Buffer;
  preview: string;
  footCheck: { skipped: boolean; issueFrames: number; issues: SpriteFootIssue[] };
}

/** Read exactly one selected file, with a fixed allocation and no second read for preview or write. */
export async function inspectSelectedSheet(path: string, cellSize: readonly [number, number],
  anchor: readonly [number, number], frames: number): Promise<CheckedSheet> {
  if (!isAbsolute(path)) throw new Error("절대 경로의 PNG 파일을 골라 주세요");
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("링크 파일은 사용할 수 없습니다");
  }
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("일반 PNG 파일을 골라 주세요");
  if ((await stat(absolute)).size > CHARACTER_SHEET_MAX_BYTES) throw new Error("시트는 8 MiB 이하여야 합니다");
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino)
      throw new Error("선택한 파일이 바뀌었습니다");
    const buffer = Buffer.alloc(CHARACTER_SHEET_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CHARACTER_SHEET_MAX_BYTES) throw new Error("시트는 8 MiB 이하여야 합니다");
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG 형식이 올바르지 않습니다");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > CHARACTER_SHEET_MAX_PIXELS)
    throw new Error("시트 픽셀 한도를 넘었습니다");
  if (width !== cellSize[0] * frames || height !== cellSize[1])
    throw new Error("시트 치수가 프레임과 맞지 않습니다");
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== width || size.height !== height)
    throw new Error("PNG를 디코드할 수 없습니다");
  const footCheck: CheckedSheet["footCheck"] = { skipped: width * height > CHECK_MAX_PIXELS, issueFrames: 0, issues: [] };
  if (!footCheck.skipped) {
    const bitmap = image.toBitmap();
    if (bitmap.length !== width * height * 4) throw new Error("PNG 픽셀을 읽을 수 없습니다");
    // Electron bitmap is BGRA; the core checker reads the alpha channel at byte 3.
    const input = { pixels: bitmap, pixelFormat: "rgba" as const, width, height, cellSize, frames, anchor };
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = inspectSpriteFootFrame(input, frame);
      if (result.issues.length) footCheck.issueFrames += 1;
      footCheck.issues.push(...result.issues.slice(0, Math.max(0, 20 - footCheck.issues.length)));
    }
  }
  return { bytes, preview: `data:image/png;base64,${bytes.toString("base64")}`, footCheck };
}

export function freshToken(): string { return randomBytes(16).toString("hex"); }
export function tokenExpiresAt(): number { return performance.now() + TOKEN_LIFETIME_MS; }
