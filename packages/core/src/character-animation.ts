import type { CharacterManifest } from "./contracts.js";
import { validateCharacterManifest } from "./validate.js";
import { DEFAULT_BEHAVIOR } from "./behavior.js";

export interface WalkMovement {
  direction: "left" | "right";
  speedPxPerSecond: number;
}

export interface AnimationSnapshot {
  state: string;
  frame: number;
  movement: WalkMovement | null;
  walkStartedMs?: number;
}

export interface CharacterAnimationOptions {
  clock?: () => number;
  random?: () => number;
  blinkIntervalMs?: readonly [number, number];
  walkIntervalMs?: readonly [number, number];
  walkDurationMs?: number;
  sleepAfterMs?: number;
  walkSpeedPxPerSecond?: number;
}

/** A clock-driven player for a validated character manifest. */
export class CharacterAnimationMachine {
  private readonly clock: () => number;
  private readonly random: () => number;
  private blinkIntervalMs: readonly [number, number];
  private walkIntervalMs: readonly [number, number];
  private walkDurationMs: number;
  private sleepAfterMs: number;
  private walkSpeedPxPerSecond: number;
  private state = "idle";
  private stateStartedMs: number;
  private quietSinceMs: number;
  private nextBlinkMs: number;
  private nextWalkMs: number;
  private dragging = false;
  private held = false;
  private movement: WalkMovement | null = null;

  constructor(private readonly manifest: CharacterManifest, options: CharacterAnimationOptions = {}) {
    const validation = validateCharacterManifest(manifest);
    if (!validation.ok) throw new Error(`Invalid character manifest: ${validation.errors.join("; ")}`);
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.blinkIntervalMs = options.blinkIntervalMs ?? DEFAULT_BEHAVIOR.blinkIntervalMs;
    this.walkIntervalMs = options.walkIntervalMs ?? DEFAULT_BEHAVIOR.walkIntervalMs;
    this.walkDurationMs = options.walkDurationMs ?? DEFAULT_BEHAVIOR.walkDurationMs;
    this.sleepAfterMs = options.sleepAfterMs ?? DEFAULT_BEHAVIOR.sleepAfterMs;
    this.walkSpeedPxPerSecond = options.walkSpeedPxPerSecond ?? DEFAULT_BEHAVIOR.walkSpeedPxPerSecond;
    this.stateStartedMs = this.clock();
    this.quietSinceMs = this.stateStartedMs;
    this.nextBlinkMs = this.schedule(this.stateStartedMs, this.blinkIntervalMs);
    this.nextWalkMs = this.schedule(this.stateStartedMs, this.walkIntervalMs);
  }

  private schedule(fromMs: number, range: readonly [number, number]): number {
    return fromMs + range[0] + this.random() * (range[1] - range[0]);
  }

  private hasState(name: string): boolean {
    return Object.hasOwn(this.manifest.states, name);
  }

  private resolve(name: string): string {
    const visited = new Set<string>();
    let current = name;
    while (!visited.has(current)) {
      if (this.hasState(current)) return current;
      visited.add(current);
      if (!Object.hasOwn(this.manifest.fallbacks, current)) break;
      const fallback = this.manifest.fallbacks[current];
      if (typeof fallback !== "string") break;
      current = fallback;
    }
    return "idle";
  }

  private enter(name: string, atMs: number): void {
    this.state = name;
    this.stateStartedMs = atMs;
    this.movement = name === "walk"
      ? { direction: this.random() < 0.5 ? "left" : "right", speedPxPerSecond: this.walkSpeedPxPerSecond }
      : null;
  }

  private resetAutomaticTimers(atMs: number): void {
    this.nextBlinkMs = this.schedule(atMs, this.blinkIntervalMs);
    this.nextWalkMs = this.schedule(atMs, this.walkIntervalMs);
  }

  configure(options: CharacterAnimationOptions, nowMs = this.clock()): void {
    this.blinkIntervalMs = options.blinkIntervalMs ?? this.blinkIntervalMs;
    this.walkIntervalMs = options.walkIntervalMs ?? this.walkIntervalMs;
    this.walkDurationMs = options.walkDurationMs ?? this.walkDurationMs;
    this.sleepAfterMs = options.sleepAfterMs ?? this.sleepAfterMs;
    this.walkSpeedPxPerSecond = options.walkSpeedPxPerSecond ?? this.walkSpeedPxPerSecond;
    this.resetAutomaticTimers(nowMs);
  }

  private currentState() {
    const state = this.manifest.states[this.state];
    if (!state) throw new Error(`Unknown animation state: ${this.state}`);
    return state;
  }

  request(stateName: string, nowMs = this.clock(), options: { hold?: boolean } = {}): void {
    if (this.dragging) return;
    this.held = options.hold === true;
    this.quietSinceMs = nowMs;
    this.enter(this.resolve(stateName), nowMs);
    this.resetAutomaticTimers(nowMs);
  }

  release(nowMs = this.clock()): void {
    if (!this.held) return;
    this.held = false;
    this.quietSinceMs = nowMs;
    this.enter("idle", nowMs);
    this.resetAutomaticTimers(nowMs);
  }

  startDrag(nowMs = this.clock()): void {
    this.dragging = true;
    this.held = false;
    this.quietSinceMs = nowMs;
    this.enter(this.hasState("drag") ? "drag" : "idle", nowMs);
  }

  endDrag(nowMs = this.clock()): void {
    this.dragging = false;
    this.held = false;
    this.quietSinceMs = nowMs;
    this.enter("idle", nowMs);
    this.resetAutomaticTimers(nowMs);
  }

  tick(nowMs = this.clock()): AnimationSnapshot {
    // A non-looping animation owns its last frame until its full duration elapses.
    // Process chained `next` transitions at their actual completion times.
    for (let transitions = 0; transitions < 1_000 && !this.dragging && !this.held; transitions += 1) {
      const state = this.currentState();
      const durationMs = state.frames * 1_000 / state.fps;
      const elapsedMs = Math.max(0, nowMs - this.stateStartedMs);
      if (this.state === "walk" && elapsedMs >= this.walkDurationMs) {
        this.enter("idle", this.stateStartedMs + this.walkDurationMs);
      } else if (!state.loop && elapsedMs >= durationMs) {
        this.enter(state.next ?? "idle", this.stateStartedMs + durationMs);
      } else {
        break;
      }
    }

    if (!this.dragging && !this.held && this.state === "idle") {
      if (nowMs - this.quietSinceMs >= this.sleepAfterMs && this.hasState("sleep")) {
        this.enter("sleep", nowMs);
      } else {
        const blinkDue = this.hasState("blink") ? this.nextBlinkMs : Infinity;
        const walkDue = this.hasState("walk") ? this.nextWalkMs : Infinity;
        if (blinkDue <= nowMs || walkDue <= nowMs) {
          if (walkDue <= nowMs) {
            this.nextWalkMs = this.schedule(nowMs + this.walkDurationMs, this.walkIntervalMs);
            this.enter("walk", nowMs);
          } else {
            this.nextBlinkMs = this.schedule(nowMs, this.blinkIntervalMs);
            this.enter("blink", nowMs);
          }
        }
      }
    }

    const state = this.currentState();
    const elapsedMs = Math.max(0, nowMs - this.stateStartedMs);
    const elapsedFrames = Math.floor(elapsedMs * state.fps / 1_000);
    const frame = state.loop ? elapsedFrames % state.frames : Math.min(state.frames - 1, elapsedFrames);
    return { state: this.state, frame, movement: this.movement,
      ...(this.state === "walk" ? { walkStartedMs: this.stateStartedMs } : {}) };
  }
}
