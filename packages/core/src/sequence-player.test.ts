import { describe, expect, it } from "vitest";
import { SequencePlayer } from "./index.js";

describe("M7 sequence scheduler", () => {
  it("emits starts and idle at exact boundaries and catches up when ticks are late", () => {
    const player = new SequencePlayer();
    player.start([{ play: "bow", ms: 500, cycleMs: 1000, say: "안녕" },
      { play: "happy", cycleMs: 700 }], 100);
    expect(player.tick(99)).toEqual([]);
    expect(player.tick(100)).toEqual([{ type: "start", atMs: 100, play: "bow", say: "안녕", durationMs: 500 }]);
    expect(player.tick(599)).toEqual([]);
    expect(player.tick(600)).toEqual([{ type: "start", atMs: 600, play: "happy", durationMs: 700 }]);
    expect(player.tick(1300)).toEqual([{ type: "end", atMs: 1300, play: "idle" }]);
    expect(player.tick(2000)).toEqual([]);
    expect(player.active).toBe(false);
  });

  it("uses at least 300ms for an omitted duration and truncates after 30000ms", () => {
    const player = new SequencePlayer();
    player.start([{ play: "a", cycleMs: 10 }, { play: "b", cycleMs: 5000, ms: 10_000 },
      { play: "c", cycleMs: 5000, ms: 10_000 }, { play: "d", cycleMs: 5000, ms: 10_000 },
      { play: "e", cycleMs: 5000, ms: 10_000 }], 50);
    expect(player.tick(30_050)).toEqual([
      { type: "start", atMs: 50, play: "a", durationMs: 300 },
      { type: "start", atMs: 350, play: "b", durationMs: 10_000 },
      { type: "start", atMs: 10_350, play: "c", durationMs: 10_000 },
      { type: "start", atMs: 20_350, play: "d", durationMs: 9_700 },
      { type: "end", atMs: 30_050, play: "idle" },
    ]);
  });

  it("stops immediately and allows a new sequence to start", () => {
    const player = new SequencePlayer();
    player.start([{ play: "bow", ms: 1000, cycleMs: 1000 }], 0);
    expect(player.tick(0)).toHaveLength(1);
    player.stop();
    expect(player.active).toBe(false);
    expect(player.tick(1000)).toEqual([]);
    player.start([{ play: "happy", cycleMs: 400 }], 2000);
    expect(player.tick(2400)).toEqual([
      { type: "start", atMs: 2000, play: "happy", durationMs: 400 },
      { type: "end", atMs: 2400, play: "idle" },
    ]);
  });
});
