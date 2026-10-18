import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { DesktopApp, type ControlResponse } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Response = ControlResponse;
type ReceivedEvent = { event: { source: string; type: string; text?: string;
  line?: { id: string; vars?: Record<string, string> }; timestamp: number }; receivedAt: number };
type PetSnapshot = {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  character: { id: string; state: string; frame: number };
  foot: unknown;
};

const desktopRoot = resolve(import.meta.dirname, "..");
let name: string;
let app: DesktopApp;
let tempDir: string;
let userDataDir: string;
let auth: { port: number; token: string };
const pipePath = (): string => `\\\\.\\pipe\\deskpet-dev-${name}`;

function request(command: Record<string, unknown>): Promise<ControlResponse> { return app.requestRaw(command); }
function events(limit?: number): Promise<ControlResponse> {
  return request({ cmd: "events", ...(limit === undefined ? {} : { limit }) });
}

function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {},
  authenticated = true): Promise<{ status: number; body: unknown }> {
  const content = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolveResponse, rejectResponse) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method, path,
      headers: { Host: `127.0.0.1:${auth.port}`, ...(authenticated ? { Authorization: `Bearer ${auth.token}` } : {}),
        ...(content === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveResponse({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
      });
    });
    call.on("error", rejectResponse);
    if (content !== undefined) call.write(content);
    call.end();
  });
}

/** Run the real built `deskpet` command against a userData folder. */
function runCli(args: string[], dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = resolve(desktopRoot, "../../packages/cli/dist/index.js");
  return new Promise((resolveRun, reject) => {
    const launcher = spawn(process.execPath, [script, ...args, "--user-data-dir", dir],
      { cwd: tempDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    launcher.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    launcher.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    launcher.on("error", reject);
    // "exit" can arrive before the last stdout/stderr chunk under load; "close" waits for both streams to end.
    launcher.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function runCodexWrapper(dir: string): Promise<number | null> {
  const script = resolve(desktopRoot, "../../docs/hooks/codex-notify-wrapper.mjs");
  const cli = resolve(desktopRoot, "../../packages/cli/dist/index.js");
  const payload = JSON.stringify({ type: "agent-turn-complete", cwd: join(tempDir, "codex-demo") });
  return new Promise((resolveRun, reject) => {
    const launcher = spawn(process.execPath, [script, process.execPath, "-e", "process.exit(0)", payload],
      { cwd: tempDir, env: { ...process.env, DESKPET_CLI: cli, DESKPET_USER_DATA_DIR: dir }, stdio: "ignore" });
    launcher.on("error", reject);
    launcher.on("close", resolveRun);
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "deskpet-events-e2e-"));
}, 30000);

beforeEach(async () => {
  userDataDir = join(tempDir, `user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  name = app.name;
  auth = await app.eventServerAuth(userDataDir);
}, 30000);

// A Windows full-suite run reached the default 10 s hook limit (11.1 s observed).
// Allow the helper's measured 12 s Electron exit observation plus 3 s for cleanup.
afterEach(async () => {
  if (app) await app.dispose();
}, 15000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

test("accepted events receive a timestamp and do not move the pet", async () => {
  await request({ cmd: "clock", pause: true });
  const before = (await request({ cmd: "state" })).result as PetSnapshot;
  expect(await http("POST", "/event", { source: "e2e", type: "notify", text: "private body", detail: "private detail" }))
    .toMatchObject({ status: 202, body: { accepted: true } });
  const result = (await events()).result as { events: ReceivedEvent[] };
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.event).toMatchObject({ source: "e2e", type: "notify" });
  expect(Number.isSafeInteger(result.events[0]?.event.timestamp)).toBe(true);
  expect(result.events[0]?.receivedAt).toBe(result.events[0]?.event.timestamp);
  // The notification leaves the queue at once and shows as a bubble (bubble.e2e.test.ts covers the bubble).
  expect(((await request({ cmd: "state" })).result as { queue: { pending: number } }).queue.pending).toBe(0);
  const after = (await request({ cmd: "state" })).result as PetSnapshot;
  expect({ visible: after.visible, bounds: after.bounds, foot: after.foot })
    .toEqual({ visible: before.visible, bounds: before.bounds, foot: before.foot });
  // Allow extra time for event delivery under a loaded CI host while polling frequently.
  await vi.waitFor(() => app.diagnostics.includes("PetEvent received:"), { timeout: 2000, interval: 10 });
  expect(app.diagnostics).toContain("PetEvent received:");
  expect(app.diagnostics).not.toContain("private body");
  expect(app.diagnostics).not.toContain("private detail");

  const timestamp = 1234567890;
  expect((await http("POST", "/event", { source: "e2e", type: "react", timestamp })).status).toBe(202);
  const recent = (await events(1)).result as { events: ReceivedEvent[] };
  expect(recent.events).toHaveLength(1);
  expect(recent.events[0]?.event.timestamp).toBe(timestamp);
  expect(Number.isSafeInteger(recent.events[0]?.receivedAt)).toBe(true);
});

test("HTTP line events use the discovered fixture catalog and reject invalid requests", async () => {
  await app.dispose();
  const pluginsDir = join(tempDir, "line-plugins");
  const fixtureDir = join(pluginsDir, "fixture");
  await mkdir(join(fixtureDir, "dist"), { recursive: true });
  await writeFile(join(fixtureDir, "manifest.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1.0.0",
    apiVersion: "2", entry: "dist/index.js", description: "E2E lines", permissions: { network: ["example.com"] },
    contributes: { lines: "lines.json" } }));
  await writeFile(join(fixtureDir, "dist", "index.js"), "export {};");
  await writeFile(join(fixtureDir, "lines.json"), JSON.stringify({ version: 1, lines: [
    { id: "fixture.done", label: "Done", kind: "done", variables: ["task"], variants: ["목록 {task}"] },
  ] }));
  userDataDir = join(tempDir, `line-data-${Date.now()}`);
  app = await DesktopApp.launch(userDataDir, [`--plugins-dir=${pluginsDir}`, "--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
  await request({ cmd: "clock", pause: true });
  const valid = { source: "fixture", type: "notify", mood: "happy", line: { id: "fixture.done", vars: { task: "빌드" } } };
  expect(await http("POST", "/event", valid)).toMatchObject({ status: 202 });
  await vi.waitFor(async () => expect((await request({ cmd: "state" })).result).toMatchObject({
    bubble: { visible: true, text: "목록 빌드" }, character: { state: "happy" },
  }), { timeout: 10_000, interval: 50 });
  expect((await http("POST", "/event", { ...valid, source: "other" })).status).toBe(400);
  expect((await http("POST", "/event", { ...valid, line: { id: "fixture.unknown" } })).status).toBe(400);
  expect((await http("POST", "/event", { ...valid, line: { id: "fixture.done", vars: { unknown: "x" } } })).status).toBe(400);
  expect((await http("POST", "/event", { ...valid, voice: { kind: "failed" } })).status).toBe(400);
  expect((await http("POST", "/event", valid, {}, false)).status).toBe(401);
});

test("malformed events are rejected without entering the history", async () => {
  const before = (await events()).result as { events: ReceivedEvent[] };
  for (const event of [{ source: "e2e" }, { source: "e2e", type: "unknown" }, "not an object"]) {
    const response = await http("POST", "/event", event);
    expect(response.status).toBe(400);
  }
  expect((await events()).result).toEqual(before);
});

test("HTTP accepts safe integer TTL and timestamp boundaries and rejects adjacent values", async () => {
  for (const [ttlMs, timestamp] of [[1, Number.MIN_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    expect((await http("POST", "/event", { source: "bounds", type: "status", ttlMs, timestamp })).status).toBe(202);
  }
  for (const event of [
    { ttlMs: 0 }, { ttlMs: Number.MAX_SAFE_INTEGER + 1 },
    { timestamp: Number.MIN_SAFE_INTEGER - 1 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect((await http("POST", "/event", { source: "bounds", type: "status", ...event })).status).toBe(400);
  }
});

test("history retains only the most recent 100 events", async () => {
  for (let index = 0; index < 101; index += 1) {
    const response = await http("POST", "/event", { source: `batch-${index}`, type: "status" });
    expect(response).toMatchObject({ status: 202, body: { accepted: true } });
    expect(((await events()).result as { events: ReceivedEvent[] }).events).toHaveLength(Math.min(index + 1, 100));
  }
  const result = (await events()).result as { events: ReceivedEvent[] };
  expect(result.events).toHaveLength(100);
  expect(result.events[0]?.event.source).toBe("batch-1");
  expect(result.events[99]?.event.source).toBe("batch-100");
  expect(((await events(2)).result as { events: ReceivedEvent[] }).events.map(({ event }) => event.source))
    .toEqual(["batch-99", "batch-100"]);
});

test("HTTP authentication, origin, host, size, routes, and status", async () => {
  expect((await http("POST", "/event", { source: "e2e", type: "notify" }, { Authorization: "" })).status).toBe(401);
  expect((await http("POST", "/event", { source: "e2e", type: "notify" }, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await http("POST", "/event", {}, { Origin: "https://example.com" })).status).toBe(403);
  expect((await http("POST", "/event", {}, { Host: "evil.example:7777" })).status).toBe(403);
  expect((await http("POST", "/event", { source: "e2e", type: "notify", detail: "x".repeat(65_536) })).status).toBe(413);
  expect((await http("POST", "/event", "{bad")).status).toBe(400);
  expect((await http("POST", "/event", {}, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await http("GET", "/event")).status).toBe(405);
  expect((await http("GET", "/absent")).status).toBe(404);
  expect((await http("POST", "/action/x", {})).status).toBe(404);
  expect(await http("GET", "/status")).toMatchObject({ status: 200, body: {
    character: { id: "placeholder" }, visible: true, eventServer: { port: auth.port }, queue: { pending: 0 },
    // The default scan root is the repository plugins/.
    plugins: expect.arrayContaining([
      expect.objectContaining({ id: "reminders", state: "running", consecutiveErrors: 0 }),
      expect.objectContaining({ id: "claude-code", name: "Claude Code", state: "running" }),
      expect.objectContaining({ id: "codex", name: "Codex", state: "running" }),
    ]),
  } });
  expect((await request({ cmd: "event", event: { source: "pipe", type: "notify" } })).ok).toBe(false);
});

test("Codex wrapper shows a bubble even when its reaction rules are disabled", async () => {
  expect(await runCodexWrapper(userDataDir)).toBe(0);
  await vi.waitFor(async () => {
    const state = (await request({ cmd: "state" })).result as { bubble: { visible: boolean; text: string } };
    expect(state.bubble).toMatchObject({ visible: true, text: "codex-demo 작업이 끝났어요" });
  }, { timeout: 10_000, interval: 50 });
  const received = (await events(1)).result as { events: ReceivedEvent[] };
  expect(received.events[0]?.event).toMatchObject({ source: "codex", type: "notify",
    line: { id: "codex.done-default", vars: { folder: "codex-demo" } } });
  expect(received.events[0]?.event.text).toBeUndefined();

  const disabledDir = join(tempDir, "codex-disabled");
  await mkdir(disabledDir, { recursive: true });
  await writeFile(join(disabledDir, "settings.json"), JSON.stringify({ plugins: { codex: { enabled: false } } }));
  const disabled = await DesktopApp.launch(disabledDir, ["--event-port=0"]);
  try {
    expect(await runCodexWrapper(disabledDir)).toBe(0);
    await vi.waitFor(async () => {
      const state = await disabled.request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } };
      expect(state.bubble).toMatchObject({ visible: true, text: "codex-demo 작업이 끝났어요" });
    }, { timeout: 10_000, interval: 50 });
  } finally {
    await disabled.dispose();
  }
}, 45_000);

test("occupied event port leaves desktop running and reports the bind error", async () => {
  const occupied = createServer();
  await new Promise<void>((resolveListen) => occupied.listen(0, "127.0.0.1", resolveListen));
  const address = occupied.address();
  if (typeof address !== "object" || address === null) throw new Error("No occupied port");
  const secondUserData = join(tempDir, `occupied-${Date.now()}`);
  const second = await DesktopApp.launch(secondUserData, [`--event-port=${address.port}`]);
  try {
    // The bind error is recorded asynchronously; wait for it up to 10 s instead of a fixed ~0.5 s window.
    const readState = async (): Promise<{ eventServer: { listening: boolean; error?: string } }> =>
      await second.request({ cmd: "state" }) as { eventServer: { listening: boolean; error?: string } };
    await vi.waitFor(async () => { expect((await readState()).eventServer.error).toBeDefined(); }, { timeout: 10_000, interval: 50 });
    const state = await readState();
    expect(state.eventServer.listening).toBe(false);
    expect(state.eventServer.error).toContain("EADDRINUSE");
    expect(state.eventServer).not.toHaveProperty("port");
    // The stale port is gone but the token stays, and the real CLI refuses to send anywhere.
    const written = await second.readEventServerFile(secondUserData);
    expect(written).not.toHaveProperty("port");
    expect(typeof written.token).toBe("string");
    const failed = await runCli(["event", "--text", "x"], secondUserData);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("서버가 열리지 않았습니다");
  } finally {
    await second.dispose();
    await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
  }
// Under load a second Electron launch plus exit has taken over 11 s, beyond the default 5 s test limit.
}, 45_000);

test("normal exit clears the port, and a new app launch restores CLI access", async () => {
  const oldPort = auth.port;
  await app.quit();
  expect(await app.readEventServerFile(userDataDir)).not.toHaveProperty("port");
  let receivedAuthorization = false;
  const replacement = createServer((request, response) => {
    receivedAuthorization ||= request.headers.authorization !== undefined;
    response.end("other service");
  });
  await new Promise<void>((resolveListen) => replacement.listen(oldPort, "127.0.0.1", resolveListen));
  try {
    const failed = await runCli(["status"], userDataDir);
    expect(failed.code).not.toBe(0);
    expect(receivedAuthorization).toBe(false);
  } finally {
    await new Promise<void>((resolveClose) => replacement.close(() => resolveClose()));
  }
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
  expect((await runCli(["status"], userDataDir)).code).toBe(0);
// Quit (up to the helper's 12 s exit wait) plus a relaunch exceeds the default 5 s test limit under load.
}, 45_000);

test("stale pid prevents bearer token disclosure to another local service", async () => {
  const oldPort = auth.port;
  await app.forceStop();
  let receivedAuthorization = false;
  const replacement = createServer((request, response) => {
    receivedAuthorization ||= request.headers.authorization !== undefined;
    response.end("other service");
  });
  await new Promise<void>((resolveListen) => replacement.listen(oldPort, "127.0.0.1", resolveListen));
  try {
    const failed = await runCli(["status"], userDataDir);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("실행 중이지 않습니다");
    expect(receivedAuthorization).toBe(false);
  } finally { await new Promise<void>((resolveClose) => replacement.close(() => resolveClose())); }
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
}, 45_000);

test("slow headers and slow body hit the absolute five-second receive deadline", async () => {
  const slow = (part: string): Promise<{ elapsedMs: number; data: string }> => new Promise((resolveClose, rejectClose) => {
    const socket = connect(auth.port, "127.0.0.1");
    let data = "";
    let startedAt = 0;
    let trickle: ReturnType<typeof setInterval> | undefined;
    socket.on("connect", () => {
      startedAt = performance.now();
      socket.write(part);
      // One byte per second reproduces the slow-header/body streams that previously lasted 8 s.
      trickle = setInterval(() => socket.write("x"), 1000);
    });
    socket.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (trickle) clearInterval(trickle);
      // The server drops the socket at 5 s, the same moment the 5th trickle byte is written, so Windows may report the
      // cut-off as a reset instead of a clean FIN. That is the behaviour under test, and "close" still follows.
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") rejectClose(error);
    });
    socket.on("close", () => { if (trickle) clearInterval(trickle); resolveClose({ elapsedMs: performance.now() - startedAt, data }); });
  });
  const header = `POST /event HTTP/1.1\r\nHost: 127.0.0.1:${auth.port}\r\nAuthorization: Bearer `;
  const body = `POST /event HTTP/1.1\r\nHost: 127.0.0.1:${auth.port}\r\nAuthorization: Bearer ${auth.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`;
  const results = await Promise.all([slow(header), slow(body)]);
  for (const result of results) {
    expect(result.data).toBe("");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(4_800);
    // Five full-suite Windows runs closed both streams before 6.5 s, but a loaded main process delays its 5 s timer.
    // Anything below the 8 s of the old per-chunk timeout still proves the deadline is absolute.
    expect(result.elapsedMs).toBeLessThan(7_500);
  }
}, 20_000);

test("duplicate Host or Authorization raw headers are rejected, a missing token is 401", async () => {
  const raw = (headers: string): Promise<string> => new Promise((resolveResponse, rejectResponse) => {
    const socket = connect(auth.port, "127.0.0.1");
    let data = "";
    socket.on("connect", () => socket.end(`GET /status HTTP/1.1\r\n${headers}\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    socket.on("error", rejectResponse);
    socket.on("close", () => resolveResponse(data));
  });
  const host = `Host: 127.0.0.1:${auth.port}\r\n`;
  const authorization = `Authorization: Bearer ${auth.token}\r\n`;
  expect(await raw(host + host + authorization)).toMatch(/^HTTP\/1\.1 400/u);
  expect(await raw(host + authorization + authorization)).toMatch(/^HTTP\/1\.1 400/u);
  expect(await raw(host)).toMatch(/^HTTP\/1\.1 401/u);
});

test("deskpet event run right after launch succeeds without waiting for the server", async () => {
  const freshUserData = join(tempDir, `fresh-${Date.now()}`);
  const fresh = await DesktopApp.launch(freshUserData, ["--event-port=0"]);
  try {
    // No eventServerAuth() here: the CLI itself must cope with an app that has only just become ready.
    expect(await runCli(["event", "--text", "바로 실행"], freshUserData)).toMatchObject({ code: 0, stdout: "이벤트를 보냈습니다.\n" });
  } finally { await fresh.dispose(); }
// Two overlapping full-suite runs measured this launch → CLI → exit path at 7,735 ms;
// the same file passed alone. Its 12 s limit covers that measured maximum.
}, 12_000);

test("deskpet CLI accepts BOM files, sends Korean text, and reports failures", async () => {
  const run = (args: string[], dir = userDataDir) => runCli(args, dir);
  expect(await run(["event", "--text", "테스트", "--mood", "happy"])).toMatchObject({ code: 0 });
  expect((await run(["status"])).stdout).toContain("DeskPet");
  expect((await run(["status", "--json"])).stdout).toContain('"eventServer"');
  const event = { source: "launcher", type: "notify", text: "한글 알림" };
  const files = [
    ["utf8-bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(event), "utf8")])],
    ["utf16le-bom.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(event), "utf16le")])],
    ["utf8.json", Buffer.from(JSON.stringify(event), "utf8")],
  ] as const;
  for (const [index, [fileName, content]] of files.entries()) {
    const file = join(tempDir, fileName);
    await writeFile(file, content);
    expect(await run(["event", "--file", fileName])).toMatchObject({ code: 0, stdout: "이벤트를 보냈습니다.\n" });
    expect(((await events()).result as { events: ReceivedEvent[] }).events).toHaveLength(index + 2);
  }
  const recorded = (await events()).result as { events: ReceivedEvent[] };
  expect(recorded.events).toHaveLength(4);
  expect(recorded.events.map(({ event: received }) => received.text)).toEqual(["테스트", "한글 알림", "한글 알림", "한글 알림"]);
  expect(await run(["event", "--json", JSON.stringify({ source: "launcher", type: "status" })]))
    .toMatchObject({ code: 0 });
  const missingFile = "missing.json";
  const missing = await run(["event", "--file", missingFile]);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain(`파일 '${missingFile}'`);
  expect(missing.stderr).toContain("ENOENT");
  const malformedFile = join(tempDir, "malformed.json");
  await writeFile(malformedFile, "not json", "utf8");
  const invalid = await run(["event", "--file", "malformed.json"]);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stderr).toContain("파일 'malformed.json'");
  expect(invalid.stderr).toContain("Unexpected token");
  expect((await run(["event", "--file", join(tempDir, "utf8.json")])).code).not.toBe(0);
  expect((await run(["event", "--file", "../utf8.json"])).code).not.toBe(0);
  const rejected = await run(["event", "--json", "{\"source\":\"launcher\"}"]);
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("400");
  const noAuthFile = await run(["status"], join(tempDir, "no-auth-file"));
  expect(noAuthFile.code).not.toBe(0);
  expect(noAuthFile.stderr).toContain("토큰 파일");
});

test("dev control rejects an oversized line and excess concurrent requests", async () => {
  const oversized = await new Promise<{ response: Response; closed: boolean }>((resolveResult, rejectResult) => {
    const socket = connect(pipePath());
    let pending = "";
    let response: Response | undefined;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${"x".repeat(64 * 1024 + 1)}\n`));
    socket.on("data", (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline >= 0) response = JSON.parse(pending.slice(0, newline)) as Response;
    });
    socket.on("error", rejectResult);
    socket.on("close", () => {
      if (response) resolveResult({ response, closed: true });
      else rejectResult(new Error("Oversized request closed without a response"));
    });
  });
  expect(oversized.closed).toBe(true);
  expect(oversized.response).toMatchObject({ ok: false, error: "Request line exceeds 64 KiB" });

  const responses = await new Promise<Response[]>((resolveResult, rejectResult) => {
    const socket = connect(pipePath());
    let pending = "";
    const received: Response[] = [];
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(Array.from({ length: 9 }, (_, index) => JSON.stringify({ id: index + 1, cmd: "state" })).join("\n") + "\n");
    });
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        received.push(JSON.parse(pending.slice(0, newline)) as Response);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (received.length === 9) { socket.end(); resolveResult(received); }
    });
    socket.on("error", rejectResult);
  });
  expect(responses).toHaveLength(9);
  expect(responses.find((response) => response.id === 9)).toMatchObject({ ok: false, error: "Too many in-flight requests" });
});
