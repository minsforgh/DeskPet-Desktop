import { nextCronOccurrence, parseCron, type CronSchedule } from "./cron.js";
import type { Disposable } from "@deskpet/plugin-sdk";

export interface SchedulerTimer { fn: () => void; at: number; cancelled: boolean; }
type Timer = ReturnType<typeof setTimeout> | SchedulerTimer;
type AsyncCallback = () => Promise<void>;

export type ScheduleResult = {
  pluginId: string;
  scheduleId: number;
  status: "success" | "failure" | "timeout";
  error?: unknown;
};

export interface SchedulerOptions {
  clock?: () => Date;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  callbackTimeoutMs?: number;
  onResult?: (result: ScheduleResult) => void;
}

interface Entry {
  id: number;
  pluginId: string;
  kind: "at" | "every";
  callback: AsyncCallback;
  cron?: CronSchedule;
  intervalMs?: number;
  next: number;
  running: boolean;
  disposed: boolean;
}

interface ResumeEntry {
  id: number;
  pluginId: string;
  callback: () => void;
  disposed: boolean;
}

export class Scheduler {
  private readonly entries = new Map<number, Entry>();
  private readonly resumes = new Map<number, ResumeEntry>();
  private timer: Timer | undefined;
  private nextId = 1;
  private offsetMs = 0;
  private readonly running = new Set<Promise<void>>();
  private readonly clock: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly callbackTimeoutMs: number;
  private readonly onResult?: (result: ScheduleResult) => void;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000;
    this.onResult = options.onResult;
  }

  private now(): Date { return new Date(this.clock().getTime() + this.offsetMs); }

  private arm(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    const next = [...this.entries.values()].filter((entry) => !entry.disposed).map((entry) => entry.next).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.fireDue();
    }, Math.max(0, next - this.now().getTime()));
  }

  private report(entry: Entry, status: ScheduleResult["status"], error?: unknown): void {
    this.onResult?.({ pluginId: entry.pluginId, scheduleId: entry.id, status, ...(error === undefined ? {} : { error }) });
  }

  private async run(entry: Entry): Promise<void> {
    if (entry.running || entry.disposed) return;
    entry.running = true;
    let timeout: Timer | undefined;
    try {
      const callback = entry.callback();
      await new Promise<void>((resolve, reject) => {
        timeout = this.setTimer(() => reject(new Error("schedule callback timed out")), this.callbackTimeoutMs);
        callback.then(resolve, reject);
      });
      this.report(entry, "success");
    } catch (error: unknown) {
      this.report(entry, error instanceof Error && error.message === "schedule callback timed out" ? "timeout" : "failure", error);
    } finally {
      if (timeout !== undefined) this.clearTimer(timeout);
      entry.running = false;
    }
  }

  private fireDue(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.disposed || entry.next > now.getTime()) continue;
      if (entry.kind === "at" && entry.cron !== undefined) entry.next = nextCronOccurrence(entry.cron, now).getTime();
      else entry.next += entry.intervalMs ?? 0;
      const run = this.run(entry);
      this.running.add(run);
      void run.finally(() => this.running.delete(run));
    }
    this.arm();
  }

  /** Resolves when every callback started so far has finished; tests and dev control wait on this after advancing the clock. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  scheduleAt(pluginId: string, cron: string, callback: AsyncCallback, opts?: { tz?: string }): Disposable {
    const parsed = parseCron(cron, opts?.tz);
    const entry: Entry = { id: this.nextId++, pluginId, kind: "at", callback, cron: parsed, next: nextCronOccurrence(parsed, this.now()).getTime(), running: false, disposed: false };
    this.entries.set(entry.id, entry);
    this.arm();
    return this.disposable(() => {
      if (entry.disposed) return;
      entry.disposed = true;
      this.entries.delete(entry.id);
      this.arm();
    });
  }

  scheduleEvery(pluginId: string, ms: number, callback: AsyncCallback): Disposable {
    if (!Number.isSafeInteger(ms) || ms < 1_000) throw new Error("schedule.every requires an integer of at least 1000ms");
    const entry: Entry = { id: this.nextId++, pluginId, kind: "every", callback, intervalMs: ms, next: this.now().getTime() + ms, running: false, disposed: false };
    this.entries.set(entry.id, entry);
    this.arm();
    return this.disposable(() => {
      if (entry.disposed) return;
      entry.disposed = true;
      this.entries.delete(entry.id);
      this.arm();
    });
  }

  onResume(pluginId: string, callback: () => void): Disposable {
    const entry: ResumeEntry = { id: this.nextId++, pluginId, callback, disposed: false };
    this.resumes.set(entry.id, entry);
    return this.disposable(() => {
      if (entry.disposed) return;
      entry.disposed = true;
      this.resumes.delete(entry.id);
    });
  }

  resume(): void {
    for (const entry of this.resumes.values()) if (!entry.disposed) entry.callback();
    const now = this.now().getTime();
    for (const entry of this.entries.values()) {
      if (entry.kind === "every" && !entry.disposed) entry.next = now + (entry.intervalMs ?? 0);
    }
    this.arm();
  }

  disposePlugin(pluginId: string): void {
    for (const entry of this.entries.values()) if (entry.pluginId === pluginId) entry.disposed = true;
    for (const entry of this.resumes.values()) if (entry.pluginId === pluginId) entry.disposed = true;
    for (const [id, entry] of this.entries) if (entry.disposed) this.entries.delete(id);
    for (const [id, entry] of this.resumes) if (entry.disposed) this.resumes.delete(id);
    this.arm();
  }

  advanceForTest(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("advanceForTest requires a non-negative integer");
    this.offsetMs += ms;
    this.fireDue();
  }

  setTimeForTest(atMs: number): void {
    if (!Number.isSafeInteger(atMs)) throw new Error("setTimeForTest requires an integer timestamp");
    this.offsetMs = atMs - this.clock().getTime();
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.kind === "at" && entry.cron !== undefined) entry.next = nextCronOccurrence(entry.cron, now).getTime();
      else if (entry.kind === "every") entry.next = now.getTime() + (entry.intervalMs ?? 0);
    }
    this.arm();
  }

  private disposable(dispose: () => void): Disposable { return { dispose }; }
}

export function createScheduler(options?: SchedulerOptions): Scheduler { return new Scheduler(options); }
