import { readFileSync } from "node:fs";
import { parseLines } from "@deskpet/core";
import type { LineCatalog } from "@deskpet/core";
import { describe, expect, it, vi } from "vitest";
import type { CheckerWindowHandle, PluginContext, PluginDefinition, PluginManifest } from "@deskpet/plugin-sdk";
import type { PluginDefinition as V2PluginDefinition } from "@deskpet/plugin-sdk/v2";
import reminders from "../../../plugins/reminders/src/index.js";
import { MemoryPluginChannel } from "./channel.js";
import type { Envelope } from "./envelope.js";
import { runPlugin } from "./runner.js";
import { PluginSession } from "./session.js";
import type { SessionHost } from "./session.js";

// The v2 session accepts line events only against the plugin's real catalog, as discovery loads it.
const remindersLines: LineCatalog = parseLines(
  JSON.parse(readFileSync(new URL("../../../plugins/reminders/lines.json", import.meta.url), "utf8")),
  "reminders",
).catalog;

type RequestEnvelope = Extract<Envelope, { kind: "req" }>;

const remindersManifest: PluginManifest = {
  id: "reminders", name: "Reminders", version: "0.0.0", apiVersion: "2", entry: "index.js", description: "",
  permissions: {}, contributes: {},
};

const demoManifest: PluginManifest = {
  id: "demo", name: "Demo", version: "1.0.0", apiVersion: "1", entry: "index.js", description: "",
  permissions: { network: ["example.com"], openExternal: ["https://example.com/a/*"], secrets: true, shell: true },
  contributes: { actions: ["demo.run", "demo.other"], trayItems: ["demo.tray"], badges: ["demo.badge"] },
};

function code(response: Envelope): string | undefined {
  return response.kind === "res" && !response.ok ? response.error.code : undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function isRequest(message: unknown): message is RequestEnvelope {
  return message !== null && typeof message === "object" && "kind" in message && message.kind === "req";
}

/** Real PluginSession on the main side of a memory channel pair, the runner on the other side. */
function setup(manifest: PluginManifest, definition: PluginDefinition | V2PluginDefinition,
  override: Partial<SessionHost> = {}, lines?: LineCatalog) {
  const [main, plugin] = MemoryPluginChannel.pair();
  const cleanup = vi.fn();
  const host: SessionHost = {
    emit: vi.fn(), register: vi.fn(() => cleanup), setBadge: vi.fn(),
    fetch: vi.fn(async () => new Response("ok", { status: 201, statusText: "Created", headers: { "x-a": "b" } })),
    openExternal: vi.fn(), exec: vi.fn(async () => ({ stdout: "out", code: 0 })),
    secrets: { get: vi.fn(async () => "secret"), set: vi.fn(async () => {}) }, log: vi.fn(), ...override,
  };
  const session = new PluginSession(manifest, main, host, () => 1000, lines);
  const seen: RequestEnvelope[] = [];
  main.onMessage((message) => { if (isRequest(message)) seen.push(message); });
  const running = runPlugin(plugin, async () => definition);
  // Manual requests use ids far from the session's own invokeAction ids.
  let nextId = 1000;
  function request(method: string, params: unknown): Promise<Envelope> {
    const id = nextId++;
    return new Promise((resolve) => {
      const off = main.onMessage((message) => {
        if (message !== null && typeof message === "object" && "kind" in message &&
            message.kind === "res" && "id" in message && message.id === id) {
          off(); resolve(message as Envelope);
        }
      });
      main.post({ v: 1, kind: "req", id, method, params });
    });
  }
  const activate = (config: Record<string, unknown> = {}) =>
    request("activate", { config, permissions: manifest.permissions });
  const handleOf = (kind: string, index = 0): number => {
    const calls = vi.mocked(host.register).mock.calls.filter((call) => call[1] === kind);
    const handle = calls[index]?.[2];
    if (handle === undefined) throw new Error(`no ${kind} registration`);
    return handle;
  };
  return { main, plugin, host, session, seen, running, request, activate, handleOf, cleanup };
}

describe("runPlugin with the reminders plugin", () => {
  it("exposes v2 Orca proxies through the session permission boundary", async () => {
    const manifest: PluginManifest = { ...demoManifest, apiVersion: "2", permissions: {
      orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true,
    } };
    const results: unknown[] = [];
    const definition: V2PluginDefinition = { async activate(ctx) {
      results.push(errorCode(await rejection(ctx.orca.snapshot())));
      results.push(errorCode(await rejection(ctx.orca.resolveGate("gate", "yes"))));
      results.push(errorCode(await rejection(ctx.orca.muteGate("gate"))));
      results.push(errorCode(await rejection(ctx.orca.openTerminal("term"))));
    } };
    const app = setup(manifest, definition);
    expect(code(await app.activate())).toBeUndefined();
    expect(results).toEqual(["E_UNAVAILABLE", "E_PERMISSION", "E_PERMISSION", "E_PERMISSION"]);
    expect(app.seen.map((request) => request.method)).toContain("orca.snapshot");
    expect(app.seen.map((request) => request.method)).toContain("orca.resolveGate");
    expect(app.seen.map((request) => request.method)).toContain("orca.muteGate");
    expect(app.seen.map((request) => request.method)).toContain("orca.openTerminal");
    expect(app.host.exec).not.toHaveBeenCalled();
    expect(code(await app.request("shutdown", {}))).toBeUndefined();
    await expect(app.running).resolves.toBeUndefined();
  });
  it("connects v2 callbacks and proxies Slack GET without exposing a token", async () => {
    const manifest: PluginManifest = { ...demoManifest, apiVersion: "2",
      permissions: { network: ["slack.com"], socketMode: ["slack.com"], secrets: true } };
    const results: unknown[] = [];
    const definition: V2PluginDefinition = { async activate(ctx) {
      const connection = await ctx.slack.connect({
        appTokenSecret: "appToken", onEvent() {}, onStatus() {},
      });
      results.push(await ctx.slack.get({
        userTokenSecret: "userToken", method: "users.info",
      }));
      results.push(errorCode(await rejection(ctx.slack.get({
        userTokenSecret: "userToken", method: "conversations.info",
      }))));
      connection.dispose();
    } };
    const openConnection = vi.fn(async () => ({ status: 200, body: { ok: false, error: "invalid_auth" } }));
    const get = vi.fn().mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"echo":"secret"}', { status: 200 }));
    const app = setup(manifest, definition, { slack: {
      transport: { openConnection, connectWebSocket: vi.fn() }, get,
    } });
    expect((await app.activate()).kind).toBe("res");
    expect(results).toEqual([{ status: 200, body: { ok: true } }, "E_UNAVAILABLE"]);
    expect(get).toHaveBeenCalledWith("https://slack.com/api/users.info", expect.objectContaining({
      method: "GET", headers: { Authorization: "Bearer secret" },
    }));
    expect(openConnection).toHaveBeenCalledWith("secret");
    expect(code(await app.request("shutdown", {}))).toBeUndefined();
    await expect(app.running).resolves.toBeUndefined();
  });
  it("reports the schema, registers schedules and emits when the callback is invoked", async () => {
    const app = setup(remindersManifest, reminders, {}, remindersLines);
    expect(code(await app.activate({ rules: [{ id: "r1", time: "09:30", text: "stretch" }] }))).toBeUndefined();
    const [hello] = app.seen;
    expect(hello?.method).toBe("hello");
    expect(hello?.params).toMatchObject({ configSchema: { properties: { rules: { type: "array" } } } });
    expect(app.host.register).toHaveBeenCalledWith("reminders", "schedule.at", 1, { cron: "30 09 * * *", opts: undefined });
    expect(app.host.register).toHaveBeenCalledWith("reminders", "onConfigChange", 2, null);

    expect(code(await app.request("invoke", { handle: app.handleOf("schedule.at") }))).toBeUndefined();
    await vi.waitFor(() => expect(app.host.emit).toHaveBeenCalledWith(
      { source: "reminders", type: "notify", key: "r1",
        line: { id: "reminders.rule", vars: { message: "stretch" } } }));
  });

  it("re-registers schedules on config.changed and disposes the old ones", async () => {
    const app = setup(remindersManifest, reminders, {}, remindersLines);
    await app.activate({ rules: [{ id: "r1", time: "09:30", text: "a" }] });
    expect(code(await app.request("config.changed", { config: { rules: [{ id: "r2", time: "10:15", text: "b" }] } })))
      .toBeUndefined();
    await vi.waitFor(() => expect(app.cleanup).toHaveBeenCalledTimes(1));
    expect(app.host.register).toHaveBeenLastCalledWith("reminders", "schedule.at", 3, { cron: "15 10 * * *", opts: undefined });
    await app.request("invoke", { handle: 3 });
    await vi.waitFor(() => expect(app.host.emit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "r2", line: { id: "reminders.rule", vars: { message: "b" } } })));
  });

  it("deactivates and resolves on shutdown", async () => {
    const app = setup(remindersManifest, reminders);
    await app.activate({ rules: [{ id: "r1", time: "09:30", text: "a" }] });
    expect(code(await app.request("deactivate", {}))).toBeUndefined();
    // The schedule and the onConfigChange listener are both disposed by the plugin.
    await vi.waitFor(() => expect(app.cleanup).toHaveBeenCalledTimes(2));
    expect(code(await app.request("shutdown", {}))).toBeUndefined();
    await expect(app.running).resolves.toBeUndefined();
  });
});

describe("user action context", () => {
  const writing: PluginDefinition = {
    activate(ctx) {
      ctx.registerAction("demo.run", async () => {
        await Promise.resolve();
        const response = await ctx.fetch(new URL("https://example.com/x"), {
          method: "post", headers: { "X-Test": "1" }, body: "hi",
        });
        await ctx.openExternal("https://example.com/a/b");
        const result = await ctx.exec?.("tool", ["-v"]);
        await ctx.secrets.set("k", `${response.status}:${await response.text()}:${result?.stdout}`);
      });
      ctx.schedule.every(1000, async () => { await ctx.fetch("https://example.com/x", { method: "POST" }); });
      ctx.schedule.every(2000, async () => { await ctx.openExternal("https://example.com/a/b"); });
      ctx.schedule.every(3000, async () => { await ctx.exec?.("tool", []); });
      ctx.schedule.every(4000, async () => { await ctx.fetch("https://example.com/x"); });
    },
  };

  it("carries inv on every request of an action handler, across awaits", async () => {
    const app = setup(demoManifest, writing);
    await app.activate();
    const response = await app.session.invokeAction("demo.run");
    expect(response).toMatchObject({ kind: "res", ok: true });
    const writes = app.seen.filter((entry) => ["fetch", "openExternal", "exec", "secrets.set"].includes(entry.method));
    expect(writes.map((entry) => entry.method)).toEqual(["fetch", "openExternal", "exec", "secrets.set"]);
    expect(typeof writes[0]?.inv).toBe("string");
    expect(writes.every((entry) => entry.inv === writes[0]?.inv)).toBe(true);
    expect(writes[0]?.params).toEqual({
      url: "https://example.com/x", method: "POST", headers: [["x-test", "1"]], body: "hi",
    });
    expect(app.host.fetch).toHaveBeenCalledWith("https://example.com/x", expect.objectContaining({ method: "POST" }));
    expect(app.host.openExternal).toHaveBeenCalledWith("https://example.com/a/b");
    expect(app.host.secrets.set).toHaveBeenCalledWith("demo", "k", "201:ok:out");
  });

  it("rejects writes from schedule callbacks but allows GET", async () => {
    const app = setup(demoManifest, writing);
    await app.activate();
    const results = [];
    for (let index = 0; index < 4; index++)
      results.push(await app.request("invoke", { handle: app.handleOf("schedule.every", index) }));
    expect(results.map(code)).toEqual(["E_PERMISSION", "E_PERMISSION", "E_PERMISSION", undefined]);
    expect(app.seen.filter((entry) => entry.method === "fetch").every((entry) => entry.inv === undefined)).toBe(true);
    expect(app.host.fetch).toHaveBeenCalledTimes(1);
    expect(app.host.openExternal).not.toHaveBeenCalled();
    expect(app.host.exec).not.toHaveBeenCalled();
  });

  it("does not leak inv into a later handler without context", async () => {
    const app = setup(demoManifest, writing);
    await app.activate();
    await app.session.invokeAction("demo.run");
    const result = await app.request("invoke", { handle: app.handleOf("schedule.every", 0) });
    expect(code(result)).toBe("E_PERMISSION");
  });

  it("exposes exec only with permissions.shell", async () => {
    let exposed: boolean | undefined;
    const probe: PluginDefinition = { activate(ctx) { exposed = "exec" in ctx; } };
    await setup(demoManifest, probe).activate();
    expect(exposed).toBe(true);
    const noShell = { ...demoManifest, permissions: { network: ["example.com"] } };
    await setup(noShell, probe).activate();
    expect(exposed).toBe(false);
  });

  it("uses config and permissions from init when activate carries none", async () => {
    let seen: { config: unknown; exec: boolean } | undefined;
    const probe: PluginDefinition = { activate(ctx) { seen = { config: ctx.config, exec: "exec" in ctx }; } };
    const app = setup(demoManifest, probe);
    expect(code(await app.request("init", { config: { count: 2 }, permissions: { shell: true } }))).toBeUndefined();
    expect(code(await app.request("activate", {}))).toBeUndefined();
    expect(seen).toEqual({ config: { count: 2 }, exec: true });
  });
});

describe("value handling", () => {
  it("rejects non-serializable values before sending", async () => {
    let emitError: unknown;
    let bodyErrors: unknown[] = [];
    const definition: PluginDefinition = {
      async activate(ctx) {
        try { ctx.emit({ source: "demo", type: "notify", actions: [{ label: "a", action: "demo.run", args: () => {} }] }); }
        catch (error) { emitError = error; }
        bodyErrors = await Promise.all([new ReadableStream(), new FormData(), new Blob(["x"]), new URLSearchParams("a=b")]
          .map((body) => rejection(ctx.fetch("https://example.com/", { method: "POST", body }))));
      },
    };
    const app = setup(demoManifest, definition);
    expect(code(await app.activate())).toBeUndefined();
    expect(errorCode(emitError)).toBe("E_NOT_SERIALIZABLE");
    expect(bodyErrors.map(errorCode)).toEqual(Array(4).fill("E_NOT_SERIALIZABLE"));
    expect(app.seen.map((entry) => entry.method)).toEqual(["hello"]);
  });

  it("flattens a Request into the wire shape", async () => {
    const definition: PluginDefinition = {
      async activate(ctx) {
        await ctx.fetch(new Request("https://example.com/r", { method: "PUT", headers: { a: "1" }, body: "req" }));
      },
    };
    const app = setup(demoManifest, definition);
    // Outside a handler the write is refused by main, which fails the activation.
    expect(code(await app.activate())).toBe("E_PERMISSION");
    const fetched = app.seen.find((entry) => entry.method === "fetch");
    expect(fetched?.params).toEqual({
      url: "https://example.com/r", method: "PUT", body: new Uint8Array([114, 101, 113]),
      headers: [["a", "1"], ["content-type", "text/plain;charset=UTF-8"]],
    });
  });

  it("freezes config and replaces it on config.changed", async () => {
    const seenConfigs: unknown[] = [];
    let ctxRef: PluginContext | undefined;
    const definition: PluginDefinition = {
      activate(ctx) {
        ctxRef = ctx;
        ctx.onConfigChange((next) => { seenConfigs.push(next); });
      },
    };
    const app = setup(demoManifest, definition);
    await app.activate({ nested: { list: [1] } });
    const first = ctxRef?.config;
    expect(first).toEqual({ nested: { list: [1] } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.nested)).toBe(true);
    await app.request("config.changed", { config: { nested: { list: [2] } } });
    expect(ctxRef?.config).toEqual({ nested: { list: [2] } });
    expect(ctxRef?.config).not.toBe(first);
    expect(seenConfigs).toEqual([{ nested: { list: [2] } }]);
    expect(Object.isFrozen(seenConfigs[0])).toBe(true);
  });

  it("proxies secrets, badges, tray items, reaction rules, log and windows", async () => {
    let windowError: unknown;
    const definition: PluginDefinition = {
      async activate(ctx) {
        expect(await ctx.secrets.get("k")).toBe("secret");
        ctx.registerAction("demo.run", () => {});
        ctx.addTrayItem({ id: "demo.tray", label: "Run", action: "demo.run" });
        ctx.addReactionRule({ match: { source: "demo" }, play: "wave" });
        ctx.setBadge("demo.badge", { text: "1", tone: "ok" });
        ctx.log.info("x".repeat(5000));
        windowError = await rejection(ctx.windows.create("clock", { url: "https://example.com/" }));
      },
    };
    const app = setup(demoManifest, definition);
    expect(code(await app.activate())).toBeUndefined();
    expect(app.host.register).toHaveBeenCalledWith("demo", "trayItem", 2, { id: "demo.tray", action: "demo.run", label: "Run" });
    expect(app.host.register).toHaveBeenCalledWith("demo", "reactionRule", 3, { match: { source: "demo" }, play: "wave" });
    expect(app.host.setBadge).toHaveBeenCalledWith("demo", "demo.badge", { text: "1", tone: "ok" });
    await vi.waitFor(() => expect(app.host.log).toHaveBeenCalledWith("info", "x".repeat(2048), "demo"));
    // Real windows arrive in M5; until then main refuses (undeclared window id).
    expect(errorCode(windowError)).toBe("E_PERMISSION");
  });
});

describe("dispose and failures", () => {
  it("makes dispose idempotent and allows registering the id again", async () => {
    let first: { dispose(): void } | undefined;
    let ctxRef: PluginContext | undefined;
    const definition: PluginDefinition = {
      activate(ctx) { ctxRef = ctx; first = ctx.registerAction("demo.run", () => {}); },
    };
    const app = setup(demoManifest, definition);
    await app.activate();
    first?.dispose();
    first?.dispose();
    await vi.waitFor(() => expect(app.cleanup).toHaveBeenCalledTimes(1));
    expect(app.seen.filter((entry) => entry.method === "dispose")).toHaveLength(1);
    // The disposed handle is gone from the runner.
    expect(code(await app.request("invoke", { handle: 1 }))).toBe("E_DISPOSED");
    ctxRef?.registerAction("demo.run", () => {});
    await vi.waitFor(() => expect(app.host.register).toHaveBeenCalledTimes(2));
    first?.dispose();
    expect(app.seen.filter((entry) => entry.method === "dispose")).toHaveLength(1);
  });

  it("answers a throwing handler with ok:false and keeps running", async () => {
    const definition: PluginDefinition = {
      activate(ctx) {
        ctx.registerAction("demo.run", () => { throw new Error("boom"); });
        ctx.registerAction("demo.other", () => {});
      },
    };
    const app = setup(demoManifest, definition);
    await app.activate();
    const failed = await app.session.invokeAction("demo.run");
    expect(failed).toMatchObject({ ok: false, error: { code: "E_UNAVAILABLE", message: "boom" } });
    expect(await app.session.invokeAction("demo.other")).toMatchObject({ ok: true });
  });

  it("fails activation when activate throws or a registration is refused", async () => {
    const throwing = setup(demoManifest, { activate() { throw new Error("nope"); } });
    expect(await throwing.activate()).toMatchObject({ ok: false, error: { message: "nope" } });
    const undeclared = setup(demoManifest, { activate(ctx: PluginContext) { ctx.registerAction("demo.missing", () => {}); } });
    expect(code(await undeclared.activate())).toBe("E_PERMISSION");
    const twice = setup(demoManifest, { activate() {} });
    await twice.activate();
    expect(code(await twice.activate())).toBe("E_UNAVAILABLE");
  });

  it("rejects when the entry fails to load", async () => {
    const [, plugin] = MemoryPluginChannel.pair();
    await expect(runPlugin(plugin, async () => { throw new Error("import failed"); })).rejects.toThrow("import failed");
  });
});

describe("requests and abort", () => {
  it("turns an AbortSignal into fetch.abort and rejects with AbortError", async () => {
    const controller = new AbortController();
    let outcome: Promise<unknown> | undefined;
    let hostSignal: AbortSignal | null | undefined;
    const definition: PluginDefinition = {
      activate(ctx) { outcome = rejection(ctx.fetch("https://example.com/slow", { signal: controller.signal })); },
    };
    const app = setup(demoManifest, definition, {
      fetch: vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
        hostSignal = init.signal;
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
    });
    await app.activate();
    await vi.waitFor(() => expect(hostSignal).toBeTruthy());
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(hostSignal?.aborted).toBe(true));
    expect(app.seen.some((entry) => entry.method === "fetch.abort")).toBe(true);
  });

  it("rejects an already aborted signal without sending", async () => {
    let outcome: unknown;
    const definition: PluginDefinition = {
      async activate(ctx) { outcome = await rejection(ctx.fetch("https://example.com/", { signal: AbortSignal.abort() })); },
    };
    const app = setup(demoManifest, definition);
    await app.activate();
    expect(outcome).toMatchObject({ name: "AbortError" });
    expect(app.seen.map((entry) => entry.method)).toEqual(["hello"]);
  });

  it("rejects a request with E_TIMEOUT when no response arrives in 35 seconds", async () => {
    const [main, plugin] = MemoryPluginChannel.pair();
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const after = (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    };
    let outcome: Promise<unknown> | undefined;
    void runPlugin(plugin, async () => ({ activate(ctx: PluginContext) { outcome = rejection(ctx.secrets.get("k")); } }), { after });
    main.onMessage((message) => {
      if (isRequest(message) && message.method === "hello") main.post({ v: 1, kind: "res", id: message.id, ok: true, value: null });
    });
    main.post({ v: 1, kind: "req", id: 1, method: "activate", params: { config: {}, permissions: {} } });
    await vi.waitFor(() => expect(timers.some((timer) => !timer.cancelled)).toBe(true));
    const live = timers.filter((timer) => !timer.cancelled);
    expect(live.map((timer) => timer.ms)).toEqual([35_000]);
    live[0]?.fn();
    expect(errorCode(await outcome)).toBe("E_TIMEOUT");
  });

  it("rejects pending requests and resolves when the channel exits", async () => {
    const [main, plugin] = MemoryPluginChannel.pair();
    let outcome: Promise<unknown> | undefined;
    const running = runPlugin(plugin, async () => ({ activate(ctx: PluginContext) { outcome = rejection(ctx.secrets.get("k")); } }));
    main.onMessage((message) => {
      if (isRequest(message) && message.method === "hello") main.post({ v: 1, kind: "res", id: message.id, ok: true, value: null });
    });
    main.post({ v: 1, kind: "req", id: 1, method: "activate", params: { config: {}, permissions: {} } });
    await vi.waitFor(() => expect(outcome).toBeDefined());
    main.kill();
    expect(errorCode(await outcome)).toBe("E_DISPOSED");
    await expect(running).resolves.toBeUndefined();
  });
});

describe("window handle lifecycle", () => {
  const windowManifest: PluginManifest = { ...demoManifest,
    permissions: { ...demoManifest.permissions, windows: ["clock"] } };

  it("ignores the old handle disposal while a replacement create is pending", async () => {
    let first: CheckerWindowHandle | undefined;
    let context: PluginContext | undefined;
    let gone: (() => void) | undefined;
    const windows: NonNullable<SessionHost["windows"]> = {
      create: vi.fn((_pluginId, _id, _generation, _opts, onGone) => { gone = onGone; }),
      show: vi.fn(), hide: vi.fn(),
      getJson: vi.fn(async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } })),
      dispose: vi.fn(),
    };
    const app = setup(windowManifest, { async activate(ctx: PluginContext) {
      context = ctx;
      first = await ctx.windows.create("clock", { url: "https://example.com/start" });
    } }, { windows });
    expect(code(await app.activate())).toBeUndefined();
    gone?.();
    const next = context?.windows.create("clock", { url: "https://example.com/start" });
    first?.dispose();
    const second = await next;
    expect(await second?.getJson("/ok")).toEqual({ status: 200, body: { ok: true } });
    expect(windows.dispose).not.toHaveBeenCalled();
    second?.dispose();
    app.session.dispose();
  });

  it("sends window methods and prevents an old handle from disposing a recreated window", async () => {
    let first: CheckerWindowHandle | undefined;
    let context: PluginContext | undefined;
    let gone: (() => void) | undefined;
    const calls: string[] = [];
    const windows: NonNullable<SessionHost["windows"]> = {
      create: vi.fn((_pluginId, _id, _generation, _opts, onGone) => { gone = onGone; }), show: vi.fn(), hide: vi.fn(),
      getJson: vi.fn(async () => new Response('{"value":1}', { headers: { "content-type": "application/json" } })),
      dispose: vi.fn((_pluginId, _id, generation) => { calls.push(String(generation)); }),
    };
    const app = setup(windowManifest, { async activate(ctx: PluginContext) {
      context = ctx;
      first = await ctx.windows.create("clock", { url: "https://example.com/start" });
    } }, { windows });
    expect(code(await app.activate())).toBeUndefined();
    expect(await first?.getJson("/ok")).toEqual({ status: 200, body: { value: 1 } });
    first?.hide();
    await vi.waitFor(() => expect(windows.hide).toHaveBeenCalledTimes(1));
    first?.dispose();
    await vi.waitFor(() => expect(windows.dispose).toHaveBeenCalledTimes(1));
    const second: CheckerWindowHandle | undefined = await context?.windows.create("clock", { url: "https://example.com/start" });
    gone?.();
    const third: CheckerWindowHandle | undefined = await context?.windows.create("clock", { url: "https://example.com/start" });
    second?.dispose();
    expect(calls).toHaveLength(1);
    expect(await third?.getJson("/ok")).toEqual({ status: 200, body: { value: 1 } });
    third?.dispose();
    await vi.waitFor(() => expect(windows.dispose).toHaveBeenCalledTimes(2));
    expect(calls[0]).not.toBe(calls[1]);
    app.session.dispose();
  });

  it("cleans active windows when the plugin deactivates", async () => {
    const windows: NonNullable<SessionHost["windows"]> = {
      create: vi.fn(), show: vi.fn(), hide: vi.fn(),
      getJson: vi.fn(async () => new Response(null)), dispose: vi.fn(),
    };
    const app = setup(windowManifest, { async activate(ctx: PluginContext) {
      await ctx.windows.create("clock", { url: "https://example.com/start" });
    } }, { windows });
    expect(code(await app.activate())).toBeUndefined();
    expect(code(await app.request("deactivate", {}))).toBeUndefined();
    await vi.waitFor(() => expect(windows.dispose).toHaveBeenCalledTimes(1));
    app.session.dispose();
  });
});
