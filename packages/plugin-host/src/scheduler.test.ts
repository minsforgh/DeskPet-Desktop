import { describe, expect, it } from "vitest";
import { Scheduler, type SchedulerTimer } from "./scheduler.js";

type FakeTimer = SchedulerTimer;

describe("scheduler", () => {
  it("keeps one armed timer, runs delayed every once, and re-bases on resume", async () => {
    const now = 0;
    const timers: FakeTimer[] = [];
    const results: string[] = [];
    const scheduler = new Scheduler({
      clock: () => new Date(now),
      setTimer: (fn, ms) => { const timer = { fn, at: now + ms, cancelled: false }; timers.push(timer); return timer; },
      clearTimer: (timer) => { (timer as FakeTimer).cancelled = true; },
      onResult: (result) => results.push(result.status),
    });
    let calls = 0;
    scheduler.scheduleEvery("p", 1000, async () => { calls += 1; });
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    scheduler.advanceForTest(3500);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(results).toEqual(["success"]);
    let resumed = 0;
    scheduler.onResume("p", () => { resumed += 1; });
    scheduler.resume();
    expect(resumed).toBe(1);
    scheduler.advanceForTest(999);
    expect(calls).toBe(1);
    scheduler.advanceForTest(1);
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it("idle resolves only after the callbacks started by advanceForTest have finished", async () => {
    const scheduler = new Scheduler({ clock: () => new Date(0), setTimer: (fn, ms) => ({ fn, at: ms, cancelled: false }), clearTimer: () => {} });
    let release: () => void = () => {};
    let finished = false;
    scheduler.scheduleEvery("p", 1000, () => new Promise<void>((resolve) => { release = () => { finished = true; resolve(); }; }));
    scheduler.advanceForTest(1000);
    let idle = false;
    const waiting = scheduler.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(finished).toBe(true);
    await scheduler.idle();
  });

  it("disposes idempotently and removes a plugin without affecting a later registration", () => {
    const scheduler = new Scheduler({ clock: () => new Date(0), setTimer: (fn) => ({ fn, at: 0, cancelled: false }), clearTimer: () => {} });
    const first = scheduler.scheduleEvery("old", 1000, async () => {});
    first.dispose();
    first.dispose();
    scheduler.disposePlugin("old");
    expect(() => scheduler.scheduleEvery("new", 1000, async () => {})).not.toThrow();
  });
});
