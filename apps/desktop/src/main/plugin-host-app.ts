import type { LineCatalog, ReactionRule } from "@deskpet/core";
import { PluginManager, defaultSlackConnectionTransport, type PluginChannel,
  type PluginStatus, type SlackConnectionTransport } from "@deskpet/plugin-host";
import type { ConfigSchema, PluginManifest } from "@deskpet/plugin-sdk";
import type { ActionRegistry, InvokeResult } from "./actions.js";
import { createPluginBridge, type PluginBridgeDeps } from "./plugin-bridge.js";
import { createOrcaService } from "./orca-service.js";
import type { PluginMenuItem } from "./tray.js";

type Permissions = PluginManifest["permissions"];
export type PermissionAnswer = "allow" | "deny" | "hold";

export interface HostChannel extends PluginChannel {
  readonly pid?: number;
  onOutput(listener: (stream: "stdout" | "stderr", line: string) => void): () => void;
}

export interface PermissionDialogOptions {
  type: "question" | "warning";
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
  noLink: true;
}

export interface PluginHostAppDeps extends Pick<PluginBridgeDeps,
  "receivePetEvent" | "openExternal" | "fetch" | "execFile" | "env" | "userDataDir" | "safeStorage" | "logger" | "windows"> {
  scanRoot: string;
  actions: Pick<ActionRegistry, "register" | "invoke">;
  createChannel(pluginId: string, entryPath: string): HostChannel;
  /** A plugin process ended; `stderrTail` is its last stderr lines, already masked with that plugin's secrets. */
  onPluginExit?(pluginId: string, code: number | null, stderrTail: readonly string[]): void;
  /** Shows the real permission window; true means the user pressed 허용. */
  showPermissionDialog(options: PermissionDialogOptions): Promise<boolean>;
  getConfig(pluginId: string): Record<string, unknown>;
  saveConfig(pluginId: string, next: Record<string, unknown>): void;
  httpActionAllowlist(): readonly string[];
}

/** One plugin as the settings window shows it. `form` exists only for a running plugin that declares a configSchema. */
export interface PluginSettingsEntry {
  id: string;
  name: string;
  state: PluginStatus["state"];
  statusLine: string;
  /** Why there is no form, in Korean; empty when there is one. */
  notice: string;
  form?: {
    schema: ConfigSchema;
    values: Record<string, unknown>;
    /** Only whether a secret field has a stored value; the value itself never leaves main. */
    secrets: Record<string, boolean>;
    canStoreSecrets: boolean;
  };
}

export interface PluginHostState {
  ready: boolean;
  plugins: PluginStatus[];
  permissionPrompt: { pluginId: string; lines: string[] } | null;
  pids: Record<string, number>;
}

export interface DisplayBadge { pluginId: string; id: string; pluginName: string; text: string;
  tone: "neutral" | "warn" | "ok"; action?: string }

/** Match the host's control-character filtering before exposing a badge in desktop UI. */
export function displayBadgeText(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127 && (code < 128 || code > 159);
  }).slice(0, 80).join("");
}

const STATE_TEXT: Record<PluginStatus["state"], string> = {
  invalid: "사용할 수 없음", "needs-permission": "허용 대기", denied: "허용 안 함", starting: "시작 중",
  running: "실행 중", restarting: "다시 시작 중", disabled: "꺼짐",
};

/** The permissions as Korean sentences for the permission window; `shell` comes first and is stressed. */
export function describePermissions(permissions: Permissions): string[] {
  const lines: string[] = [];
  if (permissions.shell === true) lines.push("임의 명령 실행: 이 컴퓨터에서 어떤 프로그램이든 실행할 수 있습니다");
  if (permissions.network?.length) lines.push(`인터넷 접속: ${permissions.network.join(", ")}`);
  if ("socketMode" in permissions && permissions.socketMode?.length)
    lines.push("Slack 실시간 연결: slack.com에 연결 요청을 보내고 수신 확인을 자동으로 보냅니다");
  if ("orcaRead" in permissions && permissions.orcaRead === true)
    lines.push("Orca 진행 상태 읽기: 이 컴퓨터의 Run, 작업, 게이트와 비소비 수신함을 조회합니다");
  if ("orcaGateResolve" in permissions && permissions.orcaGateResolve === true)
    lines.push("Orca 게이트 처리: 사용자가 선택한 버튼으로 게이트 답변을 보냅니다");
  if ("orcaOpenTerminal" in permissions && permissions.orcaOpenTerminal === true)
    lines.push("Orca 터미널 열기: 사용자가 누른 버튼으로 해당 터미널 탭으로 전환합니다");
  if (permissions.openExternal?.length) lines.push(`브라우저로 링크 열기: ${permissions.openExternal.join(", ")}`);
  if (permissions.windows?.length) lines.push(`창 열기: ${permissions.windows.join(", ")}`);
  if (permissions.secrets === true) lines.push("비밀 값(토큰, 비밀번호)을 저장하고 읽기");
  return lines;
}

export function permissionDialogOptions(manifest: PluginManifest): PermissionDialogOptions {
  const dangerous = manifest.permissions.shell === true;
  return {
    type: dangerous ? "warning" : "question",
    title: "플러그인 권한",
    message: `"${manifest.name}" 플러그인이 아래 권한을 요청합니다`,
    detail: `${describePermissions(manifest.permissions).map((line) => `• ${line}`).join("\n")}\n\n허용하면 이 플러그인이 위 기능을 쓸 수 있습니다.`,
    buttons: ["허용", "허용 안 함"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/** The sentence shown instead of a form: forms exist only for running plugins (ADR-0005 open item, decided in M4). */
function settingsNotice(state: PluginStatus["state"], hasSchema: boolean): string {
  switch (state) {
    case "running": return hasSchema ? "" : "설정할 항목이 없습니다";
    case "needs-permission": return "권한을 허용해야 설정할 수 있습니다";
    case "denied": return "허용하지 않은 플러그인이라 설정할 수 없습니다";
    case "invalid": return "사용할 수 없는 플러그인이라 설정할 수 없습니다";
    case "disabled": return "꺼진 플러그인입니다. 트레이 메뉴에서 다시 켜면 설정할 수 있습니다";
    case "starting": case "restarting": return "시작 중입니다. 잠시 뒤 새로 고침하세요";
  }
}

export function pluginStatusLine(status: PluginStatus): string {
  const reason = status.reason && (status.state === "invalid" || status.state === "disabled") ? ` (${status.reason})` : "";
  return `${status.name ?? status.id}: ${STATE_TEXT[status.state]}${reason}${status.badge ? ` · ${status.badge}` : ""}`;
}

export interface PluginHostApp {
  readonly scheduler: PluginManager["scheduler"];
  start(): void;
  stop(): Promise<void>;
  resume(): void;
  status(): PluginStatus[];
  badges(): DisplayBadge[];
  clickBadge(pluginId: string, id: string): Promise<void>;
  state(): PluginHostState;
  reactionRules(): ReactionRule[];
  lineCatalogs(): Array<{ pluginId: string; catalog: LineCatalog }>;
  /** POST /action/:id: a plugin action runs only when settings.json lists it; core actions always run. */
  invokeHttpAction(id: string, args?: unknown): Promise<InvokeResult>;
  menu(): PluginMenuItem[];
  /** Every discovered plugin with its status line and, when allowed and running, its settings form data. */
  settingsPlugins(): Promise<PluginSettingsEntry[]>;
  /** Stores secrets first (each in the plugin's own namespace), then the config, which is delivered to the plugin. */
  savePluginSettings(pluginId: string, config: Record<string, unknown>, secrets: Readonly<Record<string, string>>): Promise<void>;
  clearPluginSecret(pluginId: string, key: string): Promise<void>;
  /** Whether the stored secrets of this plugin's secret fields exist. */
  secretStatus(pluginId: string, keys: readonly string[]): Promise<Record<string, boolean>>;
  onMenuChange(listener: () => void): void;
  /** Resolves when every tray-started action (such as 다시 켜기) has finished. */
  idle(): Promise<void>;
  /** Dev control only (never wired in a packaged run): undefined shows the real window. */
  setPermissionAnswerForTest(answer: PermissionAnswer | undefined, once?: boolean): void;
  setFetchTargetForTest(port: number | undefined): void;
  setSlackTransportForTest(port: number | undefined): void;
  setOrcaExecutableForTest(path: string | null): Promise<void>;
  setOrcaTimeForTest(atMs: number): void;
  setOrcaWalDirectoryForTest(path: string): Promise<void>;
  orcaFastDetectionStatus(): { enabled: boolean; message?: string };
}

export function createPluginHostApp(deps: PluginHostAppDeps): PluginHostApp {
  const channels = new Map<string, HostChannel>();
  const pluginActions = new Set<string>();
  const reactionRules = new Set<{ pluginId: string; rule: ReactionRule }>();
  const trayItems = new Set<{ pluginId: string; label: string; click: () => void }>();
  const displayBadges = new Map<string, { pluginId: string; id: string; text: string;
    tone: DisplayBadge["tone"]; action?: string }>();
  const running = new Set<Promise<unknown>>();
  let menuListener: (() => void) | undefined;
  let menuQueued = false;
  let started = false;
  let startSettled = false;
  let permissionAnswer: PermissionAnswer | undefined;
  let prompt: PluginHostState["permissionPrompt"] = null;
  let held: ((allowed: boolean) => void) | undefined;
  let fetchPort: number | undefined;
  let slackPort: number | undefined;
  const orca = createOrcaService(deps.userDataDir, deps.env);

  const menuChanged = (): void => {
    if (menuQueued) return;
    menuQueued = true;
    queueMicrotask(() => { menuQueued = false; menuListener?.(); });
  };

  const bridge = createPluginBridge({
    windows: deps.windows,
    receivePetEvent: deps.receivePetEvent,
    actions: {
      register(id, handler) {
        const registration = deps.actions.register(id, handler);
        pluginActions.add(id);
        return { dispose() { registration.dispose(); pluginActions.delete(id); } };
      },
    },
    invokeAction: (pluginId, actionId, args) => manager.invokeAction(pluginId, actionId, args),
    addTrayItem(pluginId, item, click) {
      const entry = { pluginId, label: item.label, click };
      trayItems.add(entry);
      menuChanged();
      return () => { trayItems.delete(entry); menuChanged(); };
    },
    addReactionRule(pluginId, rule) {
      const entry = { pluginId, rule };
      reactionRules.add(entry);
      return () => { reactionRules.delete(entry); };
    },
    openExternal: deps.openExternal,
    fetch(url, init) {
      if (fetchPort === undefined) return deps.fetch(url, init);
      // Test seam: the session has already checked the declared https host; only the connection target changes.
      const original = new URL(url);
      const headers = new Headers(init.headers);
      headers.set("x-deskpet-original-host", original.host);
      return deps.fetch(`http://127.0.0.1:${fetchPort}${original.pathname}${original.search}`, { ...init, headers });
    },
    slack: {
      transport: {
        async openConnection(appToken) {
          if (slackPort === undefined) return defaultSlackConnectionTransport.openConnection(appToken);
          const response = await deps.fetch(`http://127.0.0.1:${slackPort}/api/apps.connections.open`, {
            method: "POST", headers: { Authorization: `Bearer ${appToken}` }, redirect: "error",
          });
          return { status: response.status, body: await response.json(), retryAfter: response.headers.get("Retry-After") };
        },
        connectWebSocket(url) {
          if (slackPort === undefined) return defaultSlackConnectionTransport.connectWebSocket(url);
          return new WebSocket(`ws://127.0.0.1:${slackPort}/${url.hostname}${url.pathname}${url.search}`);
        },
      } satisfies SlackConnectionTransport,
      get(url, init) {
        if (slackPort === undefined) return deps.fetch(url, init);
        const original = new URL(url);
        return deps.fetch(`http://127.0.0.1:${slackPort}${original.pathname}${original.search}`, init);
      },
    },
    orca,
    execFile: deps.execFile,
    env: deps.env,
    userDataDir: deps.userDataDir,
    safeStorage: deps.safeStorage,
    logger: deps.logger,
  });

  async function askPermission(manifest: PluginManifest): Promise<boolean> {
    if (permissionAnswer === "allow") return true;
    if (permissionAnswer === "deny") return false;
    prompt = { pluginId: manifest.id, lines: describePermissions(manifest.permissions) };
    try {
      if (permissionAnswer === "hold") return await new Promise<boolean>((resolve) => { held = resolve; });
      return await deps.showPermissionDialog(permissionDialogOptions(manifest));
    } finally { prompt = null; held = undefined; }
  }

  const manager = new PluginManager({
    scanRoot: deps.scanRoot,
    userDataDir: deps.userDataDir,
    channelFactory(pluginId, entryPath) {
      for (const [key, badge] of displayBadges) if (badge.pluginId === pluginId) displayBadges.delete(key);
      const channel = deps.createChannel(pluginId, entryPath);
      channels.set(pluginId, channel);
      // A dead process must not stay listed: the OS may hand its pid to an unrelated process.
      channel.onExit(() => {
        if (channels.get(pluginId) !== channel) return;
        channels.delete(pluginId);
        for (const [key, badge] of displayBadges) if (badge.pluginId === pluginId) displayBadges.delete(key);
        menuChanged();
      });
      const stderrTail: string[] = [];
      channel.onOutput((stream, line) => {
        const masked = bridge.formatPluginOutput(pluginId, line);
        deps.logger[stream === "stderr" ? "warn" : "info"](masked);
        if (stream === "stderr") { stderrTail.push(masked); if (stderrTail.length > 20) stderrTail.shift(); }
      });
      channel.onExit((code) => { deps.onPluginExit?.(pluginId, code, stderrTail); });
      return channel;
    },
    host: { ...bridge, setBadge(pluginId, id, badge) {
      bridge.setBadge(pluginId, id, badge);
      const key = `${pluginId}:${id}`;
      displayBadges.delete(key);
      if (badge !== null) {
        const text = displayBadgeText(bridge.maskPluginText(pluginId, badge.text));
        if (text) displayBadges.set(key, { pluginId, id, text, tone: badge.tone ?? "neutral",
          ...(badge.action === undefined ? {} : { action: badge.action }) });
      }
      // PluginManager updates status.badge after this host call resolves.
      queueMicrotask(() => queueMicrotask(menuChanged));
    } },
    askPermission,
    clock: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => {
      if (typeof timer === "object" && "cancelled" in timer) return;
      clearTimeout(timer);
    },
    emit: deps.receivePetEvent,
    log: (level, message) => { deps.logger[level](`[host] ${message}`); },
    getConfig: deps.getConfig,
    setConfig: deps.saveConfig,
    maskBadge: bridge.maskPluginText,
    onStatusChange: menuChanged,
  });

  const track = (work: Promise<unknown>): void => {
    running.add(work);
    void work.then(() => undefined, () => undefined).then(() => { running.delete(work); });
  };

  const secretStatus = async (pluginId: string, keys: readonly string[]): Promise<Record<string, boolean>> =>
    Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await bridge.hasSecret(pluginId, key)] as const)));

  return {
    scheduler: manager.scheduler,
    start() {
      if (started) return;
      started = true;
      // Held permission windows keep start() open on purpose; readiness is derived in state().
      void manager.start().catch((error: unknown) => { deps.logger.error("Start plugin host:", error); })
        .finally(() => { startSettled = true; menuChanged(); });
    },
    stop: () => manager.stop(),
    resume: () => manager.resume(),
    status: () => manager.status(),
    badges: () => {
      const names = new Map(manager.status().filter((status) => status.state === "running")
        .map((status) => [status.id, status.name ?? status.id]));
      return [...displayBadges.values()].flatMap((badge) => {
        const pluginName = names.get(badge.pluginId);
        return pluginName === undefined ? [] : [{ ...badge, pluginName }];
      });
    },
    async clickBadge(pluginId, id) {
      const badge = displayBadges.get(`${pluginId}:${id}`);
      if (!badge?.action || !manager.status().some((status) => status.id === pluginId && status.state === "running")) return;
      await manager.invokeAction(pluginId, badge.action);
    },
    state() {
      // The pid exists only once the process has spawned, so it is read when asked, not when the channel is made.
      const pids = (): Record<string, number> => Object.fromEntries([...channels]
        .flatMap(([id, channel]) => channel.pid === undefined ? [] : [[id, channel.pid] as const]));
      const plugins = manager.status();
      // A pending permission window means discovery is done and every allowed plugin has been launched.
      const ready = started && (startSettled || (prompt !== null && !plugins.some((item) => item.state === "starting")));
      return { ready, plugins, permissionPrompt: prompt, pids: pids() };
    },
    reactionRules: () => [...reactionRules].map((entry) => entry.rule),
    lineCatalogs: () => manager.lineCatalogs(),
    async invokeHttpAction(id, args) {
      if (pluginActions.has(id) && !deps.httpActionAllowlist().includes(id)) return { ok: false, reason: "not-found" };
      return deps.actions.invoke(id, args);
    },
    menu() {
      const items: PluginMenuItem[] = [];
      for (const status of manager.status()) {
        items.push({ label: pluginStatusLine(status) });
        if (status.state === "disabled") {
          items.push({ label: `다시 켜기 (${status.id})`, click: () => { track(manager.enable(status.id)); } });
        }
        for (const item of trayItems) if (item.pluginId === status.id) items.push({ label: item.label, click: item.click });
      }
      return items;
    },
    onMenuChange(listener) { menuListener = listener; },
    async idle() {
      do { await Promise.allSettled([...running]); await manager.configSettled(); } while (running.size > 0);
    },
    async settingsPlugins() {
      const forms = new Map(manager.configSchemas().map((info) => [info.id, info]));
      return Promise.all(manager.status().map(async (status): Promise<PluginSettingsEntry> => {
        const entry = { id: status.id, name: status.name ?? status.id, state: status.state, statusLine: pluginStatusLine(status) };
        const info = forms.get(status.id);
        if (!info) return { ...entry, notice: settingsNotice(status.state, false) };
        const secretKeys = Object.entries(info.schema.properties).filter(([, field]) => field.secret === true).map(([name]) => name);
        return { ...entry, notice: "", form: { schema: info.schema, values: await manager.pluginConfig(status.id),
          secrets: await secretStatus(status.id, secretKeys), canStoreSecrets: info.secrets } };
      }));
    },
    async savePluginSettings(pluginId, config, secrets) {
      for (const [key, value] of Object.entries(secrets)) {
        await bridge.secrets.set(pluginId, key, value);
        manager.secretChanged(pluginId, key);
      }
      await manager.setPluginConfig(pluginId, config);
    },
    clearPluginSecret: async (pluginId, key) => {
      await bridge.deleteSecret(pluginId, key);
      manager.secretChanged(pluginId, key);
    },
    secretStatus,
    setPermissionAnswerForTest(answer, once = false) {
      // once answers only the window that is open now and keeps the later ones held.
      if (!once) permissionAnswer = answer;
      if (answer === "allow" || answer === "deny") held?.(answer === "allow");
    },
    setFetchTargetForTest(port) { fetchPort = port; },
    setSlackTransportForTest(port) { slackPort = port; },
    setOrcaExecutableForTest(path) { return orca.setExecutableForTest(path); },
    setOrcaTimeForTest(atMs) { orca.setTimeForTest(atMs); },
    setOrcaWalDirectoryForTest(path) { return orca.setWalDirectoryForTest(path); },
    orcaFastDetectionStatus() { return orca.fastDetectionStatus(); },
  };
}
