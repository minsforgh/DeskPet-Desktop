export interface SequencePlaybackStep {
  play: string;
  ms?: number;
  /** Duration of one resolved state cycle, supplied by the caller. */
  cycleMs: number;
  say?: string;
}

export type SequenceEvent =
  | { type: "start"; atMs: number; play: string; say?: string; durationMs: number }
  | { type: "end"; atMs: number; play: "idle" };

/** Computes due transitions without reading a clock or scheduling timers. */
export class SequencePlayer {
  private events: SequenceEvent[] = [];
  private next = 0;

  start(steps: readonly SequencePlaybackStep[], startMs: number): void {
    this.stop();
    if (!Number.isFinite(startMs) || steps.length === 0) return;
    let elapsed = 0;
    for (const step of steps) {
      if (elapsed >= 30_000) break;
      const cycleMs = Number.isFinite(step.cycleMs) ? Math.max(300, step.cycleMs) : 300;
      const durationMs = Math.min(step.ms ?? cycleMs, 30_000 - elapsed);
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      this.events.push({ type: "start", atMs: startMs + elapsed, play: step.play,
        ...(step.say !== undefined ? { say: step.say } : {}), durationMs });
      elapsed += durationMs;
    }
    if (elapsed > 0) this.events.push({ type: "end", atMs: startMs + elapsed, play: "idle" });
  }

  tick(nowMs: number): SequenceEvent[] {
    const due: SequenceEvent[] = [];
    while (this.next < this.events.length) {
      const event = this.events[this.next];
      if (event === undefined || event.atMs > nowMs) break;
      due.push(event);
      this.next += 1;
    }
    return due;
  }

  stop(): void {
    this.events = [];
    this.next = 0;
  }

  get active(): boolean {
    return this.next < this.events.length;
  }
}
