import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@deskpet/plugin-sdk";
import type { LineCatalog } from "@deskpet/core";
import { MemoryPluginChannel } from "./channel.js";
import type { Envelope } from "./envelope.js";
import { PluginSession } from "./session.js";
import type { SessionHost } from "./session.js";

function fakeWindows() {
  const gone = new Map<string, () => void>();
  const port: NonNullable<SessionHost["windows"]> = {
    create: vi.fn((_pluginId, id, _generation, _opts, onGone) => { gone.set(id, onGone); }),
    show: vi.fn(), hide: vi.fn(),
    getJson: vi.fn(async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } })),
    dispose: vi.fn(),
  };
  return { port, gone };
}

const manifest: PluginManifest = {
  id: "demo", name: "Demo", version: "1.0.0", apiVersion: "1", entry: "index.js", description: "",
  permissions: { network: ["example.com", "other.com"], openExternal: ["https://example.com/a/*"],
    windows: ["clock"], secrets: true, shell: true },
  contributes: { actions: ["demo.run"], trayItems: ["demo.tray"], badges: ["demo.badge"] },
};

function setup(override: Partial<SessionHost> = {}, pluginManifest = manifest, lines?: LineCatalog) {
  let time = 1000;
  const [main, plugin] = MemoryPluginChannel.pair();
  const cleanup = vi.fn();
  const host: SessionHost = {
    emit: vi.fn(), register: vi.fn(() => cleanup), setBadge: vi.fn(),
    fetch: vi.fn(async () => new Response("ok")), openExternal: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "ok", code: 0 })),
    secrets: { get: vi.fn(async () => null), set: vi.fn(async () => {}) }, log: vi.fn(), ...override,
  };
  const session = new PluginSession(pluginManifest, main, host, () => time, lines);
  let nextId = 1;
  function request(method: string, params: unknown, inv?: string): Promise<Envelope> {
    const id = nextId++;
    return new Promise((resolve) => {
      const off = plugin.onMessage((message) => {
        if (message !== null && typeof message === "object" && "kind" in message &&
            message.kind === "res" && "id" in message && message.id === id) {
          off(); resolve(message as Envelope);
        }
      });
      plugin.post({ v: 1, kind: "req", id, method, params, ...(inv ? { inv } : {}) });
    });
  }
  async function actionInvocation() {
    expect((await request("registerAction", { id: "demo.run", handle: 10 })).kind).toBe("res");
    const received = new Promise<Extract<Envelope, { kind: "req" }>>((resolve) => {
      const off = plugin.onMessage((message) => {
        if (message !== null && typeof message === "object" && "method" in message && message.method === "invoke") {
          off(); resolve(message as Extract<Envelope, { kind: "req" }>);
        }
      });
    });
    const completed = session.invokeAction("demo.run");
    const invoke = await received;
    return { inv: invoke.inv ?? "", completed, finish: async () => {
      plugin.post({ v: 1, kind: "res", id: invoke.id, ok: true, value: null });
      await completed;
    } };
  }
  return { host, plugin, session, request, actionInvocation, cleanup, setTime: (value: number) => { time = value; } };
}

function code(response: Envelope): string | undefined {
  return response.kind === "res" && !response.ok ? response.error.code : undefined;
}

function createdGeneration(response: Envelope): number {
  if (response.kind !== "res" || !response.ok || typeof response.value !== "number")
    throw new Error("window creation did not return a generation");
  return response.value;
}

describe("PluginSession through the message channel", () => {
  it("accepts registered v2 lines and rejects v1, foreign, undeclared, and mismatched lines", async () => {
    const catalog: LineCatalog = { version: 1, lines: [{ id: "demo.done", label: "Done", kind: "done",
      variables: ["task"], variants: ["{task} done", "Done"] }] };
    const v1 = setup({}, manifest, catalog);
    const event = { source: "demo", type: "notify", line: { id: "demo.done", vars: { task: "A" } } };
    expect(code(await v1.request("emit", { event }))).toBe("E_INVALID_ARGUMENT");
    expect(v1.host.emit).not.toHaveBeenCalled();
    const v2 = setup({}, { ...manifest, apiVersion: "2" }, catalog);
    expect(code(await v2.request("emit", { event }))).toBeUndefined();
    expect(v2.host.emit).toHaveBeenCalledWith(event);
    for (const line of [{ id: "other.done" }, { id: "demo.missing" },
      { id: "demo.done", vars: { unknown: "A" } }])
      expect(code(await v2.request("emit", { event: { ...event, line } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await v2.request("emit", { event: { ...event, voice: { kind: "alert" } } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await v2.request("emit", { event: { ...event, line: { id: "demo.done" } } }))).toBeUndefined();
    expect(v2.host.emit).toHaveBeenCalledTimes(2);
  });
  it("rejects Orca requests while the main bridge is unavailable", async () => {
    expect(code(await setup().request("orca.snapshot", {}))).toBe("E_UNAVAILABLE");
    const app = setup({}, { ...manifest, apiVersion: "2", permissions: {
      orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true,
    } });
    for (const [method, params] of [
      ["orca.snapshot", {}], ["orca.resolveGate", { gateId: "gate", resolution: "yes" }],
      ["orca.openTerminal", { handle: "term" }], ["orca.muteGate", { gateId: "gate" }],
    ] as const) expect(code(await app.request(method, params))).toBe(method === "orca.snapshot" ? "E_UNAVAILABLE" : "E_PERMISSION");
    expect(code(await app.request("orca.other", {}))).toBe("E_INVALID_ARGUMENT");
    expect(app.host.exec).not.toHaveBeenCalled();
  });
  it("checks Orca permissions, identifier format, and open action invocation", async () => {
    const denied = setup({ orca: { snapshot: vi.fn(), resolveGate: vi.fn(), muteGate: vi.fn(), openTerminal: vi.fn() } },
      { ...manifest, apiVersion: "2", permissions: {} });
    expect(code(await denied.request("orca.snapshot", {}))).toBe("E_PERMISSION");
    expect(denied.host.orca?.snapshot).not.toHaveBeenCalled();
    const orca = { snapshot: vi.fn(async () => ({ availability: "ready" as const, runs: [], notifications: [] })),
      resolveGate: vi.fn(async (): Promise<"resolved" | "already-resolved" | "unconfirmed"> => "resolved"),
      muteGate: vi.fn(async () => {}),
      openTerminal: vi.fn(async () => {}) };
    const app = setup({ orca }, { ...manifest, apiVersion: "2", permissions: {
      orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true,
    } });
    expect(code(await app.request("orca.snapshot", {}))).toBeUndefined();
    expect(orca.snapshot).toHaveBeenCalledWith("demo");
    for (const bad of ["", "-bad", "../escape", "bad key", "a".repeat(257)]) {
      expect(code(await app.request("orca.resolveGate", { gateId: bad, resolution: "yes" }))).toBe("E_PERMISSION");
      expect(code(await app.request("orca.muteGate", { gateId: bad }))).toBe("E_PERMISSION");
      expect(code(await app.request("orca.openTerminal", { handle: bad }))).toBe("E_PERMISSION");
    }
    const action = await app.actionInvocation();
    for (const bad of ["", "-bad", "../escape", "bad key", "a".repeat(257)]) {
      expect(code(await app.request("orca.resolveGate", { gateId: bad, resolution: "yes" }, action.inv))).toBe("E_INVALID_ARGUMENT");
      expect(code(await app.request("orca.muteGate", { gateId: bad }, action.inv))).toBe("E_INVALID_ARGUMENT");
      expect(code(await app.request("orca.openTerminal", { handle: bad }, action.inv))).toBe("E_INVALID_ARGUMENT");
    }
    expect(code(await app.request("orca.resolveGate", { gateId: "gate_1", resolution: "y".repeat(41) }, action.inv))).toBe("E_INVALID_ARGUMENT");
    const resolved = await app.request("orca.resolveGate", { gateId: "gate_1", resolution: "yes" }, action.inv);
    expect(code(resolved)).toBeUndefined();
    expect(resolved).toMatchObject({ value: "resolved" });
    orca.resolveGate.mockResolvedValueOnce("already-resolved").mockResolvedValueOnce("unconfirmed");
    expect(await app.request("orca.resolveGate", { gateId: "gate_1", resolution: "yes" }, action.inv))
      .toMatchObject({ value: "already-resolved" });
    expect(await app.request("orca.resolveGate", { gateId: "gate_1", resolution: "yes" }, action.inv))
      .toMatchObject({ value: "unconfirmed" });
    expect(code(await app.request("orca.openTerminal", { handle: "term_1" }, action.inv))).toBeUndefined();
    expect(code(await app.request("orca.muteGate", { gateId: "gate_1" }, action.inv))).toBeUndefined();
    expect(orca.muteGate).toHaveBeenCalledWith("demo", "gate_1");
    expect(orca.resolveGate).toHaveBeenCalledWith("demo", "gate_1", "yes");
    expect(orca.openTerminal).toHaveBeenCalledWith("demo", "term_1");
    await action.finish();
  });
  it("rejects v1 Slack calls and v2 direct secret reads", async () => {
    const legacy = setup();
    expect(code(await legacy.request("slack.connect", { appTokenSecret: "appToken", handle: 1 }))).toBe("E_UNAVAILABLE");
    expect(code(await legacy.request("slack.get", { userTokenSecret: "userToken", method: "users.info" }))).toBe("E_UNAVAILABLE");
    const v2: PluginManifest = { ...manifest, apiVersion: "2", permissions: {
      ...manifest.permissions, socketMode: ["slack.com"],
    } };
    const app = setup({}, v2);
    expect(code(await app.request("secrets.get", { key: "token" }))).toBe("E_UNAVAILABLE");
    expect(app.host.secrets.get).not.toHaveBeenCalled();
  });
  it("checks Slack permission, key, method and query before reading tokens", async () => {
    const v2: PluginManifest = { ...manifest, apiVersion: "2", permissions: { secrets: true } };
    const app = setup({}, v2);
    expect(code(await app.request("slack.connect", { appTokenSecret: "appToken", handle: 1 }))).toBe("E_PERMISSION");
    expect(code(await app.request("slack.get", { userTokenSecret: "userToken", method: "users.info" }))).toBe("E_PERMISSION");
    const allowed = setup({}, { ...v2, permissions: { secrets: true, network: ["slack.com"], socketMode: ["slack.com"] } });
    expect(code(await allowed.request("slack.connect", { appTokenSecret: "bad key", handle: 1 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await allowed.request("slack.get", { userTokenSecret: "userToken", method: "chat.postMessage" }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await allowed.request("slack.get", { userTokenSecret: "userToken", method: "users.info", query: { user: 4 } }))).toBe("E_INVALID_ARGUMENT");
    expect(allowed.host.secrets.get).not.toHaveBeenCalled();
  });
  it("allows one Slack connection at a time and releases its handle on dispose", async () => {
    const v2: PluginManifest = { ...manifest, apiVersion: "2",
      permissions: { secrets: true, socketMode: ["slack.com"] } };
    const openConnection = vi.fn(async () => ({ status: 200, body: { ok: false, error: "invalid_auth" } }));
    const app = setup({ slack: { transport: { openConnection, connectWebSocket: vi.fn() },
      get: vi.fn() } }, v2);
    expect(code(await app.request("slack.connect", { appTokenSecret: "appToken", handle: 1 }))).toBeUndefined();
    expect(code(await app.request("slack.connect", { appTokenSecret: "appToken", handle: 2 }))).toBe("E_INVALID_ARGUMENT");
    await app.request("dispose", { handle: 1 });
    expect(code(await app.request("slack.connect", { appTokenSecret: "appToken", handle: 2 }))).toBeUndefined();
    app.session.dispose();
    expect(openConnection).not.toHaveBeenCalled();
  });
  it("checks event source and action prefixes before emitting", async () => {
    const app = setup();
    expect(code(await app.request("emit", { event: { source: "other", type: "notify" } }))).toBe("E_PERMISSION");
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify", actions: [{ label: "ok", action: "other.run" }] } }))).toBe("E_PERMISSION");
    expect(code(await app.request("emit", { event: { source: "demo", type: "bad" } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify", actions: [{ label: "ok", action: "demo.run" }] } }))).toBeUndefined();
    expect(app.host.emit).toHaveBeenCalledTimes(1);
  });

  it("drops unknown event and action fields before emitting", async () => {
    const app = setup();
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify", extra: "discard",
      actions: [{ label: "Run", action: "demo.run", extra: "discard" }] } }))).toBeUndefined();
    expect(app.host.emit).toHaveBeenCalledWith({ source: "demo", type: "notify",
      actions: [{ label: "Run", action: "demo.run" }] });
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify",
      extra: new ArrayBuffer(2 * 1024 * 1024) } }))).toBe("E_INVALID_ARGUMENT");
    expect(app.host.emit).toHaveBeenCalledTimes(1);
  });

  it("forwards validated voice slots with plugin events", async () => {
    const app = setup();
    const voice = { kind: "reminder", slots: { task: "회의", message: "회의 시작" } };
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify",
      text: "회의 시작", voice } }))).toBeUndefined();
    expect(app.host.emit).toHaveBeenCalledWith({ source: "demo", type: "notify",
      text: "회의 시작", voice });
  });

  it("turns a rejected channel receive into an error response", async () => {
    const app = setup();
    vi.spyOn(app.session, "receive").mockRejectedValueOnce(new Error("unexpected"));
    expect(code(await app.request("log", { level: "info", message: "ok" }))).toBe("E_UNAVAILABLE");
  });

  it("checks contributed ids, duplicate registrations, labels, badges, rules and handles", async () => {
    const app = setup();
    expect(code(await app.request("registerAction", { id: "other.run", handle: 1 }))).toBe("E_PERMISSION");
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 0 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 1 }))).toBeUndefined();
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 2 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("addTrayItem", { handle: 3, item: { id: "other", action: "demo.run", label: "a" } }))).toBe("E_PERMISSION");
    expect(code(await app.request("addTrayItem", { handle: 3, item: { id: "demo.tray", action: "other", label: "a" } }))).toBe("E_PERMISSION");
    expect(code(await app.request("addTrayItem", { handle: 3, item: { id: "demo.tray", action: "demo.run", label: "x".repeat(41) } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("addTrayItem", { handle: 3, item: { id: "demo.tray", action: "demo.run", label: "ok" } }))).toBeUndefined();
    expect(code(await app.request("setBadge", { id: "other", badge: null }))).toBe("E_PERMISSION");
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "x".repeat(41) } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "ok", tone: "bad" } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "ok", tone: "warn" } }))).toBeUndefined();
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "ok", action: "demo.run" } }))).toBe("E_UNAVAILABLE");
    const v2 = setup({}, { ...manifest, apiVersion: "2" });
    expect(code(await v2.request("setBadge", { id: "demo.badge", badge: { text: "ok", action: "demo.run" } }))).toBeUndefined();
    expect(code(await v2.request("setBadge", { id: "demo.badge", badge: { text: "ok", action: "demo.other" } }))).toBe("E_PERMISSION");
    expect(code(await v2.request("setBadge", { id: "demo.badge", badge: { text: "ok", action: 5 } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "😀".repeat(40) } }))).toBeUndefined();
    expect(code(await app.request("setBadge", { id: "demo.badge", badge: { text: "😀".repeat(41) } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("addReactionRule", { handle: 4, rule: { match: {}, play: 1 } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("addReactionRule", { handle: 4, rule: { match: {}, play: "happy" } }))).toBeUndefined();
  });

  it("keeps disposal idempotent and does not erase a later registration", async () => {
    const app = setup();
    await app.request("registerAction", { id: "demo.run", handle: 1 });
    await app.request("dispose", { handle: 1 });
    await app.request("dispose", { handle: 1 });
    expect(app.cleanup).toHaveBeenCalledTimes(1);
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 2 }))).toBeUndefined();
    await app.request("dispose", { handle: 1 });
    expect(app.cleanup).toHaveBeenCalledTimes(1);
    app.session.dispose();
    expect(app.cleanup).toHaveBeenCalledTimes(2);
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify" } }))).toBe("E_DISPOSED");
  });

  it("cleans a registration that finishes after shutdown", async () => {
    let finish: ((cleanup: () => void) => void) | undefined;
    const cleanup = vi.fn();
    const app = setup({ register: () => new Promise<() => void>((resolve) => { finish = resolve; }) });
    const pending = app.request("registerAction", { id: "demo.run", handle: 1 });
    await Promise.resolve();
    await Promise.resolve();
    app.session.dispose();
    finish?.(cleanup);
    expect(code(await pending)).toBe("E_DISPOSED");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reserves registration ids, handles and capacity before host registration settles", async () => {
    let finish: ((cleanup: () => void) => void) | undefined;
    const cleanup = vi.fn();
    const register = vi.fn(() => new Promise<() => void>((resolve) => { finish = resolve; }));
    const app = setup({ register });
    const first = app.request("registerAction", { id: "demo.run", handle: 1 });
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 2 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("schedule.onResume", { handle: 1 }))).toBe("E_INVALID_ARGUMENT");
    expect(register).toHaveBeenCalledTimes(1);
    finish?.(cleanup);
    expect(code(await first)).toBeUndefined();
    app.session.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);

    const capacity = setup();
    for (let index = 1; index <= 255; index++) {
      capacity.setTime(index * 20);
      expect(code(await capacity.request("schedule.onResume", { handle: index }))).toBeUndefined();
    }
    capacity.setTime(6000);
    const accepted = capacity.request("schedule.onResume", { handle: 256 });
    const rejected = capacity.request("schedule.onResume", { handle: 257 });
    expect(code(await rejected)).toBe("E_RATE_LIMIT");
    expect(code(await accepted)).toBeUndefined();
    expect(capacity.host.register).toHaveBeenCalledTimes(256);
    capacity.session.dispose();
  });

  it("does not remove a replacement id when an earlier registration settles late", async () => {
    let finish: ((cleanup: () => void) => void) | undefined;
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    const app = setup({ register: vi.fn((_plugin, _kind, number) => number === 1 ?
      new Promise<() => void>((resolve) => { finish = resolve; }) : newCleanup) });
    const old = app.request("registerAction", { id: "demo.run", handle: 1 });
    await Promise.resolve();
    expect(code(await app.request("dispose", { handle: 1 }))).toBeUndefined();
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 2 }))).toBeUndefined();
    finish?.(oldCleanup);
    expect(code(await old)).toBe("E_DISPOSED");
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(code(await app.request("registerAction", { id: "demo.run", handle: 3 }))).toBe("E_INVALID_ARGUMENT");
    app.session.dispose();
    expect(newCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps disposed handle history bounded while rejecting reuse", async () => {
    const app = setup();
    for (let index = 1; index <= 300; index++) {
      app.setTime(index * 20);
      expect(code(await app.request("schedule.onResume", { handle: index }))).toBeUndefined();
      expect(code(await app.request("dispose", { handle: index }))).toBeUndefined();
    }
    app.setTime(7000);
    expect(code(await app.request("schedule.onResume", { handle: 1 }))).toBe("E_INVALID_ARGUMENT");
    expect(Object.values(app.session).filter((value): value is Set<unknown> => value instanceof Set)
      .every((value) => value.size < 300)).toBe(true);
    app.session.dispose();
  });

  it("limits registrations to 256 and requests to 100 per second", async () => {
    const app = setup();
    for (let index = 1; index <= 100; index++)
      expect(code(await app.request("schedule.onResume", { handle: index }))).toBeUndefined();
    expect(code(await app.request("schedule.onResume", { handle: 101 }))).toBe("E_RATE_LIMIT");
    app.setTime(2000);
    for (let index = 101; index <= 200; index++) await app.request("schedule.onResume", { handle: index });
    app.setTime(3000);
    for (let index = 201; index <= 256; index++) await app.request("schedule.onResume", { handle: index });
    expect(code(await app.request("schedule.onResume", { handle: 257 }))).toBe("E_RATE_LIMIT");
  });

  it("keeps the 100 request cap across a fixed-second boundary", async () => {
    const app = setup();
    app.setTime(1999);
    for (let index = 0; index < 100; index++)
      expect(code(await app.request("log", { level: "info", message: "ok" }))).toBeUndefined();
    app.setTime(2000);
    expect(code(await app.request("log", { level: "info", message: "extra" }))).toBe("E_RATE_LIMIT");
    app.setTime(2999);
    expect(code(await app.request("log", { level: "info", message: "next" }))).toBeUndefined();
  });

  it("requires a live action invocation for write requests, exec and external links", async () => {
    const app = setup();
    expect(code(await app.request("fetch", { url: "https://example.com", method: "POST", headers: [] }))).toBe("E_PERMISSION");
    expect(code(await app.request("exec", { cmd: "tool", args: [] }))).toBe("E_PERMISSION");
    expect(code(await app.request("openExternal", { url: "https://example.com/a/x" }))).toBe("E_PERMISSION");
    const active = await app.actionInvocation();
    expect(code(await app.request("fetch", { url: "https://example.com", method: "POST", headers: [] }, active.inv))).toBeUndefined();
    expect(code(await app.request("fetch", { url: "https://example.com", method: "POST", headers: [], body: {} }, active.inv))).toBe("E_NOT_SERIALIZABLE");
    expect(code(await app.request("exec", { cmd: "tool", args: ["a"] }, active.inv))).toBeUndefined();
    expect(code(await app.request("exec", { cmd: "tool.cmd", args: [] }, active.inv))).toBe("E_UNAVAILABLE");
    expect(code(await app.request("exec", { cmd: "tool.bat", args: [] }, active.inv))).toBe("E_UNAVAILABLE");
    expect(code(await app.request("openExternal", { url: "https://example.com/a/x/../y" }, active.inv))).toBeUndefined();
    expect(app.host.openExternal).toHaveBeenCalledWith("https://example.com/a/y");
    app.setTime(61_001);
    expect(code(await app.request("exec", { cmd: "tool", args: [] }, active.inv))).toBe("E_PERMISSION");
    await active.finish();
    expect(code(await app.request("exec", { cmd: "tool", args: [] }, active.inv))).toBe("E_PERMISSION");
  });

  it("rejects oversized exec output from an injected host", async () => {
    const app = setup({ exec: async () => ({ stdout: "x".repeat(1024 * 1024 + 1), code: 0 }) });
    const active = await app.actionInvocation();
    expect(code(await app.request("exec", { cmd: "tool", args: [] }, active.inv))).toBe("E_INVALID_ARGUMENT");
    await active.finish();
  });

  it("enforces fetch redirects, header stripping, response size and request permissions", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const app = setup({ fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://other.com/final" } }) : new Response("ok");
    } });
    expect(code(await app.request("fetch", { url: "https://sub.example.com", headers: [] }))).toBe("E_PERMISSION");
    expect(code(await app.request("fetch", { url: "https://example.com", headers: [["Host", "bad"], ["Authorization", "secret"], ["Cookie", "a=b"]] }))).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect((calls[0]?.init.headers as Headers).has("Host")).toBe(false);
    expect((calls[1]?.init.headers as Headers).has("Authorization")).toBe(false);
    expect((calls[1]?.init.headers as Headers).has("Cookie")).toBe(false);
    const blocked = setup({ fetch: async () => new Response(null, { status: 302, headers: { location: "https://blocked.com" } }) });
    expect(code(await blocked.request("fetch", { url: "https://example.com", headers: [] }))).toBe("E_PERMISSION");
    const large = setup({ fetch: async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)) });
    expect(code(await large.request("fetch", { url: "https://example.com", headers: [] }))).toBe("E_INVALID_ARGUMENT");
  });

  it("returns non-GET redirects unchanged and stops after five allowed hops", async () => {
    const urls: string[] = [];
    const app = setup({ fetch: async (url) => {
      urls.push(url);
      return new Response(null, { status: 302, headers: { location: "/next" } });
    } });
    const active = await app.actionInvocation();
    const post = await app.request("fetch", { url: "https://example.com", method: "POST", headers: [] }, active.inv);
    expect(code(post)).toBeUndefined();
    if (post.kind === "res" && post.ok) expect(post.value).toMatchObject({ status: 302 });
    expect(urls).toHaveLength(1);
    expect(code(await app.request("fetch", { url: "https://example.com", headers: [] }))).toBe("E_RATE_LIMIT");
    expect(urls).toHaveLength(7);
    await active.finish();
  });

  it.each([
    ["blocked", "https://blocked.com/path", "E_PERMISSION"],
    ["invalid", "http://[", "E_PERMISSION"],
    ["hop limit", "/next", "E_RATE_LIMIT"],
  ])("cancels redirect bodies and aborts connections on %s", async (_case, location, expected) => {
    const cancelled = vi.fn();
    const signals: AbortSignal[] = [];
    const app = setup({ fetch: async (_url, init) => {
      if (init.signal) signals.push(init.signal);
      return new Response(new ReadableStream({ cancel: cancelled }),
        { status: 302, headers: { location } });
    } });
    expect(code(await app.request("fetch", { url: "https://example.com", headers: [] }))).toBe(expected);
    expect(cancelled).toHaveBeenCalledTimes(location === "/next" ? 6 : 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    app.session.dispose();
  });

  it("rejects duplicate in-flight request ids without losing the first fetch controller", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const app = setup({ fetch: async (_url, init) => {
        if (init.signal) signals.push(init.signal);
        return new Promise<Response>(() => {});
      } });
      const responses: Envelope[] = [];
      app.plugin.onMessage((message) => {
        if (message !== null && typeof message === "object" && "kind" in message && message.kind === "res")
          responses.push(message as Envelope);
      });
      const request = { v: 1, kind: "req", id: 99, method: "fetch",
        params: { url: "https://example.com", headers: [] } } as const;
      app.plugin.post(request);
      app.plugin.post(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(1);
      expect(responses.map(code)).toEqual(["E_INVALID_ARGUMENT"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(responses.map(code)).toEqual(["E_INVALID_ARGUMENT", "E_TIMEOUT"]);
      expect(signals[0]?.aborted).toBe(true);
      app.session.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("aborts an in-flight fetch when the session is disposed", async () => {
    let signal: AbortSignal | undefined;
    const app = setup({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }) });
    const pending = app.request("fetch", { url: "https://example.com", headers: [] });
    await Promise.resolve();
    await Promise.resolve();
    app.session.dispose();
    expect(signal?.aborted).toBe(true);
    expect(code(await pending)).toBe("E_DISPOSED");
  });

  it("checks accepted and rejected schedule and method formats at registration", async () => {
    const app = setup();
    for (const [index, cron] of ["0 0 * * *", "59 23 * * 1,3,5", "5 8 * * 1-5", "5 8 * * 1-3,5"].entries())
      expect(code(await app.request("schedule.at", { cron, handle: index + 1, opts: { tz: "Asia/Seoul" } }))).toBeUndefined();
    for (const cron of ["*/5 8 * * *", "60 8 * * *", "5 24 * * *", "5 8 1 * *", "5 8 * * 7", "5 8 * * 5-1", "5 8 * * 1-2-3", "5 8 * * 1,,3", "5 8 * * monday"])
      expect(code(await app.request("schedule.at", { cron, handle: 20 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("schedule.at", { cron: "0 0 * * *", handle: 20, opts: { tz: "Bad/Zone" } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("schedule.every", { ms: 999, handle: 20 }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("schedule.every", { ms: 1000, handle: 20 }))).toBeUndefined();
    expect(code(await app.request("fetch", { url: "https://example.com", method: "G ET", headers: [] }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("fetch", { url: "https://example.com", method: "HEAD", headers: [] }))).toBeUndefined();
    expect(code(await app.request("emit", { event: { source: "demo", type: "notify" }, unexpected: 1 }))).toBe("E_INVALID_ARGUMENT");
  });

  it("times out stalled host requests and closes timed out action contexts", async () => {
    vi.useFakeTimers();
    try {
      const app = setup({ emit: () => new Promise<void>(() => {}) });
      const stalled = app.request("emit", { event: { source: "demo", type: "notify" } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(code(await stalled)).toBe("E_TIMEOUT");
      const active = await app.actionInvocation();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(code(await active.completed)).toBe("E_TIMEOUT");
      expect(code(await app.request("exec", { cmd: "tool", args: [] }, active.inv))).toBe("E_PERMISSION");
    } finally { vi.useRealTimers(); }
  });

  it("checks secrets, unavailable windows, and malformed requests", async () => {
    const app = setup();
    expect(code(await app.request("secrets.set", { key: "bad/key", value: "x" }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("secrets.set", { key: "key", value: "é".repeat(4097) }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("secrets.set", { key: "key", value: "ok" }))).toBeUndefined();
    expect(code(await app.request("windows.create", { id: "other", opts: { url: "https://example.com" } }))).toBe("E_PERMISSION");
    expect(code(await app.request("windows.create", { id: "clock", opts: { url: "https://example.com" } }))).toBe("E_UNAVAILABLE");
    const noPermission = setup({}, { ...manifest, permissions: {} });
    expect(code(await noPermission.request("secrets.get", { key: "key" }))).toBe("E_PERMISSION");
    expect(code(await noPermission.request("exec", { cmd: "tool", args: [] }))).toBe("E_PERMISSION");
    const exits: (number | null)[] = [];
    app.plugin.onExit((value) => exits.push(value));
    await app.session.receive({ v: 1, kind: "req", id: 900, method: "log" });
    await app.session.receive({ v: 1, kind: "req", id: 901, method: "log" });
    await app.session.receive({ v: 1, kind: "req", id: 902, method: "log" });
    expect(exits).toEqual([null]);
  });
});

describe("checker windows", () => {
  const url = "https://example.com/start";

  it("rejects undeclared ids and unsafe URLs while accepting a declared HTTPS host", async () => {
    const { port } = fakeWindows();
    const app = setup({ windows: port }, { ...manifest, permissions: { ...manifest.permissions, network: ["example.com"] } });
    expect(code(await app.request("windows.create", { id: "other", opts: { url } }))).toBe("E_PERMISSION");
    for (const invalid of ["https://other.com", "http://example.com", "https://example.com:444",
      "https://user@example.com", "https://example.com.", "https://127.0.0.1", "https://sub.example.com"])
      expect(code(await app.request("windows.create", { id: "clock", opts: { url: invalid } }))).toBe("E_PERMISSION");
    expect(code(await app.request("windows.create", { id: "clock", opts: { url } }))).toBeUndefined();
    expect(port.create).toHaveBeenCalledWith("demo", "clock", expect.any(Number), { url }, expect.any(Function),
      { name: "Demo", hosts: ["example.com"], windows: ["clock"] });
    app.session.dispose();
  });

  it("passes each approved session snapshot to the window port", async () => {
    const { port } = fakeWindows();
    const approved = { ...manifest, permissions: { ...manifest.permissions,
      network: ["example.com"], windows: ["clock"] } };
    const nextApproved = { ...manifest, permissions: { ...manifest.permissions,
      network: ["other.com"], windows: ["other"] } };
    const first = setup({ windows: port }, approved);
    expect(code(await first.request("windows.create", { id: "clock", opts: { url } }))).toBeUndefined();
    expect(port.create).toHaveBeenCalledWith("demo", "clock", expect.any(Number), { url },
      expect.any(Function), { name: "Demo", hosts: ["example.com"], windows: ["clock"] });
    first.session.dispose();
    const second = setup({ windows: port }, nextApproved);
    expect(code(await second.request("windows.create", { id: "clock", opts: { url } }))).toBe("E_PERMISSION");
    expect(code(await second.request("windows.create", { id: "other", opts: { url: "https://other.com/start" } }))).toBeUndefined();
    expect(port.create).toHaveBeenLastCalledWith("demo", "other", expect.any(Number),
      { url: "https://other.com/start" }, expect.any(Function),
      { name: "Demo", hosts: ["other.com"], windows: ["other"] });
    second.session.dispose();
  });

  it("checks every option boundary and rejects unknown keys", async () => {
    const { port } = fakeWindows();
    const app = setup({ windows: port });
    for (const extra of [{ other: true }, { width: 199 }, { width: 4097 }, { width: 200.5 },
      { height: 199 }, { height: 4097 }, { height: 200.5 }, { title: "x".repeat(81) },
      { title: "😀".repeat(81) }, { show: "true" }])
      expect(code(await app.request("windows.create", { id: "clock", opts: { url, ...extra } }))).toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("windows.create", { id: "clock",
      opts: { url, width: 200, height: 4096, title: "😀".repeat(80), show: false } }))).toBeUndefined();
    app.session.dispose();
  });

  it("requires user context for showing and permits hiding outside an action", async () => {
    const { port } = fakeWindows();
    const app = setup({ windows: port });
    expect(code(await app.request("windows.create", { id: "clock", opts: { url, show: true } }))).toBe("E_PERMISSION");
    const generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    expect(code(await app.request("window.show", { id: "clock", generation }))).toBe("E_PERMISSION");
    expect(code(await app.request("window.hide", { id: "clock", generation }))).toBeUndefined();
    const action = await app.actionInvocation();
    expect(code(await app.request("window.show", { id: "clock", generation }, action.inv))).toBeUndefined();
    await action.finish();
    expect(port.show).toHaveBeenCalledTimes(1);
    app.session.dispose();
  });

  it("uses the same error for absent and foreign ids and releases capacity after dispose or crash", async () => {
    const { port, gone } = fakeWindows();
    const app = setup({ windows: port });
    const other = setup({ windows: port }, { ...manifest, id: "other", permissions: { ...manifest.permissions, windows: ["clock"] } });
    let generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    for (const method of ["window.show", "window.hide", "window.getJson"])
      for (const target of [app, other])
        expect(code(await target.request(method, { id: "missing", generation, ...(method === "window.getJson" ? { path: "/ok" } : {}) })))
          .toBe("E_INVALID_ARGUMENT");
    for (const method of ["window.show", "window.hide", "window.getJson"])
      expect(code(await other.request(method, { id: "clock", generation, ...(method === "window.getJson" ? { path: "/ok" } : {}) })))
        .toBe("E_INVALID_ARGUMENT");
    expect(code(await app.request("windows.create", { id: "clock", opts: { url } }))).toBe("E_INVALID_ARGUMENT");
    gone.get("clock")?.();
    expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/ok" }))).toBe("E_UNAVAILABLE");
    generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    expect(code(await app.request("window.dispose", { id: "clock", generation }))).toBeUndefined();
    expect(code(await app.request("window.dispose", { id: "clock", generation }))).toBeUndefined();
    expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/ok" }))).toBe("E_DISPOSED");
    expect(code(await app.request("windows.create", { id: "clock", opts: { url } }))).toBeUndefined();
    app.session.dispose(); other.session.dispose();
  });

  it("rejects stale window methods and ignores stale disposal", async () => {
    const { port, gone } = fakeWindows();
    const app = setup({ windows: port });
    const previous = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    gone.get("clock")?.();
    const current = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    expect(current).not.toBe(previous);
    for (const method of ["window.show", "window.hide", "window.getJson"])
      expect(code(await app.request(method, { id: "clock", generation: previous,
        ...(method === "window.getJson" ? { path: "/ok" } : {}) }))).toBe("E_DISPOSED");
    expect(code(await app.request("window.dispose", { id: "clock", generation: previous }))).toBeUndefined();
    expect(port.dispose).not.toHaveBeenCalled();
    expect(code(await app.request("window.hide", { id: "clock", generation: current }))).toBeUndefined();
    app.session.dispose();
  });

  it("caps live windows by declaration and by four across sessions", async () => {
    const { port } = fakeWindows();
    const ids = ["a", "b", "c", "d", "e"];
    const app = setup({ windows: port }, { ...manifest, permissions: { ...manifest.permissions, windows: ids } });
    const generations = new Map<string, number>();
    for (const id of ids.slice(0, 4)) generations.set(id, createdGeneration(await app.request("windows.create", { id, opts: { url } })));
    expect(code(await app.request("windows.create", { id: "e", opts: { url } }))).toBe("E_RATE_LIMIT");
    const other = setup({ windows: port }, { ...manifest, id: "other", permissions: { ...manifest.permissions, windows: ["clock"] } });
    expect(code(await other.request("windows.create", { id: "clock", opts: { url } }))).toBe("E_RATE_LIMIT");
    expect(code(await app.request("window.dispose", { id: "a", generation: generations.get("a") }))).toBeUndefined();
    expect(code(await other.request("windows.create", { id: "clock", opts: { url } }))).toBeUndefined();
    app.session.dispose(); other.session.dispose();
  });

  it("keeps a global slot until asynchronous window disposal settles", async () => {
    const { port } = fakeWindows();
    let failDispose: (() => void) | undefined;
    vi.mocked(port.dispose).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failDispose = () => reject(new Error("window already closed"));
    }));
    const ids = ["a", "b", "c", "d", "e"];
    const app = setup({ windows: port }, { ...manifest, permissions: { ...manifest.permissions, windows: ids } });
    const generations = new Map<string, number>();
    for (const id of ids.slice(0, 4)) generations.set(id, createdGeneration(await app.request("windows.create", { id, opts: { url } })));
    const disposing = app.request("window.dispose", { id: "a", generation: generations.get("a") });
    await vi.waitFor(() => expect(failDispose).toBeDefined());
    expect(code(await app.request("windows.create", { id: "e", opts: { url } }))).toBe("E_RATE_LIMIT");
    failDispose?.();
    expect(code(await disposing)).toBeUndefined();
    expect(code(await app.request("windows.create", { id: "e", opts: { url } }))).toBeUndefined();
    app.session.dispose();
  });

  it("disposes a timed-out create and permits the same id to be retried", async () => {
    vi.useFakeTimers();
    try {
      const { port } = fakeWindows();
      const app = setup({ windows: port }, { ...manifest,
        permissions: { ...manifest.permissions, windows: ["a", "b", "c", "clock"] } });
      for (const id of ["a", "b", "c"])
        createdGeneration(await app.request("windows.create", { id, opts: { url } }));
      vi.mocked(port.create).mockImplementationOnce(() => new Promise<void>(() => {}));
      const creating = app.request("windows.create", { id: "clock", opts: { url } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(code(await creating)).toBe("E_TIMEOUT");
      expect(port.dispose).toHaveBeenCalledTimes(1);
      expect(code(await app.request("windows.create", { id: "clock", opts: { url } }))).toBeUndefined();
      app.session.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("accepts rooted paths and rejects malformed or write-shaped getJson messages", async () => {
    const { port } = fakeWindows();
    const app = setup({ windows: port });
    const generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    for (const path of ["relative", "//evil.com/x", "/a\\b", "/a\u0000b", "/a\u001fb", "/" + "x".repeat(2048)])
      expect(code(await app.request("window.getJson", { id: "clock", generation, path }))).toBe("E_INVALID_ARGUMENT");
    for (const extra of [{ method: "POST" }, { headers: { Cookie: "secret" } }, { body: "secret" }])
      expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/ok", ...extra }))).toBe("E_INVALID_ARGUMENT");
    expect(await app.request("window.getJson", { id: "clock", generation, path: "/ok?token=secret" }))
      .toMatchObject({ ok: true, value: { status: 200, body: { ok: true } } });
    expect(port.getJson).toHaveBeenCalledTimes(1);
    expect(port.getJson).toHaveBeenCalledWith("demo", "clock", expect.any(Number), "/ok?token=secret", expect.any(AbortSignal));
    app.session.dispose();
  });

  it("returns null for redirects, caps bodies, and logs no path or response data", async () => {
    const { port } = fakeWindows();
    const app = setup({ windows: port });
    const generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    vi.mocked(port.getJson).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.com", "set-cookie": "cookie-secret" } }));
    expect(await app.request("window.getJson", { id: "clock", generation, path: "/redirect?query-secret" }))
      .toMatchObject({ ok: true, value: { status: 302, body: null } });
    vi.mocked(port.getJson).mockResolvedValueOnce(new Response("body-secret" + "x".repeat(1024 * 1024),
      { headers: { "content-type": "application/json", "set-cookie": "cookie-secret" } }));
    expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/large?query-secret" })))
      .toBe("E_INVALID_ARGUMENT");
    vi.mocked(port.getJson).mockRejectedValueOnce(new Error("https://example.com/fail?query-secret cookie-secret"));
    expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/fail?query-secret" })))
      .toBe("E_UNAVAILABLE");
    vi.mocked(port.getJson).mockResolvedValueOnce(new Response('{"body-secret":true}',
      { headers: { "content-type": "text/plain", "set-cookie": "cookie-secret" } }));
    expect(await app.request("window.getJson", { id: "clock", generation, path: "/plain?query-secret" }))
      .toMatchObject({ ok: true, value: { status: 200, body: null } });
    const logs = vi.mocked(app.host.log).mock.calls.map((call) => call[1]).join("\n");
    for (const secret of ["redirect", "large", "fail", "plain", "query-secret", "body-secret", "cookie-secret", "evil.com"])
      expect(logs).not.toContain(secret);
    expect(logs).toContain("status=302");
    expect(logs).toContain("error=E_INVALID_ARGUMENT");
    app.session.dispose();
  });

  it("rejects a third concurrent request and aborts pending requests on disposal", async () => {
    const { port } = fakeWindows();
    vi.mocked(port.getJson).mockImplementation((_pluginId, _id, _generation, _path, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("url-secret")), { once: true });
    }));
    const app = setup({ windows: port });
    const generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
    const first = app.request("window.getJson", { id: "clock", generation, path: "/a" });
    const second = app.request("window.getJson", { id: "clock", generation, path: "/b" });
    await vi.waitFor(() => expect(port.getJson).toHaveBeenCalledTimes(2));
    expect(code(await app.request("window.getJson", { id: "clock", generation, path: "/c" }))).toBe("E_RATE_LIMIT");
    expect(code(await app.request("window.dispose", { id: "clock", generation }))).toBeUndefined();
    expect(code(await first)).toBe("E_DISPOSED");
    expect(code(await second)).toBe("E_DISPOSED");
    app.session.dispose();
  });

  it("times out getJson at 20 seconds with a controlled clock", async () => {
    vi.useFakeTimers();
    try {
      const { port } = fakeWindows();
      vi.mocked(port.getJson).mockImplementation(() => new Promise(() => {}));
      const app = setup({ windows: port });
      const generation = createdGeneration(await app.request("windows.create", { id: "clock", opts: { url } }));
      const result = app.request("window.getJson", { id: "clock", generation, path: "/slow" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(code(await result)).toBe("E_TIMEOUT");
      app.session.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("cleans every owned window on session exit without touching another plugin", async () => {
    const { port } = fakeWindows();
    const own = setup({ windows: port }, { ...manifest, permissions: { ...manifest.permissions, windows: ["a", "b"] } });
    const other = setup({ windows: port }, { ...manifest, id: "other", permissions: { ...manifest.permissions, windows: ["a"] } });
    for (const id of ["a", "b"]) await own.request("windows.create", { id, opts: { url } });
    await other.request("windows.create", { id: "a", opts: { url } });
    own.session.dispose();
    expect(port.dispose).toHaveBeenCalledWith("demo", "a", expect.any(Number));
    expect(port.dispose).toHaveBeenCalledWith("demo", "b", expect.any(Number));
    expect(vi.mocked(port.dispose).mock.calls.some((call) => call[0] === "other")).toBe(false);
    other.session.dispose();
  });
});
