export type { PluginBadge, PluginContext, PluginDefinition, PluginManifest, PluginPermissions,
  OrcaSnapshot, SocketModeEvent, SocketModeStatus } from "./contracts.js";
export { pluginBadgeSchema, pluginManifestSchema } from "./schemas.js";
import type { PluginDefinition } from "./contracts.js";

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
