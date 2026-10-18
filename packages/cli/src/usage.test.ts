import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { validatePetEvent } from "@deskpet/core";
import { usageText } from "./usage.js";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, "..", "..", "..");
const entry = join(here, "..", "dist", "index.js");

// Windows workspace measurement: `pnpm --filter @deskpet/cli build` took at most 2.7 s
// (single run, warm pnpm store). 20 s covers cold caches with wide margin.
beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@deskpet/cli", "build"],
    { cwd: workspaceRoot, shell: process.platform === "win32", stdio: "pipe" });
}, 20_000);

/** Run the real built CLI entry (the `deskpet` bin target) and capture code/stdout/stderr. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", rejectRun);
    // "exit" can arrive before the last stdout/stderr chunk under load; "close" waits for both streams to end.
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const optionNames = ["text", "mood", "priority", "type", "source", "key", "ttl", "detail", "voice", "slot", "file", "json", "user-data-dir"];

test("usage lists every option once with a one-line Korean description", () => {
  const lines = usageText().split("\n");
  for (const name of optionNames) {
    const linesFor = lines.filter((line) => line.trimStart().startsWith(`--${name} `));
    expect(linesFor.length, `option --${name} entry`).toBe(1);
    const described = (linesFor[0] ?? "").trim().replace(/^--[a-z-]+\s*(<[^>]*>)?/u, "").trim();
    expect(described.length, `option --${name} description`).toBeGreaterThan(0);
    expect(described, `option --${name} description is Korean`).toMatch(/[가-힣]/);
  }
});

// Windows workspace measurement: one CLI run took at most 0.1 s (help path only,
// no app connection); 5 s per case covers spawn overhead with wide margin.
test.each([
  ["--help"], ["-h"],
  ["event", "--help"], ["event", "-h"],
  ["status", "--help"], ["status", "-h"],
])("deskpet %s prints usage to stdout and exits 0", async (...args: string[]) => {
  const run = await runCli(args);
  expect(run.code).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain(usageText());
}, 5_000);

test("unknown options and misplaced --help still fail with the existing errors", async () => {
  const unknown = await runCli(["event", "--nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("알 수 없는 옵션: --nope");
  const misplaced = await runCli(["event", "--text", "--help"]);
  expect(misplaced.code).toBe(1);
  expect(misplaced.stderr).toContain("옵션 값이 없습니다: --text");
});

test.each([
  [["event", "--voice", "unknown"], "--voice"],
  [["event", "--voice", "deadlines"], "deadline, reminder, alert"],
  [["event", "--voice", "done", "--slot", "unknown=value"], "--slot"],
  [["event", "--slot", "task=value"], "--slot은 --voice"],
])("deskpet rejects invalid voice options before reading credentials", async (args, message) => {
  const run = await runCli(args);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(message);
});

test("deskpet event sends voice through HTTP to PetEvent validation", async () => {
  const token = "a".repeat(64);
  const root = await mkdtemp(join(workspaceRoot, ".voice-cli-test-"));
  let received: unknown;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    const validated = validatePetEvent(received);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/event");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    response.writeHead(validated.ok ? 202 : 400, { "Content-Type": "application/json" });
    response.end(JSON.stringify(validated.ok ? { accepted: true } : { errors: validated.errors }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Test server has no port");
    await writeFile(join(root, "event-server.json"), JSON.stringify({ port: address.port, token, pid: process.pid }));
    const run = await runCli(["event", "--user-data-dir", root, "--text", "fallback", "--voice", "done",
      "--slot", "task=Build", "--slot", "result=pass=ok"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(received).toEqual({ source: "cli", type: "notify", text: "fallback",
      voice: { kind: "done", slots: { task: "Build", result: "pass=ok" } } });
    for (const kind of ["deadline", "reminder", "alert"]) {
      const next = await runCli(["event", "--user-data-dir", root, "--text", "fallback", "--voice", kind, "--slot", "message=hi"]);
      expect(next.code).toBe(0);
      expect(received).toEqual({ source: "cli", type: "notify", text: "fallback", voice: { kind, slots: { message: "hi" } } });
    }
    const line = await runCli(["event", "--user-data-dir", root, "--source", "fixture", "--line", "fixture.done",
      "--var", "task=Build", "--var", "result=pass=ok", "--text", "fallback"]);
    expect(line.code).toBe(0);
    expect(received).toEqual({ source: "fixture", type: "notify", text: "fallback",
      line: { id: "fixture.done", vars: { task: "Build", result: "pass=ok" } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.each([[["event", "--var", "task=x"], "--var는 --line"],
  [["event", "--line", "fixture.done", "--var", "Task=x"], "--var 이름"],
  [["event", "--line", "fixture.done", "--var", "task=x", "--var", "task=y"], "중복 --var"]])(
  "deskpet rejects bad line variable arguments before reading credentials", async (args, message) => {
    const run = await runCli(args);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
  });
