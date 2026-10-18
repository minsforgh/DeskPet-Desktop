import { describe, expect, it, vi } from "vitest";
import { SlackConnection, validSlackSocketUrl, INITIAL_RETRY_MS, MAX_RETRY_MS, type SlackConnectionResponse, type SocketLike } from "./slack-connection.js";

const socketUrl = "wss://wss-primary.slack.com/link/test?secret=fake-url";
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.emit("close"); }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
  message(data: unknown): void { this.emit("message", JSON.stringify(data)); }
}
function setup(responses: SlackConnectionResponse[] = [{ status: 200, body: { ok: true, url: socketUrl } }], onEvent: (event: { type: string; event: Readonly<Record<string, unknown>> }) => Promise<void> | void = () => {}) {
  const sockets: FakeSocket[] = [];
  const status: string[] = [];
  const logs: string[] = [];
  const tasks = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const openConnection = vi.fn(async () => responses.shift() ?? { status: 500, body: { ok: false } });
  const connection = new SlackConnection({
    getAppToken: async () => "fake-token",
    transport: { openConnection, connectWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
    timers: { setTimeout: (fn, ms) => { const id = ++nextTimer; tasks.set(id, { fn, ms }); return id as unknown as ReturnType<typeof setTimeout>; }, clearTimeout: (id) => { tasks.delete(id as unknown as number); } },
    random: () => 0,
    onEvent, onStatus: (value) => status.push(value), log: (code, count) => logs.push(`${code}:${count ?? ""}`),
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const fire = async () => { const [id, task] = [...tasks][0] ?? []; if (!task) throw new Error("timer missing"); if (id === undefined) throw new Error("timer missing"); tasks.delete(id); task.fn(); await flush(); };
  return { connection, sockets, status, logs, tasks, openConnection, flush, fire };
}

describe("Slack Socket Mode connection", () => {
  it.each([
    ["wss://wss-primary.slack.com/link/abc", true],
    ["wss://a.b.slack.com/link/abc?x=1", true],
    ["wss://evilslack.com/link/abc", false],
    ["wss://slack.com/link/abc", false],
    ["ws://a.slack.com/link/abc", false],
    ["wss://a.slack.com:443/link/abc", false],
    ["wss://a.slack.com:444/link/abc", false],
    ["wss://user:pass@a.slack.com/link/abc", false],
    ["wss://127.0.0.1/link/abc", false],
    ["wss://a.slack.com./link/abc", false],
    ["wss://한글.slack.com/link/abc", false],
    ["wss://-bad.slack.com/link/abc", false],
    ["wss://bad-.slack.com/link/abc", false],
    ["wss://a.slack.com/else/abc", false],
  ])("validates URL %s", (url, valid) => {
    expect(validSlackSocketUrl(url) !== null).toBe(valid);
  });

  it("reports hello, acks before callback, and passes only the event", async () => {
    const received: unknown[] = [];
    const ctx = setup(undefined, (value) => { received.push(value); expect(ctx.sockets[0]?.sent).toEqual(['{"envelope_id":"id"}']); });
    ctx.connection.start(); await ctx.flush();
    ctx.sockets[0]?.message({ type: "hello" });
    expect(ctx.status).toContain("connected");
    ctx.sockets[0]?.message({ type: "events_api", envelope_id: "id", payload: { event: { type: "message", text: "fake-body" } } });
    expect(received).toEqual([{ type: "message", event: { type: "message", text: "fake-body" } }]);
  });

  it("keeps the connection after a rejected callback and still acks", async () => {
    const ctx = setup(undefined, async () => { throw new Error("fake-body"); });
    ctx.connection.start(); await ctx.flush();
    ctx.sockets[0]?.message({ type: "events_api", envelope_id: "id", payload: { event: { type: "message" } } });
    await ctx.flush();
    expect(ctx.sockets[0]?.sent).toEqual(['{"envelope_id":"id"}']);
    expect(ctx.sockets[0]?.closed).toBe(false);
    expect(ctx.logs).toContain("event-callback-failed:");
  });

  it.each(["invalid_auth", "token_revoked", "token_expired", "not_authed"])("stops on token error %s", async (error) => {
    const ctx = setup([{ status: 200, body: { ok: false, error } }]);
    ctx.connection.start(); await ctx.flush();
    expect(ctx.status.at(-1)).toBe("token-required");
    expect(ctx.tasks.size).toBe(0);
  });

  it("stops on missing scope", async () => {
    const ctx = setup([{ status: 200, body: { ok: false, error: "missing_scope" } }]);
    ctx.connection.start(); await ctx.flush();
    expect(ctx.status.at(-1)).toBe("permission-required");
    expect(ctx.tasks.size).toBe(0);
  });

  it("requires a token without opening a connection", async () => {
    const ctx = setup();
    const connection = new SlackConnection({
      getAppToken: async () => null,
      transport: { openConnection: ctx.openConnection, connectWebSocket: () => { throw new Error("unexpected"); } },
      onEvent: () => {}, onStatus: (status) => ctx.status.push(status), log: () => {},
    });
    connection.start(); await ctx.flush();
    expect(ctx.status.at(-1)).toBe("token-required");
    expect(ctx.openConnection).not.toHaveBeenCalled();
  });

  it("rejects a bad returned URL before opening a socket", async () => {
    const ctx = setup([{ status: 200, body: { ok: true, url: "wss://evilslack.com/link/fake-url" } }]);
    ctx.connection.start(); await ctx.flush();
    expect(ctx.sockets).toHaveLength(0);
    expect(ctx.logs).toContain("socket-url-invalid:");
    expect(ctx.tasks.size).toBe(1);
  });

  it("honors Retry-After and increases capped backoff with one timer", async () => {
    const responses: SlackConnectionResponse[] = Array.from({ length: 9 }, () => ({ status: 500, body: { ok: false } }));
    responses.unshift({ status: 429, body: { ok: false }, retryAfter: "12" });
    const ctx = setup(responses);
    ctx.connection.start(); await ctx.flush();
    expect([...ctx.tasks.values()][0]?.ms).toBe(12_000);
    const delays = [12_000];
    for (let i = 0; i < 9; i++) {
      await ctx.fire();
      expect(ctx.tasks.size).toBe(1);
      delays.push([...ctx.tasks.values()][0]?.ms ?? -1);
    }
    expect(delays.slice(1, 5)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect([...ctx.tasks.values()][0]?.ms).toBe(MAX_RETRY_MS);
    expect(INITIAL_RETRY_MS).toBeLessThan(MAX_RETRY_MS);
  });

  it("opens replacement before closing the old socket and ignores old events", async () => {
    const ctx = setup([{ status: 200, body: { ok: true, url: socketUrl } }, { status: 200, body: { ok: true, url: socketUrl } }]);
    ctx.connection.start(); await ctx.flush();
    const old = ctx.sockets[0];
    old?.message({ type: "disconnect", reason: "refresh_requested" }); await ctx.flush();
    expect(ctx.sockets).toHaveLength(2);
    expect(old?.closed).toBe(false);
    ctx.sockets[1]?.emit("open");
    expect(old?.closed).toBe(true);
    old?.message({ type: "events_api", envelope_id: "old", payload: { event: { type: "message" } } });
    expect(old?.sent).toEqual([]);
  });

  it("ignores late responses and sends nothing after stop", async () => {
    let resolveResponse: (value: SlackConnectionResponse) => void = () => {};
    const socket = new FakeSocket();
    const logs: string[] = [];
    const connection = new SlackConnection({
      getAppToken: async () => "fake-token",
      transport: { openConnection: () => new Promise((resolve) => { resolveResponse = resolve; }), connectWebSocket: () => socket },
      onEvent: () => {}, onStatus: (status) => logs.push(status), log: (code) => logs.push(code),
    });
    connection.start(); await Promise.resolve();
    connection.stop();
    resolveResponse({ status: 200, body: { ok: true, url: socketUrl } });
    await Promise.resolve();
    socket.message({ type: "events_api", envelope_id: "id", payload: { event: { type: "message" } } });
    expect(socket.sent).toEqual([]);
    expect(logs.join(" ")).not.toMatch(/fake-token|fake-body|fake-url/);
  });

  it("does not ack if a status callback stops the connection", async () => {
    const socket = new FakeSocket();
    const connection = new SlackConnection({
      getAppToken: async () => "fake-token",
      transport: { openConnection: async () => ({ status: 200, body: { ok: true, url: socketUrl } }), connectWebSocket: () => socket },
      onEvent: () => {}, onStatus: (status) => { if (status === "connected") connection.stop(); }, log: () => {},
    });
    connection.start();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    socket.message({ type: "hello", envelope_id: "id" });
    expect(socket.sent).toEqual([]);
  });

  it("logs fixed codes and statuses without leaking response content", async () => {
    const ctx = setup([{ status: 500, body: { ok: false, error: "fake-body", url: socketUrl, token: "fake-token" } }]);
    ctx.connection.start(); await ctx.flush();
    expect([...ctx.logs, ...ctx.status].join(" ")).not.toMatch(/fake-token|fake-body|fake-url/);
  });
});
