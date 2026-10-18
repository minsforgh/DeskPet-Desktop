import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acquireE2eRunLock } from "./e2e-run-lock.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

async function lockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deskpet-lock-unit-"));
  paths.push(directory);
  return join(directory, "e2e.lock");
}

test("acquires and releases a lock with owner PID, start, and worktree", async () => {
  const path = await lockPath();
  const release = await acquireE2eRunLock({ path, pid: process.pid, cwd: "worktree-one", now: () => 1000 });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, startedAt: 1000, cwd: "worktree-one" });
  await release();
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("waits with the owner location until the first run releases", async () => {
  const path = await lockPath();
  const releaseFirst = await acquireE2eRunLock({ path, pid: process.pid, cwd: "first-worktree", now: () => 1000 });
  const messages: string[] = [];
  let resume: (() => void) | undefined;
  let startedWaiting: (() => void) | undefined;
  const waiting = new Promise<void>((resolveWaiting) => { startedWaiting = resolveWaiting; });
  const second = acquireE2eRunLock({ path, pid: process.pid, cwd: "second-worktree", now: () => 4000,
    report: (message) => { messages.push(message); startedWaiting?.(); },
    wait: () => new Promise<void>((resolveWait) => { resume = resolveWait; }) });
  await waiting;
  expect(messages[0]).toContain("first-worktree, PID");
  expect(messages[0]).toContain("경과 3초");
  await releaseFirst();
  resume?.();
  const releaseSecond = await second;
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ cwd: "second-worktree" });
  await releaseSecond();
});

test("reclaims a lock whose owner PID has died", async () => {
  const path = await lockPath();
  await acquireE2eRunLock({ path, pid: 765432, cwd: "dead-worktree", now: () => 1000 });
  const release = await acquireE2eRunLock({ path, pid: process.pid, cwd: "live-worktree", isAlive: () => false });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ cwd: "live-worktree" });
  await release();
});

test("only one simultaneous contender acquires the path", async () => {
  const path = await lockPath();
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => acquireE2eRunLock({
    path, pid: process.pid, cwd: `contender-${index}`, wait: async () => { throw new Error("held"); }, report: () => {},
  })));
  const winners = outcomes.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  await winners[0]?.value();
});

test("simultaneous stale-lock reclaim still grants one owner", async () => {
  const path = await lockPath();
  await acquireE2eRunLock({ path, pid: 765432, cwd: "dead-worktree" });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => acquireE2eRunLock({
    path, pid: process.pid, cwd: `reclaimer-${index}`, wait: async () => { throw new Error("held"); }, report: () => {},
  })));
  const winners = outcomes.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  await winners[0]?.value();
});
