import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { parseLines } from "@deskpet/core";
import type { LineCatalog } from "@deskpet/core";
import { validatePluginManifest } from "@deskpet/plugin-sdk";
import type { PluginManifest } from "@deskpet/plugin-sdk";
import { resolvePluginEntry } from "./entry-path.js";

export type DiscoveredPlugin =
  | { id: string; state: "valid"; manifest: PluginManifest; folder: string; entry: string; lines?: LineCatalog }
  | { id: string; state: "invalid"; reason: string };

const MAX_MANIFEST_BYTES = 64 * 1024;
const SUPPORTED_API_VERSIONS = ["1", "2"];

function reason(message: string): string {
  return message.slice(0, 200);
}

async function readLinesFile(folder: string, relative: string): Promise<unknown> {
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes("\\") ||
      relative.includes(":") || relative.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("lines path is invalid");
  const root = await realpath(folder);
  const target = path.resolve(root, ...relative.split("/"));
  const actual = await realpath(target);
  const within = path.relative(root, actual);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
    throw new Error("lines path leaves plugin folder");
  let current = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()))
      throw new Error("lines path must be a regular file without links");
  }
  return JSON.parse(await readFile(actual, "utf8"));
}

async function inspectPlugin(root: string, id: string): Promise<DiscoveredPlugin> {
  const folder = path.join(root, id);
  try {
    const folderInfo = await lstat(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) return { id, state: "invalid", reason: "plugin folder must be a directory" };
    const actualFolder = await realpath(folder);
    const parent = path.dirname(actualFolder);
    if (process.platform === "win32" ? parent.toLowerCase() !== root.toLowerCase() : parent !== root) {
      return { id, state: "invalid", reason: "plugin folder leaves scan root" };
    }
    const manifestPath = path.join(folder, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return { id, state: "invalid", reason: "manifest must be a regular file" };
    if (manifestInfo.size > MAX_MANIFEST_BYTES) return { id, state: "invalid", reason: "manifest exceeds 64 KiB" };
    const bytes = await readFile(manifestPath);
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return { id, state: "invalid", reason: "manifest exceeds 64 KiB" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { id, state: "invalid", reason: "manifest is not valid JSON" };
    }
    const result = validatePluginManifest(parsed);
    if (!result.ok) return { id, state: "invalid", reason: reason(result.errors[0]?.startsWith("apiVersion must be") ? result.errors[0] : "manifest is invalid") };
    const manifest = result.value;
    if (manifest.id !== id) return { id, state: "invalid", reason: "manifest id differs from folder name" };
    if (!SUPPORTED_API_VERSIONS.includes(manifest.apiVersion)) return { id, state: "invalid", reason: "apiVersion is unsupported" };
    if (manifest.permissions.network?.some((host) => isIP(host) !== 0)) {
      return { id, state: "invalid", reason: "network IP literals are forbidden" };
    }
    let entry: string;
    try {
      entry = await resolvePluginEntry(folder, manifest.entry);
    } catch {
      return { id, state: "invalid", reason: "entry path is invalid" };
    }
    let lines: LineCatalog | undefined;
    if (manifest.apiVersion === "2" && manifest.contributes.lines !== undefined) {
      try {
        const parsed = parseLines(await readLinesFile(folder, manifest.contributes.lines), manifest.id);
        if (parsed.problems.length > 0) return { id, state: "invalid", reason: reason(`lines are invalid: ${parsed.problems[0]}`) };
        lines = parsed.catalog;
      } catch {
        return { id, state: "invalid", reason: "lines file could not be read" };
      }
    }
    return { id, state: "valid", manifest, folder, entry, ...(lines === undefined ? {} : { lines }) };
  } catch {
    return { id, state: "invalid", reason: "plugin files could not be read" };
  }
}

export async function discoverPlugins(scanRoot: string): Promise<DiscoveredPlugin[]> {
  let root: string;
  try {
    root = await realpath(scanRoot);
  } catch {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries.filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_") &&
    entry.name !== "node_modules" && (entry.isDirectory() || entry.isSymbolicLink()));
  const discovered = await Promise.all(candidates.map((entry) => inspectPlugin(root, entry.name)));
  return discovered.sort((left, right) => left.id.localeCompare(right.id));
}
