import type { LineCatalog, LinePetEvent } from "@deskpet/core";
import type { ConfigFieldSchema, ConfigItemsSchema, ConfigSchema, ObjectItemField, PluginManifest } from "@deskpet/plugin-sdk";
import type { PluginChannel } from "./channel.js";
import { discoverPlugins, type DiscoveredPlugin } from "./discover.js";
import { resolvePluginEntry } from "./entry-path.js";
import type { Envelope } from "./envelope.js";
import { isEnvelope } from "./envelope.js";
import { checkGrant, loadGrants, recordGrant, saveGrants } from "./grants.js";
import { Scheduler, type ScheduleResult, type SchedulerOptions } from "./scheduler.js";
import { PluginSession, type SessionHost } from "./session.js";

export type PluginState = "invalid" | "needs-permission" | "denied" | "starting" | "running" | "restarting" | "disabled";
export interface PluginStatus {
  id: string;
  name?: string;
  version?: string;
  state: PluginState;
  reason?: string;
  badge?: string;
  consecutiveErrors: number;
}

type Timer = Parameters<NonNullable<SchedulerOptions["clearTimer"]>>[0];
type RequestResult = Extract<Envelope, { kind: "res" }>;
interface ManagedPlugin {
  discovered: Extract<DiscoveredPlugin, { state: "valid" }>;
  status: PluginStatus;
  channel?: PluginChannel;
  session?: PluginSession;
  schema?: ConfigSchema;
  pending: Map<number, { resolve: (value: RequestResult) => void; timer: Timer }>;
  nextRequestId: number;
  restart?: Timer;
  generation: number;
  closing: boolean;
  exited: boolean;
  configRevision: number;
  cleanupTask?: Promise<void>;
  badges: Map<string, string>;
}

/** What a settings form needs about one running plugin; `secrets` is whether it may store secret values. */
export interface PluginConfigInfo { id: string; schema: ConfigSchema; secrets: boolean }

export interface PluginManagerOptions {
  scanRoot: string;
  userDataDir: string;
  channelFactory(pluginId: string, entryPath: string): PluginChannel | Promise<PluginChannel>;
  host: SessionHost;
  askPermission(manifest: PluginManifest, permissions: PluginManifest["permissions"]): Promise<boolean>;
  clock: () => Date;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
  emit: (event: LinePetEvent) => void | Promise<void>;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  getConfig(id: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  setConfig(id: string, next: Record<string, unknown>): void | Promise<void>;
  maskBadge?: (pluginId: string, text: string) => string;
  createScheduler?: (onResult: (result: ScheduleResult) => void) => Scheduler;
  /** Called after a plugin appears or its state changes, so a menu can be rebuilt. Error counts alone do not call it. */
  onStatusChange?: () => void;
}

// Windows MemoryPluginChannel manager tests (8 cases, 2026-10-07) completed in at
// most 22ms per case. ADR-0005 §4 fixes these larger process safety ceilings:
// 30s activation, 5s deactivation, 2s shutdown, 3s app exit, and 1s/5s restart.
// The runner integration must measure actual process maxima before tuning them.
const ACTIVATE_MS = 30_000;
const DEACTIVATE_MS = 5_000;
const SHUTDOWN_MS = 2_000;
const EXIT_MS = 3_000;
const RESTART_DELAYS_MS = [1_000, 5_000] as const;

type ObjectItems = Extract<ConfigItemsSchema, { type: "object" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function badgeText(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127 && (code < 128 || code > 159);
  }).slice(0, 80).join("");
}

function scalarMatches(value: unknown, field: { type: string; enum?: readonly (string | number)[] }): boolean {
  if (typeof value !== field.type) return false;
  return field.enum === undefined || field.enum.includes(value as string | number);
}

function objectFieldMatches(value: unknown, field: ObjectItemField): boolean {
  if (field.type !== "array") return scalarMatches(value, field);
  // The enum of an array property limits its elements.
  return Array.isArray(value) && value.every((element: unknown) =>
    scalarMatches(element, { type: field.items.type, enum: field.enum }));
}

/** Checks one array element against declared properties; undeclared properties are allowed. */
function objectItemMatches(item: unknown, items: ObjectItems): boolean {
  if (!isRecord(item)) return false;
  for (const name of items.required ?? []) if (item[name] === undefined) return false;
  return Object.entries(items.properties).every(([name, field]) =>
    item[name] === undefined || objectFieldMatches(item[name], field));
}

function configFieldMatches(value: unknown, field: ConfigFieldSchema): boolean {
  if (field.type === "array") {
    if (!Array.isArray(value)) return false;
    if (field.items?.type === "object") return true;
    return field.items === undefined || value.every((item: unknown) => typeof item === "string");
  }
  return scalarMatches(value, field);
}

function validObjectItemField(field: unknown): boolean {
  if (!isRecord(field)) return false;
  if (field.type === "array") {
    // Flat arrays only: the element type is a string or a number, never another array or object.
    if (!isRecord(field.items) || (field.items.type !== "string" && field.items.type !== "number")) return false;
  } else if ((field.type !== "string" && field.type !== "number" && field.type !== "boolean") || field.items !== undefined) return false;
  return field.enum === undefined || (Array.isArray(field.enum) &&
    field.enum.every((item: unknown) => typeof item === "string" || typeof item === "number"));
}

function validItems(items: unknown): boolean {
  if (!isRecord(items)) return false;
  if (items.type === "string") return true;
  if (items.type !== "object" || !isRecord(items.properties)) return false;
  if (items.required !== undefined && (!Array.isArray(items.required) ||
      !items.required.every((name: unknown) => typeof name === "string"))) return false;
  return Object.values(items.properties).every(validObjectItemField);
}

function configSchema(value: unknown): ConfigSchema | undefined {
  const candidate = value;
  if (!isRecord(candidate) || candidate.type !== "object" || !isRecord(candidate.properties)) return undefined;
  const properties = candidate.properties;
  for (const field of Object.values(properties)) {
    if (!isRecord(field)) return undefined;
    const type = field.type;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "array") return undefined;
    if (field.enum !== undefined && (!Array.isArray(field.enum) ||
        !field.enum.every((item: unknown) => typeof item === "string" || typeof item === "number"))) return undefined;
    if (field.items !== undefined && (type !== "array" || !validItems(field.items))) return undefined;
  }
  return value as ConfigSchema;
}

export class PluginManager {
  readonly scheduler: Scheduler;
  private readonly plugins = new Map<string, ManagedPlugin>();
  private readonly statuses = new Map<string, PluginStatus>();
  private readonly deliveries = new Set<Promise<void>>();
  private started = false;
  private stopping = false;

  constructor(private readonly options: PluginManagerOptions) {
    this.scheduler = options.createScheduler?.((result) => this.onScheduleResult(result)) ??
      new Scheduler({ clock: options.clock, setTimer: options.setTimer, clearTimer: options.clearTimer,
        onResult: (result) => this.onScheduleResult(result) });
  }

  private setState(status: PluginStatus, state: PluginState): void {
    if (status.state === state) return;
    status.state = state;
    this.options.onStatusChange?.();
  }

  status(): PluginStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({ ...item }));
  }

  /** Catalogs are available even while their plugins are disabled or awaiting permission. */
  lineCatalogs(): Array<{ pluginId: string; catalog: LineCatalog }> {
    return [...this.plugins.values()].flatMap((plugin) => plugin.discovered.lines === undefined ? [] :
      [{ pluginId: plugin.status.id, catalog: structuredClone(plugin.discovered.lines) }]);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const discovered = await discoverPlugins(this.options.scanRoot);
    const grants = await loadGrants(this.options.userDataDir);
    const permissions: ManagedPlugin[] = [];
    const launches: Promise<void>[] = [];
    for (const item of discovered) {
      if (item.state === "invalid") {
        this.statuses.set(item.id, { id: item.id, state: "invalid", reason: item.reason.slice(0, 200), consecutiveErrors: 0 });
        this.options.onStatusChange?.();
        this.options.log("warn", `Invalid plugin ${item.id}: ${item.reason}`);
        continue;
      }
      const status: PluginStatus = { id: item.id, name: item.manifest.name, version: item.manifest.version,
        state: "needs-permission", consecutiveErrors: 0 };
      const plugin: ManagedPlugin = { discovered: item, status, pending: new Map(), nextRequestId: 1,
        generation: 0, closing: false, exited: false, configRevision: 0, badges: new Map() };
      this.statuses.set(item.id, status);
      this.plugins.set(item.id, plugin);
      this.options.onStatusChange?.();
      const grant = checkGrant(grants, item.id, item.manifest.permissions, this.options.clock);
      if (grant === "denied") this.setState(status, "denied");
      else if (grant === "needs-permission") permissions.push(plugin);
      else {
        if (grant === "updated") await saveGrants(this.options.userDataDir, grants);
        launches.push(this.launch(plugin));
      }
    }
    // Permission dialogs are serialized, while already allowed plugins launch immediately.
    for (const plugin of permissions) {
      if (this.stopping) break;
      try {
        const allowed = await this.options.askPermission(plugin.discovered.manifest, plugin.discovered.manifest.permissions);
        recordGrant(grants, plugin.status.id, plugin.discovered.manifest.permissions,
          allowed ? "granted" : "denied", this.options.clock);
        await saveGrants(this.options.userDataDir, grants);
        if (allowed) launches.push(this.launch(plugin));
        else this.setState(plugin.status, "denied");
      } catch {
        this.setState(plugin.status, "denied");
        this.options.log("error", `Permission decision failed for ${plugin.status.id}`);
      }
    }
    await Promise.allSettled(launches);
  }

  async enable(id: string): Promise<boolean> {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.status.state !== "disabled" || this.stopping) return false;
    if (plugin.cleanupTask) await plugin.cleanupTask;
    plugin.status.consecutiveErrors = 0;
    delete plugin.status.reason;
    this.setState(plugin.status, "starting");
    await this.launch(plugin);
    return true;
  }

  async setPluginConfig(id: string, next: Record<string, unknown>): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("Unknown plugin");
    await this.options.setConfig(id, this.cleanConfig(plugin, next));
    const revision = ++plugin.configRevision;
    queueMicrotask(() => {
      if (revision !== plugin.configRevision || plugin.status.state !== "running") return;
      const delivery = this.sendConfig(plugin).catch(() => this.recordError(plugin));
      this.deliveries.add(delivery);
      void delivery.finally(() => { this.deliveries.delete(delivery); });
    });
  }

  /** Resolves when every config.changed sent so far has been answered by its plugin. */
  async configSettled(): Promise<void> {
    while (this.deliveries.size > 0) await Promise.allSettled([...this.deliveries]);
  }

  /** The config schema of every running plugin that declares one; only running (allowed, started) plugins have a form. */
  configSchemas(): PluginConfigInfo[] {
    return [...this.plugins.values()].flatMap((plugin) => plugin.status.state === "running" && plugin.schema
      ? [{ id: plugin.status.id, schema: structuredClone(plugin.schema), secrets: plugin.discovered.manifest.permissions.secrets === true }]
      : []).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The stored config as the plugin itself would receive it: cleaned by its schema, defaults filled, secrets left out. */
  async pluginConfig(id: string): Promise<Record<string, unknown>> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("Unknown plugin");
    return this.cleanedConfig(plugin);
  }

  async invokeAction(id: string, actionId: string, args?: unknown): Promise<RequestResult> {
    const plugin = this.plugins.get(id);
    if (!plugin?.session || plugin.status.state !== "running") throw new Error("Plugin is unavailable");
    const result = await plugin.session.invokeAction(actionId, args);
    if (result.kind !== "res") throw new Error("Invalid plugin response");
    this.onCallbackResult(plugin, result);
    return result;
  }

  resume(): void { this.scheduler.resume(); }

  secretChanged(id: string, key: string): void {
    this.plugins.get(id)?.session?.restartSlackForSecret(key);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const closing = Promise.allSettled([...this.plugins.values()].map((plugin) => this.cleanup(plugin)));
    let timer: Timer | undefined;
    await Promise.race([closing, new Promise<void>((resolve) => {
      timer = this.options.setTimer(resolve, EXIT_MS);
    })]);
    if (timer !== undefined) this.options.clearTimer(timer);
    for (const plugin of this.plugins.values()) {
      plugin.exited = true;
      plugin.channel?.kill();
      this.rejectPending(plugin);
    }
  }

  private async launch(plugin: ManagedPlugin): Promise<void> {
    if (this.stopping || plugin.status.state === "disabled") return;
    this.setState(plugin.status, "starting");
    plugin.closing = false;
    plugin.exited = false;
    plugin.cleanupTask = undefined;
    const generation = ++plugin.generation;
    plugin.badges.clear();
    delete plugin.status.badge;
    try {
      const entry = await resolvePluginEntry(plugin.discovered.folder, plugin.discovered.manifest.entry);
      const channel = await this.options.channelFactory(plugin.status.id, entry);
      if (this.stopping || generation !== plugin.generation) { channel.kill(); return; }
      plugin.channel = channel;
      channel.onMessage((message) => this.onMessage(plugin, generation, message));
      const host: SessionHost = {
        ...this.options.host,
        register: (id, kind, handle, value) => this.register(plugin, id, kind, handle, value),
        log: (level, message, id) => this.options.host.log(level, message, id),
        setBadge: async (pluginId, id, badge) => {
          if (generation !== plugin.generation || (plugin.closing && badge !== null)) return;
          await this.options.host.setBadge(pluginId, id, badge);
          if (generation !== plugin.generation || plugin.closing) return;
          if (badge === null) plugin.badges.delete(id);
          else {
            plugin.badges.delete(id);
            const text = badgeText(this.options.maskBadge?.(pluginId, badge.text) ?? badge.text);
            if (text) plugin.badges.set(id, text);
          }
          const current = [...plugin.badges.values()].at(-1);
          if (current === undefined) delete plugin.status.badge;
          else plugin.status.badge = current;
        },
      };
      plugin.session = new PluginSession(plugin.discovered.manifest, channel, host,
        () => this.options.clock().getTime(), plugin.discovered.lines);
      channel.onExit(() => { void this.onExit(plugin, generation); });
      const hello = await this.waitForHello(plugin, generation);
      if (hello === null) throw new Error("hello timed out");
      if (this.stopping || generation !== plugin.generation) return;
      plugin.schema = hello;
      const config = await this.cleanedConfig(plugin);
      const initialized = await this.request(plugin, "init", { config, permissions: plugin.discovered.manifest.permissions }, ACTIVATE_MS);
      if (!initialized.ok) throw new Error("init failed");
      const result = await this.request(plugin, "activate", {}, ACTIVATE_MS);
      if (!result.ok && result.error.code === "E_TIMEOUT") {
        channel.kill();
        return;
      }
      if (!result.ok) throw new Error("activate failed");
      this.setState(plugin.status, "running");
    } catch {
      if (generation !== plugin.generation || this.stopping) return;
      if (plugin.exited) return;
      this.recordError(plugin);
      if (this.statuses.get(plugin.status.id)?.state !== "disabled") {
        await this.cleanup(plugin);
        this.restart(plugin);
      }
    }
  }

  private waitForHello(plugin: ManagedPlugin, generation: number): Promise<ConfigSchema | undefined | null> {
    return new Promise((resolve) => {
      const channel = plugin.channel;
      if (!channel) { resolve(null); return; }
      const timer = this.options.setTimer(() => { off(); resolve(null); }, ACTIVATE_MS);
      const off = channel.onMessage((message) => {
        if (generation !== plugin.generation || !isEnvelope(message) || message.kind !== "req" || message.method !== "hello") return;
        off(); this.options.clearTimer(timer);
        const params = message.params;
        const schema = params !== null && typeof params === "object" && !Array.isArray(params) &&
          "configSchema" in params ? configSchema(params.configSchema) : undefined;
        resolve(schema);
      });
      channel.onExit(() => {
        off(); this.options.clearTimer(timer); resolve(null);
      });
    });
  }

  private onMessage(plugin: ManagedPlugin, generation: number, message: unknown): void {
    if (generation !== plugin.generation || !isEnvelope(message) || message.kind !== "res") return;
    const pending = plugin.pending.get(message.id);
    if (!pending) return;
    plugin.pending.delete(message.id);
    this.options.clearTimer(pending.timer);
    pending.resolve(message);
  }

  private request(plugin: ManagedPlugin, method: string, params: unknown, timeoutMs: number): Promise<RequestResult> {
    const channel = plugin.channel;
    if (!channel) return Promise.reject(new Error("Plugin channel closed"));
    const id = plugin.nextRequestId++;
    return new Promise((resolve) => {
      const timer = this.options.setTimer(() => {
        plugin.pending.delete(id);
        resolve({ v: 1, kind: "res", id, ok: false, error: { code: "E_TIMEOUT", message: "요청 시간이 초과되었습니다" } });
      }, timeoutMs);
      plugin.pending.set(id, { resolve, timer });
      channel.post({ v: 1, kind: "req", id, method, params });
    });
  }

  private async cleanedConfig(plugin: ManagedPlugin): Promise<Record<string, unknown>> {
    const raw = await this.options.getConfig(plugin.status.id);
    return this.cleanConfig(plugin, raw);
  }

  private cleanConfig(plugin: ManagedPlugin, raw: Record<string, unknown>): Record<string, unknown> {
    const schema = plugin.schema;
    if (!schema) return { ...raw };
    const config: Record<string, unknown> = {};
    const put = (name: string, value: unknown): void => {
      Object.defineProperty(config, name, { value, enumerable: true, writable: true, configurable: true });
    };
    for (const [name, field] of Object.entries(schema.properties)) {
      if (field.secret) {
        if (plugin.discovered.manifest.permissions.secrets !== true)
          this.options.log("warn", `Secret config field without permission: ${plugin.status.id}`);
        continue;
      }
      const value = raw[name];
      if (value === undefined) {
        if (field.default !== undefined) put(name, field.default);
      } else if (configFieldMatches(value, field)) {
        if (field.items?.type === "object" && Array.isArray(value)) {
          // ADR-0005 §6 for object arrays: drop only the bad elements, keep the rest.
          const items = field.items;
          const kept = value.filter((item: unknown) => objectItemMatches(item, items));
          if (kept.length !== value.length)
            this.options.log("warn", `Invalid config items for ${plugin.status.id}: ${name} (${value.length - kept.length} dropped)`);
          put(name, kept);
        } else put(name, value);
      } else {
        this.options.log("warn", `Invalid config field for ${plugin.status.id}: ${name}`);
        if (field.default !== undefined) put(name, field.default);
      }
    }
    return config;
  }

  private async sendConfig(plugin: ManagedPlugin): Promise<void> {
    const config = await this.cleanedConfig(plugin);
    const result = await this.request(plugin, "config.changed", { config }, ACTIVATE_MS);
    this.onCallbackResult(plugin, result);
  }

  private register(plugin: ManagedPlugin, id: string, kind: string, handle: number, value: unknown):
    undefined | (() => void) | Promise<undefined | (() => void)> {
    if (kind === "schedule.every" || kind === "schedule.at" || kind === "schedule.onResume") {
      const params = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
      const invoke = async (): Promise<void> => {
        const result = await this.request(plugin, "invoke", { handle, args: null }, ACTIVATE_MS);
        if (!result.ok) throw new Error("Plugin callback failed");
      };
      if (kind === "schedule.every" && typeof params.ms === "number") {
        const disposable = this.scheduler.scheduleEvery(id, params.ms, invoke);
        return () => disposable.dispose();
      }
      if (kind === "schedule.at" && typeof params.cron === "string") {
        const opts = params.opts !== null && typeof params.opts === "object" && !Array.isArray(params.opts) &&
          "tz" in params.opts && typeof params.opts.tz === "string" ? { tz: params.opts.tz } : undefined;
        const disposable = this.scheduler.scheduleAt(id, params.cron, invoke, opts);
        return () => disposable.dispose();
      }
      if (kind === "schedule.onResume") {
        const disposable = this.scheduler.onResume(id, () => {
          void invoke().then(() => this.recordSuccess(plugin), () => this.recordError(plugin));
        });
        return () => disposable.dispose();
      }
    }
    return this.options.host.register(id, kind, handle, value);
  }

  private onScheduleResult(result: ScheduleResult): void {
    const plugin = this.plugins.get(result.pluginId);
    if (!plugin || plugin.status.state !== "running") return;
    if (result.status === "success") this.recordSuccess(plugin);
    else this.recordError(plugin);
  }

  private onCallbackResult(plugin: ManagedPlugin, result: RequestResult): void {
    if (result.ok) this.recordSuccess(plugin);
    else this.recordError(plugin);
  }

  private recordSuccess(plugin: ManagedPlugin): void { plugin.status.consecutiveErrors = 0; }

  private recordError(plugin: ManagedPlugin): void {
    if (plugin.status.state === "disabled" || this.stopping) return;
    plugin.status.consecutiveErrors++;
    if (plugin.status.consecutiveErrors < 3) return;
    plugin.status.reason = "오류가 3번 이어졌습니다";
    this.setState(plugin.status, "disabled");
    if (plugin.restart) this.options.clearTimer(plugin.restart);
    void this.cleanup(plugin);
    const name = plugin.discovered.manifest.name;
    void Promise.resolve(this.options.emit({ source: "deskpet", type: "notify", priority: "high",
      mood: "worried", key: `plugin-disabled:${plugin.status.id}`,
      text: `"${name}" 플러그인을 껐어요. 오류가 3번 이어졌어요`.slice(0, 120) })).catch(() => {});
  }

  private async onExit(plugin: ManagedPlugin, generation: number): Promise<void> {
    if (generation !== plugin.generation || plugin.closing || this.stopping) return;
    plugin.exited = true;
    this.rejectPending(plugin);
    this.recordError(plugin);
    await this.cleanup(plugin);
    if (plugin.status.state !== "disabled") this.restart(plugin);
  }

  private rejectPending(plugin: ManagedPlugin): void {
    for (const [id, pending] of plugin.pending) {
      this.options.clearTimer(pending.timer);
      pending.resolve({ v: 1, kind: "res", id, ok: false,
        error: { code: "E_DISPOSED", message: "플러그인이 종료되었습니다" } });
    }
    plugin.pending.clear();
  }

  private restart(plugin: ManagedPlugin): void {
    if (this.stopping || plugin.status.state === "disabled" || plugin.restart) return;
    this.setState(plugin.status, "restarting");
    const delay = RESTART_DELAYS_MS[Math.min(plugin.status.consecutiveErrors - 1, 1)] ?? RESTART_DELAYS_MS[0];
    plugin.restart = this.options.setTimer(() => { plugin.restart = undefined; void this.launch(plugin); }, delay);
  }

  private cleanup(plugin: ManagedPlugin): Promise<void> {
    if (plugin.cleanupTask) return plugin.cleanupTask;
    plugin.cleanupTask = this.doCleanup(plugin);
    return plugin.cleanupTask;
  }

  private async doCleanup(plugin: ManagedPlugin): Promise<void> {
    plugin.closing = true;
    plugin.badges.clear();
    delete plugin.status.badge;
    if (plugin.restart) { this.options.clearTimer(plugin.restart); plugin.restart = undefined; }
    const channel = plugin.channel;
    if (!channel) return;
    if (!plugin.exited) {
      try { await this.request(plugin, "deactivate", {}, DEACTIVATE_MS); } catch { /* Continue cleanup. */ }
    }
    this.scheduler.disposePlugin(plugin.status.id);
    plugin.session?.dispose();
    if (!plugin.exited) {
      try { await this.request(plugin, "shutdown", {}, SHUTDOWN_MS); } catch { /* Kill below. */ }
    }
    channel.kill();
    this.rejectPending(plugin);
    plugin.channel = undefined;
    plugin.session = undefined;
  }
}
