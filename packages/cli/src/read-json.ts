import { Buffer } from "node:buffer";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function decodeJsonBuffer(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const bytes = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const first = bytes[index];
      bytes[index] = bytes[index + 1] ?? 0;
      bytes[index + 1] = first ?? 0;
    }
    return bytes.toString("utf16le");
  }
  return buffer.toString("utf8");
}

export async function readJsonFile(path: string, workingDirectory = process.cwd()): Promise<unknown> {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new Error("파일은 작업 폴더 안의 상대 경로여야 합니다");
  const root = await realpath(workingDirectory);
  const target = resolve(root, path);
  const canonical = await realpath(target);
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || canonical !== target)
    throw new Error("파일 경로가 작업 폴더 밖이거나 링크입니다");
  return JSON.parse(decodeJsonBuffer(await readFile(canonical))) as unknown;
}
