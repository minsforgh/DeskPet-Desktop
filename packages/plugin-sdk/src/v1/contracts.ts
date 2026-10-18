import type { PetEvent, ReactionRule } from "@deskpet/core";

export interface PluginPermissions {
  network?: string[];
  windows?: string[];
  openExternal?: string[];
  secrets?: boolean;
  shell?: boolean;
}

export interface PluginContributions {
  actions?: string[];
  trayItems?: string[];
  badges?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: "1";
  entry: string;
  description: string;
  permissions: PluginPermissions;
  contributes: PluginContributions;
}

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A property of an object array item: a scalar, or a flat array of strings or numbers (no nesting). */
export type ObjectItemField =
  | { type: "string" | "number" | "boolean"; title?: string; description?: string; default?: unknown;
      enum?: readonly (string | number)[] }
  /** For type "array", `enum` limits the elements, not the array. */
  | { type: "array"; items: { type: "string" } | { type: "number" }; title?: string; description?: string;
      default?: unknown; enum?: readonly (string | number)[] };

export type ConfigItemsSchema =
  | { type: "string" }
  | { type: "object"; properties: Record<string, ObjectItemField>; required?: string[] };

export interface ConfigFieldSchema {
  type: "string" | "number" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly (string | number)[];
  items?: ConfigItemsSchema;
  secret?: boolean;
}

export interface ConfigSchema {
  type: "object";
  properties: Record<string, ConfigFieldSchema>;
  required?: string[];
}

export interface CheckerWindowOptions {
  url: string;
  show?: boolean;
  width?: number;
  height?: number;
  title?: string;
}

export interface CheckerWindowHandle extends Disposable {
  show(): void;
  hide(): void;
  /** GET only, with login cookies, against the window's home origin (the origin of the url passed to windows.create). path must start with "/" and stay on that origin; method, headers and body cannot be set. */
  getJson(path: string): Promise<{ status: number; body: unknown }>;
}

export interface PluginContext {
  emit(event: PetEvent): void;

  /** id must be declared in contributes.actions. Only a user-invoked handler permits write-capable fetch or exec. */
  registerAction(id: string, handler: (args?: unknown) => Promise<void> | void): Disposable;

  /** item.id must be declared in contributes.trayItems; item.action must be a declared action. */
  addTrayItem(item: { id: string; label: string; action: string }): Disposable;

  schedule: {
    every(ms: number, fn: () => Promise<void>): Disposable;
    at(cron: string, fn: () => Promise<void>, opts?: { tz?: string }): Disposable;
    onResume(fn: () => void): Disposable;
  };

  addReactionRule(rule: ReactionRule): Disposable;

  /** id must be declared in contributes.badges. */
  setBadge(id: string, badge: { text: string; tone?: "neutral" | "warn" | "ok" } | null): void;

  config: Readonly<Record<string, unknown>>;
  onConfigChange(fn: (next: Record<string, unknown>) => void): Disposable;
  secrets: { get(key: string): Promise<string | null>; set(key: string, v: string): Promise<void> };

  openExternal(url: string): Promise<void>;
  /** GET and HEAD by default. Other methods are allowed only while a user-invoked bubble or tray action handler runs. Local HTTP /action/:id counts only for configured allowlisted actions. The host rejects other calls, including activate, schedules, onResume and onConfigChange. M4 host enforcement implements this M0 rule. */
  fetch: typeof globalThis.fetch;
  /** id must be declared in permissions.windows. The initial URL and navigation stay on permissions.network hosts; other navigation and new windows are blocked or opened in the system browser. The host assigns storage by plugin id and opens the window with contextIsolation and no Node integration. */
  windows: { create(id: string, opts: CheckerWindowOptions): Promise<CheckerWindowHandle> };
  /** Allowed only while a user-invoked bubble or tray action handler runs; local HTTP actions count only when configured on the allowlist. The host rejects calls from activate, schedules, onResume and onConfigChange. */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

  log: Logger;
}

export interface PluginDefinition {
  configSchema?: ConfigSchema;
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
