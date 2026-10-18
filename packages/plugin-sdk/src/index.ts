import { isIP } from "node:net";
import type { ValidationResult } from "@deskpet/core";
import { pluginManifestSchema } from "./v1/index.js";
import type { PluginDefinition, PluginManifest as V1PluginManifest,
  PluginPermissions as V1PluginPermissions } from "./v1/index.js";
import { pluginManifestSchema as v2PluginManifestSchema } from "./v2/index.js";
import type { PluginManifest as V2PluginManifest,
  PluginPermissions as V2PluginPermissions } from "./v2/index.js";

export type PluginManifest = V1PluginManifest | V2PluginManifest;
export type PluginPermissions = V1PluginPermissions | V2PluginPermissions;

export type {
  CheckerWindowHandle,
  CheckerWindowOptions,
  ConfigFieldSchema,
  ConfigItemsSchema,
  ConfigSchema,
  Disposable,
  Logger,
  ObjectItemField,
  PluginContext,
  PluginContributions,
  PluginDefinition,
} from "./v1/index.js";
export { pluginManifestSchema } from "./v1/index.js";

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export function validatePluginManifest(input: unknown): ValidationResult<PluginManifest> {
  if (!isObject(input)) return { ok: false, errors: ["manifest must be an object"] };
  if (input.apiVersion !== "1" && input.apiVersion !== "2") {
    return { ok: false, errors: ['apiVersion must be "1" or "2"'] };
  }
  const schema = input.apiVersion === "2" ? v2PluginManifestSchema : pluginManifestSchema;
  const errors: string[] = [];
  for (const field of ["id", "name", "version", "entry", "description"] as const) {
    if (typeof input[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (typeof input.id === "string" && !new RegExp(pluginManifestSchema.properties.id.pattern).test(input.id)) errors.push("id has invalid format");

  if (!isObject(input.permissions)) errors.push("permissions must be an object");
  else {
    const permissions = input.permissions;
    for (const key of Object.keys(permissions)) {
      if (!(key in schema.properties.permissions.properties)) errors.push(`permissions.${key} is unknown`);
    }
    for (const field of ["network", "windows", "openExternal"] as const) {
      if (!Object.hasOwn(permissions, field)) continue;
      const value = permissions[field];
      if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
        errors.push(`permissions.${field} must be a string array`);
        continue;
      }
      for (const item of value) {
        if (field === "openExternal" ? !validExternalPattern(item) :
          !new RegExp(pluginManifestSchema.properties.permissions.properties[field].items.pattern).test(item)) {
          errors.push(`permissions.${field} has invalid format`);
        }
      }
    }
    for (const field of ["secrets", "shell"] as const) {
      if (Object.hasOwn(permissions, field) && typeof permissions[field] !== "boolean") errors.push(`permissions.${field} must be boolean`);
    }
    if (input.apiVersion === "2" && Object.hasOwn(permissions, "socketMode")) {
      const value = permissions.socketMode;
      if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
        errors.push("permissions.socketMode must be a string array");
      } else if (new Set(value).size !== value.length ||
          value.some((item) => item !== v2PluginManifestSchema.properties.permissions.properties.socketMode.items.const)) {
        errors.push("permissions.socketMode has invalid format");
      }
    }
    if (input.apiVersion === "2") {
      for (const field of ["orcaRead", "orcaGateResolve", "orcaOpenTerminal"] as const) {
        if (Object.hasOwn(permissions, field) && typeof permissions[field] !== "boolean")
          errors.push(`permissions.${field} must be boolean`);
      }
    }
  }

  if (!isObject(input.contributes)) errors.push("contributes must be an object");
  else {
    if (input.apiVersion === "2" && Object.hasOwn(input.contributes, "lines")) {
      const lines = input.contributes.lines;
      if (typeof lines !== "string" || !lines || lines.length > 260 || lines.includes("\\") ||
          lines.includes(":") || lines.startsWith("/") ||
          lines.split("/").some((part) => !part || part === "." || part === ".." ||
            Array.from(part).some((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code < 32 || (code >= 127 && code <= 159);
            }))) errors.push("contributes.lines has invalid path");
    }
    for (const field of ["actions", "trayItems", "badges"] as const) {
      if (!Object.hasOwn(input.contributes, field)) continue;
      const value = input.contributes[field];
      if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
        errors.push(`contributes.${field} must be a string array`);
        continue;
      }
      for (const item of value) {
        if (!new RegExp(pluginManifestSchema.properties.contributes.properties[field].items.pattern).test(item) ||
            typeof input.id !== "string" || !item.startsWith(`${input.id}.`)) {
          errors.push(`contributes.${field} has invalid format`);
        }
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as PluginManifest };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validExternalPattern(value: string): boolean {
  if (!new RegExp(pluginManifestSchema.properties.permissions.properties.openExternal.items.pattern).test(value)) return false;
  try {
    const url = new URL(value.endsWith("*") ? `${value.slice(0, -1)}placeholder` : value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      isIP(url.hostname) === 0 && !url.hostname.startsWith("[");
  } catch {
    return false;
  }
}
