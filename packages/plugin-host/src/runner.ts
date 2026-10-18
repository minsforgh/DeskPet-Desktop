import { AsyncLocalStorage } from "node:async_hooks";
import type { CheckerWindowHandle, Disposable, PluginContext, PluginDefinition } from "@deskpet/plugin-sdk";
import type { PluginContext as V2PluginContext, PluginDefinition as V2PluginDefinition } from "@deskpet/plugin-sdk/v2";
import type { PluginChannel } from "./channel.js";
import type { Envelope } from "./envelope.js";
import { isEnvelope } from "./envelope.js";

type RequestEnvelope = Extract<Envelope, { kind: "req" }>;
type Callback = (args: unknown) => unknown;
type LogLevel = "debug" | "info" | "warn" | "error";

// ADR-0005 §2: main caps fetch/exec at 30s, so the proxy gives up 5s later and no Promise stays pending.
const REQUEST_TIMEOUT_MS = 35_000;
// session.ts rejects log messages over 2048 characters.
const MAX_LOG_LENGTH = 2048;
// Response statuses that cannot carry a body in the Response constructor.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export class PluginRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface RunnerOptions {
  /** Schedules fn after ms and returns a cancel function. Injected so tests never wait on real time. */
  after?: (fn: () => void, ms: number) => () => void;
}

function defaultAfter(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PluginRequestError("E_INVALID_ARGUMENT", "params must be an object");
  return Object.fromEntries(Object.entries(value));
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

function frozenConfig(value: unknown): Readonly<Record<string, unknown>> {
  const copy = record(structuredClone(value));
  deepFreeze(copy);
  return copy;
}

function headerPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new PluginRequestError("E_INVALID_ARGUMENT", "fetch response headers are malformed");
  return value.map((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string")
      throw new PluginRequestError("E_INVALID_ARGUMENT", "fetch response headers are malformed");
    return [entry[0], entry[1]];
  });
}

function toResponse(value: unknown): Response {
  const result = record(value);
  const { status, statusText, body } = result;
  if (typeof status !== "number" || typeof statusText !== "string" || !(body instanceof ArrayBuffer))
    throw new PluginRequestError("E_INVALID_ARGUMENT", "fetch response is malformed");
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body,
    { status, statusText, headers: headerPairs(result.headers) });
}

function flatBody(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === null || typeof body === "string") return body ?? undefined;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new PluginRequestError("E_NOT_SERIALIZABLE", "fetch body must be a string or bytes");
}

/** Flattens fetch arguments into the wire shape of ADR-0005 §2. */
async function flattenFetch(input: string | URL | Request, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let method = init?.method ?? (input instanceof Request ? input.method : "GET");
  let body: string | Uint8Array | undefined;
  if (init?.body !== undefined) body = flatBody(init.body);
  else if (input instanceof Request && input.body !== null) body = new Uint8Array(await input.arrayBuffer());
  method = method.toUpperCase();
  return {
    url: input instanceof Request ? input.url : String(input), method,
    headers: [...headers],
    ...(body === undefined ? {} : { body }),
  };
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason ?? new DOMException("This operation was aborted", "AbortError");
}

function windowResult(value: unknown): { status: number; body: unknown } {
  const result = record(value);
  if (typeof result.status !== "number") throw new PluginRequestError("E_INVALID_ARGUMENT", "window response is malformed");
  return { status: result.status, body: result.body };
}

/**
 * Runs inside the plugin process. The caller wires the real channel and the entry import (`load`).
 * Resolves when main sends `shutdown` or the channel exits; rejects if `load` or `hello` fails.
 */
export async function runPlugin(channel: PluginChannel, load: () => Promise<PluginDefinition | V2PluginDefinition>,
  options: RunnerOptions = {}): Promise<void> {
  const after = options.after ?? defaultAfter;
  // The store is the inv of the user action whose handler is running; undefined outside of one.
  const invocation = new AsyncLocalStorage<string | undefined>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; cancel: () => void }>();
  const callbacks = new Map<number, Callback>();
  const configHandles = new Set<number>();
  const windowHandles = new Map<string, number>();
  let nextRequestId = 1;
  let nextHandle = 1;
  let closed = false;
  let activated = false;
  let config: Readonly<Record<string, unknown>> = Object.freeze({});
  // The manager sends config and permissions in `init` and an empty `activate`; direct callers may put them in `activate`.
  let initParams: Record<string, unknown> = {};
  // While activate runs, failed fire-and-forget requests (registrations, emit) fail the activation.
  let startup: Promise<unknown>[] | undefined;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });

  function send(method: string, params: unknown): { id: number; result: Promise<unknown> } {
    try { structuredClone(params); }
    catch { throw new PluginRequestError("E_NOT_SERIALIZABLE", `${method}: value cannot be sent to the host`); }
    if (closed) return { id: 0, result: Promise.reject(new PluginRequestError("E_DISPOSED", "channel is closed")) };
    const id = nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const cancel = after(() => {
        pending.delete(id);
        reject(new PluginRequestError("E_TIMEOUT", `${method}: no response from host`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, cancel });
    });
    const inv = invocation.getStore();
    channel.post({ v: 1, kind: "req", id, method, params, ...(inv === undefined ? {} : { inv }) });
    return { id, result };
  }

  function call(method: string, params: unknown): Promise<unknown> {
    return send(method, params).result;
  }

  function background(method: string, result: Promise<unknown>): void {
    if (method === "log") { result.catch(() => {}); return; }
    if (startup) { result.catch(() => {}); startup.push(result); return; }
    result.catch((error: unknown) => {
      const code = error instanceof PluginRequestError ? error.code : "E_UNAVAILABLE";
      try { background("log", call("log", { level: "warn", message: `${method} failed: ${code}` })); }
      catch { /* Reporting is best effort. */ }
    });
  }

  function notify(method: string, params: unknown): void {
    background(method, call(method, params));
  }

  /** Registers a callback (or just a disposable handle when callback is absent) with main. */
  function register(method: string, params: Record<string, unknown>, callback?: Callback): Disposable {
    const handle = nextHandle++;
    const request = call(method, { ...params, handle });
    if (callback) callbacks.set(handle, callback);
    if (method === "onConfigChange") configHandles.add(handle);
    const drop = (): void => { callbacks.delete(handle); configHandles.delete(handle); };
    let failed = false;
    let disposed = false;
    background(method, request.catch((error: unknown) => { failed = true; drop(); throw error; }));
    return {
      dispose() {
        if (disposed || failed) return;
        disposed = true;
        drop();
        notify("dispose", { handle });
      },
    };
  }

  function logger(level: LogLevel): (message: string) => void {
    return (message) => notify("log", { level, message: String(message).slice(0, MAX_LOG_LENGTH) });
  }

  async function proxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const flat = await flattenFetch(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortReason(signal);
    const { id, result } = send("fetch", flat);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => {
        try { notify("fetch.abort", { id }); } catch { /* The request is already rejected below. */ }
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return toResponse(await Promise.race([result, aborted])); }
    finally { if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
  }

  function createContext(shell: boolean): PluginContext & V2PluginContext {
    const ctx: PluginContext = {
      emit(event) { notify("emit", { event }); },
      registerAction(id, handler) { return register("registerAction", { id }, (args) => handler(args)); },
      addTrayItem(item) { return register("addTrayItem", { item }); },
      schedule: {
        every(ms, fn) { return register("schedule.every", { ms }, () => fn()); },
        at(cron, fn, opts) {
          return register("schedule.at", { cron, ...(opts === undefined ? {} : { opts }) }, () => fn());
        },
        onResume(fn) { return register("schedule.onResume", {}, () => fn()); },
      },
      addReactionRule(rule) { return register("addReactionRule", { rule }); },
      setBadge(id, badge) { notify("setBadge", { id, badge }); },
      get config() { return config; },
      onConfigChange(fn) { return register("onConfigChange", {}, (next) => fn(frozenConfig(next))); },
      secrets: {
        async get(key) {
          const value = await call("secrets.get", { key });
          return typeof value === "string" ? value : null;
        },
        async set(key, value) { await call("secrets.set", { key, value }); },
      },
      async openExternal(url) { await call("openExternal", { url }); },
      fetch: proxyFetch,
      windows: {
        async create(id, opts) {
          const generation = await call("windows.create", { id, opts });
          if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0)
            throw new PluginRequestError("E_INVALID_ARGUMENT", "window generation is malformed");
          let disposed = false;
          windowHandles.set(id, generation);
          const alive = (): void => {
            if (disposed || windowHandles.get(id) !== generation)
              throw new PluginRequestError("E_DISPOSED", "window handle is disposed");
          };
          const handle: CheckerWindowHandle = {
            show() { alive(); notify("window.show", { id, generation }); },
            hide() { alive(); notify("window.hide", { id, generation }); },
            async getJson(path) { alive(); return windowResult(await call("window.getJson", { id, generation, path })); },
            dispose() {
              if (disposed) return;
              disposed = true;
              if (windowHandles.get(id) !== generation) return;
              windowHandles.delete(id);
              notify("window.dispose", { id, generation });
            },
          };
          return handle;
        },
      },
      log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    };
    if (shell) {
      ctx.exec = async (cmd, args) => {
        const result = record(await call("exec", { cmd, args }));
        if (typeof result.stdout !== "string" || typeof result.code !== "number")
          throw new PluginRequestError("E_INVALID_ARGUMENT", "exec response is malformed");
        return { stdout: result.stdout, code: result.code };
      };
    }
    const slack: V2PluginContext["slack"] = {
      async connect(options) {
        const handle = nextHandle++;
        callbacks.set(handle, (args) => {
          const message = record(args);
          if (message.kind === "event") {
            const value = record(message.value);
            if (typeof value.type === "string") return options.onEvent({ type: value.type, event: record(value.event) });
          }
          if (message.kind === "status" && (message.value === "connecting" || message.value === "connected" ||
              message.value === "reconnecting" || message.value === "token-required" || message.value === "permission-required"))
            return options.onStatus(message.value);
          throw new PluginRequestError("E_INVALID_ARGUMENT", "Slack callback is malformed");
        });
        try { await call("slack.connect", { appTokenSecret: options.appTokenSecret, handle }); }
        catch (error) { callbacks.delete(handle); throw error; }
        let disposed = false;
        return { dispose() {
          if (disposed) return;
          disposed = true;
          callbacks.delete(handle);
          notify("dispose", { handle });
        } };
      },
      async get(options) {
        return windowResult(await call("slack.get", {
          userTokenSecret: options.userTokenSecret, method: options.method, query: options.query,
        }));
      },
    };
    const orca: V2PluginContext["orca"] = {
      async snapshot() {
        return await call("orca.snapshot", {}) as Awaited<ReturnType<V2PluginContext["orca"]["snapshot"]>>;
      },
      async resolveGate(gateId, resolution) {
        return await call("orca.resolveGate", { gateId, resolution }) as Awaited<ReturnType<V2PluginContext["orca"]["resolveGate"]>>;
      },
      async muteGate(gateId) {
        await call("orca.muteGate", { gateId });
      },
      async openTerminal(handle) {
        await call("orca.openTerminal", { handle });
      },
    };
    return Object.assign(ctx, { slack, orca });
  }

  const ready = (async (): Promise<PluginDefinition | V2PluginDefinition> => {
    const definition = await load();
    await call("hello", definition.configSchema === undefined ? {} : { configSchema: definition.configSchema });
    return definition;
  })();
  ready.catch(() => {});

  async function activate(params: unknown): Promise<void> {
    const definition = await ready;
    if (activated) throw new PluginRequestError("E_UNAVAILABLE", "plugin is already active");
    const body = { ...initParams, ...record(params) };
    config = frozenConfig(body.config);
    const ctx = createContext(record(body.permissions).shell === true);
    activated = true;
    startup = [];
    try {
      await invocation.run(undefined, () => definition.activate(ctx));
      for (const outcome of await Promise.allSettled(startup)) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
    } finally { startup = undefined; }
  }

  async function changeConfig(params: unknown): Promise<void> {
    config = frozenConfig(record(params).config);
    let failure: { error: unknown } | undefined;
    for (const handle of [...configHandles]) {
      try { await invocation.run(undefined, () => callbacks.get(handle)?.(config)); }
      catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }

  async function invoke(request: RequestEnvelope): Promise<void> {
    const { handle, args } = record(request.params);
    const callback = typeof handle === "number" ? callbacks.get(handle) : undefined;
    if (!callback) throw new PluginRequestError("E_DISPOSED", "callback is not registered");
    await invocation.run(request.inv, () => callback(args));
  }

  async function dispatch(request: RequestEnvelope): Promise<void> {
    switch (request.method) {
      case "init": { initParams = record(request.params); return; }
      case "activate": return activate(request.params);
      case "invoke": return invoke(request);
      case "config.changed": return changeConfig(request.params);
      case "deactivate": {
        const definition = await ready;
        try { await invocation.run(undefined, async () => definition.deactivate?.()); }
        finally {
          for (const [id, generation] of windowHandles) notify("window.dispose", { id, generation });
          windowHandles.clear();
        }
        return;
      }
      case "shutdown": return;
      default: throw new PluginRequestError("E_INVALID_ARGUMENT", "unknown method");
    }
  }

  async function handle(request: RequestEnvelope): Promise<void> {
    try {
      await dispatch(request);
      channel.post({ v: 1, kind: "res", id: request.id, ok: true, value: null });
    } catch (error) {
      const code = error instanceof PluginRequestError ? error.code : "E_UNAVAILABLE";
      const message = error instanceof Error ? error.message : String(error);
      channel.post({ v: 1, kind: "res", id: request.id, ok: false, error: { code, message: message.slice(0, 500) } });
    }
    if (request.method === "shutdown") finish();
  }

  channel.onMessage((message) => {
    if (!isEnvelope(message)) return;
    if (message.kind === "req") { void handle(message); return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    waiting.cancel();
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new PluginRequestError(message.error.code, message.error.message));
  });
  channel.onExit(() => {
    closed = true;
    for (const waiting of pending.values()) {
      waiting.cancel();
      waiting.reject(new PluginRequestError("E_DISPOSED", "channel is closed"));
    }
    pending.clear();
    finish();
  });

  await ready;
  await done;
}
