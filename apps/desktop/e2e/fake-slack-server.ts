import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

export interface SlackHit { method: string; path: string; authorization: string | undefined; host: string | undefined }

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  if (body.length > 65535) throw new Error("Fake Slack frame is too long");
  return Buffer.concat([body.length <= 125 ? Buffer.from([0x81, body.length]) :
    Buffer.from([0x81, 126, body.length >> 8, body.length & 255]), body]);
}

export async function fakeSlackServer() {
  const hits: SlackHit[] = [];
  const acks: unknown[] = [];
  const sockets = new Set<Duplex>();
  let openError: string | undefined;
  let closed = 0;
  const server: Server = createServer((request, response) => {
    hits.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization,
      host: request.headers.host });
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/apps.connections.open") {
      response.end(JSON.stringify(openError ? { ok: false, error: openError } :
        { ok: true, url: "wss://wss-primary.slack.com/link/test?ticket=fake-ticket" }));
    } else if (request.url?.startsWith("/api/users.info")) {
      response.end(JSON.stringify({ ok: true, user: { name: "Tester", team_id: "TTEAM",
        profile: { display_name: "Tester" } } }));
    } else if (request.url?.startsWith("/api/conversations.info")) {
      response.end(JSON.stringify({ ok: true, channel: { name: "general" } }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  server.on("upgrade", (request, socket) => {
    hits.push({ method: "UPGRADE", path: request.url ?? "", authorization: request.headers.authorization,
      host: request.headers.host });
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || request.url !== "/wss-primary.slack.com/link/test?ticket=fake-ticket") {
      socket.destroy(); return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); closed++; });
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 6) {
        const opcode = (bytes[0] ?? 0) & 0x0f;
        const length = (bytes[1] ?? 0) & 0x7f;
        if (length > 125) { socket.destroy(); return; }
        const end = 6 + length;
        if (bytes.length < end) return;
        const mask = bytes.subarray(2, 6);
        const payload = Buffer.from(bytes.subarray(6, end));
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
        bytes = bytes.subarray(end);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) {
          try { acks.push(JSON.parse(payload.toString("utf8"))); } catch { /* The test asserts valid acknowledgements. */ }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Slack server has no port");
  return {
    port: address.port, hits, acks, sockets,
    get closed() { return closed; },
    setOpenError(error: string | undefined) { openError = error; },
    send(value: unknown) { for (const socket of sockets) socket.write(frame(JSON.stringify(value))); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
