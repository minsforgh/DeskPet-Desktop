#!/usr/bin/env node
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAuthFile, type Credentials } from "./auth-file.js";
import { readJsonFile } from "./read-json.js";
import { usageText } from "./usage.js";

type Options = Record<string, string | boolean>;
type Command = "event" | "status" | "help";
type Status = { version: string; character: { id: string; state: string }; visible: boolean;
  eventServer: { port: number }; queue: { pending: number }; plugins: unknown[] };

function parseArgs(args: string[]): { command: Command; options: Options; slots: string[]; vars: string[] } {
  const command = args.shift();
  if (command === "--help" || command === "-h") return { command: "help", options: {}, slots: [], vars: [] };
  if (command !== "event" && command !== "status") throw new Error("사용법: deskpet event|status [옵션]");
  if (args[0] === "--help" || args[0] === "-h") return { command: "help", options: {}, slots: [], vars: [] };
  const options: Options = {};
  const slots: string[] = [];
  const vars: string[] = [];
  const known = new Set(["text", "mood", "priority", "type", "source", "key", "ttl", "detail", "file", "json", "user-data-dir", "voice", "slot", "line", "var"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new Error(`알 수 없는 인자: ${arg}`);
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg.slice(2) : arg.slice(2, equal);
    if (!known.has(name) || (command === "status" && name !== "json" && name !== "user-data-dir"))
      throw new Error(`알 수 없는 옵션: --${name}`);
    if (name in options && name !== "slot" && name !== "var") throw new Error(`중복 옵션: --${name}`);
    if (command === "status" && name === "json" && equal < 0) options[name] = true;
    else {
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (value === undefined || value.startsWith("--")) throw new Error(`옵션 값이 없습니다: --${name}`);
      if (name === "slot") slots.push(value);
      else if (name === "var") vars.push(value);
      else options[name] = value;
    }
  }
  return { command, options, slots, vars };
}

function userDataPath(options: Options): string {
  const override = options["user-data-dir"] ?? process.env.DESKPET_USER_DATA_DIR;
  if (typeof override === "string") return override;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "deskpet");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "deskpet");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "deskpet");
}

function auth(options: Options): Promise<Credentials> {
  return readAuthFile(join(userDataPath(options), "event-server.json"));
}

async function send(method: "GET" | "POST", path: string, body: unknown, credentials: { port: number; token: string }): Promise<{
  status: number; body: unknown;
}> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveResponse, rejectResponse) => {
    const call = request({ hostname: "127.0.0.1", port: credentials.port, method, path,
      headers: { Authorization: `Bearer ${credentials.token}`, ...(data === undefined ? {} : {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
      }) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = content;
        try { parsed = JSON.parse(content) as unknown; } catch { /* Keep server text for error reporting. */ }
        resolveResponse({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    call.on("error", rejectResponse);
    if (data !== undefined) call.write(data);
    call.end();
  });
}

async function eventFrom(options: Options, slots: string[], vars: string[]): Promise<unknown> {
  const kind = options.voice;
  if (kind !== undefined && kind !== "done" && kind !== "waiting" && kind !== "failed" && kind !== "info" && kind !== "deadline" && kind !== "reminder" && kind !== "alert")
    throw new Error("--voice는 done, waiting, failed, info, deadline, reminder, alert 중 하나여야 합니다.");
  if (slots.length > 0 && kind === undefined) throw new Error("--slot은 --voice와 함께 써야 합니다.");
  const values: Record<string, string> = {};
  for (const slot of slots) {
    const equal = slot.indexOf("=");
    const name = slot.slice(0, equal);
    if (equal < 0 || !["task", "result", "folder", "message"].includes(name))
      throw new Error("--slot 이름은 task, result, folder, message 중 하나여야 합니다.");
    if (Object.hasOwn(values, name)) throw new Error(`중복 --slot 이름: ${name}`);
    values[name] = slot.slice(equal + 1);
  }
  if (vars.length > 0 && options.line === undefined) throw new Error("--var는 --line과 함께 써야 합니다.");
  const lineVars: Record<string, string> = {};
  for (const variable of vars) {
    const equal = variable.indexOf("=");
    const name = variable.slice(0, equal);
    if (equal < 0 || !/^[a-z][a-z0-9]*$/u.test(name)) throw new Error("--var 이름이 올바르지 않습니다.");
    if (Object.hasOwn(lineVars, name)) throw new Error(`중복 --var 이름: ${name}`);
    lineVars[name] = variable.slice(equal + 1);
  }
  if (options.file !== undefined && options.json !== undefined) throw new Error("--file과 --json은 함께 쓸 수 없습니다.");
  let input: unknown;
  if (typeof options.file === "string") {
    try { input = await readJsonFile(options.file); }
    catch (error) { throw new Error(`파일 '${options.file}'을 읽거나 파싱할 수 없습니다: ${String(error)}`, { cause: error }); }
  } else if (typeof options.json === "string") {
    try { input = JSON.parse(options.json) as unknown; }
    catch { throw new Error("JSON 입력을 파싱할 수 없습니다."); }
  } else {
    const event: Record<string, unknown> = { source: options.source ?? "cli", type: options.type ?? "notify" };
    for (const name of ["text", "mood", "priority", "key", "detail"] as const) {
      if (options[name] !== undefined) event[name] = options[name];
    }
    if (options.ttl !== undefined) {
      const ttl = Number(options.ttl);
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("--ttl은 양의 정수 밀리초여야 합니다.");
      event.ttlMs = ttl;
    }
    input = event;
  }
  if (kind === undefined && options.line === undefined) return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("--voice나 --line을 쓰려면 이벤트 JSON 객체가 필요합니다.");
  return { ...input, ...(kind === undefined ? {} : { voice: { kind, ...(slots.length > 0 ? { slots: values } : {}) } }),
    ...(options.line === undefined ? {} : { line: { id: options.line, ...(vars.length > 0 ? { vars: lineVars } : {}) } }) };
}

async function main(): Promise<void> {
  const { command, options, slots, vars } = parseArgs(process.argv.slice(2));
  if (command === "help") { console.log(usageText()); return; }
  const event = command === "event" ? await eventFrom(options, slots, vars) : undefined;
  const credentials = await auth(options);
  let result: { status: number; body: unknown };
  try { result = await send(command === "event" ? "POST" : "GET", command === "event" ? "/event" : "/status",
    event, credentials); }
  catch (error) { throw new Error("DeskPet 앱의 로컬 이벤트 서버에 연결할 수 없습니다.", { cause: error }); }
  if (result.status < 200 || result.status >= 300) throw new Error(`서버 오류 ${result.status}: ${JSON.stringify(result.body)}`);
  if (command === "event") console.log("이벤트를 보냈습니다.");
  else if (options.json) console.log(JSON.stringify(result.body));
  else if (typeof result.body === "object" && result.body !== null && "character" in result.body &&
      typeof result.body.character === "object" && result.body.character !== null &&
      "id" in result.body.character && "state" in result.body.character) {
    const status = result.body as Status;
    console.log(`DeskPet ${status.version}\n캐릭터: ${status.character.id} (${status.character.state})` +
      `\n표시: ${status.visible ? "켜짐" : "숨김"}\n이벤트 서버: 127.0.0.1:${status.eventServer.port}` +
      `\n대기 알림: ${status.queue.pending}\n플러그인: ${status.plugins.length}`);
  } else console.log(JSON.stringify(result.body));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
