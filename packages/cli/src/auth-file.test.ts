import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { AUTH_RETRY_ATTEMPTS, AUTH_RETRY_INTERVAL_MS, judgeAuthFile, readAuthFile } from "./auth-file.js";

const token = "a".repeat(64);
const pid = process.pid;
const root = await mkdtemp(join(tmpdir(), "deskpet-cli-auth-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("accepts a file with a valid port and token", () => {
  expect(judgeAuthFile(JSON.stringify({ port: 7777, token, pid }))).toEqual({ ok: true, credentials: { port: 7777, token, pid } });
  expect(judgeAuthFile(JSON.stringify({ port: 1, token, pid })).ok).toBe(true);
  expect(judgeAuthFile(JSON.stringify({ port: 65535, token, pid })).ok).toBe(true);
});

test("rejects a missing, broken, or incomplete file with a one-line message", () => {
  const bad: [string | undefined, string][] = [
    [undefined, "토큰 파일이 없습니다"],
    ["not json", "JSON이 아닙니다"],
    ["[]", "형식이 잘못"],
    [JSON.stringify({ token }), "열리지 않았습니다"],
    [JSON.stringify({ port: 0, token, pid }), "1~65535"],
    [JSON.stringify({ port: 65536, token, pid }), "1~65535"],
    [JSON.stringify({ port: -1, token, pid }), "1~65535"],
    [JSON.stringify({ port: 80.5, token, pid }), "1~65535"],
    [JSON.stringify({ port: "7777", token, pid }), "1~65535"],
    [JSON.stringify({ port: 7777 }), "token이 없습니다"],
    [JSON.stringify({ port: 7777, token: "" }), "token이 없습니다"],
    [JSON.stringify({ port: 7777, token }), "pid가 유효하지"],
  ];
  for (const [text, expected] of bad) {
    const result = judgeAuthFile(text);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.message).toContain(expected); expect(result.message).not.toContain("\n"); }
  }
});

test("retries through an injected read and wait, then gives up", async () => {
  expect(AUTH_RETRY_INTERVAL_MS * AUTH_RETRY_ATTEMPTS).toBeLessThanOrEqual(2000);
  const path = join(root, "late.json");
  let reads = 0;
  expect(await readAuthFile(path, { attempts: 3,
    readText: async () => ++reads < 2 ? "" : JSON.stringify({ port: 4321, token, pid }),
    wait: async () => undefined })).toEqual({ port: 4321, token, pid });
  expect(reads).toBe(2);
  await expect(readAuthFile(join(root, "never.json"), { intervalMs: 1, attempts: 3 })).rejects.toThrow("토큰 파일이 없습니다");
  const noPort = join(root, "no-port.json");
  await writeFile(noPort, JSON.stringify({ token }));
  await expect(readAuthFile(noPort, { intervalMs: 1, attempts: 3 })).rejects.toThrow("열리지 않았습니다");
});

test("rejects a dead pid before returning credentials", async () => {
  const path = join(root, "dead.json");
  await writeFile(path, JSON.stringify({ port: 4321, token, pid: 2147483647 }));
  await expect(readAuthFile(path, { attempts: 1 })).rejects.toThrow("실행 중이지 않습니다");
});
