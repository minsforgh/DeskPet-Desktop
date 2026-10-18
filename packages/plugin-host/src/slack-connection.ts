export type SlackConnectionStatus = "connecting" | "connected" | "reconnecting" | "token-required" | "permission-required";
export interface SlackConnectionEvent { type: string; event: Readonly<Record<string, unknown>>; }
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event) => void): void;
}
export interface SlackConnectionResponse { status: number; body: unknown; retryAfter?: string | null; }
export interface SlackConnectionTransport {
  openConnection(appToken: string): Promise<SlackConnectionResponse>;
  connectWebSocket(url: URL): SocketLike;
}
export interface SlackConnectionTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface SlackConnectionOptions {
  getAppToken(): Promise<string | null>;
  transport?: SlackConnectionTransport;
  timers?: SlackConnectionTimers;
  random?: () => number;
  onEvent(event: SlackConnectionEvent): Promise<void> | void;
  onStatus(status: SlackConnectionStatus): void;
  log(code: string, count?: number): void;
}

// Provisional values: confirm after measuring mock-server retries and real Slack reconnects, recording conditions and maximum observed delay.
export const INITIAL_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;
const MAX_ENVELOPE_ID_LENGTH = 128;

export const defaultSlackConnectionTransport: SlackConnectionTransport = {
  async openConnection(appToken) {
    const response = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST", headers: { Authorization: `Bearer ${appToken}` }, redirect: "error",
    });
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get("Retry-After") };
  },
  connectWebSocket(url) { return new WebSocket(url) satisfies SocketLike; },
};

/** Validate the raw URL so explicit default ports cannot disappear during URL normalization. */
export function validSlackSocketUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const authority = /^wss:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || !/^[a-z0-9.-]+$/i.test(authority)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:" || url.username || url.password || url.port || url.hostname.endsWith(".")) return null;
    const labels = url.hostname.split(".");
    if (labels.length < 3 || labels.slice(-2).join(".") !== "slack.com") return null;
    if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    if (!url.pathname.startsWith("/link/")) return null;
    return url;
  } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class SlackConnection {
  private readonly transport: SlackConnectionTransport;
  private readonly timers: SlackConnectionTimers;
  private readonly random: () => number;
  private generation = 0;
  private active = false;
  private socket: SocketLike | null = null;
  private candidate: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(private readonly options: SlackConnectionOptions) {
    this.transport = options.transport ?? defaultSlackConnectionTransport;
    this.timers = options.timers ?? { setTimeout, clearTimeout };
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.begin();
  }

  stop(): void {
    this.active = false;
    this.generation++;
    this.clearTimer();
    this.closeSockets();
  }

  restart(): void { this.stop(); this.start(); }

  private begin(): void {
    const generation = ++this.generation;
    this.options.onStatus(this.failures ? "reconnecting" : "connecting");
    void this.open(generation);
  }

  private current(generation: number): boolean { return this.active && generation === this.generation; }

  private async open(generation: number): Promise<void> {
    let token: string | null;
    try { token = await this.options.getAppToken(); }
    catch { if (this.current(generation)) this.retry(generation, "token-read-failed"); return; }
    if (!this.current(generation)) return;
    if (!token) { this.options.onStatus("token-required"); return; }
    let response: SlackConnectionResponse;
    try { response = await this.transport.openConnection(token); }
    catch { if (this.current(generation)) this.retry(generation, "open-failed"); return; }
    if (!this.current(generation)) return;
    const body = record(response.body);
    if (body?.ok === false) {
      if (["invalid_auth", "token_revoked", "token_expired", "not_authed"].includes(String(body.error))) {
        this.options.log("token-invalid"); this.options.onStatus("token-required"); return;
      }
      if (body.error === "missing_scope") {
        this.options.log("permission-missing"); this.options.onStatus("permission-required"); return;
      }
    }
    if (response.status === 429) { this.retry(generation, "rate-limited", response.retryAfter); return; }
    if (response.status < 200 || response.status >= 300 || body?.ok !== true) {
      this.retry(generation, "open-rejected", undefined, response.status); return;
    }
    const url = validSlackSocketUrl(body.url);
    if (!url) { this.retry(generation, "socket-url-invalid"); return; }
    try { this.attach(this.transport.connectWebSocket(url), generation); }
    catch { this.retry(generation, "socket-create-failed"); }
  }

  private attach(socket: SocketLike, generation: number): void {
    this.socket = socket;
    socket.addEventListener("open", () => { if (this.current(generation) && this.socket === socket) this.failures = 0; });
    socket.addEventListener("message", (event) => {
      if (!this.current(generation) || this.socket !== socket) return;
      this.message(socket, generation, event);
    });
    const failed = () => {
      if (!this.current(generation) || this.socket !== socket) return;
      this.socket = null;
      socket.close();
      this.retry(generation, "socket-closed");
    };
    socket.addEventListener("close", failed);
    socket.addEventListener("error", failed);
  }

  private message(socket: SocketLike, generation: number, event: Event): void {
    let data: Record<string, unknown> | null;
    try {
      const raw = (event as MessageEvent).data;
      data = record(JSON.parse(raw));
    } catch { this.options.log("message-invalid"); return; }
    if (!data) { this.options.log("message-invalid"); return; }
    if (data.type === "hello") this.options.onStatus("connected");
    if (!this.current(generation) || this.socket !== socket) return;
    if (data.envelope_id !== undefined) {
      const id = data.envelope_id;
      if (typeof id !== "string" || id.length < 1 || id.length > MAX_ENVELOPE_ID_LENGTH) {
        this.options.log("envelope-invalid"); return;
      }
      try { socket.send(JSON.stringify({ envelope_id: id })); }
      catch { this.options.log("ack-failed"); return; }
      if (data.type === "events_api") {
        const payload = record(data.payload);
        const slackEvent = record(payload?.event);
        if (slackEvent && typeof slackEvent.type === "string") {
          try { void Promise.resolve(this.options.onEvent({ type: slackEvent.type, event: slackEvent })).catch(() => { if (this.current(generation)) this.options.log("event-callback-failed"); }); }
          catch { this.options.log("event-callback-failed"); }
        }
      }
    }
    if (data.type === "disconnect") {
      if (data.reason === "warning") { this.options.log("disconnect-warning"); return; }
      if (data.reason === "refresh_requested") { this.refresh(socket, generation); return; }
      socket.close();
      this.socket = null;
      this.retry(generation, "disconnect-requested");
    }
  }

  private refresh(oldSocket: SocketLike, generation: number): void {
    if (this.candidate) return;
    void (async () => {
      let token: string | null;
      try { token = await this.options.getAppToken(); }
      catch { if (this.current(generation)) this.options.log("refresh-failed"); return; }
      if (!this.current(generation) || this.socket !== oldSocket) return;
      if (!token) { this.options.onStatus("token-required"); return; }
      let response: SlackConnectionResponse;
      try { response = await this.transport.openConnection(token); }
      catch { if (this.current(generation)) this.options.log("refresh-failed"); return; }
      if (!this.current(generation) || this.socket !== oldSocket) return;
      const url = validSlackSocketUrl(record(response.body)?.url);
      if (response.status < 200 || response.status >= 300 || !url) { this.options.log("refresh-failed"); return; }
      let next: SocketLike;
      try { next = this.transport.connectWebSocket(url); }
      catch { this.options.log("refresh-failed"); return; }
      this.candidate = next;
      next.addEventListener("open", () => {
        if (!this.current(generation) || this.candidate !== next || this.socket !== oldSocket) { next.close(); return; }
        this.candidate = null;
        const nextGeneration = ++this.generation;
        this.attach(next, nextGeneration);
        oldSocket.close();
      });
      const failed = () => {
        if (!this.current(generation) || this.candidate !== next) return;
        this.candidate = null;
        next.close();
        this.options.log("refresh-failed");
      };
      next.addEventListener("close", failed);
      next.addEventListener("error", failed);
    })();
  }

  private retry(generation: number, code: string, retryAfter?: string | null, status?: number): void {
    if (!this.current(generation)) return;
    this.options.log(code, status);
    this.options.onStatus("reconnecting");
    if (!this.current(generation)) return;
    this.clearTimer();
    this.failures++;
    const base = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.min(this.failures - 1, 30));
    const jitter = Math.floor(base * Math.min(1, Math.max(0, this.random())));
    const retrySeconds = retryAfter === undefined || retryAfter === null ? NaN : Number(retryAfter);
    const retryMs = Number.isFinite(retrySeconds) && retrySeconds >= 0 ? retrySeconds * 1000 : 0;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.current(generation)) this.begin();
    }, Math.max(base + jitter, retryMs));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private closeSockets(): void {
    const socket = this.socket;
    const candidate = this.candidate;
    this.socket = null;
    this.candidate = null;
    socket?.close();
    candidate?.close();
  }
}
