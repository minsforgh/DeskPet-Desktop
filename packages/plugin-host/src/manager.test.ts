import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@deskpet/plugin-sdk";
import { MemoryPluginChannel } from "./channel.js";
import { isEnvelope, type Envelope } from "./envelope.js";
import { badgeText, PluginManager } from "./manager.js";
import type { PluginManagerOptions } from "./manager.js";
import type { SchedulerTimer } from "./scheduler.js";

const temporary: string[] = [];
const base: PluginManifest = {
  id: "alpha", name: "Alpha", version: "1.0.0", apiVersion: "1", entry: "index.js",
  description: "", permissions: {}, contributes: {},
};

class Clock {
  now = 1_000_000;
  readonly timers = new Set<SchedulerTimer>();
  set = (fn: () => void, ms: number): SchedulerTimer => {
    const timer = { fn, at: this.now + ms, cancelled: false };
    this.timers.add(timer);
    return timer;
  };
  clear = (timer: SchedulerTimer | ReturnType<typeof setTimeout>): void => {
    if ("cancelled" in timer) timer.cancelled = true;
    else clearTimeout(timer);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) {
      if (timer.cancelled || timer.at > this.now) continue;
      this.timers.delete(timer);
      timer.fn();
    }
  }
}

async function fixture(manifests: Array<PluginManifest | { id: string; invalid: true }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "deskpet-manager-"));
  temporary.push(root);
  const scanRoot = path.join(root, "plugins");
  const userDataDir = path.join(root, "userData");
  await mkdir(scanRoot);
  await mkdir(userDataDir);
  for (const manifest of manifests) {
    const folder = path.join(scanRoot, manifest.id);
    await mkdir(folder);
    await writeFile(path.join(folder, "index.js"), "export {};");
    await writeFile(path.join(folder, "manifest.json"), "invalid" in manifest ? "{" : JSON.stringify(manifest));
  }
  return { scanRoot, userDataDir };
}

function setup(paths: { scanRoot: string; userDataDir: string }, options: {
  permission?: (manifest: PluginManifest) => Promise<boolean>;
  reply?: (request: Extract<Envelope, { kind: "req" }>) => boolean | null;
  schema?: unknown;
  trace?: string[];
  onChannel?: (pluginId: string, count: number) => void;
  onStatusChange?: () => void;
  maskBadge?: (pluginId: string, text: string) => string;
} = {}) {
  const clock = new Clock();
  const requests: Array<{ pluginId: string; method: string; params: unknown }> = [];
  const channels = new Map<string, MemoryPluginChannel[]>();
  const emit = vi.fn();
  const askPermission = vi.fn(options.permission ?? (async () => true));
  const register = vi.fn(() => () => { options.trace?.push("remove"); });
  const log = vi.fn();
  const config = new Map<string, Record<string, unknown>>();
  const managerOptions: PluginManagerOptions = {
    ...paths, clock: () => new Date(clock.now), setTimer: clock.set, clearTimer: clock.clear,
    channelFactory(pluginId) {
      const [main, peer] = MemoryPluginChannel.pair();
      channels.set(pluginId, [...channels.get(pluginId) ?? [], peer]);
      options.onChannel?.(pluginId, channels.get(pluginId)?.length ?? 0);
      peer.onMessage((message) => {
        if (!isEnvelope(message) || message.kind !== "req") return;
        requests.push({ pluginId, method: message.method, params: message.params });
        options.trace?.push(message.method);
        const answer = options.reply?.(message);
        if (answer === null) return;
        const ok = answer ?? true;
        peer.post(ok ? { v: 1, kind: "res", id: message.id, ok: true, value: null } :
          { v: 1, kind: "res", id: message.id, ok: false, error: { code: "E_UNAVAILABLE", message: "plugin text" } });
      });
      queueMicrotask(() => peer.post({ v: 1, kind: "req", id: 1, method: "hello",
        params: { configSchema: options.schema } }));
      return main;
    },
    host: {
      emit, register, setBadge: vi.fn(), fetch: vi.fn(async () => new Response()),
      openExternal: vi.fn(), exec: vi.fn(async () => ({ stdout: "", code: 0 })),
      secrets: { get: vi.fn(async () => null), set: vi.fn(async () => {}) }, log,
    },
    askPermission, emit, log, onStatusChange: options.onStatusChange,
    maskBadge: options.maskBadge,
    getConfig: (id) => config.get(id) ?? {}, setConfig: (id, next) => { config.set(id, next); },
  };
  return { manager: new PluginManager(managerOptions), clock, requests, channels, emit, askPermission, log, config, register };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// The manager reads the plugin folder and grants file from disk, so completion is a condition, not a tick count.
async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => { expect(condition()).toBe(true); }, { timeout: 5_000, interval: 5 });
}

afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("PluginManager", () => {
  it("exposes catalogs while a plugin is denied or disabled", async () => {
    const manifest: PluginManifest = { ...base, apiVersion: "2", permissions: { network: ["example.com"] },
      contributes: { lines: "lines.json" } };
    const paths = await fixture([manifest]);
    const catalog = { version: 1, lines: [{ id: "alpha.done", label: "Done", kind: "done",
      variables: [], variants: ["Done"] }] };
    await writeFile(path.join(paths.scanRoot, "alpha", "lines.json"), JSON.stringify(catalog));
    const app = setup(paths, { permission: async () => false });
    await app.manager.start();
    expect(app.manager.status()[0]?.state).toBe("denied");
    expect(app.manager.lineCatalogs()).toEqual([{ pluginId: "alpha", catalog }]);
  });
  it("limits badge text to 80 characters and removes control characters", () => {
    expect(badgeText("A".repeat(81))).toBe("A".repeat(80));
    expect(badgeText("😀".repeat(81))).toBe("😀".repeat(80));
    expect(badgeText("가\n나\u0000\u007f\u0085다")).toBe("가나다");
  });

  it("includes the current badge in status and removes it when cleared or stopped", async () => {
    const manifest = { ...base, contributes: { badges: ["alpha.first", "alpha.second"] } };
    const test = setup(await fixture([manifest]));
    await test.manager.start();
    const peer = test.channels.get("alpha")?.[0];
    expect(peer).toBeDefined();
    peer?.post({ v: 1, kind: "req", id: 2, method: "setBadge",
      params: { id: "alpha.first", badge: { text: "first\nline" } } });
    await until(() => test.manager.status()[0]?.badge === "firstline");
    peer?.post({ v: 1, kind: "req", id: 3, method: "setBadge",
      params: { id: "alpha.second", badge: { text: "second" } } });
    await until(() => test.manager.status()[0]?.badge === "second");
    peer?.post({ v: 1, kind: "req", id: 4, method: "setBadge",
      params: { id: "alpha.second", badge: null } });
    await until(() => test.manager.status()[0]?.badge === "firstline");
    peer?.post({ v: 1, kind: "req", id: 5, method: "setBadge",
      params: { id: "alpha.first", badge: null } });
    await until(() => test.manager.status()[0]?.badge === undefined);
    peer?.post({ v: 1, kind: "req", id: 6, method: "setBadge",
      params: { id: "alpha.first", badge: { text: "closing" } } });
    await until(() => test.manager.status()[0]?.badge === "closing");
    await test.manager.stop();
    expect(test.manager.status()[0]).not.toHaveProperty("badge");
  });

  it("masks a badge before exposing it in status", async () => {
    const manifest = { ...base, contributes: { badges: ["alpha.status"] } };
    const test = setup(await fixture([manifest]), {
      maskBadge: (_pluginId, text) => text.replaceAll("private123", "***"),
    });
    await test.manager.start();
    test.channels.get("alpha")?.[0]?.post({ v: 1, kind: "req", id: 2, method: "setBadge",
      params: { id: "alpha.status", badge: { text: "Check private123" } } });
    await until(() => test.manager.status()[0]?.badge === "Check ***");
    await test.manager.stop();
  });

  it("discovers, records empty permissions without a dialog, initializes and activates", async () => {
    const test = setup(await fixture([base]));
    await test.manager.start();
    expect(test.askPermission).not.toHaveBeenCalled();
    expect(test.requests.map((request) => request.method)).toEqual(["init", "activate"]);
    expect(test.manager.status()).toEqual([{ id: "alpha", name: "Alpha", version: "1.0.0",
      state: "running", consecutiveErrors: 0 }]);
    await test.manager.stop();
  });

  it("reports every state change so a menu can be rebuilt", async () => {
    const seen: string[] = [];
    const holder: { manager?: PluginManager } = {};
    const test = setup(await fixture([base]), { reply: (request) => request.method !== "invoke",
      onStatusChange: () => { seen.push(holder.manager?.status()[0]?.state ?? "none"); } });
    holder.manager = test.manager;
    await test.manager.start();
    expect(seen).toEqual(["needs-permission", "starting", "running"]);
    const peer = test.channels.get("alpha")?.[0];
    peer?.post({ v: 1, kind: "req", id: 2, method: "schedule.every", params: { ms: 1_000, handle: 7 } });
    await settle();
    for (let i = 0; i < 3; i++) { test.clock.advance(1_000); await settle(); }
    expect(seen.at(-1)).toBe("disabled");
    expect(seen.filter((state) => state === "disabled")).toHaveLength(1);
    await test.manager.stop();
  });

  it("isolates invalid manifests and denied grants", async () => {
    const denied = { ...base, id: "denied", permissions: { network: ["example.com"] } };
    const test = setup(await fixture([{ id: "broken", invalid: true }, denied]), { permission: async () => false });
    await test.manager.start();
    expect(test.manager.status().map(({ id, state }) => [id, state])).toEqual([
      ["broken", "invalid"], ["denied", "denied"],
    ]);
    expect(test.channels.size).toBe(0);
    await test.manager.stop();
  });

  it("asks again when permissions change and keeps a running plugin independent of the dialog", async () => {
    const permissions = { ...base, id: "zeta", permissions: { network: ["example.com"] } };
    const paths = await fixture([base, permissions]);
    let allow: (value: boolean) => void = () => {};
    let dialogOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => { dialogOpened = resolve; });
    const first = setup(paths, { permission: () => {
      dialogOpened();
      return new Promise((resolve) => { allow = resolve; });
    } });
    const starting = first.manager.start();
    await opened;
    await until(() => first.manager.status().find((item) => item.id === "alpha")?.state === "running");
    expect(first.manager.status().find((item) => item.id === "alpha")?.state).toBe("running");
    expect(first.manager.status().find((item) => item.id === "zeta")?.state).toBe("needs-permission");
    allow(true);
    await starting;
    await first.manager.stop();
    const second = setup(paths);
    await second.manager.start();
    expect(second.askPermission).not.toHaveBeenCalled();
    await second.manager.stop();
    await writeFile(path.join(paths.scanRoot, "zeta", "manifest.json"), JSON.stringify({
      ...permissions, permissions: { network: ["example.com", "other.com"] },
    }));
    const third = setup(paths);
    await third.manager.start();
    expect(third.askPermission).toHaveBeenCalledTimes(1);
    await third.manager.stop();
  });

  it("sanitizes config and sends only the latest queued change", async () => {
    const schema = { type: "object", properties: {
      count: { type: "number", default: 2 }, tags: { type: "array", items: { type: "string" } },
      secret: { type: "string", secret: true },
    } };
    const test = setup(await fixture([base]), { schema });
    test.config.set("alpha", { count: "bad", tags: ["ok"], secret: "hidden" });
    await test.manager.start();
    expect(test.requests.find((request) => request.method === "init")?.params).toEqual({
      config: { count: 2, tags: ["ok"] }, permissions: {},
    });
    expect(test.log).toHaveBeenCalled();
    await Promise.all([
      test.manager.setPluginConfig("alpha", { count: 3 }),
      test.manager.setPluginConfig("alpha", { count: 4 }),
    ]);
    await settle();
    const changes = test.requests.filter((request) => request.method === "config.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.params).toEqual({ config: { count: 4 } });
    await test.manager.stop();
  });

  it("drops only invalid elements of an object array and warns", async () => {
    const schema = { type: "object", properties: {
      rules: { type: "array", default: [], items: { type: "object", required: ["id", "time"], properties: {
        id: { type: "string" }, time: { type: "string" }, priority: { type: "string", enum: ["low", "high"] },
      } } },
    } };
    const test = setup(await fixture([base]), { schema });
    const good = { id: "a", time: "09:00", priority: "low", days: [1, 2] };
    test.config.set("alpha", { rules: [good, { id: "b" }, { id: "c", time: 9 }, { id: "d", time: "1", priority: "x" },
      "text", null, [], { id: "e", time: "10:00" }] });
    await test.manager.start();
    expect(test.requests.find((request) => request.method === "init")?.params).toEqual({
      config: { rules: [good, { id: "e", time: "10:00" }] }, permissions: {},
    });
    expect(test.log).toHaveBeenCalledWith("warn", "Invalid config items for alpha: rules (6 dropped)");
    await test.manager.stop();
  });

  it("checks flat array properties of object items by element type and enum", async () => {
    const schema = { type: "object", properties: {
      rules: { type: "array", default: [], items: { type: "object", required: ["id"], properties: {
        id: { type: "string" }, days: { type: "array", items: { type: "number" }, enum: [0, 1, 2, 3, 4, 5, 6] },
        tags: { type: "array", items: { type: "string" } },
      } } },
    } };
    const test = setup(await fixture([base]), { schema });
    const good = { id: "a", days: [1, 3], tags: ["x"] };
    test.config.set("alpha", { rules: [good, { id: "b", days: [7] }, { id: "c", days: ["1"] }, { id: "d", days: 1 },
      { id: "e", tags: [1] }, { id: "f", days: [] }, { id: "g", days: [[1]] }] });
    await test.manager.start();
    expect(test.requests.find((request) => request.method === "init")?.params).toEqual({
      config: { rules: [good, { id: "f", days: [] }] }, permissions: {},
    });
    expect(test.log).toHaveBeenCalledWith("warn", "Invalid config items for alpha: rules (5 dropped)");
    await test.manager.stop();
  });

  it("replaces a non-array object-array field with its default", async () => {
    const schema = { type: "object", properties: {
      rules: { type: "array", default: [], items: { type: "object", properties: { id: { type: "string" } } } },
    } };
    const test = setup(await fixture([base]), { schema });
    test.config.set("alpha", { rules: { id: "a" } });
    await test.manager.start();
    expect(test.requests.find((request) => request.method === "init")?.params).toEqual({
      config: { rules: [] }, permissions: {},
    });
    await test.manager.stop();
  });

  it("ignores a schema with malformed object items and sends config unchanged", async () => {
    const bad = [
      { type: "object", properties: { x: { type: "array" } } },
      { type: "object", properties: { x: { type: "object" } } },
      { type: "object", properties: { x: { type: "array", items: { type: "object", properties: {} } } } },
      { type: "object", properties: { x: { type: "array", items: { type: "boolean" } } } },
      { type: "object", properties: { x: { type: "array", items: { type: "array" } } } },
      { type: "object", properties: { x: { type: "string", items: { type: "string" } } } },
      { type: "object", properties: {}, required: [1] },
      { type: "object" },
      { type: "number" },
    ];
    for (const items of bad) {
      const test = setup(await fixture([base]), { schema: { type: "object", properties: { rules: { type: "array", items } } } });
      test.config.set("alpha", { rules: [{ id: "keep" }] });
      await test.manager.start();
      expect(test.requests.find((request) => request.method === "init")?.params).toEqual({
        config: { rules: [{ id: "keep" }] }, permissions: {},
      });
      await test.manager.stop();
    }
  });

  it("lists schemas only for running plugins, with the secrets permission and a detached copy", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const test = setup(await fixture([base, { ...base, id: "beta", permissions: { secrets: true } }]), { schema });
    expect(test.manager.configSchemas()).toEqual([]);
    await test.manager.start();
    const listed = test.manager.configSchemas();
    expect(listed.map(({ id, secrets }) => ({ id, secrets }))).toEqual([{ id: "alpha", secrets: false }, { id: "beta", secrets: true }]);
    expect(listed[0]?.schema).toEqual(schema);
    const name = listed[0]?.schema.properties.name;
    if (name) name.type = "number";
    expect(test.manager.configSchemas()[0]?.schema).toEqual(schema);
    test.config.set("alpha", { name: "kept", other: 1 });
    expect(await test.manager.pluginConfig("alpha")).toEqual({ name: "kept" });
    await expect(test.manager.pluginConfig("nobody")).rejects.toThrow("Unknown plugin");
    await test.manager.stop();
  });

  it("configSettled waits until the plugin has answered config.changed", async () => {
    const test = setup(await fixture([base]), { schema: { type: "object", properties: { count: { type: "number" } } } });
    await test.manager.start();
    await test.manager.setPluginConfig("alpha", { count: 5 });
    await test.manager.configSettled();
    expect(test.requests.filter((request) => request.method === "config.changed")).toHaveLength(1);
    await test.manager.stop();
  });

  it("uses scheduler results to disable after three failures and can enable again", async () => {
    const test = setup(await fixture([{ ...base, contributes: { badges: ["alpha.status"] } }]),
      { reply: (request) => request.method !== "invoke" });
    await test.manager.start();
    const peer = test.channels.get("alpha")?.[0];
    expect(peer).toBeDefined();
    peer?.post({ v: 1, kind: "req", id: 2, method: "setBadge",
      params: { id: "alpha.status", badge: { text: "stale" } } });
    await until(() => test.manager.status()[0]?.badge === "stale");
    peer?.post({ v: 1, kind: "req", id: 3, method: "schedule.every", params: { ms: 1_000, handle: 7 } });
    await settle();
    for (let i = 0; i < 3; i++) { test.clock.advance(1_000); await settle(); }
    expect(test.manager.status()[0]).toMatchObject({ state: "disabled", consecutiveErrors: 3,
      reason: "오류가 3번 이어졌습니다" });
    expect(test.manager.status()[0]).not.toHaveProperty("badge");
    expect(test.emit).toHaveBeenCalledWith(expect.objectContaining({ source: "deskpet", type: "notify",
      priority: "high", mood: "worried", key: "plugin-disabled:alpha" }));
    test.clock.advance(2_000);
    await settle();
    expect(await test.manager.enable("alpha")).toBe(true);
    expect(test.manager.status()[0]).toMatchObject({ state: "running", consecutiveErrors: 0 });
    await test.manager.stop();
  });

  it("restarts unexpected exits after one and five seconds", async () => {
    let openedSecond: () => void = () => {};
    let openedThird: () => void = () => {};
    const second = new Promise<void>((resolve) => { openedSecond = resolve; });
    const third = new Promise<void>((resolve) => { openedThird = resolve; });
    const test = setup(await fixture([{ ...base, contributes: { badges: ["alpha.status"] } }]), { onChannel: (_, count) => {
      if (count === 2) openedSecond();
      if (count === 3) openedThird();
    } });
    await test.manager.start();
    test.channels.get("alpha")?.[0]?.post({ v: 1, kind: "req", id: 2, method: "setBadge",
      params: { id: "alpha.status", badge: { text: "old generation" } } });
    await until(() => test.manager.status()[0]?.badge === "old generation");
    test.channels.get("alpha")?.[0]?.kill();
    await settle();
    expect(test.manager.status()[0]).toMatchObject({ state: "restarting", consecutiveErrors: 1 });
    expect(test.manager.status()[0]).not.toHaveProperty("badge");
    test.clock.advance(999); await settle();
    expect(test.channels.get("alpha")).toHaveLength(1);
    test.clock.advance(1); await settle();
    await second;
    await until(() => test.manager.status()[0]?.state === "running");
    expect(test.channels.get("alpha")).toHaveLength(2);
    test.channels.get("alpha")?.[1]?.kill();
    await settle();
    expect(test.manager.status()[0]).toMatchObject({ state: "restarting", consecutiveErrors: 2 });
    test.clock.advance(5_000); await settle();
    await third;
    await until(() => test.manager.status()[0]?.state === "running");
    expect(test.channels.get("alpha")).toHaveLength(3);
    test.channels.get("alpha")?.[2]?.kill();
    await settle();
    expect(test.manager.status()[0]).toMatchObject({ state: "disabled", consecutiveErrors: 3 });
    expect(test.emit).toHaveBeenCalledTimes(1);
    await test.manager.stop();
  });

  it("removes registrations after deactivate and before shutdown", async () => {
    const trace: string[] = [];
    const manifest = { ...base, contributes: { actions: ["alpha.run"] } };
    const test = setup(await fixture([manifest]), { trace });
    await test.manager.start();
    test.channels.get("alpha")?.[0]?.post({ v: 1, kind: "req", id: 2,
      method: "registerAction", params: { id: "alpha.run", handle: 2 } });
    await settle();
    await test.manager.stop();
    expect(trace.slice(-3)).toEqual(["deactivate", "remove", "shutdown"]);
  });

  it("deactivates before registrations are removed and stops within the three-second app limit", async () => {
    const test = setup(await fixture([base]), { reply: (request) => request.method === "deactivate" ? null : true });
    await test.manager.start();
    const closing = test.manager.stop();
    await settle();
    expect(test.requests.at(-1)?.method).toBe("deactivate");
    test.clock.advance(3_000);
    await closing;
    expect(test.channels.get("alpha")?.[0]).toBeDefined();
  });
});
