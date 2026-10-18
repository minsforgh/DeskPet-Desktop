import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginPermissions } from "@deskpet/plugin-sdk";

export interface Grant {
  decision: "granted" | "denied";
  at: string;
  permissionsHash: string;
  permissions: PluginPermissions;
}

export interface GrantFile {
  version: 1;
  grants: Record<string, Grant>;
}

export type GrantCheck = "granted" | "denied" | "needs-permission" | "updated";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = normalize((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

export function permissionsHash(permissions: PluginPermissions): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(normalize(permissions))).digest("hex")}`;
}

function empty(permissions: PluginPermissions): boolean {
  return Object.values(permissions).every((value) => value === false || (Array.isArray(value) && value.length === 0));
}

function subset(current: PluginPermissions, previous: PluginPermissions): boolean {
  for (const key of Object.keys(current) as (keyof PluginPermissions)[]) {
    const value = current[key];
    const old = previous[key];
    if (value === undefined || value === false) continue;
    if (value === true) {
      if (old !== true) return false;
    } else if (!Array.isArray(old) || !value.every((item) => old.includes(item))) return false;
  }
  return true;
}

export function recordGrant(file: GrantFile, id: string, permissions: PluginPermissions,
  decision: Grant["decision"], now: () => Date): void {
  file.grants[id] = { decision, at: now().toISOString(), permissionsHash: permissionsHash(permissions), permissions };
}

export function checkGrant(file: GrantFile, id: string, permissions: PluginPermissions, now: () => Date): GrantCheck {
  if (empty(permissions)) {
    recordGrant(file, id, permissions, "granted", now);
    return "updated";
  }
  const grant = file.grants[id];
  if (!grant) return "needs-permission";
  const hash = permissionsHash(permissions);
  if (grant.permissionsHash === hash) return grant.decision;
  if (grant.decision === "granted" && subset(permissions, grant.permissions)) {
    recordGrant(file, id, permissions, "granted", now);
    return "updated";
  }
  return "needs-permission";
}

function isGrant(value: unknown): value is Grant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.permissions === null || typeof item.permissions !== "object" || Array.isArray(item.permissions)) return false;
  const permissions = item.permissions as Record<string, unknown>;
  for (const [key, permission] of Object.entries(permissions)) {
    if (key === "socketMode") {
      if (!Array.isArray(permission) || permission.length > 1 ||
          !permission.every((part: unknown) => part === "slack.com")) return false;
    } else if (["network", "windows", "openExternal"].includes(key)) {
      if (!Array.isArray(permission) || !permission.every((part: unknown) => typeof part === "string")) return false;
    } else if (["secrets", "shell", "orcaRead", "orcaGateResolve", "orcaOpenTerminal"].includes(key)) {
      if (typeof permission !== "boolean") return false;
    } else return false;
  }
  return (item.decision === "granted" || item.decision === "denied") && typeof item.at === "string" &&
    typeof item.permissionsHash === "string" &&
    item.permissionsHash === permissionsHash(item.permissions as PluginPermissions);
}

function blank(): GrantFile {
  return { version: 1, grants: {} };
}

async function grantsPath(userDataDir: string): Promise<string> {
  const root = await realpath(userDataDir);
  const file = path.join(root, "plugin-grants.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("grant file must be regular");
    if (await realpath(file) !== file) throw new Error("grant file leaves user data");
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return file;
}

export async function loadGrants(userDataDir: string): Promise<GrantFile> {
  const file = await grantsPath(userDataDir);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return blank();
    const root = parsed as Record<string, unknown>;
    if (root.version !== 1 || root.grants === null || typeof root.grants !== "object" || Array.isArray(root.grants)) return blank();
    const grants = root.grants as Record<string, unknown>;
    if (!Object.values(grants).every(isGrant)) return blank();
    return { version: 1, grants: grants as Record<string, Grant> };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return blank();
    if (error instanceof SyntaxError) return blank();
    throw error;
  }
}

export async function saveGrants(userDataDir: string, file: GrantFile): Promise<void> {
  const target = await grantsPath(userDataDir);
  const temporary = path.join(path.dirname(target), `.plugin-grants-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(file), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
