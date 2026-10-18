import type { PetEvent, ReactionRule } from "@deskpet/core";
import { validateReactionRule } from "@deskpet/core";
import { SecretsStore, SessionError, type SessionHost } from "@deskpet/plugin-host";
import type { ActionRegistry } from "./actions.js";
import { maskPluginLog } from "./log-mask.js";

type Badge = Parameters<SessionHost["setBadge"]>[2];
type LogLevel = Parameters<SessionHost["log"]>[0];
type ExecOptions = { timeout: number; maxBuffer: number; windowsHide: boolean; shell: false; env: Record<string, string> };

export interface PluginBridgeDeps {
  windows?: SessionHost["windows"];
  receivePetEvent(event: PetEvent): void | Promise<void>;
  actions: Pick<ActionRegistry, "register">;
  invokeAction(pluginId: string, actionId: string, args?: unknown): Promise<{ ok: boolean }>;
  addTrayItem(pluginId: string, item: { id: string; label: string; action: string }, click: () => void): () => void;
  addReactionRule(pluginId: string, rule: ReactionRule): () => void;
  openExternal(url: string): void | Promise<void>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  slack?: SessionHost["slack"];
  orca?: SessionHost["orca"];
  execFile(command: string, args: string[], options: ExecOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void): void;
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
  logger: Pick<Console, LogLevel>;
}

export interface PluginBridge extends SessionHost {
  readonly badges: ReadonlyMap<string, Badge>;
  formatPluginOutput(pluginId: string, line: string): string;
  maskPluginText(pluginId: string, text: string): string;
  /** For the settings window only: whether a value is stored, and removal. Values are never read back out. */
  hasSecret(pluginId: string, key: string): Promise<boolean>;
  deleteSecret(pluginId: string, key: string): Promise<void>;
}

function field(value: unknown, name: string): string {
  if (value === null || typeof value !== "object" || !(name in value))
    throw new SessionError("E_INVALID_ARGUMENT", "등록 값이 올바르지 않습니다");
  const result: unknown = Reflect.get(value, name);
  if (typeof result !== "string") throw new SessionError("E_INVALID_ARGUMENT", "등록 값이 올바르지 않습니다");
  return result;
}

function execEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  const allowed = new Map([
    ["path", "PATH"], ["systemroot", "SystemRoot"], ["windir", "WINDIR"],
    ["temp", "TEMP"], ["tmp", "TMP"],
  ]);
  for (const [key, value] of Object.entries(env)) {
    const name = allowed.get(key.toLowerCase());
    if (name && value !== undefined) cleaned[name] = value;
  }
  return cleaned;
}

export function createPluginBridge(deps: PluginBridgeDeps): PluginBridge {
  const badges = new Map<string, Badge>();
  const knownSecrets = new Map<string, Set<string>>();
  const secrets = new SecretsStore(deps.userDataDir, {
    isAvailable: () => deps.safeStorage.isEncryptionAvailable(),
    encrypt: (value) => deps.safeStorage.encryptString(value),
    decrypt: (value) => deps.safeStorage.decryptString(value),
  }, (message) => deps.logger.warn(message));
  const remember = (pluginId: string, value: string): void => {
    if (value.length < 6) return;
    let values = knownSecrets.get(pluginId);
    if (!values) { values = new Set(); knownSecrets.set(pluginId, values); }
    values.add(value);
  };
  const formatPluginOutput = (pluginId: string, line: string): string => {
    const prefix = `[plugin:${pluginId}] `;
    return prefix + maskPluginLog(line, knownSecrets.get(pluginId) ?? new Set(), 2048 - Buffer.byteLength(prefix, "utf8"));
  };

  return {
    badges,
    windows: deps.windows,
    formatPluginOutput,
    maskPluginText: (pluginId, text) => maskPluginLog(text, knownSecrets.get(pluginId) ?? new Set()),
    hasSecret: (pluginId, key) => secrets.has(pluginId, key),
    deleteSecret: (pluginId, key) => secrets.delete(pluginId, key),
    emit: deps.receivePetEvent,
    register(pluginId, kind, _handle, value) {
      if (kind === "action") {
        const id = field(value, "id");
        if (!id.startsWith(`${pluginId}.`))
          throw new SessionError("E_INVALID_ARGUMENT", "액션 ID 접두사가 올바르지 않습니다");
        const registration = deps.actions.register(id, async (args) => {
          const result = await deps.invokeAction(pluginId, id, args);
          if (!result.ok) throw new Error("플러그인 액션에 실패했습니다");
        });
        return () => registration.dispose();
      }
      if (kind === "trayItem") {
        const item = { id: field(value, "id"), label: field(value, "label"), action: field(value, "action") };
        if (!item.id.startsWith(`${pluginId}.`) || !item.action.startsWith(`${pluginId}.`))
          throw new SessionError("E_INVALID_ARGUMENT", "트레이 항목 접두사가 올바르지 않습니다");
        return deps.addTrayItem(pluginId, item, () => {
          void deps.invokeAction(pluginId, item.action).catch(() => {});
        });
      }
      if (kind === "reactionRule") {
        const checked = validateReactionRule(value);
        if (!checked.ok) throw new SessionError("E_INVALID_ARGUMENT", "반응 규칙이 올바르지 않습니다");
        return deps.addReactionRule(pluginId, checked.value);
      }
      if (kind === "onConfigChange") return undefined;
      throw new SessionError("E_INVALID_ARGUMENT", "등록 종류가 올바르지 않습니다");
    },
    setBadge(pluginId, id, badge) {
      const key = `${pluginId}:${id}`;
      if (badge === null) badges.delete(key);
      else badges.set(key, badge);
    },
    fetch: (url, init) => deps.fetch(url, { ...init, credentials: "omit" }),
    slack: deps.slack,
    orca: deps.orca,
    openExternal: deps.openExternal,
    async exec(command, args) {
      if (/\.(?:cmd|bat)$/i.test(command))
        throw new SessionError("E_UNAVAILABLE", "이 명령 파일 형식은 실행할 수 없습니다");
      return new Promise((resolve, reject) => {
        deps.execFile(command, args, {
          // ADR-0005 §3 fixes these process limits; integration timing is measured in M4 task 2.
          timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
          env: execEnvironment(deps.env),
        }, (error, stdout, stderr) => {
          if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > 1024 * 1024) {
            reject(new SessionError("E_UNAVAILABLE", "명령 출력이 너무 큽니다"));
            return;
          }
          if (error) {
            if ("code" in error && typeof error.code === "number") {
              resolve({ stdout, code: error.code });
              return;
            }
            if ("killed" in error && error.killed === true ||
                "code" in error && error.code === "ETIMEDOUT") {
              reject(new SessionError("E_TIMEOUT", "명령 실행 시간이 초과되었습니다"));
              return;
            }
            reject(new SessionError("E_UNAVAILABLE", "명령을 실행할 수 없습니다"));
            return;
          }
          resolve({ stdout, code: 0 });
        });
      });
    },
    secrets: {
      async get(pluginId, key) {
        const value = await secrets.get(pluginId, key);
        if (value !== null) remember(pluginId, value);
        return value;
      },
      async set(pluginId, key, value) {
        await secrets.set(pluginId, key, value);
        remember(pluginId, value);
      },
    },
    log(level, message, pluginId) { deps.logger[level](formatPluginOutput(pluginId, message)); },
  };
}
