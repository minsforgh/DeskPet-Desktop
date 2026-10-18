import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { validatePetEvent, type LineCatalog, type LinePetEvent } from "@deskpet/core";
import type { InvokeResult } from "./actions.js";

export const EVENT_AUTH_FILE = "event-server.json";
export const MAX_EVENT_BODY_BYTES = 64 * 1024;
// ADR-0004 specifies one 5 s budget for headers and body combined. The timeout is absolute from TCP accept.
export const RECEIVE_DEADLINE_MS = 5_000;
export type EventServerState = { port?: number; listening: boolean; error?: string };
type Decision = { status: number; route?: "event" | "status" | "action" };

export function decideRequest(method: string | undefined, path: string | undefined, headers: {
  authorization?: string; host?: string; origin?: string; "content-type"?: string;
}, port: number, token: string): Decision {
  const supplied = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : "";
  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  if (!supplied || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { status: 401 };
  if (headers.origin !== undefined) return { status: 403 };
  if (headers.host !== `127.0.0.1:${port}` && headers.host !== `localhost:${port}`) return { status: 403 };
  const route = path === "/event" ? "event" : path === "/status" ? "status"
    : path?.startsWith("/action/") && path.length > "/action/".length ? "action" : undefined;
  if (!route) return { status: 404 };
  if (method !== (route === "status" ? "GET" : "POST")) return { status: 405, route };
  if (method === "POST" && headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    return { status: 415, route };
  return { status: 200, route };
}

async function tokenFor(userDataDir: string): Promise<string> {
  const path = join(userDataDir, EVENT_AUTH_FILE);
  try {
    const stored: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof stored === "object" && stored !== null && "token" in stored && typeof stored.token === "string" &&
        stored.token.length === 64 && Buffer.from(stored.token, "hex").toString("hex") === stored.token) return stored.token;
    throw new Error("Invalid event server token file");
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return randomBytes(32).toString("hex");
}

// Written in one step (temporary file, then rename) so a reader never sees a half-written file.
// Without a port the file only keeps the token: the server is not listening, so no client may be sent anywhere.
async function saveAuth(userDataDir: string, port: number | undefined, token: string): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  const path = join(userDataDir, EVENT_AUTH_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(port === undefined ? { token } : { port, token, pid: process.pid }), { mode: 0o600 });
  await rename(temporary, path);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function shouldClearAuthOnStart(pid: unknown, ownPid: number, alive: (pid: number) => boolean): boolean {
  return !Number.isSafeInteger(pid) || typeof pid !== "number" || pid <= 0 || pid === ownPid || !alive(pid);
}

export function shouldClearAuthOnClose(pid: unknown, ownPid: number): boolean {
  return pid === ownPid;
}

async function storedAuthPid(userDataDir: string): Promise<unknown> {
  try {
    const stored: unknown = JSON.parse(await readFile(join(userDataDir, EVENT_AUTH_FILE), "utf8"));
    return typeof stored === "object" && stored !== null && "pid" in stored ? stored.pid : undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function clearAuthOnStart(userDataDir: string, token: string): Promise<void> {
  if (shouldClearAuthOnStart(await storedAuthPid(userDataDir), process.pid, isProcessAlive))
    await saveAuth(userDataDir, undefined, token);
}

async function clearAuthOnClose(userDataDir: string, token: string): Promise<void> {
  if (shouldClearAuthOnClose(await storedAuthPid(userDataDir), process.pid))
    await saveAuth(userDataDir, undefined, token);
}

function respond(response: ServerResponse, status: number, body: unknown = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage, response: ServerResponse, allowEmpty = false): Promise<unknown | undefined> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (value: unknown | undefined): void => { if (!finished) { finished = true; resolveBody(value); } };
    request.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_EVENT_BODY_BYTES) { respond(response, 413); request.pause(); finish(undefined); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (finished) return;
      const raw = Buffer.concat(chunks);
      // An action body may be empty; undefined then means "no body", the same value an aborted read resolves with.
      // Callers tell the two apart with response.headersSent, which only an error response sets.
      if (raw.length === 0 && allowEmpty) { finish(undefined); return; }
      try { finish(JSON.parse(raw.toString("utf8")) as unknown); }
      catch { respond(response, 400, { errors: ["Invalid JSON"] }); finish(undefined); }
    });
    request.on("aborted", () => finish(undefined));
    request.on("error", () => finish(undefined));
  });
}

export async function startEventServer(options: {
  userDataDir: string; port: number; status: () => unknown; onEvent: (event: LinePetEvent) => void;
  lineCatalogs?: () => readonly { pluginId: string; catalog: LineCatalog }[];
  onAction: (id: string, args?: unknown) => Promise<InvokeResult>;
}): Promise<{ state: EventServerState; close: () => Promise<void> }> {
  const state: EventServerState = { listening: false };
  let token: string;
  try { token = await tokenFor(options.userDataDir); }
  catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    console.error("Event server setup:", state.error);
    return { state, close: async () => undefined };
  }
  // Clear a stale address before binding, but leave another live instance's address intact.
  try { await clearAuthOnStart(options.userDataDir, token); }
  catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    return { state, close: async () => undefined };
  }
  const server: Server = createServer(async (request, response) => {
    const counts = { host: 0, authorization: 0 };
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]?.toLowerCase();
      if (name === "host" || name === "authorization") counts[name] += 1;
    }
    // Only duplicates are malformed here; a missing header falls through to the 401/403 checks below.
    if (counts.host > 1 || counts.authorization > 1) { respond(response, 400); return; }
    const deadline = deadlines.get(request.socket);
    if (deadline) {
      const clearDeadline = (): void => { clearTimeout(deadline); deadlines.delete(request.socket); };
      request.once("end", clearDeadline);
      response.once("finish", clearDeadline);
    }
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    const decision = decideRequest(request.method, request.url, {
      authorization: request.headers.authorization, host: request.headers.host, origin: request.headers.origin,
      "content-type": request.headers["content-type"],
    }, port, token);
    let status = decision.status;
    try {
      if (status === 200 && decision.route === "status") respond(response, status, options.status());
      else if (status === 200 && decision.route === "event") {
        const body = await bodyOf(request, response);
        if (response.headersSent || request.aborted) return;
        const validated = validatePetEvent(body);
        if (!validated.ok) { status = 400; respond(response, status, { errors: validated.errors }); }
        else {
          const event = validated.value;
          const line = event.line;
          const catalog = line === undefined ? undefined : options.lineCatalogs?.().find(({ pluginId }) => pluginId === event.source)?.catalog;
          const declared = catalog?.lines.find(({ id }) => id === line?.id);
          const lineError = line === undefined ? undefined
            : !line.id.startsWith(`${event.source}.`) ? "line.id must match source"
              : declared === undefined ? "line.id is not registered"
                : Object.keys(line.vars ?? {}).some((name) => !declared.variables.includes(name)) ? "line.vars has undeclared variables"
                  : event.voice !== undefined && event.voice.kind !== declared.kind ? "line kind does not match voice.kind"
                    : undefined;
          if (lineError !== undefined) { status = 400; respond(response, status, { errors: [lineError] }); }
          else { options.onEvent(event); status = 202; respond(response, status, { accepted: true }); }
        }
      } else if (status === 200 && decision.route === "action") {
        // The id is compared exactly as written, without percent-decoding; unknown or malformed ids are not found.
        const path = (request.url ?? "").split("?", 1)[0] ?? "";
        const id = path.slice("/action/".length);
        const body = await bodyOf(request, response, true);
        if (response.headersSent || request.aborted) return;
        const objectBody = body === undefined ? undefined
          : typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
        if (objectBody === null) {
          status = 400;
          respond(response, status, { errors: ["Action body must be empty or a JSON object"] });
        } else {
          const result = await options.onAction(id, objectBody !== undefined && "args" in objectBody ? objectBody.args : undefined);
          status = result.ok ? 200 : result.reason === "not-found" ? 404 : 500;
          respond(response, status, result.ok ? { executed: true } : {});
        }
      } else respond(response, status);
    } catch {
      status = 500;
      if (!response.headersSent) respond(response, status);
    } finally {
      console.info("Event HTTP:", { method: request.method, path: request.url?.split("?", 1)[0], status: response.statusCode });
    }
  });
  const sockets = new Set<import("node:net").Socket>();
  const deadlines = new Map<import("node:net").Socket, ReturnType<typeof setTimeout>>();
  server.on("connection", (socket) => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); const timer = deadlines.get(socket); if (timer) clearTimeout(timer); deadlines.delete(socket); });
    deadlines.set(socket, setTimeout(() => socket.destroy(), RECEIVE_DEADLINE_MS));
    socket.on("error", () => undefined);
  });
  server.on("clientError", (_error, socket) => { if (!socket.destroyed) socket.destroy(); });
  const listenError = await new Promise<Error | undefined>((resolveListen) => {
    server.once("error", resolveListen);
    server.listen(options.port, "127.0.0.1", () => { server.removeAllListeners("error"); resolveListen(undefined); });
  });
  if (listenError) {
    state.error = listenError.message;
    console.error("Event server listen:", state.error);
    // Drop only a stale address; a live instance may own the port that rejected this bind.
    try { await clearAuthOnStart(options.userDataDir, token); }
    catch (error) { console.error("Event server token file:", error instanceof Error ? error.message : String(error)); }
    return { state, close: async () => undefined };
  }
  server.on("error", (error) => { state.error = error.message; state.listening = false; console.error("Event server:", state.error); });
  const address = server.address();
  state.port = typeof address === "object" && address !== null ? address.port : options.port;
  try { await saveAuth(options.userDataDir, state.port, token); }
  catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    console.error("Event server token file:", state.error);
    server.close();
  }
  if (!state.error) state.listening = true;
  return { state, close: async () => {
    await clearAuthOnClose(options.userDataDir, token);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  } };
}
