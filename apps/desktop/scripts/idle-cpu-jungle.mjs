// jungle-on setup for measure-idle-cpu.mjs: local fake HTTPS LMS, staged plugin folder, launch arguments and
// stabilization. Mirrors apps/desktop/e2e/helpers/fake-lms.ts (kept in sync by hand: .mjs cannot import the .ts helper).
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { sendRequest } from "./control.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const certPath = join(desktopRoot, "e2e", "checker-cert.pfx");
const jungleRoot = resolve(desktopRoot, "..", "..", "plugins", "jungle");
const COOKIE = "IDLE-CPU-FAKE-COOKIE";
const COHORT_ID = "idle-cohort";
// First automatic poll fires about 5 s after activation; the e2e waits 30 s for it.
const FIRST_POLL_TIMEOUT_MS = 30000;
const CHECK_NOW_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 100;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Local HTTPS stand-in for the Jungle LMS on a random 127.0.0.1 port. Records requests in `hits`. */
export async function startFakeLms() {
  const pfx = await readFile(certPath);
  const fake = { hits: [] };
  fake.server = createServer({ pfx, passphrase: "test-only" }, (request, response) => {
    const path = request.url ?? "/";
    const cookie = request.headers.cookie ?? "";
    fake.hits.push({ path, method: request.method ?? "" });
    if (path === "/" || path === "/check-in") {
      response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `SESSION=${COOKIE}; Max-Age=3600; SameSite=None; Secure` });
      response.end("<html><body>fake lms</body></html>");
    } else if (path.startsWith("/api/")) {
      if (!cookie.includes(`SESSION=${COOKIE}`)) return json(response, 401, { error: "login" });
      if (path === "/api/v2/me/cohorts") {
        json(response, 200, [{ id: COHORT_ID, name: "idle", startDate: "2099-01-01", endDate: "2099-12-31", isActive: true }]);
      } else if (path === `/api/v2/me/cohorts/${COHORT_ID}/attendance/today`) {
        json(response, 200, { id: "idle-attendance", date: "2099-01-01", status: "idle", checkedAt: "2099-01-01T01:02:03Z",
          checkedOutAt: null, isStudying: true });
      } else json(response, 404, {});
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen) => fake.server.listen(0, "127.0.0.1", resolveListen));
  const address = fake.server.address();
  if (typeof address !== "object" || address === null) throw new Error("가짜 LMS 포트를 얻지 못했습니다.");
  fake.port = address.port;
  fake.close = () => new Promise((resolveClose) => { fake.server.close(() => resolveClose()); fake.server.closeAllConnections?.(); });
  return fake;
}

/** Copies the built plugins/jungle into <pluginsDir>/jungle without touching the original folder. Returns the plugin count (1). */
export async function stageJunglePlugin(pluginsDir) {
  const target = join(pluginsDir, "jungle");
  await mkdir(target, { recursive: true });
  for (const name of ["manifest.json", "package.json", "lines.json", "dist"]) {
    try {
      await cp(join(jungleRoot, name), join(target, name), { recursive: true });
    } catch {
      throw new Error(`jungle 플러그인 빌드 산출물이 없습니다 (${name}). 먼저 저장소 루트에서 \`pnpm build\`를 실행하세요.`);
    }
  }
  // The copy resolves @deskpet/* through the original workspace links.
  await symlink(join(jungleRoot, "node_modules"), join(target, "node_modules"), "junction");
  return 1;
}

/** Writes settings.json (check-now allowed, do-not-disturb off, plus `extraSettings`) before launch and returns the extra Electron arguments. */
export async function prepareJungleLaunch(userDataDir, pluginsDir, port, extraSettings = {}) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "settings.json"),
    JSON.stringify({ doNotDisturb: { enabled: false }, httpActionAllowlist: ["jungle.check-now"], ...extraSettings }));
  return ["--event-port=0", `--plugins-dir=${pluginsDir}`, "--permission-answer=allow",
    `--host-resolver-rules=MAP jungle-lms.krafton.com 127.0.0.1:${port}, MAP accounts.google.com 127.0.0.1:${port}`];
}

export const logPathOf = (userDataDir) => join(userDataDir, "logs", "deskpet.log");

const readLog = (userDataDir) => readFile(logPathOf(userDataDir), "utf8").catch(() => "");
export const countPolls = (text) => text.split("\n").filter((line) => line.includes("[plugin:jungle] jungle: poll kind=")).length;
const countOkPolls = (text) => text.split("\n").filter((line) => line.includes("[plugin:jungle] jungle: poll kind=ok")).length;

async function waitUntil(description, timeoutMs, condition, isAlive) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive()) throw new Error(`${description}: 앱이 종료됐습니다.`);
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`${description}: ${timeoutMs / 1000}초 안에 끝나지 않았습니다.`);
    await sleep(WAIT_POLL_MS);
  }
}

async function eventServerAuth(name, userDataDir) {
  const ready = await sendRequest(name, { cmd: "eventServerReady" });
  if (ready?.listening !== true) throw new Error(`이벤트 서버가 열리지 않았습니다: ${ready?.error ?? "알 수 없음"}`);
  const { port, token } = JSON.parse(await readFile(join(userDataDir, "event-server.json"), "utf8"));
  if (!Number.isInteger(port) || typeof token !== "string" || token.length === 0) throw new Error("event-server.json 이 올바르지 않습니다.");
  return { port, token };
}

/** Sends jungle.check-now through the user-action endpoint (same path as the tray item). */
export async function sendCheckNow(name, userDataDir) {
  const { port, token } = await eventServerAuth(name, userDataDir);
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/action/jungle.check-now`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  if (response.status !== 200) throw new Error(`jungle.check-now 가 ${response.status} 로 거절됐습니다.`);
}

/**
 * Brings jungle to its plain waiting state: the first automatic poll ran (hidden checker window exists), the home
 * page set the login cookie, and one check-now returned ok. Waits on the fake server's request record and the log
 * file instead of fixed sleeps.
 */
export async function stabilizeJungle(name, userDataDir, lms, isAlive) {
  await waitUntil("첫 자동 조회", FIRST_POLL_TIMEOUT_MS, async () => countPolls(await readLog(userDataDir)) > 0, isAlive);
  await waitUntil("체커 창 홈 페이지 로드", CHECK_NOW_TIMEOUT_MS, () => lms.hits.some((hit) => hit.path === "/"), isAlive);
  const before = countOkPolls(await readLog(userDataDir));
  await sendCheckNow(name, userDataDir);
  await waitUntil("로그인 쿠키 상태의 조회 ok", CHECK_NOW_TIMEOUT_MS, async () => countOkPolls(await readLog(userDataDir)) > before, isAlive);
}

/** Number of jungle poll lines in the log so far (burst bookkeeping). */
export async function pollCount(userDataDir) {
  return countPolls(await readLog(userDataDir));
}
