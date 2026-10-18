import { pluginManifestSchema as v1PluginManifestSchema } from "../v1/schemas.js";

export const pluginBadgeSchema = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", maxLength: 40 },
    tone: { enum: ["neutral", "warn", "ok"] },
    action: { type: "string", maxLength: 128 },
  },
} as const;

export const pluginManifestSchema = {
  ...v1PluginManifestSchema,
  properties: {
    ...v1PluginManifestSchema.properties,
    apiVersion: { const: "2" },
    contributes: {
      ...v1PluginManifestSchema.properties.contributes,
      properties: {
        ...v1PluginManifestSchema.properties.contributes.properties,
        lines: { type: "string" },
      },
    },
    permissions: {
      ...v1PluginManifestSchema.properties.permissions,
      properties: {
        ...v1PluginManifestSchema.properties.permissions.properties,
        socketMode: { type: "array", uniqueItems: true, items: { type: "string", const: "slack.com" } },
        orcaRead: { type: "boolean" },
        orcaGateResolve: { type: "boolean" },
        orcaOpenTerminal: { type: "boolean" },
      },
    },
  },
} as const;
