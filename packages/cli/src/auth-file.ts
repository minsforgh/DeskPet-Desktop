import { readFile } from "node:fs/promises";

export type Credentials = { port: number; token: string; pid: number };
export type AuthFileResult = { ok: true; credentials: Credentials } | { ok: false; message: string };

// The app writes the file only after the server is listening, which in e2e runs took well under 1 s after the
// pet became ready (the old 0.5 s wait in the tests was too short once). Retry every 100 ms, 20 times, so a CLI
// run right after launch waits at most 2 s in total before reporting the problem.
export const AUTH_RETRY_INTERVAL_MS = 100;
export const AUTH_RETRY_ATTEMPTS = 20;

/** Judge the text of event-server.json. Never returns a port outside 1-65535. */
export function judgeAuthFile(text: string | undefined): AuthFileResult {
  if (text === undefined) return { ok: false, message: "DeskPet 토큰 파일이 없습니다. 앱을 실행했는지, userData 경로가 맞는지 확인하세요." };
  let stored: unknown;
  try { stored = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown; }
  catch { return { ok: false, message: "DeskPet 토큰 파일이 JSON이 아닙니다." }; }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return { ok: false, message: "DeskPet 토큰 파일 형식이 잘못되었습니다." };
  const { port, token, pid } = stored as { port?: unknown; token?: unknown; pid?: unknown };
  if (typeof token !== "string" || token.length === 0) return { ok: false, message: "DeskPet 토큰 파일에 token이 없습니다." };
  if (port === undefined) return { ok: false, message: "DeskPet 이벤트 서버가 열리지 않았습니다. 앱 로그에서 포트 사용 중 오류를 확인하세요." };
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, message: "DeskPet 토큰 파일의 port가 1~65535 사이의 정수가 아닙니다." };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)
    return { ok: false, message: "DeskPet 토큰 파일의 pid가 유효하지 않습니다." };
  return { ok: true, credentials: { port, token, pid } };
}

/** Read the file, waiting briefly while the app may still be starting. */
export async function readAuthFile(path: string, options: { intervalMs?: number; attempts?: number;
  readText?: (path: string) => Promise<string>; wait?: (ms: number) => Promise<void> } = {}): Promise<Credentials> {
  const intervalMs = options.intervalMs ?? AUTH_RETRY_INTERVAL_MS;
  const attempts = options.attempts ?? AUTH_RETRY_ATTEMPTS;
  let result: AuthFileResult = judgeAuthFile(undefined);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let text: string | undefined;
    try { text = await (options.readText ?? ((file) => readFile(file, "utf8")))(path); } catch { text = undefined; }
    result = judgeAuthFile(text);
    if (result.ok) {
      try { process.kill(result.credentials.pid, 0); return result.credentials; }
      catch { throw new Error("DeskPet 앱 프로세스가 실행 중이지 않습니다."); }
    }
    if (attempt < attempts - 1) await (options.wait ?? ((ms) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms))))(intervalMs);
  }
  throw new Error(result.ok ? "" : result.message);
}
