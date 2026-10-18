import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function resolvePluginEntry(pluginDir: string, entry: string): Promise<string> {
  if (!entry || entry.length > 260 || entry.includes("\\") || entry.includes("\0") ||
      entry.includes(":") || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
    throw new Error("entry has invalid path");
  }
  const parts = entry.split("/");
  if (parts.some((part) => !part || part === "..")) throw new Error("entry has invalid path");
  if (![".js", ".mjs", ".cjs"].includes(path.posix.extname(entry))) throw new Error("entry has invalid extension");

  const folderInfo = await lstat(pluginDir);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error("plugin folder must be a directory");
  const root = await realpath(pluginDir);
  const manifestInfo = await lstat(path.join(root, "manifest.json"));
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("manifest must be a regular file");

  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("entry may not use links");
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error("entry must be a regular file");
    }
  }
  const expected = path.resolve(root, ...parts);
  const relative = path.relative(root, expected);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("entry leaves plugin folder");
  }
  const actual = await realpath(expected);
  if (!samePath(actual, expected)) throw new Error("entry may not use links");
  return actual;
}
