import { describe, expect, it } from "vitest";
import { CharacterAnimationMachine, DEFAULT_BEHAVIOR, resolveBehavior, validateBehavior, validateCharacterManifest } from "./index.js";
import type { CharacterManifest } from "./index.js";

const manifest: CharacterManifest = {
  id: "test", name: "Test", apiVersion: "1", cellSize: [32, 32], anchor: [16, 31], scale: 1,
  states: {
    idle: { sheet: "idle.png", frames: 4, fps: 10, loop: true },
    blink: { sheet: "blink.png", frames: 2, fps: 10, loop: false, next: "idle" },
    walk: { sheet: "walk.png", frames: 2, fps: 10, loop: true },
    sleep: { sheet: "sleep.png", frames: 2, fps: 2, loop: true },
    wave: { sheet: "wave.png", frames: 2, fps: 10, loop: false },
    drag: { sheet: "drag.png", frames: 2, fps: 10, loop: true },
  },
  fallbacks: { greet: "wave" },
};

function machine(pack = manifest, overrides: ConstructorParameters<typeof CharacterAnimationMachine>[1] = {}) {
  let now = 0;
  const player = new CharacterAnimationMachine(pack, {
    clock: () => now, random: () => 0.25,
    blinkIntervalMs: [100, 100], walkIntervalMs: [250, 250],
    walkDurationMs: 300, sleepAfterMs: 1_000, walkSpeedPxPerSecond: 42,
    ...overrides,
  });
  return { player, setTime: (time: number) => { now = time; } };
}

describe("character animation machine", () => {
  it("resolves defaults, pack behavior, and valid user overrides by key", () => {
    expect(resolveBehavior(undefined, undefined)).toEqual(DEFAULT_BEHAVIOR);
    const result = resolveBehavior(
      { sleepAfterMs: 40_000, blinkIntervalMs: [2_000, 4_000], walkDurationMs: 2_000 },
      { sleepAfterMs: 10_000, blinkIntervalMs: [4_000, 2_000], walkIntervalMs: [5_000, 6_000],
        walkDurationMs: 30_001, walkSpeedPxPerSecond: 0, future: true });
    expect(result).toEqual({ sleepAfterMs: 10_000, blinkIntervalMs: [2_000, 4_000],
      walkIntervalMs: [5_000, 6_000], walkDurationMs: 2_000, walkSpeedPxPerSecond: 0,
      climbChance: 0.4, descendChance: 0.5, jumpMaxHeight: 150, climbSpeed: 120, jumpClearance: 24, gravity: 2000,
      gapJumpDistance: 200, gapJumpChance: 0.5 });
    expect(resolveBehavior(null, { sleepAfterMs: "bad", unknown: 1 })).toEqual(DEFAULT_BEHAVIOR);
  });

  it("resolves climb and descend chances in 0-1 with decimals, rejecting values outside", () => {
    expect(resolveBehavior({ climbChance: 0.2 }, { descendChance: 1 })).toMatchObject({ climbChance: 0.2, descendChance: 1 });
    expect(resolveBehavior({ climbChance: 0 }, { climbChance: 1.01, descendChance: -0.1 }))
      .toMatchObject({ climbChance: 0, descendChance: 0.5 });
    expect(resolveBehavior({ climbChance: "0.2", descendChance: NaN }, undefined)).toMatchObject({ climbChance: 0.4, descendChance: 0.5 });
    expect(validateBehavior({ climbChance: 0, descendChance: 1 })).toEqual([]);
    expect(validateBehavior({ climbChance: 1.5, descendChance: "1" })).toHaveLength(2);
  });

  it("resolves jump, climb speed and gravity values inside their ranges only", () => {
    expect(resolveBehavior({ jumpMaxHeight: 0, climbSpeed: 20 }, { jumpClearance: 300, gravity: 10000 }))
      .toMatchObject({ jumpMaxHeight: 0, climbSpeed: 20, jumpClearance: 300, gravity: 10000 });
    expect(resolveBehavior({ jumpMaxHeight: 2001, climbSpeed: 19, gravity: 199 }, { jumpClearance: 301 }))
      .toMatchObject({ jumpMaxHeight: 150, climbSpeed: 120, jumpClearance: 24, gravity: 2000 });
    expect(validateBehavior({ jumpMaxHeight: 2000, climbSpeed: 1000, jumpClearance: 0, gravity: 200 })).toEqual([]);
    expect(validateBehavior({ jumpMaxHeight: -1, climbSpeed: 19, jumpClearance: 301, gravity: 10001 })).toHaveLength(4);
  });

  it("resolves the gap jump distance (0-1000) and chance (0-1) inside their ranges only", () => {
    expect(resolveBehavior({ gapJumpDistance: 0 }, { gapJumpChance: 1 })).toMatchObject({ gapJumpDistance: 0, gapJumpChance: 1 });
    expect(resolveBehavior({ gapJumpDistance: 1000, gapJumpChance: 0 }, undefined)).toMatchObject({ gapJumpDistance: 1000, gapJumpChance: 0 });
    expect(resolveBehavior({ gapJumpDistance: 1001, gapJumpChance: -0.1 }, { gapJumpChance: 1.1 }))
      .toMatchObject({ gapJumpDistance: 200, gapJumpChance: 0.5 });
    expect(validateBehavior({ gapJumpDistance: 1000, gapJumpChance: 0 })).toEqual([]);
    expect(validateBehavior({ gapJumpDistance: -1, gapJumpChance: 1.1 })).toHaveLength(2);
  });

  it("reschedules automatic activity without changing the state or quiet time", () => {
    let now = 0;
    const player = new CharacterAnimationMachine(manifest, { clock: () => now, random: () => 0,
      blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [20_000, 20_000], sleepAfterMs: 60_000 });
    now = 500;
    player.configure({ blinkIntervalMs: [1_000, 1_000], walkIntervalMs: [5_000, 5_000],
      sleepAfterMs: 6_000 }, now);
    expect(player.tick().state).toBe("idle");
    now = 1_499;
    expect(player.tick().state).toBe("idle");
    now = 1_500;
    expect(player.tick().state).toBe("blink");
    now = 1_700;
    expect(player.tick().state).toBe("idle");
    now = 6_000;
    expect(player.tick().state).toBe("sleep");

    let walkNow = 0;
    const walker = new CharacterAnimationMachine(manifest, { clock: () => walkNow, random: () => 0,
      blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [20_000, 20_000], sleepAfterMs: 60_000 });
    walkNow = 500;
    walker.configure({ blinkIntervalMs: [60_000, 60_000], walkIntervalMs: [5_000, 5_000] }, walkNow);
    walkNow = 5_499;
    expect(walker.tick().state).toBe("idle");
    walkNow = 5_500;
    expect(walker.tick().state).toBe("walk");
  });

  it("preserves an active walk and its speed while applying duration and future speed", () => {
    let now = 0;
    const player = new CharacterAnimationMachine(manifest, { clock: () => now, random: () => 0,
      blinkIntervalMs: [60_000, 60_000], walkIntervalMs: [5_000, 5_000],
      walkDurationMs: 3_000, sleepAfterMs: 60_000, walkSpeedPxPerSecond: 30 });
    player.request("walk", 0);
    now = 500;
    player.configure({ walkDurationMs: 1_000, walkSpeedPxPerSecond: 60,
      walkIntervalMs: [5_000, 5_000] }, now);
    expect(player.tick()).toMatchObject({ state: "walk", movement: { speedPxPerSecond: 30 }, walkStartedMs: 0 });
    now = 1_000;
    expect(player.tick().state).toBe("idle");
    now = 5_500;
    expect(player.tick()).toMatchObject({ state: "walk", movement: { speedPxPerSecond: 60 } });
  });
  it("advances frames with the injected clock and loops idle", () => {
    const { player, setTime } = machine();
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
    setTime(99);
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
    // Disable automatic activity to isolate frame timing.
    const slow = machine(manifest, { blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [10_000, 10_000] });
    slow.setTime(100);
    expect(slow.player.tick()).toMatchObject({ state: "idle", frame: 1 });
    slow.setTime(400);
    expect(slow.player.tick()).toMatchObject({ state: "idle", frame: 0 });
  });

  it("holds the final non-loop frame, then follows next or idle", () => {
    const { player, setTime } = machine(manifest, { blinkIntervalMs: [10_000, 10_000] });
    player.request("blink");
    setTime(199);
    expect(player.tick()).toMatchObject({ state: "blink", frame: 1 });
    setTime(200);
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
    player.request("wave");
    setTime(400);
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
  });

  it("holds a non-looping reaction at its last frame until release resets quiet time", () => {
    const { player, setTime } = machine(manifest, {
      blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [10_000, 10_000], sleepAfterMs: 1_000,
    });
    player.request("wave", 0, { hold: true });
    setTime(2_000);
    expect(player.tick()).toMatchObject({ state: "wave", frame: 1 });
    player.release();
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
    setTime(2_999);
    expect(player.tick().state).toBe("idle");
    setTime(3_000);
    expect(player.tick().state).toBe("sleep");
  });

  it("keeps looping a held state and lets a new request interrupt it", () => {
    const { player, setTime } = machine(manifest, {
      blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [10_000, 10_000], sleepAfterMs: 1_000,
    });
    player.request("walk", 0, { hold: true });
    setTime(1_050);
    expect(player.tick()).toMatchObject({ state: "walk", frame: 0 });
    player.request("wave");
    setTime(1_250);
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
  });

  it("resolves direct fallbacks and unknown requests, and rejects invalid chains", () => {
    const { player } = machine(manifest);
    player.request("greet");
    expect(player.tick()).toMatchObject({ state: "wave" });
    player.request("missing");
    expect(player.tick()).toMatchObject({ state: "idle" });
    // Validation forbids dangling fallback values; the player still terminates on malformed input.
    const chained = { ...manifest, fallbacks: { first: "second", second: "wave", a: "b", b: "a" } };
    expect(validateCharacterManifest(chained).ok).toBe(false);
    expect(() => machine(chained)).toThrow(/Invalid character manifest/);
  });

  it("rejects zero frames before playback", () => {
    const idle = manifest.states.idle;
    if (!idle) throw new Error("test manifest requires idle");
    const invalid = { ...manifest, states: { ...manifest.states, idle: { ...idle, frames: 0 } } };
    expect(() => machine(invalid)).toThrow(/frames/);
  });

  it("clamps a clock moved backward and resolves the longest allowed next chain", () => {
    const slow = machine(manifest, { blinkIntervalMs: [10_000, 10_000], walkIntervalMs: [10_000, 10_000] });
    slow.setTime(300);
    expect(slow.player.tick().frame).toBe(3);
    slow.setTime(100);
    expect(slow.player.tick().frame).toBe(1);
    const idle = manifest.states.idle;
    if (!idle) throw new Error("test manifest requires idle");
    const states: CharacterManifest["states"] = { idle };
    for (let index = 0; index < 31; index += 1)
      states[`n${index}`] = { sheet: `n${index}.png`, frames: 1, fps: 1, loop: false,
        next: index < 30 ? `n${index + 1}` : "idle" };
    const chain = machine({ ...manifest, states, fallbacks: {} }, { blinkIntervalMs: [2_000_000, 2_000_000],
      walkIntervalMs: [2_000_000, 2_000_000], sleepAfterMs: 2_000_000 });
    chain.player.request("n0");
    chain.setTime(1_100_000);
    expect(chain.player.tick().state).toBe("idle");
  });

  it("automatically visits blink, walk with movement, then sleep after quiet", () => {
    const { player, setTime } = machine();
    setTime(100);
    expect(player.tick()).toMatchObject({ state: "blink", frame: 0 });
    setTime(300);
    expect(player.tick()).toMatchObject({ state: "walk", movement: { direction: "left", speedPxPerSecond: 42 } });
    setTime(600);
    expect(player.tick().state).toBe("blink");
    setTime(1_000);
    expect(player.tick()).toMatchObject({ state: "sleep", frame: 0, movement: null });
    player.request("idle");
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
  });

  it("skips optional automatic states absent from the pack", () => {
    const idle = manifest.states.idle;
    if (!idle) throw new Error("test manifest requires idle");
    const { player, setTime } = machine({ ...manifest, states: { idle }, fallbacks: {} });
    setTime(10_000);
    expect(player.tick()).toMatchObject({ state: "idle", movement: null });
  });

  it("uses injected randomness to vary automatic intervals", () => {
    const { player, setTime } = machine(manifest, {
      random: () => 0.5,
      blinkIntervalMs: [100, 200],
      walkIntervalMs: [10_000, 10_000],
    });
    setTime(149);
    expect(player.tick().state).toBe("idle");
    setTime(150);
    expect(player.tick().state).toBe("blink");
  });

  it("enters drag when present and returns to idle on release", () => {
    const { player, setTime } = machine();
    player.startDrag();
    setTime(100);
    expect(player.tick()).toMatchObject({ state: "drag", frame: 1 });
    player.request("wave");
    expect(player.tick().state).toBe("drag");
    player.endDrag();
    expect(player.tick()).toMatchObject({ state: "idle", frame: 0 });
  });

  it("stays idle during drag when the pack has no drag state", () => {
    const states = { ...manifest.states };
    delete states.drag;
    const { player, setTime } = machine({ ...manifest, states });
    player.startDrag();
    setTime(500);
    expect(player.tick()).toMatchObject({ state: "idle", movement: null });
    player.endDrag();
    expect(player.tick().state).toBe("idle");
  });
});
