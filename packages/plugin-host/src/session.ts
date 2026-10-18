import { validatePetEvent, validateReactionRule } from "@deskpet/core";
import type { LineCatalog, LinePetEvent, ReactionRule } from "@deskpet/core";
import type { CheckerWindowOptions, PluginManifest } from "@deskpet/plugin-sdk";
import type { OrcaSnapshot } from "@deskpet/plugin-sdk/v2";
import type { PluginChannel } from "./channel.js";
import type { Envelope } from "./envelope.js";
import { validateEnvelope } from "./envelope.js";
import { Invocations } from "./invocation.js";
import { allowedExternalUrl, allowedNetworkUrl, allowedWindowRequest } from "./permissions.js";
import { SecretStoreError, validSecretKey } from "./secrets-store.js";
import { SlackConnection, type SlackConnectionTransport, type SlackConnectionEvent,
  type SlackConnectionStatus } from "./slack-connection.js";

type ErrorCode = "E_PERMISSION" | "E_INVALID_ARGUMENT" | "E_NOT_SERIALIZABLE" | "E_TIMEOUT" |
  "E_RATE_LIMIT" | "E_UNAVAILABLE" | "E_DISPOSED";

export class SessionError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

export interface SessionHost {
  emit(event: LinePetEvent): void | Promise<void>;
  register(pluginId: string, kind: string, handle: number, value: unknown):
    undefined | (() => void) | Promise<undefined | (() => void)>;
  setBadge(pluginId: string, id: string, badge: { text: string; tone?: "neutral" | "warn" | "ok"; action?: string } | null): void | Promise<void>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  openExternal(url: string): void | Promise<void>;
  exec(command: string, args: string[]): Promise<{ stdout: string; code: number }>;
  secrets: { get(pluginId: string, key: string): Promise<string | null>; set(pluginId: string, key: string, value: string): Promise<void> };
  slack?: { transport?: SlackConnectionTransport; get(url: string, init: RequestInit): Promise<Response> };
  orca?: { snapshot(pluginId: string): Promise<OrcaSnapshot>;
    muteGate(pluginId: string, gateId: string): Promise<void>;
    resolveGate(pluginId: string, gateId: string, resolution: string): Promise<"resolved" | "already-resolved" | "unconfirmed">;
    openTerminal(pluginId: string, handle: string): Promise<void> };
  windows?: {
    create(pluginId: string, id: string, generation: number, opts: CheckerWindowOptions,
      onGone: () => void, approved: { name: string; hosts: readonly string[]; windows: readonly string[] }): void | Promise<void>;
    show(pluginId: string, id: string, generation: number): void | Promise<void>;
    hide(pluginId: string, id: string, generation: number): void | Promise<void>;
    getJson(pluginId: string, id: string, generation: number, path: string, signal: AbortSignal): Promise<Response>;
    dispose(pluginId: string, id: string, generation: number): void | Promise<void>;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string, pluginId: string): void;
}

interface Registration { kind: string; id?: string; cleanup?: () => void }
interface WindowRecord { generation: number; url: URL; state: "active" | "disposed" | "gone";
  pending: number; aborts: Set<AbortController>; disposal?: Promise<void> }

// ADR-0005 §2 design limits, before measurement. Measure with the runner in M4 task 2 and adjust.
const FAST_REQUEST_MS = 5_000;
const SLOW_REQUEST_MS = 30_000;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SessionError("E_INVALID_ARGUMENT", "인자 형식이 올바르지 않습니다");
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length > max)
    throw new SessionError("E_INVALID_ARGUMENT", "문자열 인자가 올바르지 않습니다");
  return value;
}

function handle(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new SessionError("E_INVALID_ARGUMENT", "콜백 번호가 올바르지 않습니다");
  return value;
}

function windowGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new SessionError("E_INVALID_ARGUMENT", "창 세대 번호가 올바르지 않습니다");
  return value;
}

function label(value: unknown): string {
  const result = string(value, 80);
  if (!result || Array.from(result).length > 40)
    throw new SessionError("E_INVALID_ARGUMENT", "문구는 1자부터 40자까지입니다");
  return result;
}

function headerList(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length > 128) throw new SessionError("E_INVALID_ARGUMENT", "헤더가 올바르지 않습니다");
  return value.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new SessionError("E_INVALID_ARGUMENT", "헤더가 올바르지 않습니다");
    return [string(entry[0], 256), string(entry[1], 8192)];
  });
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new SessionError("E_INVALID_ARGUMENT", "알 수 없는 인자가 있습니다");
}

const parameterKeys: Record<string, readonly string[]> = {
  emit: ["event"], registerAction: ["id", "handle"], addTrayItem: ["item", "handle"],
  setBadge: ["id", "badge"], addReactionRule: ["rule", "handle"],
  "schedule.every": ["ms", "handle"], "schedule.at": ["cron", "opts", "handle"],
  "schedule.onResume": ["handle"], onConfigChange: ["handle"], dispose: ["handle"],
  "secrets.get": ["key"], "secrets.set": ["key", "value"],
  "slack.connect": ["appTokenSecret", "handle"], "slack.get": ["userTokenSecret", "method", "query"],
  "orca.snapshot": [], "orca.resolveGate": ["gateId", "resolution"], "orca.muteGate": ["gateId"], "orca.openTerminal": ["handle"],
  openExternal: ["url"],
  fetch: ["url", "method", "headers", "body"], "fetch.abort": ["id"],
  exec: ["cmd", "args"], "windows.create": ["id", "opts"],
  "window.show": ["id", "generation"], "window.hide": ["id", "generation"],
  "window.getJson": ["id", "generation", "path"], "window.dispose": ["id", "generation"],
  log: ["level", "message"], hello: ["configSchema"],
};

function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }

async function limitedBody(response: Response, maxBytes = 10 * 1024 * 1024): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new SessionError("E_INVALID_ARGUMENT",
        maxBytes === 10 * 1024 * 1024 ? "응답 본문이 10 MiB를 넘었습니다" : "Slack 응답이 너무 큽니다");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
}

export class PluginSession {
  private static readonly activeWindows = new Set<object>();
  private static nextWindowGeneration = 1;
  readonly invocations: Invocations;
  private readonly registrations = new Map<number, Registration>();
  // Increasing handles reject late reuse without retaining disposed-handle tombstones.
  private highestHandle = 0;
  private highestRequestId = 0;
  private readonly registeredIds = new Map<string, number>();
  private readonly pending = new Map<number, { resolve: (value: Envelope) => void; invocation?: string;
    timer: ReturnType<typeof setTimeout> }>();
  private readonly fetches = new Map<number, AbortController>();
  private readonly badges = new Set<string>();
  private readonly windows = new Map<string, WindowRecord>();
  private slackConnection: SlackConnection | undefined;
  private slackKey: string | undefined;
  private nextRequestId = 1;
  private invalidCount = 0;
  private readonly requestTimes: number[] = [];
  private disposed = false;

  constructor(readonly manifest: PluginManifest, private readonly channel: PluginChannel,
    private readonly host: SessionHost, private readonly now: () => number,
    private readonly lines?: LineCatalog) {
    this.invocations = new Invocations(now);
    channel.onMessage((message) => {
      void this.receive(message).catch(() => {
        if (message !== null && typeof message === "object" && "id" in message &&
            typeof message.id === "number" && Number.isSafeInteger(message.id) && message.id > 0)
          this.channel.post(this.failure(message.id, "E_UNAVAILABLE", "요청을 처리할 수 없습니다"));
      });
    });
    channel.onExit(() => this.dispose());
  }

  async invokeAction(actionId: string, args?: unknown): Promise<Envelope> {
    const key = `action:${actionId}`;
    const registered = this.registeredIds.get(key);
    if (registered === undefined || this.disposed) throw new SessionError("E_DISPOSED", "액션을 사용할 수 없습니다");
    const inv = this.invocations.begin(this.manifest.id, actionId);
    const id = this.nextRequestId++;
    const response = new Promise<Envelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.invocations.close(inv);
        resolve(this.failure(id, "E_TIMEOUT", "액션 시간이 초과되었습니다"));
      }, SLOW_REQUEST_MS);
      this.pending.set(id, { resolve, invocation: inv, timer });
    });
    this.channel.post({ v: 1, kind: "req", id, method: "invoke", params: { handle: registered, args }, inv });
    return response;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.slackConnection?.stop();
    this.slackConnection = undefined;
    this.invocations.closePlugin(this.manifest.id);
    for (const controller of this.fetches.values()) controller.abort();
    this.fetches.clear();
    for (const [id, window] of this.windows) this.disposeWindow(id, window);
    for (const registration of this.registrations.values()) {
      try { registration.cleanup?.(); } catch { /* Cleanup continues for other registrations. */ }
    }
    for (const id of this.badges) {
      try { void Promise.resolve(this.host.setBadge(this.manifest.id, id, null)).catch(() => {}); }
      catch { /* Cleanup continues for other badges. */ }
    }
    this.badges.clear();
    this.registrations.clear();
    this.registeredIds.clear();
    this.highestHandle = 0;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve(this.failure(id, "E_DISPOSED", "플러그인이 종료되었습니다"));
    }
    this.pending.clear();
  }

  restartSlackForSecret(key: string): void {
    if (!this.disposed && key === this.slackKey) this.slackConnection?.restart();
  }

  private invokeSlack(handleNumber: number, args: unknown): Promise<void> {
    if (this.disposed || !this.registrations.has(handleNumber)) return Promise.resolve();
    const id = this.nextRequestId++;
    const result = new Promise<Envelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(this.failure(id, "E_TIMEOUT", "Slack 콜백 시간이 초과되었습니다"));
      }, SLOW_REQUEST_MS);
      this.pending.set(id, { resolve, timer });
    });
    this.channel.post({ v: 1, kind: "req", id, method: "invoke", params: { handle: handleNumber, args } });
    return result.then((response) => {
      if (response.kind !== "res" || !response.ok) throw new Error("Slack callback failed");
    });
  }

  private failure(id: number, code: ErrorCode, message: string): Envelope {
    return { v: 1, kind: "res", id, ok: false, error: { code, message } };
  }

  async receive(input: unknown): Promise<void> {
    const checked = validateEnvelope(input);
    if (!checked.ok) {
      if (checked.reason === "size" && input !== null && typeof input === "object" && "id" in input &&
          typeof input.id === "number" && Number.isSafeInteger(input.id) && input.id > 0)
        this.channel.post(this.failure(input.id, "E_INVALID_ARGUMENT", "요청이 너무 큽니다"));
      else if (++this.invalidCount >= 3) { this.dispose(); this.channel.kill(); }
      return;
    }
    this.invalidCount = 0;
    const message = checked.value;
    if (message.kind === "res") {
      const waiting = this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (waiting.invocation) this.invocations.close(waiting.invocation);
        waiting.resolve(message);
      }
      return;
    }
    const id = message.id;
    if (this.disposed) { this.channel.post(this.failure(id, "E_DISPOSED", "플러그인이 종료되었습니다")); return; }
    if (id <= this.highestRequestId) {
      this.channel.post(this.failure(id, "E_INVALID_ARGUMENT", "요청 번호는 증가해야 합니다")); return;
    }
    this.highestRequestId = id;
    const at = this.now();
    while (this.requestTimes.length && (this.requestTimes[0] ?? 0) <= at - 1000) this.requestTimes.shift();
    if (this.requestTimes.length >= 100) { this.channel.post(this.failure(id, "E_RATE_LIMIT", "요청이 너무 많습니다")); return; }
    this.requestTimes.push(at);
    try {
      const slow = message.method.startsWith("orca.") || message.method === "fetch" || message.method === "exec" || message.method === "window.getJson" ||
        message.method === "slack.get";
      const value = message.method === "windows.create" ? await this.handleRequest(message) : await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fetches.get(id)?.abort();
          reject(new SessionError("E_TIMEOUT", "요청 시간이 초과되었습니다"));
        }, slow ? SLOW_REQUEST_MS : FAST_REQUEST_MS);
        void this.handleRequest(message).then(resolve, reject).finally(() => clearTimeout(timer));
      });
      if (this.disposed) throw new SessionError("E_DISPOSED", "플러그인이 종료되었습니다");
      this.channel.post({ v: 1, kind: "res", id, ok: true, value: value ?? null });
    } catch (error) {
      const code = this.disposed ? "E_DISPOSED" : error instanceof SessionError || error instanceof SecretStoreError ? error.code : "E_UNAVAILABLE";
      const message = this.disposed ? "플러그인이 종료되었습니다" :
        error instanceof SessionError || error instanceof SecretStoreError ? error.message : "요청을 처리할 수 없습니다";
      this.channel.post(this.failure(id, code, message));
    }
  }

  private needsInvocation(inv: string | undefined): void {
    if (!this.invocations.permits(inv, this.manifest.id))
      throw new SessionError("E_PERMISSION", "사용자 액션 안에서만 사용할 수 있습니다");
  }

  private windowPort(): NonNullable<SessionHost["windows"]> {
    if (!this.host.windows) throw new SessionError("E_UNAVAILABLE", "창 기능을 사용할 수 없습니다");
    return this.host.windows;
  }

  private liveWindow(id: string, generation: number) {
    const window = this.windows.get(id);
    if (!window) throw new SessionError("E_INVALID_ARGUMENT", "창 번호가 올바르지 않습니다");
    if (window.generation !== generation) throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
    if (window.state === "gone") throw new SessionError("E_UNAVAILABLE", "창이 종료되었습니다");
    if (window.state === "disposed") throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
    return window;
  }

  private disposeWindow(id: string, window: WindowRecord): Promise<void> {
    if (window.state !== "active") return window.disposal ?? Promise.resolve();
    window.state = "disposed";
    for (const controller of window.aborts) controller.abort();
    try {
      window.disposal = Promise.resolve(this.host.windows?.dispose(this.manifest.id, id, window.generation))
        .then(() => {}, () => {}).finally(() => PluginSession.activeWindows.delete(window));
    } catch { PluginSession.activeWindows.delete(window); window.disposal = Promise.resolve(); }
    return window.disposal;
  }

  private async windowJson(id: string, generation: number, path: string): Promise<{ status: number; body: unknown }> {
    const window = this.liveWindow(id, generation);
    if (window.pending >= 2) throw new SessionError("E_RATE_LIMIT", "창 요청이 너무 많습니다");
    const controller = new AbortController();
    window.pending++;
    window.aborts.add(controller);
    // Prototype on Windows/Electron 44.5.1 observed a 20,105 ms maximum for a 20 s abort.
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let aborted = false;
    const cancel = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new SessionError(window.state === "active" ? "E_TIMEOUT" : window.state === "gone" ? "E_UNAVAILABLE" : "E_DISPOSED",
        window.state === "active" ? "창 요청 시간이 초과되었습니다" : "창이 닫혔습니다"));
    }, { once: true }));
    try {
      const response = await Promise.race([this.windowPort().getJson(this.manifest.id, id, window.generation, path, controller.signal), cancel]);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        this.host.log("info", `[window] ${this.manifest.id}/${id} getJson status=${response.status}`, this.manifest.id);
        return { status: response.status, body: null };
      }
      let body: unknown = null;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await Promise.race([reader.read(), cancel]);
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 1024 * 1024) throw new SessionError("E_INVALID_ARGUMENT", "창 응답이 너무 큽니다");
            chunks.push(next.value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType === "application/json" || contentType?.endsWith("+json"))
          try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Invalid JSON returns null. */ }
      }
      if (window.state !== "active") throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
      this.host.log("info", `[window] ${this.manifest.id}/${id} getJson status=${response.status}`, this.manifest.id);
      return { status: response.status, body };
    } catch (error) {
      const code = error instanceof SessionError ? error.code : aborted ? "E_TIMEOUT" : "E_UNAVAILABLE";
      this.host.log("warn", `[window] ${this.manifest.id}/${id} getJson error=${code}`, this.manifest.id);
      if (error instanceof SessionError) throw error;
      throw new SessionError(code, "창 요청을 처리할 수 없습니다");
    } finally {
      clearTimeout(timeout);
      window.aborts.delete(controller);
      window.pending--;
    }
  }

  private declared(kind: "actions" | "trayItems" | "badges", id: string): void {
    if (!this.manifest.contributes[kind]?.includes(id))
      throw new SessionError("E_PERMISSION", "선언되지 않은 항목입니다");
  }

  private async register(kind: string, callback: unknown, value: unknown, id?: string): Promise<null> {
    const number = handle(callback);
    if (this.registrations.size >= 256) throw new SessionError("E_RATE_LIMIT", "등록은 256개까지 가능합니다");
    if (number <= this.highestHandle || id && this.registeredIds.has(`${kind}:${id}`))
      throw new SessionError("E_INVALID_ARGUMENT", "이미 등록된 항목입니다");
    this.highestHandle = number;
    this.registrations.set(number, { kind, id });
    if (id) this.registeredIds.set(`${kind}:${id}`, number);
    let cleanup: undefined | (() => void);
    try { cleanup = await this.host.register(this.manifest.id, kind, number, value); }
    catch (error) {
      this.registrations.delete(number);
      if (id && this.registeredIds.get(`${kind}:${id}`) === number)
        this.registeredIds.delete(`${kind}:${id}`);
      throw error;
    }
    if (this.disposed) {
      if (typeof cleanup === "function") cleanup();
      throw new SessionError("E_DISPOSED", "플러그인이 종료되었습니다");
    }
    const registration = this.registrations.get(number);
    if (!registration) {
      if (typeof cleanup === "function") cleanup();
      throw new SessionError("E_DISPOSED", "등록이 해제되었습니다");
    }
    registration.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    return null;
  }

  private async fetch(id: number, params: Record<string, unknown>, inv: string | undefined): Promise<unknown> {
    const requested = string(params.url);
    let url = allowedNetworkUrl(requested, this.manifest.permissions.network);
    if (!url) throw new SessionError("E_PERMISSION", "허용되지 않은 네트워크 주소입니다");
    const method = string(params.method ?? "GET", 16).toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new SessionError("E_INVALID_ARGUMENT", "HTTP 메서드가 올바르지 않습니다");
    if (method !== "GET" && method !== "HEAD") this.needsInvocation(inv);
    const headers = new Headers();
    try {
      for (const [name, value] of headerList(params.headers ?? [])) {
        if (!["host", "content-length", "connection", "transfer-encoding"].includes(name.toLowerCase())) headers.append(name, value);
      }
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("E_INVALID_ARGUMENT", "헤더가 올바르지 않습니다");
    }
    const body = params.body;
    if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array))
      throw new SessionError("E_NOT_SERIALIZABLE", "요청 본문을 전송할 수 없습니다");
    if (body !== undefined && method !== "GET" && method !== "HEAD" &&
        (typeof body === "string" ? Buffer.byteLength(body) : body.byteLength) > 10 * 1024 * 1024)
      throw new SessionError("E_INVALID_ARGUMENT", "요청 본문이 10 MiB를 넘었습니다");
    const controller = new AbortController();
    this.fetches.set(id, controller);
    let response: Response | undefined;
    try {
      for (let redirects = 0; ; redirects++) {
        response = await this.host.fetch(url.href, {
          method, headers, body: method === "GET" || method === "HEAD" ? undefined : body instanceof Uint8Array ? new Uint8Array(body) : body,
          redirect: "manual", credentials: "omit", signal: controller.signal,
        });
        const location = response.headers.get("location");
        if ((method === "GET" || method === "HEAD") && isRedirect(response.status) && location) {
          if (redirects >= 5) throw new SessionError("E_RATE_LIMIT", "리다이렉트가 너무 많습니다");
          let destination: string;
          try { destination = new URL(location, url).href; }
          catch { throw new SessionError("E_PERMISSION", "허용되지 않은 리다이렉트입니다"); }
          const next = allowedNetworkUrl(destination, this.manifest.permissions.network);
          if (!next) throw new SessionError("E_PERMISSION", "허용되지 않은 리다이렉트입니다");
          if (next.hostname !== url.hostname) { headers.delete("Authorization"); headers.delete("Cookie"); }
          url = next;
          await response.body?.cancel();
          response = undefined;
          continue;
        }
        return { status: response.status, statusText: response.statusText,
          headers: [...response.headers], body: await limitedBody(response) };
      }
    } catch (error) {
      controller.abort();
      await response?.body?.cancel().catch(() => {});
      throw error;
    } finally { this.fetches.delete(id); }
  }

  private async handleRequest(request: Extract<Envelope, { kind: "req" }>): Promise<unknown> {
    if (request.method.startsWith("orca.") && this.manifest.apiVersion !== "2")
      throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
    const p = object(request.params);
    const allowed = parameterKeys[request.method];
    if (!allowed) throw new SessionError("E_INVALID_ARGUMENT", "알 수 없는 요청입니다");
    onlyKeys(p, allowed);
    switch (request.method) {
      case "orca.snapshot":
      case "orca.resolveGate":
      case "orca.muteGate":
      case "orca.openTerminal": {
        if (this.manifest.apiVersion !== "2") throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
        const permission = request.method === "orca.snapshot" || request.method === "orca.muteGate" ? "orcaRead" :
          request.method === "orca.resolveGate" ? "orcaGateResolve" : "orcaOpenTerminal";
        if (this.manifest.permissions[permission] !== true) throw new SessionError("E_PERMISSION", "Orca 권한이 없습니다");
        if (request.method !== "orca.snapshot") this.needsInvocation(request.inv);
        if (!this.host.orca) throw new SessionError("E_UNAVAILABLE", "Orca 기능을 사용할 수 없습니다");
        if (request.method === "orca.snapshot") return this.host.orca.snapshot(this.manifest.id);
        const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
          value.length <= 256 && /^[A-Za-z0-9_:.@][A-Za-z0-9_:.@-]*$/.test(value);
        if (request.method === "orca.muteGate") {
          if (!validId(p.gateId)) throw new SessionError("E_INVALID_ARGUMENT", "게이트 ID가 올바르지 않습니다");
          await this.host.orca.muteGate(this.manifest.id, p.gateId);
          return null;
        }
        if (request.method === "orca.resolveGate") {
          if (!validId(p.gateId) || typeof p.resolution !== "string" || p.resolution.length < 1 ||
              p.resolution.length > 40 || [...p.resolution].some((char) => char.charCodeAt(0) < 32))
            throw new SessionError("E_INVALID_ARGUMENT", "게이트 선택 값이 올바르지 않습니다");
          return await this.host.orca.resolveGate(this.manifest.id, p.gateId, p.resolution);
        } else {
          if (!validId(p.handle)) throw new SessionError("E_INVALID_ARGUMENT", "터미널 핸들이 올바르지 않습니다");
          await this.host.orca.openTerminal(this.manifest.id, p.handle);
        }
        return null;
      }
      case "emit": {
        const result = validatePetEvent(p.event);
        if (!result.ok) throw new SessionError("E_INVALID_ARGUMENT", "이벤트가 올바르지 않습니다");
        if (result.value.source !== this.manifest.id ||
            result.value.actions?.some((action) => !action.action.startsWith(`${this.manifest.id}.`)))
          throw new SessionError("E_PERMISSION", "다른 플러그인의 이벤트 또는 액션입니다");
        const event = result.value;
        if (event.line !== undefined) {
          if (this.manifest.apiVersion !== "2")
            throw new SessionError("E_INVALID_ARGUMENT", "v1 플러그인은 대사 목록을 사용할 수 없습니다");
          const line = this.lines?.lines.find((item) => item.id === event.line?.id);
          if (!event.line.id.startsWith(`${this.manifest.id}.`) || !line ||
              Object.keys(event.line.vars ?? {}).some((name) => !line.variables.includes(name)) ||
              (event.voice !== undefined && event.voice.kind !== line.kind))
            throw new SessionError("E_INVALID_ARGUMENT", "대사 ID 또는 변수가 올바르지 않습니다");
        }
        await this.host.emit({
          source: event.source, type: event.type,
          ...(event.key === undefined ? {} : { key: event.key }),
          ...(event.text === undefined ? {} : { text: event.text }),
          ...(event.voice === undefined ? {} : { voice: event.voice }),
          ...(event.line === undefined ? {} : { line: event.line }),
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          ...(event.mood === undefined ? {} : { mood: event.mood }),
          ...(event.priority === undefined ? {} : { priority: event.priority }),
          ...(event.actions === undefined ? {} : { actions: event.actions.map((action) => ({
            label: action.label, action: action.action,
            ...(action.args === undefined ? {} : { args: action.args }),
          })) }),
          ...(event.ttlMs === undefined ? {} : { ttlMs: event.ttlMs }),
          ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        }); return null;
      }
      case "registerAction": {
        const id = string(p.id, 128); this.declared("actions", id);
        return this.register("action", p.handle, { id }, id);
      }
      case "addTrayItem": {
        const item = object(p.item);
        onlyKeys(item, ["id", "action", "label"]);
        const id = string(item.id, 128); const action = string(item.action, 128);
        this.declared("trayItems", id); this.declared("actions", action);
        return this.register("trayItem", p.handle, { id, action, label: label(item.label) }, id);
      }
      case "setBadge": {
        const id = string(p.id, 128); this.declared("badges", id);
        let badge: { text: string; tone?: "neutral" | "warn" | "ok"; action?: string } | null = null;
        if (p.badge !== null) {
          const value = object(p.badge);
          onlyKeys(value, ["text", "tone", "action"]);
          if (value.tone !== undefined && value.tone !== "neutral" && value.tone !== "warn" && value.tone !== "ok")
            throw new SessionError("E_INVALID_ARGUMENT", "배지 색상이 올바르지 않습니다");
          let action: string | undefined;
          if (value.action !== undefined) {
            if (this.manifest.apiVersion !== "2") throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
            action = string(value.action, 128);
            this.declared("actions", action);
          }
          badge = { text: label(value.text), ...(value.tone === undefined ? {} : { tone: value.tone }),
            ...(action === undefined ? {} : { action }) };
        }
        await this.host.setBadge(this.manifest.id, id, badge);
        if (this.disposed) {
          await this.host.setBadge(this.manifest.id, id, null);
          throw new SessionError("E_DISPOSED", "플러그인이 종료되었습니다");
        }
        if (badge) this.badges.add(id); else this.badges.delete(id);
        return null;
      }
      case "addReactionRule": {
        const result = validateReactionRule(p.rule);
        if (!result.ok) throw new SessionError("E_INVALID_ARGUMENT", "반응 규칙이 올바르지 않습니다");
        return this.register("reactionRule", p.handle, result.value satisfies ReactionRule);
      }
      case "schedule.every": {
        const ms = p.ms;
        if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 1000)
          throw new SessionError("E_INVALID_ARGUMENT", "반복 간격이 올바르지 않습니다");
        return this.register("schedule.every", p.handle, { ms });
      }
      case "schedule.at": {
        const cron = string(p.cron, 128);
        if (!/^\d{1,2} \d{1,2} \* \* (?:\*|[0-6](?:-[0-6])?(?:,[0-6](?:-[0-6])?)*)$/.test(cron))
          throw new SessionError("E_INVALID_ARGUMENT", "일정 형식이 올바르지 않습니다");
        const [minute, hour] = cron.split(" ").map(Number);
        if (minute === undefined || hour === undefined || minute > 59 || hour > 23)
          throw new SessionError("E_INVALID_ARGUMENT", "일정 시간이 올바르지 않습니다");
        const day = cron.split(" ")[4];
        if (day !== "*") for (const part of (day ?? "").split(",")) {
          const [first, last] = part.split("-").map(Number);
          if (first === undefined || last !== undefined && (last <= first || last > 6))
            throw new SessionError("E_INVALID_ARGUMENT", "요일 범위가 올바르지 않습니다");
        }
        if (p.opts !== undefined) {
          const opts = object(p.opts); onlyKeys(opts, ["tz"]);
          if (opts.tz !== undefined) {
            const tz = string(opts.tz, 128);
            try { new Intl.DateTimeFormat("en", { timeZone: tz }); }
            catch { throw new SessionError("E_INVALID_ARGUMENT", "시간대가 올바르지 않습니다"); }
          }
        }
        return this.register("schedule.at", p.handle, { cron, opts: p.opts });
      }
      case "schedule.onResume": return this.register("schedule.onResume", p.handle, null);
      case "onConfigChange": return this.register("onConfigChange", p.handle, null);
      case "dispose": {
        const number = handle(p.handle);
        const registration = this.registrations.get(number);
        if (registration) {
          registration.cleanup?.(); this.registrations.delete(number);
          if (registration.id) this.registeredIds.delete(`${registration.kind}:${registration.id}`);
        }
        return null;
      }
      case "secrets.get":
      case "secrets.set": {
        if (request.method === "secrets.get" && this.manifest.apiVersion === "2")
          throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
        if (this.manifest.permissions.secrets !== true) throw new SessionError("E_PERMISSION", "비밀 저장 권한이 없습니다");
        const key = string(p.key, 64);
        if (!validSecretKey(key)) throw new SessionError("E_INVALID_ARGUMENT", "비밀 키가 올바르지 않습니다");
        if (request.method === "secrets.get") return this.host.secrets.get(this.manifest.id, key);
        const value = string(p.value, 8192);
        if (Buffer.byteLength(value, "utf8") > 8192) throw new SessionError("E_INVALID_ARGUMENT", "비밀 값이 너무 큽니다");
        await this.host.secrets.set(this.manifest.id, key, value); return null;
      }
      case "slack.connect": {
        if (this.manifest.apiVersion !== "2") throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
        if (this.manifest.permissions.secrets !== true ||
            !this.manifest.permissions.socketMode?.includes("slack.com"))
          throw new SessionError("E_PERMISSION", "Slack 연결 권한이 없습니다");
        const key = string(p.appTokenSecret, 64);
        if (!validSecretKey(key)) throw new SessionError("E_INVALID_ARGUMENT", "비밀 키가 올바르지 않습니다");
        if (this.slackConnection) throw new SessionError("E_INVALID_ARGUMENT", "Slack 연결이 이미 있습니다");
        const number = handle(p.handle);
        if (number <= this.highestHandle || this.registrations.size >= 256)
          throw new SessionError("E_INVALID_ARGUMENT", "이미 등록된 콜백입니다");
        this.highestHandle = number;
        const notify = (kind: "event" | "status", value: SlackConnectionEvent | SlackConnectionStatus): Promise<void> =>
          this.invokeSlack(number, { kind, value });
        const connection = new SlackConnection({
          getAppToken: () => this.host.secrets.get(this.manifest.id, key),
          ...(this.host.slack?.transport ? { transport: this.host.slack.transport } : {}),
          onEvent: (event) => notify("event", event),
          onStatus: (status) => { void notify("status", status).catch(() => this.host.log("warn", "slack-status-callback-failed", this.manifest.id)); },
          log: (code, count) => this.host.log("warn", `slack:${code}${count === undefined ? "" : `:${count}`}`, this.manifest.id),
        });
        this.slackConnection = connection;
        this.slackKey = key;
        this.registrations.set(number, { kind: "slack", cleanup: () => {
          connection.stop();
          if (this.slackConnection === connection) { this.slackConnection = undefined; this.slackKey = undefined; }
        } });
        connection.start();
        return null;
      }
      case "slack.get": {
        if (this.manifest.apiVersion !== "2") throw new SessionError("E_UNAVAILABLE", "이 API를 사용할 수 없습니다");
        if (this.manifest.permissions.secrets !== true || !this.manifest.permissions.network?.includes("slack.com"))
          throw new SessionError("E_PERMISSION", "Slack 조회 권한이 없습니다");
        const key = string(p.userTokenSecret, 64);
        if (!validSecretKey(key)) throw new SessionError("E_INVALID_ARGUMENT", "비밀 키가 올바르지 않습니다");
        if (p.method !== "users.info" && p.method !== "conversations.info")
          throw new SessionError("E_INVALID_ARGUMENT", "Slack 조회 메서드가 올바르지 않습니다");
        const query = p.query === undefined ? {} : object(p.query);
        if (Object.keys(query).length > 16) throw new SessionError("E_INVALID_ARGUMENT", "조회 인자가 너무 많습니다");
        const url = new URL(`https://slack.com/api/${p.method}`);
        for (const [name, value] of Object.entries(query)) {
          if (!name || name.length > 64 || typeof value !== "string" || value.length > 1024)
            throw new SessionError("E_INVALID_ARGUMENT", "조회 인자가 올바르지 않습니다");
          url.searchParams.set(name, value);
        }
        const token = await this.host.secrets.get(this.manifest.id, key);
        if (!token) throw new SessionError("E_UNAVAILABLE", "Slack 토큰이 필요합니다");
        let response: Response;
        try {
          response = await (this.host.slack?.get ?? fetch)(url.href,
            { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
        } catch { throw new SessionError("E_UNAVAILABLE", "Slack 조회에 실패했습니다"); }
        const bytes = await limitedBody(response, 1024 * 1024);
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new SessionError("E_UNAVAILABLE", "Slack 응답을 읽을 수 없습니다"); }
        if (JSON.stringify(body).includes(token)) throw new SessionError("E_UNAVAILABLE", "Slack 응답을 전달할 수 없습니다");
        return { status: response.status, body };
      }
      case "openExternal": {
        this.needsInvocation(request.inv);
        const url = allowedExternalUrl(string(p.url), this.manifest.permissions.openExternal);
        if (!url) throw new SessionError("E_PERMISSION", "허용되지 않은 외부 주소입니다");
        await this.host.openExternal(url.href); return null;
      }
      case "fetch": return this.fetch(request.id, p, request.inv);
      case "fetch.abort": {
        const id = handle(p.id); this.fetches.get(id)?.abort(); return null;
      }
      case "exec": {
        if (this.manifest.permissions.shell !== true) throw new SessionError("E_PERMISSION", "명령 실행 권한이 없습니다");
        this.needsInvocation(request.inv);
        const command = string(p.cmd, 4096);
        if (!command) throw new SessionError("E_INVALID_ARGUMENT", "명령이 비어 있습니다");
        if (/\.(?:cmd|bat)$/i.test(command)) throw new SessionError("E_UNAVAILABLE", "이 명령 파일 형식은 실행할 수 없습니다");
        if (!Array.isArray(p.args) || p.args.length > 128 || !p.args.every((arg) => typeof arg === "string" && arg.length <= 8192))
          throw new SessionError("E_INVALID_ARGUMENT", "명령 인자가 올바르지 않습니다");
        const result = await this.host.exec(command, p.args);
        if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > 1024 * 1024 ||
            !Number.isSafeInteger(result.code))
          throw new SessionError("E_INVALID_ARGUMENT", "명령 결과가 너무 크거나 올바르지 않습니다");
        return result;
      }
      case "windows.create": {
        const id = string(p.id, 128); const opts = object(p.opts);
        onlyKeys(opts, ["url", "show", "width", "height", "title"]);
        if (opts.show !== undefined && typeof opts.show !== "boolean" ||
            opts.width !== undefined && (typeof opts.width !== "number" || !Number.isSafeInteger(opts.width) || opts.width < 200 || opts.width > 4096) ||
            opts.height !== undefined && (typeof opts.height !== "number" || !Number.isSafeInteger(opts.height) || opts.height < 200 || opts.height > 4096) ||
            opts.title !== undefined && (typeof opts.title !== "string" || Array.from(opts.title).length > 80))
          throw new SessionError("E_INVALID_ARGUMENT", "창 옵션이 올바르지 않습니다");
        const url = string(opts.url);
        if (!allowedWindowRequest(id, url, this.manifest.permissions))
          throw new SessionError("E_PERMISSION", "허용되지 않은 창 또는 주소입니다");
        if (opts.show === true) this.needsInvocation(request.inv);
        const existing = this.windows.get(id);
        if (existing?.state === "active") throw new SessionError("E_INVALID_ARGUMENT", "이미 열린 창입니다");
        if ([...this.windows.values()].filter((window) => window.state === "active").length >=
            (this.manifest.permissions.windows?.length ?? 0) || PluginSession.activeWindows.size >= 4)
          throw new SessionError("E_RATE_LIMIT", "창 개수를 초과했습니다");
        const port = this.windowPort();
        const window: WindowRecord = { generation: PluginSession.nextWindowGeneration++, url: new URL(url),
          state: "active", pending: 0, aborts: new Set() };
        this.windows.set(id, window);
        PluginSession.activeWindows.add(window);
        const options: CheckerWindowOptions = { url: window.url.href,
          ...(opts.show === undefined ? {} : { show: opts.show }),
          ...(opts.width === undefined ? {} : { width: opts.width }),
          ...(opts.height === undefined ? {} : { height: opts.height }),
          ...(opts.title === undefined ? {} : { title: opts.title }) };
        let createTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          const creating = Promise.resolve(port.create(this.manifest.id, id, window.generation, options, () => {
            if (this.windows.get(id) !== window || window.state !== "active") return;
            window.state = "gone";
            PluginSession.activeWindows.delete(window);
            for (const controller of window.aborts) controller.abort();
          }, { name: this.manifest.name, hosts: [...(this.manifest.permissions.network ?? [])],
            windows: [...(this.manifest.permissions.windows ?? [])] }));
          void creating.then(() => {
            if (timedOut) void Promise.resolve().then(() => port.dispose(this.manifest.id, id, window.generation)).catch(() => {});
          }, () => {});
          // Reuse the existing 5 s request cap; cleanup must finish before the timeout response.
          await Promise.race([creating, new Promise<never>((_, reject) => {
            createTimer = setTimeout(() => reject(new SessionError("E_TIMEOUT", "창 생성 시간이 초과되었습니다")), FAST_REQUEST_MS);
          })]);
        } catch (error) {
          timedOut = error instanceof SessionError && error.code === "E_TIMEOUT";
          await this.disposeWindow(id, window);
          throw error;
        } finally { if (createTimer) clearTimeout(createTimer); }
        if (this.disposed || window.state !== "active") {
          if (window.state === "gone") {
            try { await port.dispose(this.manifest.id, id, window.generation); } catch { /* The window may already be gone. */ }
          } else await this.disposeWindow(id, window);
          throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
        }
        return window.generation;
      }
      case "window.show": {
        const id = string(p.id, 128);
        const window = this.liveWindow(id, windowGeneration(p.generation));
        this.needsInvocation(request.inv);
        await this.windowPort().show(this.manifest.id, id, window.generation);
        return null;
      }
      case "window.hide": {
        const id = string(p.id, 128);
        const window = this.liveWindow(id, windowGeneration(p.generation));
        await this.windowPort().hide(this.manifest.id, id, window.generation);
        return null;
      }
      case "window.getJson": {
        const id = string(p.id, 128);
        const window = this.liveWindow(id, windowGeneration(p.generation));
        const path = string(p.path, 2048);
        if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") ||
            Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
          throw new SessionError("E_INVALID_ARGUMENT", "창 경로가 올바르지 않습니다");
        if (new URL(path, window.url.origin).origin !== window.url.origin)
          throw new SessionError("E_PERMISSION", "허용되지 않은 창 경로입니다");
        return this.windowJson(id, window.generation, path);
      }
      case "window.dispose": {
        const id = string(p.id, 128);
        const generation = windowGeneration(p.generation);
        const window = this.windows.get(id);
        if (!window) throw new SessionError("E_INVALID_ARGUMENT", "창 번호가 올바르지 않습니다");
        if (window.generation !== generation) return null;
        await this.disposeWindow(id, window);
        return null;
      }
      case "log": {
        if (p.level !== "debug" && p.level !== "info" && p.level !== "warn" && p.level !== "error")
          throw new SessionError("E_INVALID_ARGUMENT", "로그 수준이 올바르지 않습니다");
        this.host.log(p.level, string(p.message, 2048), this.manifest.id); return null;
      }
      case "hello": {
        if (p.configSchema !== undefined) object(p.configSchema);
        return null;
      }
      default: throw new SessionError("E_INVALID_ARGUMENT", "알 수 없는 요청입니다");
    }
  }
}
