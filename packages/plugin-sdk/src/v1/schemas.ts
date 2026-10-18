const networkHostPattern = "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$";
const openExternalPattern = `^https://(?![0-9.]+/)${networkHostPattern.slice(1, -1)}/(?:[^\\s*]*(?:/\\*)?|\\*)$`;
const contributionIdPattern = "^[a-z0-9-]+\\.[^.]+$";
const pluginIdPattern = "^[a-z0-9-]+$";
const windowIdPattern = "^[a-z0-9-]+$";

export const pluginManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["id", "name", "version", "apiVersion", "entry", "description", "permissions", "contributes"],
  properties: {
    id: { type: "string", pattern: pluginIdPattern },
    name: { type: "string" },
    version: { type: "string" },
    apiVersion: { const: "1" },
    entry: { type: "string" },
    description: { type: "string" },
    permissions: {
      type: "object",
      properties: {
        network: { type: "array", items: { type: "string", pattern: networkHostPattern } },
        windows: { type: "array", items: { type: "string", pattern: windowIdPattern } },
        openExternal: { type: "array", items: { type: "string", pattern: openExternalPattern } },
        secrets: { type: "boolean" },
        shell: { type: "boolean" },
      },
      additionalProperties: false,
    },
    contributes: {
      type: "object",
      properties: {
        actions: { type: "array", items: { type: "string", pattern: contributionIdPattern } },
        trayItems: { type: "array", items: { type: "string", pattern: contributionIdPattern } },
        badges: { type: "array", items: { type: "string", pattern: contributionIdPattern } },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const;
