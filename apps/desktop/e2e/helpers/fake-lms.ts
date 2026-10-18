import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { DesktopApp } from "../desktop-app.js";

/** Recognizable fake values; tests assert none of them ever reach the log file. */
export const FAKE = {
  cookie: "SECRET-COOKIE-VALUE-123",
  cohortName: "SECRET-COHORT-NAME-ABC",
  cohortId: "cohort-secret-id-1",
  attendanceId: "attendance-secret-id",
  status: "SECRET-STATUS-XYZ",
  checkedAt: "2099-01-01T01:02:03Z",
} as const;

export type LmsMode = "ok" | "unauthorized" | "todayError";
export type LmsHit = { host: string; path: string; method: string; cookie: string; accept: string };

const certPath = join(import.meta.dirname, "..", "checker-cert.pfx");
const jungleRoot = join(import.meta.dirname, "..", "..", "..", "..", "plugins", "jungle");

export interface FakeLms {
  server: Server;
  port: number;
  hits: LmsHit[];
  mode: LmsMode;
  expireSession(): void;
  close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Local HTTPS stand-in for the Jungle LMS. The app maps the real manifest hosts to this port. */
export async function startFakeLms(): Promise<FakeLms> {
  const pfx = await readFile(certPath);
  const fake = { hits: [] as LmsHit[], mode: "ok" as LmsMode } as FakeLms;
  let sessionGeneration = 0;
  const sessionCookie = (): string => `SESSION=${FAKE.cookie}${sessionGeneration === 0 ? "" : `-${sessionGeneration}`}`;
  fake.expireSession = () => { sessionGeneration += 1; };
  fake.server = createServer({ pfx, passphrase: "test-only" }, (request, response) => {
    const path = request.url ?? "/";
    const cookie = request.headers.cookie ?? "";
    fake.hits.push({ host: request.headers.host ?? "", path, method: request.method ?? "", cookie,
      accept: request.headers.accept ?? "" });
    const loggedIn = cookie.includes(sessionCookie());
    if (path === "/") {
      response.writeHead(302, {
        Location: sessionGeneration === 0 || loggedIn ? "/dashboard" : "/login",
        ...(sessionGeneration === 0 ? { "Set-Cookie": `${sessionCookie()}; Path=/; Max-Age=3600; SameSite=None; Secure` } : {}),
      });
      response.end();
    } else if (path === "/dashboard" || path === "/check-in") {
      if (!loggedIn) {
        response.writeHead(302, sessionGeneration === 0
          ? { Location: path, "Set-Cookie": `${sessionCookie()}; Path=/; Max-Age=3600; SameSite=None; Secure` }
          : { Location: "/login" });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<html><body>${path === "/dashboard" ? "fake dashboard" : "fake check-in"}</body></html>`);
      }
    } else if (path === "/login") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html><body>fake login <a href='/login/complete'>Google 로그인</a></body></html>");
    } else if (path === "/login/complete") {
      response.writeHead(200, { "Content-Type": "text/html",
        "Set-Cookie": `${sessionCookie()}; Path=/; Max-Age=3600; SameSite=None; Secure` });
      response.end("<html><body>fake login complete</body></html>");
    } else if (path.startsWith("/api/")) {
      if (fake.mode === "unauthorized" || !loggedIn) return json(response, 401, { error: "login" });
      if (path === "/api/v2/me/cohorts") {
        json(response, 200, [{ id: FAKE.cohortId, name: FAKE.cohortName, startDate: "2099-01-01", endDate: "2099-12-31",
          isActive: true }]);
      } else if (path === `/api/v2/me/cohorts/${FAKE.cohortId}/attendance/today`) {
        if (fake.mode === "todayError") return json(response, 500, { error: FAKE.status });
        json(response, 200, { id: FAKE.attendanceId, date: "2099-01-01", status: FAKE.status,
          checkedAt: FAKE.checkedAt, checkedOutAt: null, isStudying: true });
      } else json(response, 404, {});
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const address = fake.server.address();
  if (typeof address !== "object" || address === null) throw new Error("Fake LMS has no port");
  fake.port = address.port;
  fake.close = () => new Promise<void>((resolve) => fake.server.close(() => resolve()));
  return fake;
}

/** Chromium switch sending the plugin's real manifest hosts to the fake server. */
export const lmsHostRules = (port: number): string =>
  `--host-resolver-rules=MAP jungle-lms.krafton.com 127.0.0.1:${port}, MAP accounts.google.com 127.0.0.1:${port}`;

/** Copies the built plugins/jungle into <root>/jungle without touching the original folder. */
export async function stageJunglePlugin(root: string): Promise<void> {
  const target = join(root, "jungle");
  await mkdir(target, { recursive: true });
  for (const name of ["manifest.json", "package.json", "dist"]) await cp(join(jungleRoot, name), join(target, name), { recursive: true });
  // The copy resolves @deskpet/* through the original workspace links.
  await symlink(join(jungleRoot, "node_modules"), join(target, "node_modules"), "junction");
}

// Weekday afternoon KST: the Studying phase the expected bubble texts assume, whatever time the PC shows.
export const FIXED_JUNGLE_CLOCK = "2026-10-08T15:00:00+09:00";

/** Starts the app with the staged jungle plugin pointed at the fake LMS, with the plugin clock fixed. */
export async function launchJungle(userData: string, root: string, port: number, actions: readonly string[],
  clock: string = FIXED_JUNGLE_CLOCK): Promise<DesktopApp> {
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false }, httpActionAllowlist: actions }));
  return DesktopApp.launch(userData, ["--event-port=0", `--plugins-dir=${root}`, "--permission-answer=allow", `--plugin-clock=${clock}`, lmsHostRules(port)]);
}

export const logPathOf = (userData: string): string => join(userData, "logs", "deskpet.log");
