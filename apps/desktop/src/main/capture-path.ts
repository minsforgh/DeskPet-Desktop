import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve a requested output file against `root` and return its real location.
 * The file's folder must already exist and, after following links, lie inside `root`.
 * The file itself must not be a link, so writing it cannot land outside `root`.
 */
export async function resolveInside(root: string, requested: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, requested);
  const path = join(await realpath(dirname(target)), basename(target));
  const within = relative(realRoot, path);
  if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
    throw new Error("Path is outside the allowed folder");
  }
  const existing = await lstat(path).catch(() => undefined);
  if (existing && !existing.isFile()) throw new Error("Path is not a regular file");
  return path;
}
