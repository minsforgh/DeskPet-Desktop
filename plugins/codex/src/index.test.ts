import { describe, expect, it } from "vitest";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import plugin from "./index.js";

describe("codex plugin", () => {
  it("registers mood-specific rules by default", async () => {
    const test = createTestContext();
    await plugin.activate(test.ctx);
    expect([...test.reactionRules]).toEqual([
      { match: { source: "codex", type: "notify", mood: "happy" }, play: "happy" },
      { match: { source: "codex", type: "notify", mood: "worried" }, play: "worried" },
    ]);
  });

  it("does not register rules when disabled and reacts to config changes", async () => {
    const test = createTestContext({ config: { enabled: false } });
    await plugin.activate(test.ctx);
    expect(test.reactionRules).toEqual(new Set());
    test.changeConfig({ enabled: true });
    expect(test.reactionRules).toHaveLength(2);
    test.changeConfig({ enabled: false });
    expect(test.reactionRules).toEqual(new Set());
    await plugin.deactivate?.();
  });
});
