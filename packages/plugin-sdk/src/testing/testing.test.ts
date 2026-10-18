import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "@deskpet/plugin-sdk";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import type { Disposable } from "@deskpet/plugin-sdk";

const manifest = {
  id: "hello",
  contributes: {
    actions: ["hello.wave"],
    trayItems: ["hello.wave"],
    badges: ["hello.status"],
  },
  permissions: {
    network: ["example.com"],
    openExternal: ["https://example.com/allowed/*"],
    windows: ["checker"],
    shell: true,
    secrets: true,
  },
};

describe("createTestContext", () => {
  it("runs the plan §5-3 hello plugin and cleans up on deactivate", async () => {
    const disposables: Disposable[] = [];
    const hello = definePlugin({
      activate(ctx) {
        disposables.push(ctx.registerAction("hello.wave", () =>
          ctx.emit({ source: "hello", type: "react", mood: "happy", text: "안녕!" })
        ));
        disposables.push(ctx.addTrayItem({ id: "hello.wave", label: "인사하기", action: "hello.wave" }));
      },
      deactivate() { for (const disposable of disposables) disposable.dispose(); },
    });
    const test = createTestContext({ manifest });

    await hello.activate(test.ctx);
    expect(test.actions.has("hello.wave")).toBe(true);
    expect(test.trayItems.get("hello.wave")).toEqual({
      id: "hello.wave", label: "인사하기", action: "hello.wave",
    });
    await test.runAction("hello.wave");
    expect(test.events).toEqual([{ source: "hello", type: "react", mood: "happy", text: "안녕!" }]);

    await hello.deactivate?.();
    expect(test.actions.size).toBe(0);
    expect(test.trayItems.size).toBe(0);
    await expect(test.runAction("hello.wave")).rejects.toThrow("not registered");
  });

  it("rejects undeclared action IDs", () => {
    const { ctx } = createTestContext();
    expect(() => ctx.registerAction("hello.wave", () => {})).toThrow("not declared");
  });

  it("rejects undeclared tray IDs and action targets", () => {
    const { ctx } = createTestContext({ manifest: { contributes: { trayItems: ["hello.wave"] } } });
    expect(() => ctx.addTrayItem({ id: "hello.other", label: "Other", action: "hello.wave" })).toThrow("tray item");
    expect(() => ctx.addTrayItem({ id: "hello.wave", label: "Wave", action: "hello.wave" })).toThrow("tray action");
  });

  it("rejects undeclared badge IDs", () => {
    const { ctx } = createTestContext();
    expect(() => ctx.setBadge("hello.status", { text: "ok" })).toThrow("not declared");
  });

  it("rejects secrets get and set without declared permission", async () => {
    const { ctx } = createTestContext({ secrets: { token: "secret" } });
    await expect(ctx.secrets.get("token")).rejects.toThrow("secrets permission");
    await expect(ctx.secrets.set("token", "changed")).rejects.toThrow("secrets permission");
  });

  it("rejects undeclared window IDs", async () => {
    const { ctx } = createTestContext({ manifest });
    await expect(ctx.windows.create("other", { url: "https://example.com" })).rejects.toThrow("not declared");
  });

  it("rejects windows on undeclared network hosts", async () => {
    const { ctx } = createTestContext({ manifest });
    await expect(ctx.windows.create("checker", { url: "https://other.com" })).rejects.toThrow("network host");
  });

  it("rejects external URLs outside the declared host and path", async () => {
    const test = createTestContext({ manifest });
    await expect(test.ctx.openExternal("https://example.com/other/page")).rejects.toThrow("not allowed");
    await expect(test.ctx.openExternal("https://other.com/allowed/page")).rejects.toThrow("not allowed");
    await test.ctx.openExternal("https://example.com/allowed/page");
    expect(test.openExternalCalls).toEqual(["https://example.com/allowed/page"]);
  });

  it("rejects fetch to undeclared hosts before calling its substitute", async () => {
    const substitute = vi.fn(async () => new Response("ok"));
    const test = createTestContext({ manifest, fetch: substitute });
    await expect(test.ctx.fetch("https://other.com/data")).rejects.toThrow("network host");
    expect(substitute).not.toHaveBeenCalled();
  });

  it("rejects write fetch outside a user-invoked action", async () => {
    const substitute = vi.fn(async () => new Response("ok"));
    const test = createTestContext({ manifest, fetch: substitute });
    await expect(test.ctx.fetch("https://example.com/data", { method: "POST" })).rejects.toThrow("user-invoked action");
    expect(substitute).not.toHaveBeenCalled();
    await test.ctx.fetch("https://example.com/data", { method: "HEAD" });
    expect(substitute).toHaveBeenCalledTimes(1);
  });

  it("allows write fetch within runAction, then closes that scope", async () => {
    const substitute = vi.fn(async () => new Response("ok"));
    const test = createTestContext({ manifest, fetch: substitute });
    test.ctx.registerAction("hello.wave", async (args) => {
      expect(args).toEqual({ count: 1 });
      await test.ctx.fetch("https://example.com/data", { method: "POST" });
    });
    await test.runAction("hello.wave", { count: 1 });
    expect(substitute).toHaveBeenCalledTimes(1);
    await expect(test.ctx.fetch("https://example.com/data", { method: "POST" })).rejects.toThrow("user-invoked action");
  });

  it("closes write permission for detached work after the action returns", async () => {
    const substitute = vi.fn(async () => new Response("ok"));
    const test = createTestContext({ manifest, fetch: substitute });
    let later: Promise<unknown> | undefined;
    test.ctx.registerAction("hello.wave", () => {
      later = new Promise((resolve) => {
        setTimeout(() => {
          void test.ctx.fetch("https://example.com/data", { method: "POST" })
            .then(() => resolve("allowed"), resolve);
        }, 0);
      });
    });
    await test.runAction("hello.wave");
    const result = await later;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("user-invoked action");
    expect(substitute).not.toHaveBeenCalled();
  });

  it("never uses live fetch by default", async () => {
    const { ctx } = createTestContext({ manifest });
    await expect(ctx.fetch("https://example.com/data")).rejects.toThrow("no test fetch substitute");
  });

  it("exposes exec only with shell permission and only in runAction", async () => {
    expect(createTestContext().ctx.exec).toBeUndefined();
    const substitute = vi.fn(async () => ({ stdout: "ok", code: 0 }));
    const test = createTestContext({ manifest, exec: substitute });
    await expect(test.ctx.exec?.("echo", ["ok"])).rejects.toThrow("user-invoked action");
    test.ctx.registerAction("hello.wave", async () => {
      expect(await test.ctx.exec?.("echo", ["ok"])).toEqual({ stdout: "ok", code: 0 });
    });
    await test.runAction("hello.wave");
    expect(substitute).toHaveBeenCalledOnce();
  });

  it("runs schedules and config callbacks manually without write permission", async () => {
    const test = createTestContext({ manifest, fetch: vi.fn(async () => new Response("ok")) });
    const calls: string[] = [];
    const write = () => test.ctx.fetch("https://example.com/data", { method: "POST" }).then(() => {});
    const every = test.ctx.schedule.every(100, async () => { calls.push("every"); await write(); });
    const at = test.ctx.schedule.at("* * * * *", async () => { calls.push("at"); await write(); });
    const resume = test.ctx.schedule.onResume(() => { calls.push("resume"); void write().catch(() => {}); });
    const config = test.ctx.onConfigChange(() => { calls.push("config"); void write().catch(() => {}); });

    await expect(test.runEvery()).rejects.toThrow("user-invoked action");
    await expect(test.runAt()).rejects.toThrow("user-invoked action");
    test.runOnResume();
    test.changeConfig({ theme: "dark" });
    expect(test.ctx.config).toEqual({ theme: "dark" });
    expect(calls).toEqual(["every", "at", "resume", "config"]);
    every.dispose(); at.dispose(); resume.dispose(); config.dispose();
    expect(test.schedules).toEqual({ every: [], at: [], onResume: [] });
    expect(() => test.runOnResume()).toThrow("not registered");
  });

  it("records reactions, badges, logs, secrets, and checker responses; disposal removes registrations", async () => {
    const test = createTestContext({
      manifest,
      config: { enabled: true },
      secrets: { token: "secret" },
      windowResponses: { "/status": { status: 200, body: { ready: true } } },
    });
    expect(test.ctx.config).toEqual({ enabled: true });
    expect(await test.ctx.secrets.get("token")).toBe("secret");
    await test.ctx.secrets.set("token", "changed");
    expect(await test.ctx.secrets.get("token")).toBe("changed");
    const rule = { match: { source: "hello" }, play: "wave" };
    const disposable = test.ctx.addReactionRule(rule);
    test.ctx.setBadge("hello.status", { text: "ready", tone: "ok" });
    test.ctx.log.info("started");
    const window = await test.ctx.windows.create("checker", { url: "https://example.com/login" });
    expect(await window.getJson("/status")).toEqual({ status: 200, body: { ready: true } });
    expect(test.windows[0]?.paths).toEqual(["/status"]);
    await expect(window.getJson("//other.com/status")).rejects.toThrow("same-origin");
    expect(test.reactionRules.has(rule)).toBe(true);
    expect(test.badges.get("hello.status")).toEqual({ text: "ready", tone: "ok" });
    expect(test.logs).toEqual([{ level: "info", message: "started" }]);
    window.show();
    expect(test.windows[0]?.visible).toBe(true);
    window.hide();
    disposable.dispose();
    window.dispose();
    test.ctx.setBadge("hello.status", null);
    expect(test.reactionRules.size).toBe(0);
    expect(test.windows).toEqual([]);
    expect(test.badges.size).toBe(0);
  });
});
