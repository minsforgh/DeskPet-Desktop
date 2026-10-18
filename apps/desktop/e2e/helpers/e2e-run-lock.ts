import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_LOCK_PATH = join(tmpdir(), "deskpet-e2e-run.lock");
export const E2E_TIMINGS_PATH = join(tmpdir(), "deskpet-e2e-control-timings.jsonl");

type Owner = { pid: number; startedAt: number; cwd: string; nonce: string };
type LockOptions = {
  path?: string;
  pid?: number;
  cwd?: string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  wait?: () => Promise<void>;
  report?: (message: string) => void;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const ownerOf = (value: unknown): Owner | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const owner = value as Partial<Owner>;
  return Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
    typeof owner.startedAt === "number" && Number.isFinite(owner.startedAt) &&
    typeof owner.cwd === "string" && typeof owner.nonce === "string"
    ? owner as Owner : undefined;
};

const readOwner = async (path: string): Promise<Owner | undefined> => {
  try { return ownerOf(JSON.parse(await readFile(path, "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
};

/** Every worktree links a complete temp file to one shared path; link fails atomically if another run owns it. */
export async function acquireE2eRunLock(options: LockOptions = {}): Promise<() => Promise<void>> {
  const path = options.path ?? E2E_LOCK_PATH;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? alive;
  // Single-suite measurements took 390–479 s; a 1 s poll adds at most 1 s to the next run.
  const wait = options.wait ?? (() => new Promise<void>((resolveWait) => setTimeout(resolveWait, 1000)));
  const report = options.report ?? console.info;
  const owner: Owner = { pid: options.pid ?? process.pid, startedAt: now(), cwd: options.cwd ?? process.cwd(), nonce: randomUUID() };
  const temp = `${path}.${owner.pid}.${owner.nonce}.tmp`;
  const reclaimPath = `${path}.reclaim`;
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  await writeFile(temp, JSON.stringify(owner));
  try {
    for (;;) {
      try { await link(temp, path); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const current = await readOwner(path);
      if (current && !isAlive(current.pid)) {
        let reclaiming = false;
        try { await link(temp, reclaimPath); reclaiming = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (reclaiming) {
          try {
            // One reaper at a time may unlink; a contender cannot remove a lock another reaper just acquired.
            const latest = await readOwner(path);
            if (latest?.nonce === current.nonce && !isAlive(latest.pid)) {
              try { await unlink(path); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
          } finally { await unlink(reclaimPath); }
        } else {
          const reaper = await readOwner(reclaimPath);
          if (reaper && !isAlive(reaper.pid)) {
            try { await unlink(reclaimPath); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          await wait();
        }
        continue;
      }
      // Observed full runs lasted 390–479 s; a 10 s report interval keeps a long queue visible without ~479 lines.
      if (now() - lastReportedAt >= 10_000) {
        report(`다른 e2e 실행 대기 중: ${current?.cwd ?? "소유자 확인 중"}, PID ${current?.pid ?? "?"}, 경과 ${current ? Math.max(0, Math.floor((now() - current.startedAt) / 1000)) : "?"}초`);
        lastReportedAt = now();
      }
      await wait();
    }
  } finally { await unlink(temp); }
  return async () => {
    if ((await readOwner(path))?.nonce === owner.nonce) await unlink(path);
  };
}

export async function setup(): Promise<() => Promise<void>> {
  const release = await acquireE2eRunLock();
  try { await writeFile(E2E_TIMINGS_PATH, ""); }
  catch (error) { await release(); throw error; }
  return async () => {
    try {
      const lines = (await readFile(E2E_TIMINGS_PATH, "utf8")).trim().split("\n").filter(Boolean);
      const maxima = new Map<string, number>();
      for (const line of lines) {
        const row = JSON.parse(line) as Record<string, number>;
        for (const [command, duration] of Object.entries(row))
          maxima.set(command, Math.max(maxima.get(command) ?? 0, duration));
      }
      console.info(`[e2e control] 성공 요청 명령별 최대 소요: ${[...maxima].sort(([left], [right]) => left.localeCompare(right))
        .map(([command, duration]) => `${command}=${duration}ms`).join(", ") || "없음"}`);
    } finally {
      await unlink(E2E_TIMINGS_PATH).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await release();
    }
  };
}
