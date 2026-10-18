import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type PetSnapshot = { visible: boolean; character: { state: string }; queue: { pending: number } };
type RecordedEvent = { source: string; type: string; mood?: string };

let app: DesktopApp;
let tempDir: string;
let userDataDir: string;
let auth: { port: number; token: string };

const state = (): Promise<PetSnapshot> => app.request({ cmd: "state" }) as Promise<PetSnapshot>;
const events = (): Promise<RecordedEvent[]> =>
  (app.request({ cmd: "events" }) as Promise<{ events: Array<{ event: RecordedEvent }> }>)
    .then((result) => result.events.map(({ event }) => event));

/** A request against the real local HTTP server. An undefined override removes the header entirely. */
function http(method: string, path: string, body?: unknown, overrides: Record<string, string | undefined> = {}):
Promise<{ status: number; body: unknown }> {
  const content = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    Host: `127.0.0.1:${auth.port}`,
    Authorization: `Bearer ${auth.token}`,
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    ...overrides,
  })) if (value !== undefined) headers[name] = value;
  return new Promise((resolveResponse, rejectResponse) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method, path, headers }, (response) => {
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

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-action-e2e-")); }, 30000);

beforeEach(async () => {
  userDataDir = join(tempDir, `user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  app = await DesktopApp.launch(userDataDir, ["--event-port=0"]);
  auth = await app.eventServerAuth(userDataDir);
}, 30000);

// Same allowance as event.e2e.test.ts: the helper observes Electron's exit for up to 12 s.
afterEach(async () => { if (app) await app.dispose(); }, 15000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (tempDir) await cleanupTemporaryPath(tempDir, app ? [app] : []); }
});

// Every row of the /action/:id response table (docs/plan.md 6-4, M3-7), including "missing" header variants.
test("rejected action requests follow the response table and leave the pet untouched", async () => {
  // Freeze the clock on a known state so the assertions cannot race the automatic blink cycle.
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "setState", state: "idle" });
  expect((await http("POST", "/action/deskpet.ping", {}, { Authorization: undefined })).status).toBe(401);
  expect((await http("POST", "/action/deskpet.ping", {}, { Authorization: "" })).status).toBe(401);
  expect((await http("POST", "/action/deskpet.ping", {}, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await http("POST", "/action/deskpet.ping", {}, { Host: "evil.example:7777" })).status).toBe(403);
  expect((await http("POST", "/action/deskpet.ping", {}, { Origin: "https://example.com" })).status).toBe(403);
  // Not on the allowlist, and an id that register() would reject, both 404.
  expect((await http("POST", "/action/deskpet.absent", {})).status).toBe(404);
  expect((await http("POST", "/action/ping", {})).status).toBe(404);
  expect((await http("POST", "/action/deskpet.ping/extra", {})).status).toBe(404);
  expect((await http("POST", "/action/", {})).status).toBe(404);
  expect((await http("POST", "/action/deskpet.ping", "{bad")).status).toBe(400);
  expect((await http("POST", "/action/deskpet.ping", "[1,2]")).status).toBe(400);
  expect((await http("POST", "/action/deskpet.ping", "\"text\"")).status).toBe(400);
  expect((await http("POST", "/action/deskpet.ping", "null")).status).toBe(400);
  expect((await http("GET", "/action/deskpet.ping")).status).toBe(405);
  expect((await http("POST", "/action/deskpet.ping", {}, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await http("POST", "/action/deskpet.ping", {}, { "Content-Type": undefined })).status).toBe(415);
  expect((await http("POST", "/action/deskpet.ping", { args: "x".repeat(65_600) })).status).toBe(413);
  // The demo handler rejects non-object args by throwing, which the server reports as a handler failure.
  expect((await http("POST", "/action/deskpet.ping", { args: [1, 2] })).status).toBe(500);
  const snapshot = await state();
  expect(snapshot.character.state).toBe("idle");
  expect(await events()).toEqual([]);
});

test("an executed action makes the pet react happy and records the event", async () => {
  await app.request({ cmd: "clock", pause: true });
  expect(await http("POST", "/action/deskpet.ping", undefined)).toMatchObject({ status: 200, body: { executed: true } });
  expect((await state()).character.state).toBe("happy");
  expect(await events()).toEqual([
    expect.objectContaining({ source: "deskpet", type: "react", mood: "happy" }),
  ]);
  // An object args body runs the same action again; unknown keys are ignored, as PetEvent validation ignores them.
  expect(await http("POST", "/action/deskpet.ping", { args: { extra: true }, ignored: 1 }))
    .toMatchObject({ status: 200, body: { executed: true } });
  const recorded = await events();
  expect(recorded).toHaveLength(2);
  for (const event of recorded) expect(event).toMatchObject({ source: "deskpet", type: "react", mood: "happy" });
  expect((await state()).character.state).toBe("happy");
});
