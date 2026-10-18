import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@deskpet/plugin-sdk";
import { definePlugin as defineV1Plugin } from "@deskpet/plugin-sdk";
import { definePlugin as defineV2Plugin, pluginBadgeSchema, pluginManifestSchema as v2Schema } from "./v2/index.js";
import type { PluginManifest } from "@deskpet/plugin-sdk";
import type { ValidationResult } from "@deskpet/core";

function expectRejected<T>(result: ValidationResult<T>): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.every((error) => typeof error === "string" && error.length > 0)).toBe(true);
}

// The jungle plugin.json example from docs/plan.md §5-2.
const jungle = {
  id: "jungle",
  name: "정글 출석",
  version: "0.1.0",
  apiVersion: "1",
  entry: "dist/index.js",
  description: "크래프톤 정글 출석 상태를 읽고 마감 전에 알려 준다",
  permissions: {
    network: ["jungle-lms.krafton.com", "accounts.google.com"],
    windows: ["lms-checker"],
    openExternal: ["https://jungle-lms.krafton.com/*"],
    secrets: false,
    shell: false,
  },
  contributes: {
    actions: ["jungle.openCheckIn", "jungle.login", "jungle.refresh"],
    trayItems: ["jungle.refresh"],
    badges: ["jungle.status"],
  },
} satisfies PluginManifest;

describe("PluginManifest contract", () => {
  it("accepts the jungle manifest", () => {
    expect(validatePluginManifest(jungle)).toEqual({ ok: true, value: jungle });
  });

  it.each([
    ["empty permissions and contributes", { ...jungle, permissions: {}, contributes: {} }],
    ["openExternal root wildcard", { ...jungle, permissions: { openExternal: ["https://example.com/*"] } }],
    ["openExternal path wildcard", { ...jungle, permissions: { openExternal: ["https://example.com/path/*"] } }],
  ])("accepts %s", (_label, input) => {
    expect(validatePluginManifest(input)).toEqual({ ok: true, value: input });
  });

  it("allows unknown fields outside permissions", () => {
    expect(validatePluginManifest({ ...jungle, future: true, contributes: { ...jungle.contributes, future: true } }).ok).toBe(true);
  });

  it.each([
    ["unsupported apiVersion", { ...jungle, apiVersion: "3" }],
    ["numeric apiVersion", { ...jungle, apiVersion: 1 }],
    ["missing entry", { ...jungle, entry: undefined }],
    ["missing id", { ...jungle, id: undefined }],
    ["uppercase plugin id", { ...jungle, id: "Jungle" }],
    ["missing name", { ...jungle, name: undefined }],
    ["missing version", { ...jungle, version: undefined }],
    ["missing apiVersion", { ...jungle, apiVersion: undefined }],
    ["missing description", { ...jungle, description: undefined }],
    ["missing permissions", { ...jungle, permissions: undefined }],
    ["missing contributes", { ...jungle, contributes: undefined }],
    ["permissions must be an object", { ...jungle, permissions: ["network"] }],
    ["unknown permission", { ...jungle, permissions: { future: true } }],
    ["network must be a string array", { ...jungle, permissions: { network: "jungle-lms.krafton.com" } }],
    ["network element type", { ...jungle, permissions: { network: [1] } }],
    ["network URL", { ...jungle, permissions: { network: ["https://jungle-lms.krafton.com"] } }],
    ["network wildcard", { ...jungle, permissions: { network: ["*.krafton.com"] } }],
    ["network uppercase", { ...jungle, permissions: { network: ["Jungle-Lms.krafton.com"] } }],
    ["network port", { ...jungle, permissions: { network: ["jungle-lms.krafton.com:443"] } }],
    ["network path", { ...jungle, permissions: { network: ["jungle-lms.krafton.com/path"] } }],
    ["window id empty", { ...jungle, permissions: { windows: [""] } }],
    ["window id uppercase", { ...jungle, permissions: { windows: ["LMS-checker"] } }],
    ["openExternal http", { ...jungle, permissions: { openExternal: ["http://jungle-lms.krafton.com/*"] } }],
    ["openExternal wildcard in middle", { ...jungle, permissions: { openExternal: ["https://jungle-lms.krafton.com/*/status"] } }],
    ["openExternal missing authority", { ...jungle, permissions: { openExternal: ["https://:"] } }],
    ["openExternal bracket authority", { ...jungle, permissions: { openExternal: ["https://["] } }],
    ["openExternal nonnumeric port", { ...jungle, permissions: { openExternal: ["https://example.com:abc/*"] } }],
    ["openExternal insecure scheme", { ...jungle, permissions: { openExternal: ["http://example.com/*"] } }],
    ["openExternal wildcard host", { ...jungle, permissions: { openExternal: ["https://*.example.com/*"] } }],
    ["openExternal numeric port", { ...jungle, permissions: { openExternal: ["https://example.com:8443/*"] } }],
    ["openExternal IP literal", { ...jungle, permissions: { openExternal: ["https://127.0.0.1/*"] } }],
    ["openExternal user info", { ...jungle, permissions: { openExternal: ["https://user@example.com/*"] } }],
    ["secrets must be a boolean", { ...jungle, permissions: { secrets: "yes" } }],
    ["contributes must be an object", { ...jungle, contributes: ["actions"] }],
    ["actions must be a string array", { ...jungle, contributes: { actions: "jungle.refresh" } }],
    ["action element type", { ...jungle, contributes: { actions: [1] } }],
    ["action id without plugin prefix", { ...jungle, contributes: { actions: ["refresh"] } }],
    ["action id with another plugin prefix", { ...jungle, contributes: { actions: ["other.refresh"] } }],
    ["tray item id without plugin prefix", { ...jungle, contributes: { trayItems: ["refresh"] } }],
    ["badge id without plugin prefix", { ...jungle, contributes: { badges: ["status"] } }],
    ["null input", null],
    ["array input", []],
    ["primitive input", 1],
  ])("rejects %s", (_label, input) => {
    expectRejected(validatePluginManifest(input));
  });
});

describe("v2 PluginManifest contract", () => {
  it("keeps v1 emit typed without line while v2 emit accepts it", () => {
    defineV1Plugin({ activate(ctx) {
      // @ts-expect-error v1 emit does not expose line
      ctx.emit({ source: "jungle", type: "notify", line: { id: "jungle.done" } });
    } });
    defineV2Plugin({ activate(ctx) {
      ctx.emit({ source: "orca", type: "notify", line: { id: "orca.done", vars: { task: "A" } } });
    } });
  });

  it("validates v2 catalog paths while retaining the v1 manifest result", () => {
    const base = { ...jungle, apiVersion: "2", contributes: { ...jungle.contributes, lines: "content/lines.json" } };
    expect(validatePluginManifest(base).ok).toBe(true);
    for (const lines of ["", "../lines.json", "content/../lines.json", "/lines.json", "C:/lines.json",
      "content\\lines.json", "content//lines.json", "content/./lines.json", 1])
      expect(validatePluginManifest({ ...base, contributes: { ...base.contributes, lines } }).ok).toBe(false);
    expect(validatePluginManifest({ ...jungle, contributes: { ...jungle.contributes, lines: "lines.json" } }).ok).toBe(true);
  });
  const v2 = { ...jungle, apiVersion: "2", permissions: {
    network: ["slack.com"], socketMode: ["slack.com"], secrets: true,
    openExternal: ["https://app.slack.com/client/*"],
  } };

  it("exports the v2 schema and definition without exposing secrets", () => {
    expect(v2Schema.properties.apiVersion.const).toBe("2");
    expect(v2Schema.properties.contributes.properties.lines).toEqual({ type: "string" });
    expect(pluginBadgeSchema.properties.action).toEqual({ type: "string", maxLength: 128 });
    const definition = defineV2Plugin({ activate(ctx) {
      void ctx.slack.get({ userTokenSecret: "token", method: "users.info" });
      void ctx.orca.snapshot();
      // @ts-expect-error v2 cannot read secret values directly
      void ctx.secrets;
    } });
    expect(definition.activate).toBeTypeOf("function");
  });

  it.each([
    ["declared", v2],
    ["omitted", { ...v2, permissions: {} }],
    ["empty", { ...v2, permissions: { socketMode: [] } }],
  ])("accepts %s socketMode", (_label, input) => {
    expect(validatePluginManifest(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ["empty string", [""]], ["URL", ["https://slack.com"]], ["IP", ["127.0.0.1"]],
    ["wildcard", ["*.slack.com"]], ["uppercase", ["Slack.com"]],
    ["other host", ["example.com"]], ["duplicate", ["slack.com", "slack.com"]],
    ["nonstring", [1]], ["scalar", "slack.com"],
  ])("rejects %s socketMode", (_label, socketMode) => {
    expectRejected(validatePluginManifest({ ...v2, permissions: { socketMode } }));
  });

  it("rejects socketMode in v1 and missing or unsupported versions", () => {
    expectRejected(validatePluginManifest({ ...jungle, permissions: { socketMode: ["slack.com"] } }));
    expectRejected(validatePluginManifest({ ...v2, apiVersion: undefined }));
    expectRejected(validatePluginManifest({ ...v2, apiVersion: "3" }));
  });

  it("accepts v2 Orca permissions and rejects them in v1", () => {
    const permissions = { orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true };
    expect(v2Schema.properties.permissions.properties.orcaRead).toEqual({ type: "boolean" });
    expect(v2Schema.properties.permissions.properties.orcaGateResolve).toEqual({ type: "boolean" });
    expect(v2Schema.properties.permissions.properties.orcaOpenTerminal).toEqual({ type: "boolean" });
    expect(validatePluginManifest({ ...v2, permissions }).ok).toBe(true);
    for (const key of Object.keys(permissions)) {
      expectRejected(validatePluginManifest({ ...jungle, permissions: { [key]: true } }));
    }
  });

  it.each(["orcaRead", "orcaGateResolve", "orcaOpenTerminal"])("requires boolean %s", (key) => {
    for (const value of ["true", 1, null, [], {}]) {
      expectRejected(validatePluginManifest({ ...v2, permissions: { [key]: value } }));
    }
    expect(validatePluginManifest({ ...v2, permissions: { [key]: false } }).ok).toBe(true);
  });
});
