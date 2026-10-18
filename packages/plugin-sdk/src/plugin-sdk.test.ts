import { describe, expect, it } from "vitest";
import { definePlugin, pluginManifestSchema } from "@deskpet/plugin-sdk";
import type { ConfigSchema } from "@deskpet/plugin-sdk";

// The minimal hello plugin from docs/plan.md §5-3.
const hello = definePlugin({
  activate(ctx) {
    ctx.registerAction("hello.wave", () =>
      ctx.emit({ source: "hello", type: "react", mood: "happy", text: "안녕!" })
    );
    ctx.addTrayItem({ id: "hello.wave", label: "인사하기", action: "hello.wave" });
  },
});

describe("plugin SDK v1", () => {
  it("returns the typed plugin definition unchanged", () => {
    expect(definePlugin(hello)).toBe(hello);
  });

  it("exports a draft 2020-12 manifest schema with the required shape", () => {
    expect(pluginManifestSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(pluginManifestSchema.type).toBe("object");
    expect(pluginManifestSchema.required).toEqual([
      "id", "name", "version", "apiVersion", "entry", "description", "permissions", "contributes",
    ]);
    expect(pluginManifestSchema.properties.apiVersion.const).toBe("1");
    expect(pluginManifestSchema.properties.permissions.properties.network.items.pattern).toBeDefined();
    expect(pluginManifestSchema.properties.permissions.properties.secrets).toEqual({ type: "boolean" });
    expect(pluginManifestSchema.properties.contributes.properties.actions.items.pattern).toBeDefined();
    expect(pluginManifestSchema.properties.permissions.additionalProperties).toBe(false);
    expect(pluginManifestSchema.properties.contributes.additionalProperties).toBe(true);
    expect(pluginManifestSchema.additionalProperties).toBe(true);
  });

  it("restricts permission and contribution identifier formats", () => {
    const permissions = pluginManifestSchema.properties.permissions.properties;
    const contributes = pluginManifestSchema.properties.contributes.properties;
    const network = new RegExp(permissions.network.items.pattern);
    const openExternal = new RegExp(permissions.openExternal.items.pattern);
    const windows = new RegExp(permissions.windows.items.pattern);
    const action = new RegExp(contributes.actions.items.pattern);
    const pluginId = new RegExp(pluginManifestSchema.properties.id.pattern);

    expect(network.test("jungle-lms.krafton.com")).toBe(true);
    for (const host of ["https://jungle-lms.krafton.com", "*.krafton.com", "Jungle.com", "host:443", "host/path", "-host.com"]) {
      expect(network.test(host)).toBe(false);
    }
    expect(openExternal.test("https://jungle-lms.krafton.com/*")).toBe(true);
    expect(openExternal.test("https://jungle-lms.krafton.com/path/*")).toBe(true);
    for (const pattern of ["http://jungle-lms.krafton.com/*", "https://jungle-lms.krafton.com/*/path", "https://*.krafton.com/"]) {
      expect(openExternal.test(pattern)).toBe(false);
    }
    expect(windows.test("lms-checker")).toBe(true);
    expect(windows.test("")).toBe(false);
    expect(windows.test("LMS-checker")).toBe(false);
    expect(action.test("jungle.openCheckIn")).toBe(true);
    expect(action.test("openCheckIn")).toBe(false);
    expect(action.test("Jungle.openCheckIn")).toBe(false);
    expect(pluginId.test("jungle-1")).toBe(true);
    expect(pluginId.test("Jungle")).toBe(false);
  });

  it("restricts openExternal to HTTPS host paths with a trailing wildcard", () => {
    const pattern = new RegExp(pluginManifestSchema.properties.permissions.properties.openExternal.items.pattern);
    for (const value of [
      "https://jungle-lms.krafton.com/*",
      "https://example.com/*",
      "https://example.com/path/*",
    ]) {
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of [
      "https://:",
      "https://[",
      "https://example.com:abc/*",
      "http://example.com/*",
      "https://*.example.com/*",
      "https://example.com:8443/*",
      "https://127.0.0.1/*",
      "https://user@example.com/*",
      "https://example.com/*/path",
    ]) {
      expect(pattern.test(value)).toBe(false);
    }
  });
});

describe("config schema object items (D-022)", () => {
  it("accepts string items and object items with scalar properties", () => {
    const schema: ConfigSchema = { type: "object", properties: {
      tags: { type: "array", items: { type: "string" } },
      rules: { type: "array", items: { type: "object", required: ["id"], properties: {
        id: { type: "string", title: "ID" },
        count: { type: "number", default: 1 },
        on: { type: "boolean" },
        level: { type: "string", enum: ["low", "high"] },
      } } },
    } };
    expect(schema.properties.rules?.items?.type).toBe("object");
    definePlugin({ configSchema: schema, activate() {} });
  });

  it("accepts flat string or number arrays with an element enum as item properties", () => {
    const schema: ConfigSchema = { type: "object", properties: { rules: { type: "array", items: { type: "object", properties: {
      days: { type: "array", title: "요일", items: { type: "number" }, enum: [0, 1, 2, 3, 4, 5, 6] },
      tags: { type: "array", items: { type: "string" } },
    } } } } };
    expect(schema.properties.rules?.items?.type).toBe("object");
    definePlugin({ configSchema: schema, activate() {} });
  });

  it("rejects arrays without a flat element type at compile time", () => {
    const schema: ConfigSchema = { type: "object", properties: { rules: { type: "array", items: { type: "object", properties: {
      // @ts-expect-error an array property must declare its element type
      none: { type: "array" },
      // @ts-expect-error array elements are strings or numbers, not booleans
      flags: { type: "array", items: { type: "boolean" } },
      // @ts-expect-error array elements cannot be arrays
      nested: { type: "array", items: { type: "array" } },
    } } } } };
    expect(schema.type).toBe("object");
  });

  it("rejects nested arrays and objects as item properties at compile time", () => {
    const schema: ConfigSchema = { type: "object", properties: { rules: { type: "array", items: { type: "object", properties: {
      // @ts-expect-error object item properties cannot be objects
      nested: { type: "object" },
    } } } } };
    expect(schema.type).toBe("object");
  });
});
