import { AsyncLocalStorage } from "node:async_hooks";
import type { PetEvent, ReactionRule } from "@deskpet/core";
import type {
  CheckerWindowOptions,
  PluginContext,
  PluginManifest,
} from "../v1/index.js";

type ActionHandler = (args?: unknown) => Promise<void> | void;
type AsyncCallback = () => Promise<void>;
type Badge = { text: string; tone?: "neutral" | "warn" | "ok" };

export interface TestContextOptions {
  manifest?: Partial<PluginManifest>;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  windowResponses?: Record<string, { status: number; body: unknown }>;
}

export interface TestWindow {
  id: string;
  options: CheckerWindowOptions;
  paths: string[];
  visible: boolean;
}

export interface TestContext {
  ctx: PluginContext;
  events: PetEvent[];
  actions: Map<string, ActionHandler>;
  trayItems: Map<string, { id: string; label: string; action: string }>;
  reactionRules: Set<ReactionRule>;
  badges: Map<string, Badge>;
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }>;
  openExternalCalls: string[];
  windows: TestWindow[];
  schedules: {
    every: Array<{ ms: number; fn: AsyncCallback }>;
    at: Array<{ cron: string; fn: AsyncCallback; opts?: { tz?: string } }>;
    onResume: Array<() => void>;
  };
  runAction(id: string, args?: unknown): Promise<void>;
  runEvery(index?: number): Promise<void>;
  runAt(index?: number): Promise<void>;
  runOnResume(index?: number): void;
  changeConfig(next: Record<string, unknown>): void;
}

function removeFrom<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index !== -1) items.splice(index, 1);
}

function urlFor(value: string | URL): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`URL is not allowed: ${value}`);
  }
  return url;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const permissions = options.manifest?.permissions ?? {};
  const contributes = options.manifest?.contributes ?? {};
  const events: PetEvent[] = [];
  const actions = new Map<string, ActionHandler>();
  const trayItems = new Map<string, { id: string; label: string; action: string }>();
  const reactionRules = new Set<ReactionRule>();
  const badges = new Map<string, Badge>();
  const logs: TestContext["logs"] = [];
  const openExternalCalls: string[] = [];
  const windows: TestWindow[] = [];
  const schedules: TestContext["schedules"] = { every: [], at: [], onResume: [] };
  const configListeners = new Set<(next: Record<string, unknown>) => void>();
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const actionScope = new AsyncLocalStorage<{ active: boolean }>();

  function requireDeclared(id: string, allowed: string[] | undefined, kind: string): void {
    if (!allowed?.includes(id)) throw new Error(`${kind} is not declared: ${id}`);
  }

  function requireNetwork(url: URL): void {
    if (!permissions.network?.includes(url.hostname)) {
      throw new Error(`network host is not allowed: ${url.hostname}`);
    }
  }

  function requireActionScope(): void {
    if (actionScope.getStore()?.active !== true) {
      throw new Error("write operation requires a user-invoked action");
    }
  }

  const ctx: PluginContext = {
    emit(event) { events.push(event); },
    registerAction(id, handler) {
      requireDeclared(id, contributes.actions, "action");
      actions.set(id, handler);
      return { dispose() { if (actions.get(id) === handler) actions.delete(id); } };
    },
    addTrayItem(item) {
      requireDeclared(item.id, contributes.trayItems, "tray item");
      requireDeclared(item.action, contributes.actions, "tray action");
      trayItems.set(item.id, item);
      return { dispose() { if (trayItems.get(item.id) === item) trayItems.delete(item.id); } };
    },
    schedule: {
      every(ms, fn) {
        const entry = { ms, fn };
        schedules.every.push(entry);
        return { dispose() { removeFrom(schedules.every, entry); } };
      },
      at(cron, fn, opts) {
        const entry = { cron, fn, opts };
        schedules.at.push(entry);
        return { dispose() { removeFrom(schedules.at, entry); } };
      },
      onResume(fn) {
        schedules.onResume.push(fn);
        return { dispose() { removeFrom(schedules.onResume, fn); } };
      },
    },
    addReactionRule(rule) {
      reactionRules.add(rule);
      return { dispose() { reactionRules.delete(rule); } };
    },
    setBadge(id, badge) {
      requireDeclared(id, contributes.badges, "badge");
      if (badge === null) badges.delete(id);
      else badges.set(id, badge);
    },
    config: { ...options.config },
    onConfigChange(fn) {
      configListeners.add(fn);
      return { dispose() { configListeners.delete(fn); } };
    },
    secrets: {
      async get(key) {
        if (permissions.secrets !== true) throw new Error("secrets permission is not declared");
        return secrets.get(key) ?? null;
      },
      async set(key, value) {
        if (permissions.secrets !== true) throw new Error("secrets permission is not declared");
        secrets.set(key, value);
      },
    },
    async openExternal(value) {
      const url = urlFor(value);
      if (url.protocol !== "https:" || url.port || !permissions.openExternal?.some((pattern) => {
        const match = /^https:\/\/([^/]+)(\/.*)$/.exec(pattern);
        if (!match || match[1] !== url.hostname) return false;
        const path = match[2];
        if (!path) return false;
        return path.endsWith("/*")
          ? url.pathname.startsWith(path.slice(0, -1))
          : url.pathname === path;
      })) {
        throw new Error(`external URL is not allowed: ${value}`);
      }
      openExternalCalls.push(value);
    },
    async fetch(input, init) {
      const url = urlFor(input instanceof Request ? input.url : input);
      requireNetwork(url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" && method !== "HEAD") requireActionScope();
      if (!options.fetch) throw new Error("no test fetch substitute configured");
      return options.fetch(input, init);
    },
    windows: {
      async create(id, windowOptions) {
        requireDeclared(id, permissions.windows, "window");
        const origin = urlFor(windowOptions.url);
        requireNetwork(origin);
        const window: TestWindow = {
          id, options: windowOptions, paths: [], visible: windowOptions.show ?? false,
        };
        windows.push(window);
        return {
          show() { window.visible = true; },
          hide() { window.visible = false; },
          async getJson(path: string) {
            if (!path.startsWith("/") || path.startsWith("//") || new URL(path, origin).origin !== origin.origin) {
              throw new Error(`checker path is not same-origin: ${path}`);
            }
            window.paths.push(path);
            const response = options.windowResponses?.[path];
            if (!response) throw new Error(`no checker response configured for ${path}`);
            return response;
          },
          dispose() { removeFrom(windows, window); },
        };
      },
    },
    log: {
      debug(message) { logs.push({ level: "debug", message }); },
      info(message) { logs.push({ level: "info", message }); },
      warn(message) { logs.push({ level: "warn", message }); },
      error(message) { logs.push({ level: "error", message }); },
    },
  };

  if (permissions.shell) {
    ctx.exec = async (cmd, args) => {
      requireActionScope();
      if (!options.exec) throw new Error("no test exec substitute configured");
      return options.exec(cmd, args);
    };
  }

  return {
    ctx, events, actions, trayItems, reactionRules, badges, logs,
    openExternalCalls, windows, schedules,
    async runAction(id, args) {
      const handler = actions.get(id);
      if (!handler) throw new Error(`action is not registered: ${id}`);
      const scope = { active: true };
      try {
        await actionScope.run(scope, () => handler(args));
      } finally {
        scope.active = false;
      }
    },
    async runEvery(index = 0) {
      const entry = schedules.every[index];
      if (!entry) throw new Error(`every callback is not registered: ${index}`);
      await actionScope.run({ active: false }, () => entry.fn());
    },
    async runAt(index = 0) {
      const entry = schedules.at[index];
      if (!entry) throw new Error(`at callback is not registered: ${index}`);
      await actionScope.run({ active: false }, () => entry.fn());
    },
    runOnResume(index = 0) {
      const fn = schedules.onResume[index];
      if (!fn) throw new Error(`onResume callback is not registered: ${index}`);
      actionScope.run({ active: false }, fn);
    },
    changeConfig(next) {
      ctx.config = { ...next };
      for (const listener of configListeners) actionScope.run({ active: false }, () => listener(next));
    },
  };
}
