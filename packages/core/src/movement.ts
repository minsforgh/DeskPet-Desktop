import { BEHAVIOR_RANGES } from "./behavior.js";
import { displayUnionBounds, findCrossedPlatform, findStandingPlatform, floorAtX, isWallSideVisible } from "./terrain.js";
import type { TerrainDisplay, TerrainPlatform, TerrainPoint, TerrainWall } from "./terrain.js";

export const MOVEMENT_PHYSICS = {
  gravity: 2_000,
  terminalSpeed: 1_800,
  maxThrowSpeed: 2_200,
  stillSpeed: 80,
  floorPassSpeed: 1_500,
  stepMs: 16,
  dragWindowMs: 100,
  dragSamples: 8,
  climbReadyMs: 400,
  climbSpeed: 120,
  jumpMaxHeight: 150,
  jumpClearance: 24,
  gapJumpDistance: 200,
  gapJumpChance: 0.5,
  normalLandingMs: 300,
  softLandingMs: 400,
  climbChance: 0.5,
  descendChance: 0.5,
  hopRise: 12,
  wallTolerance: 2,
} as const;

export const DEFAULT_MOVEMENT_FALLBACKS: Readonly<Record<string, string>> = {
  "climb-ready": "surprised", climb: "walk", descend: "walk",
  fall: "drag", land: "idle", thrown: "fall",
  jump: "happy", "hop-down": "fall", "climb-down": "climb",
};

export type MovementState = "grounded" | "climb-ready" | "climbing" | "jumping" | "hop-down" |
  "climbing-down" | "descending" | "falling" | "landing" | "thrown" | "dragging";
export type WalkDirection = "left" | "right";
export type MovementVelocity = { x: number; y: number };
export type MovementSnapshot = {
  foot: TerrainPoint;
  state: MovementState;
  request: "climb-ready" | "climb" | "jump" | "hop-down" | "climb-down" | "descend" | "fall" | "land" |
    "thrown" | "drag" | null;
  reverseWalk: boolean;
  standingPlatformId: string | null;
  velocity: MovementVelocity;
};
export type MovementOptions = {
  foot: TerrainPoint;
  nowMs?: number;
  platforms?: readonly TerrainPlatform[];
  /** Visible window bodies for the wall check; without them nothing blocks a walking pet. */
  walls?: readonly TerrainWall[];
  displays?: readonly TerrainDisplay[];
  visibleSize: { width: number; height: number };
  climbChance?: number;
  descendChance?: number;
  climbSpeed?: number;
  gravity?: number;
  /** ADR-0009 §17: height difference up to which the pet jumps (or hops down) instead of climbing. */
  jumpMaxHeight?: number;
  jumpClearance?: number;
  /** ADR-0009 §18: gap (DIP) from a ledge across which the pet may jump to another window; 0 = never. */
  gapJumpDistance?: number;
  gapJumpChance?: number;
  landing?: "normal" | "soft";
  landingDurationMs?: number;
  random?: () => number;
  enabled?: boolean;
};

const EPSILON = 0.001;
const finitePoint = (point: TerrainPoint): boolean => Number.isFinite(point.x) && Number.isFinite(point.y);
const directionSign = (direction: WalkDirection): number => direction === "right" ? 1 : -1;
const containsX = (platform: TerrainPlatform, x: number): boolean => platform.x1 <= x && x < platform.x2;
const platformId = (platform: TerrainPlatform): string =>
  platform.windowId ?? `floor:${platform.displayId}`;
const requestFor = (state: MovementState): MovementSnapshot["request"] => ({
  grounded: null, "climb-ready": "climb-ready", climbing: "climb", jumping: "jump", "hop-down": "hop-down",
  "climbing-down": "climb-down", descending: "descend",
  falling: "fall", landing: "land", thrown: "thrown", dragging: "drag",
} satisfies Record<MovementState, MovementSnapshot["request"]>)[state];

/** Velocity from the first and last samples in the last 100 ms, capped by vector magnitude. */
export function dragReleaseVelocity(samples: readonly { timeMs: number; foot: TerrainPoint }[],
  releaseMs: number): MovementVelocity {
  const recent = samples.filter((sample) => sample.timeMs >= releaseMs - MOVEMENT_PHYSICS.dragWindowMs &&
    sample.timeMs <= releaseMs).slice(-MOVEMENT_PHYSICS.dragSamples);
  if (recent.length < 2) return { x: 0, y: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last) return { x: 0, y: 0 };
  const seconds = (last.timeMs - first.timeMs) / 1_000;
  if (seconds <= 0) return { x: 0, y: 0 };
  const x = (last.foot.x - first.foot.x) / seconds;
  const y = (last.foot.y - first.foot.y) / seconds;
  const magnitude = Math.hypot(x, y);
  const scale = magnitude > MOVEMENT_PHYSICS.maxThrowSpeed ? MOVEMENT_PHYSICS.maxThrowSpeed / magnitude : 1;
  return { x: x * scale, y: y * scale };
}

/** A window the pet stands on that moves at least this far (x or y) drops the pet where it stands (D-055). */
const WINDOW_MOVE_FALL_DIP = 2;

/** The same platform after a terrain refresh, or null when it vanished or moved by WINDOW_MOVE_FALL_DIP or more. */
function followPlatform(previous: TerrainPlatform, platforms: readonly TerrainPlatform[]):
  { platform: TerrainPlatform; dx: number; dy: number } | null {
  let best: { platform: TerrainPlatform; dx: number; dy: number } | null = null;
  for (const platform of platforms) {
    if (platform.windowId !== previous.windowId || platform.displayId !== previous.displayId) continue;
    const dx = platform.x1 - previous.x1;
    const dy = platform.y - previous.y;
    if (Math.abs(dx) >= WINDOW_MOVE_FALL_DIP || Math.abs(dy) >= WINDOW_MOVE_FALL_DIP ||
      Math.abs(platform.x2 - previous.x2) >= WINDOW_MOVE_FALL_DIP) continue;
    if (best === null || Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)) best = { platform, dx, dy };
  }
  return best;
}

export class PetMovement {
  private foot: TerrainPoint;
  private state: MovementState = "grounded";
  private velocity: MovementVelocity = { x: 0, y: 0 };
  private platforms: readonly TerrainPlatform[];
  private displays: readonly TerrainDisplay[];
  private walls: readonly TerrainWall[];
  private standing: TerrainPlatform | null = null;
  private walk: { direction: WalkDirection; speed: number } | null = null;
  private samples: { timeMs: number; foot: TerrainPoint }[] = [];
  private lastMs: number;
  private simulatedMs: number;
  private reverseWalk = false;
  private phaseStartedMs = 0;
  /** Platform the current climb, jump, hop-down or climb-down ends on. */
  private climbTarget: TerrainPlatform | null = null;
  /** The window side being climbed (ADR-0009 §19): its id, the x of the side edge, and (climb-down) the ledge platform. */
  private grip: { windowId: string; sideX: number; platform: TerrainPlatform | null } | null = null;
  /** The walk a climb-ready pet resumes, reversed, when its wall goes away. */
  private resumeWalk: { direction: WalkDirection; speed: number } | null = null;
  private arc: { from: TerrainPoint; to: TerrainPoint; vx: number; vy: number; gravity: number;
    durationS: number } | null = null;
  private softLanding = false;
  private climbDirection: WalkDirection = "right";
  private descendStart: TerrainPoint | null = null;
  private descendTargetX = 0;
  private throwDownEligible = false;
  private passedFloor = false;
  private wrapExempt = false;
  private readonly random: () => number;
  private landingMs: number;
  private landingDurationMs: number;
  private readonly visibleSize: { width: number; height: number };
  private climbChance: number;
  private descendChance: number;
  private climbSpeed: number;
  private gravity: number;
  private jumpMaxHeight: number;
  private jumpClearance: number;
  private gapJumpDistance: number;
  private gapJumpChance: number;
  private enabled: boolean;

  constructor(options: MovementOptions) {
    if (!finitePoint(options.foot) || !Number.isFinite(options.nowMs ?? 0) ||
      !Number.isFinite(options.visibleSize.width) || !Number.isFinite(options.visibleSize.height) ||
      options.visibleSize.width <= 0 || options.visibleSize.height <= 0) throw new RangeError("Invalid movement options");
    this.foot = { ...options.foot };
    this.platforms = options.platforms ?? [];
    this.displays = options.displays ?? [];
    this.walls = options.walls ?? [];
    this.lastMs = options.nowMs ?? 0;
    this.simulatedMs = this.lastMs;
    this.random = options.random ?? Math.random;
    this.visibleSize = options.visibleSize;
    this.climbChance = options.climbChance ?? MOVEMENT_PHYSICS.climbChance;
    this.descendChance = options.descendChance ?? MOVEMENT_PHYSICS.descendChance;
    this.climbSpeed = options.climbSpeed ?? MOVEMENT_PHYSICS.climbSpeed;
    this.gravity = options.gravity ?? MOVEMENT_PHYSICS.gravity;
    this.jumpMaxHeight = options.jumpMaxHeight ?? MOVEMENT_PHYSICS.jumpMaxHeight;
    this.jumpClearance = options.jumpClearance ?? MOVEMENT_PHYSICS.jumpClearance;
    this.gapJumpDistance = options.gapJumpDistance ?? MOVEMENT_PHYSICS.gapJumpDistance;
    this.gapJumpChance = options.gapJumpChance ?? MOVEMENT_PHYSICS.gapJumpChance;
    this.landingMs = options.landingDurationMs ?? (options.landing === "soft"
      ? MOVEMENT_PHYSICS.softLandingMs : MOVEMENT_PHYSICS.normalLandingMs);
    this.landingDurationMs = this.landingMs;
    this.enabled = options.enabled ?? true;
    this.standing = findStandingPlatform(this.platforms, this.foot);
    if (this.enabled && this.standing === null) this.state = "falling";
  }

  snapshot(): MovementSnapshot {
    return { foot: { ...this.foot }, state: this.state, request: requestFor(this.state),
      reverseWalk: this.reverseWalk, standingPlatformId: this.standing ? platformId(this.standing) : null,
      velocity: { ...this.velocity } };
  }

  setEnabled(enabled: boolean): MovementSnapshot {
    if (this.enabled === enabled) return this.snapshot();
    this.enabled = enabled;
    if (!enabled) {
      this.state = "grounded";
      this.velocity = { x: 0, y: 0 };
      this.walk = null;
      this.standing = findStandingPlatform(this.platforms, this.foot);
    } else {
      this.standing = findStandingPlatform(this.platforms, this.foot);
      if (!this.standing) this.enter("falling");
    }
    return this.snapshot();
  }

  /** Applies a pack's landing style to later landings; a landing already under way keeps its length. */
  setLanding(landing: "normal" | "soft"): void {
    this.landingMs = landing === "soft" ? MOVEMENT_PHYSICS.softLandingMs : MOVEMENT_PHYSICS.normalLandingMs;
  }

  /** Applies a saved behavior at once; absent fields keep their value. Invalid numbers throw before anything changes. */
  configure(values: Pick<MovementOptions, "climbChance" | "descendChance" | "climbSpeed" | "gravity" | "jumpMaxHeight" | "jumpClearance" | "gapJumpDistance" | "gapJumpChance">): void {
    for (const key of ["climbChance", "descendChance", "climbSpeed", "gravity", "jumpMaxHeight", "jumpClearance", "gapJumpDistance", "gapJumpChance"] as const) {
      const value = values[key];
      const [min, max] = BEHAVIOR_RANGES[key];
      if (value !== undefined && !(Number.isFinite(value) && value >= min && value <= max))
        throw new RangeError(`Invalid movement ${key}`);
    }
    this.climbChance = values.climbChance ?? this.climbChance;
    this.descendChance = values.descendChance ?? this.descendChance;
    this.climbSpeed = values.climbSpeed ?? this.climbSpeed;
    this.gravity = values.gravity ?? this.gravity;
    this.jumpMaxHeight = values.jumpMaxHeight ?? this.jumpMaxHeight;
    this.jumpClearance = values.jumpClearance ?? this.jumpClearance;
    this.gapJumpDistance = values.gapJumpDistance ?? this.gapJumpDistance;
    this.gapJumpChance = values.gapJumpChance ?? this.gapJumpChance;
  }

  /** Reads back the stored jump values. */
  jumpSettings(): { jumpMaxHeight: number; jumpClearance: number } {
    return { jumpMaxHeight: this.jumpMaxHeight, jumpClearance: this.jumpClearance };
  }

  setChances(climbChance: number, descendChance: number): void {
    if (![climbChance, descendChance].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
      throw new RangeError("Invalid movement chance");
    this.climbChance = climbChance;
    this.descendChance = descendChance;
  }

  placeFoot(foot: TerrainPoint): MovementSnapshot {
    if (!finitePoint(foot)) throw new RangeError("Invalid foot position");
    this.foot = { ...foot };
    this.velocity = { x: 0, y: 0 };
    this.walk = null;
    this.standing = findStandingPlatform(this.platforms, foot);
    this.enter(!this.enabled || this.standing ? "grounded" : "falling");
    return this.snapshot();
  }

  setTerrain(platforms: readonly TerrainPlatform[], displays: readonly TerrainDisplay[],
    walls: readonly TerrainWall[] = []): MovementSnapshot {
    const previous = this.standing;
    this.platforms = platforms;
    this.displays = displays;
    this.walls = walls;
    this.followMotionTargets();
    if (!this.enabled || previous === null || (this.state !== "grounded" && this.state !== "landing"))
      return this.snapshot();
    if (previous.windowId === null) {
      this.standing = findStandingPlatform(platforms, this.foot);
    } else {
      const candidate = platforms.filter((platform) => platform.windowId === previous.windowId);
      const match = candidate.find((platform) => platform.displayId === previous.displayId) ?? candidate[0];
      if (match) {
        const dx = match.x1 - previous.x1;
        const dy = match.y - previous.y;
        if (Math.abs(dx) >= WINDOW_MOVE_FALL_DIP || Math.abs(dy) >= WINDOW_MOVE_FALL_DIP) this.standing = null;
        else {
          this.foot = { x: this.foot.x + dx, y: this.foot.y + dy };
          this.standing = candidate.find((platform) => containsX(platform, this.foot.x) && platform.y === this.foot.y) ?? null;
        }
      } else this.standing = null;
    }
    if (this.standing === null) this.enter("falling");
    return this.snapshot();
  }

  /** ADR-0009 §19: follow the window a jump, hop, climb-ready or climb is bound to; a 2 DIP move or its loss ends the plan. */
  private followMotionTargets(): void {
    const target = this.climbTarget;
    if (!target) return;
    const state = this.state;
    if (state !== "jumping" && state !== "hop-down" && state !== "climb-ready" && state !== "climbing" &&
      state !== "climbing-down") return;
    const followed = followPlatform(target, this.platforms);
    const gripPlatform = state === "climbing-down" ? this.grip?.platform ?? null : null;
    const followedGrip = gripPlatform ? followPlatform(gripPlatform, this.platforms) : followed;
    if (!followed || !followedGrip) {
      if (state === "climb-ready") this.abortClimbReady();
      else this.dropToFall();
      return;
    }
    this.climbTarget = followed.platform;
    if (this.grip && gripPlatform) this.grip.platform = followedGrip.platform;
    if (state === "jumping" || state === "hop-down") {
      if (this.arc) this.arc.to = { x: this.arc.to.x + followed.dx, y: this.arc.to.y + followed.dy };
    } else if (state !== "climb-ready") {
      this.foot = { x: this.foot.x + followedGrip.dx, y: this.foot.y + followedGrip.dy };
      if (this.grip) this.grip.sideX += followedGrip.dx;
    }
  }

  /** Gives up the target and keeps the current velocity: a pet in flight keeps flying, a climber falls from where it is. */
  private dropToFall(): void {
    this.arc = null;
    this.climbTarget = null;
    this.grip = null;
    this.softLanding = false;
    if (this.state === "climbing" || this.state === "climbing-down") this.velocity = { x: 0, y: 0 };
    this.enter("falling");
  }

  /** The wall of a climb-ready pet is gone: back on the ground, walking the other way. */
  private abortClimbReady(): void {
    const resume = this.resumeWalk;
    this.climbTarget = null;
    this.grip = null;
    this.resumeWalk = null;
    this.velocity = { x: 0, y: 0 };
    this.standing = findStandingPlatform(this.platforms, this.foot);
    if (!this.standing) { this.enter("falling"); return; }
    if (resume) {
      this.walk = { direction: resume.direction === "right" ? "left" : "right", speed: resume.speed };
      this.reverseWalk = true;
    }
    this.enter("grounded");
  }

  requestWalk(direction: WalkDirection, speedPxPerSecond: number): MovementSnapshot {
    if (!Number.isFinite(speedPxPerSecond) || speedPxPerSecond < 0) throw new RangeError("Invalid walk speed");
    this.walk = { direction, speed: speedPxPerSecond };
    this.reverseWalk = false;
    return this.snapshot();
  }

  stopWalk(): void { this.walk = null; }

  startDrag(timeMs: number, foot = this.foot): MovementSnapshot {
    this.advance(timeMs);
    if (!finitePoint(foot)) throw new RangeError("Invalid foot position");
    this.samples = [];
    this.foot = { ...foot };
    this.velocity = { x: 0, y: 0 };
    this.standing = null;
    this.walk = null;
    this.enter("dragging");
    this.sampleDrag(timeMs, foot);
    return this.snapshot();
  }

  sampleDrag(timeMs: number, foot: TerrainPoint): MovementSnapshot {
    this.advance(timeMs);
    if (!finitePoint(foot)) throw new RangeError("Invalid foot position");
    if (this.state !== "dragging") return this.snapshot();
    this.foot = { ...foot };
    this.samples.push({ timeMs, foot: { ...foot } });
    if (this.samples.length > MOVEMENT_PHYSICS.dragSamples) this.samples.shift();
    return this.snapshot();
  }

  endDrag(timeMs: number, foot = this.foot): MovementSnapshot {
    this.sampleDrag(timeMs, foot);
    if (this.state !== "dragging") return this.snapshot();
    const velocity = dragReleaseVelocity(this.samples, timeMs);
    this.samples = [];
    this.velocity = Math.hypot(velocity.x, velocity.y) <= MOVEMENT_PHYSICS.stillSpeed
      ? { x: 0, y: 0 } : velocity;
    this.standing = findStandingPlatform(this.platforms, this.foot);
    this.throwDownEligible = this.velocity.y > 0;
    this.passedFloor = false;
    if (this.velocity.x !== 0 || this.velocity.y !== 0) {
      this.standing = null;
      this.enter("thrown");
    } else if (this.standing) this.enter("grounded");
    else this.enter("falling");
    return this.snapshot();
  }

  advance(untilMs: number): MovementSnapshot {
    this.checkEventTime(untilMs);
    if (!this.enabled) {
      this.lastMs = untilMs;
      this.simulatedMs = untilMs;
      return this.snapshot();
    }
    const steps = Math.floor((untilMs - this.simulatedMs) / MOVEMENT_PHYSICS.stepMs);
    this.lastMs = untilMs;
    for (let index = 0; index < steps; index += 1) {
      this.simulatedMs += MOVEMENT_PHYSICS.stepMs;
      this.tick(MOVEMENT_PHYSICS.stepMs / 1_000);
    }
    return this.snapshot();
  }

  private checkEventTime(timeMs: number): void {
    if (!Number.isFinite(timeMs) || timeMs < this.lastMs) throw new RangeError("Invalid movement time");
  }

  private enter(state: MovementState): void {
    this.state = state;
    this.phaseStartedMs = this.simulatedMs;
  }

  private tick(dt: number): void {
    this.wrapExempt = false;
    if (this.state === "dragging") return;
    if (this.state === "landing") {
      if (this.simulatedMs - this.phaseStartedMs >= this.landingDurationMs) this.enter("grounded");
      return;
    }
    if (this.state === "grounded") { this.walkTick(dt); return; }
    if (this.state === "climb-ready") {
      if (!this.climbTarget || !this.platforms.includes(this.climbTarget)) { this.abortClimbReady(); return; }
      if (this.simulatedMs - this.phaseStartedMs >= MOVEMENT_PHYSICS.climbReadyMs) this.enter("climbing");
      return;
    }
    if (this.state === "climbing" || this.state === "climbing-down") { this.climbTick(dt); return; }
    if (this.state === "jumping" || this.state === "hop-down") { this.arcTick(); return; }
    this.flightTick(dt);
  }

  private walkTick(dt: number): void {
    if (!this.walk || !this.standing || this.walk.speed === 0) return;
    const sign = directionSign(this.walk.direction);
    const nextX = this.foot.x + sign * this.walk.speed * dt;
    const wall = this.walls.find((piece) => piece.y1 < this.foot.y &&
      this.foot.y <= piece.y2 + MOVEMENT_PHYSICS.wallTolerance &&
      (sign > 0 ? this.foot.x < piece.x1 && nextX >= piece.x1 : this.foot.x >= piece.x2 && nextX < piece.x2));
    if (wall) {
      const top = this.wallTop(wall, sign);
      if (top && this.random() < this.climbChance) this.startClimb(top, this.walk.direction, wall);
      else this.reverseDirection();
      return;
    }
    if (!containsX(this.standing, nextX)) {
      const adjacent = this.platforms.find((platform) => platform.y === this.foot.y && containsX(platform, nextX));
      if (adjacent) { this.standing = adjacent; this.foot.x = nextX; return; }
      if (!this.inDisplay({ x: nextX, y: this.foot.y })) { this.reverseDirection(); return; }
      const across = this.gapTarget(sign);
      if (across && this.random() < this.gapJumpChance) { this.startGapJump(across, this.walk.direction); return; }
      if (this.random() < this.descendChance) {
        this.foot.x = sign > 0 ? this.standing.x2 + EPSILON : this.standing.x1 - EPSILON;
        const below = this.platformBelow(this.foot);
        if (below) { this.startDrop(below, this.walk.direction); return; }
        this.descendStart = { ...this.foot };
        this.descendTargetX = this.foot.x + sign * this.visibleSize.width / 2;
        this.velocity = { x: sign * Math.max(this.walk.speed, this.climbSpeed), y: 0 };
        this.walk = null;
        this.standing = null;
        this.enter("descending");
      } else this.reverseDirection();
      return;
    }
    this.foot.x = nextX;
  }

  private reverseDirection(): void {
    this.reverseWalk = true;
    if (this.walk) this.walk.direction = this.walk.direction === "right" ? "left" : "right";
  }

  /** The visible top of the wall's window that the pet would stand on after crossing the wall's near edge. */
  private wallTop(wall: TerrainWall, sign: number): TerrainPlatform | null {
    const x = sign > 0 ? wall.x1 + 1 : wall.x2 - 1;
    return this.platforms.find((platform) => platform.windowId === wall.windowId &&
      Math.abs(platform.y - wall.y1) < 1 && containsX(platform, x)) ?? null;
  }

  /** The nearest platform under the point, where a ledge walker would end up. */
  private platformBelow(point: TerrainPoint): TerrainPlatform | null {
    let below: TerrainPlatform | null = null;
    for (const platform of this.platforms) {
      if (containsX(platform, point.x) && platform.y > point.y + EPSILON && (below === null || platform.y < below.y))
        below = platform;
    }
    return below;
  }

  /** The nearest window top that starts within gapJumpDistance beyond the ledge; a higher one only up to jumpMaxHeight. */
  private gapTarget(sign: number): TerrainPlatform | null {
    const standing = this.standing;
    if (!standing || this.gapJumpDistance <= 0) return null;
    let best: TerrainPlatform | null = null;
    let bestGap = Infinity;
    for (const platform of this.platforms) {
      if (platform === standing || platform.windowId === null) continue;
      const gap = sign > 0 ? platform.x1 - standing.x2 : standing.x1 - platform.x2;
      if (gap <= 0 || gap > this.gapJumpDistance || gap >= bestGap) continue;
      if (this.foot.y - platform.y > this.jumpMaxHeight) continue;
      best = platform;
      bestGap = gap;
    }
    return best;
  }

  /** A jump across the gap: the apex is jumpClearance above the higher of the two tops, landing one step inside. */
  private startGapJump(target: TerrainPlatform, direction: WalkDirection): void {
    const standing = this.standing;
    if (!standing) return;
    const sign = directionSign(direction);
    this.foot.x = sign > 0 ? standing.x2 - EPSILON : standing.x1;
    const inset = Math.min(this.visibleSize.width / 2, (target.x2 - target.x1) / 2);
    const to = { x: sign > 0 ? target.x1 + inset : target.x2 - inset, y: target.y };
    const apexY = Math.min(this.foot.y, target.y) - this.jumpClearance;
    const rise = this.foot.y - apexY;
    const fall = target.y - apexY;
    const durationS = Math.sqrt(2 * rise / this.gravity) + Math.sqrt(2 * fall / this.gravity);
    this.climbTarget = target;
    this.climbDirection = direction;
    this.descendStart = null;
    this.walk = null;
    this.standing = null;
    this.startArc(to, -Math.sqrt(2 * rise * this.gravity), durationS, false);
    this.enter("jumping");
  }

  /** Up to jumpMaxHeight the pet jumps onto the top; above it, it climbs the wall (no height limit). */
  private startClimb(top: TerrainPlatform, direction: WalkDirection, wall: TerrainWall): void {
    this.climbTarget = top;
    this.climbDirection = direction;
    this.grip = { windowId: wall.windowId, sideX: direction === "right" ? wall.x1 : wall.x2, platform: null };
    this.resumeWalk = this.walk ? { ...this.walk } : null;
    this.walk = null;
    const height = this.foot.y - top.y;
    if (height > this.jumpMaxHeight) { this.enter("climb-ready"); return; }
    const sign = directionSign(direction);
    const inset = Math.min(this.visibleSize.width / 2, (top.x2 - top.x1) / 2);
    const to = { x: sign > 0 ? top.x1 + inset : top.x2 - inset, y: top.y };
    // The apex is jumpClearance above the top: rise (height + clearance), then fall clearance onto it.
    const rise = height + this.jumpClearance;
    const durationS = Math.sqrt(2 * rise / this.gravity) + Math.sqrt(2 * this.jumpClearance / this.gravity);
    this.startArc(to, -Math.sqrt(2 * rise * this.gravity), durationS, false);
    this.enter("jumping");
  }

  /** A drop up to jumpMaxHeight is a light hop forward; a longer one is climbed down along the side. */
  private startDrop(below: TerrainPlatform, direction: WalkDirection): void {
    this.climbTarget = below;
    this.climbDirection = direction;
    this.descendStart = null;
    this.walk = null;
    const ledge = this.standing;
    this.grip = ledge?.windowId ? { windowId: ledge.windowId, platform: ledge,
      sideX: direction === "right" ? ledge.x2 : ledge.x1 } : null;
    this.standing = null;
    const drop = below.y - this.foot.y;
    if (drop > this.jumpMaxHeight) { this.velocity = { x: 0, y: 0 }; this.enter("climbing-down"); return; }
    const sign = directionSign(direction);
    const x = Math.max(below.x1 + EPSILON, Math.min(below.x2 - EPSILON, this.foot.x + sign * this.visibleSize.width / 2));
    const vy = -Math.sqrt(2 * MOVEMENT_PHYSICS.hopRise * this.gravity);
    const durationS = (-vy + Math.sqrt(vy * vy + 2 * this.gravity * drop)) / this.gravity;
    this.startArc({ x, y: below.y }, vy, durationS, true);
    this.enter("hop-down");
  }

  private startArc(to: TerrainPoint, vy: number, durationS: number, soft: boolean): void {
    this.arc = { from: { ...this.foot }, to, vx: (to.x - this.foot.x) / durationS, vy, gravity: this.gravity, durationS };
    this.softLanding = soft;
    this.velocity = { x: this.arc.vx, y: vy };
  }

  /** Jump and hop-down follow a parabola from the start point, so the landing spot is exact at any step size. */
  private arcTick(): void {
    const target = this.climbTarget;
    const arc = this.arc;
    if (!target || !arc || !this.platforms.includes(target)) { this.dropToFall(); return; }
    const seconds = (this.simulatedMs - this.phaseStartedMs) / 1_000;
    if (seconds >= arc.durationS) {
      this.arc = null;
      this.climbTarget = null;
      this.foot = { ...arc.to };
      this.land(target);
      return;
    }
    this.foot = { x: arc.from.x + arc.vx * seconds, y: arc.from.y + arc.vy * seconds + arc.gravity * seconds * seconds / 2 };
    this.velocity = { x: arc.vx, y: arc.vy + arc.gravity * seconds };
  }

  private climbTick(dt: number): void {
    const target = this.climbTarget;
    if (!target || !this.platforms.includes(target)) { this.dropToFall(); return; }
    // No wall data (walls empty) means the side cannot be checked; otherwise a climber never hangs on thin air.
    if (this.grip && this.walls.length > 0 && !isWallSideVisible(this.walls, this.grip.windowId, this.grip.sideX,
      this.foot.y, MOVEMENT_PHYSICS.wallTolerance)) { this.dropToFall(); return; }
    if (this.state === "climbing-down") {
      this.foot.y = Math.min(target.y, this.foot.y + this.climbSpeed * dt);
      if (this.foot.y === target.y) {
        this.standing = target;
        this.climbTarget = null;
        this.enter("grounded");
      }
      return;
    }
    this.foot.y = Math.max(target.y, this.foot.y - this.climbSpeed * dt);
    if (this.foot.y === target.y) {
      this.foot.x = this.climbDirection === "right" ? Math.max(this.foot.x, target.x1 + EPSILON) :
        Math.min(this.foot.x, target.x2 - EPSILON);
      this.standing = target;
      this.velocity = { x: 0, y: 0 };
      this.climbTarget = null;
      this.enter("grounded");
    }
  }

  private flightTick(dt: number): void {
    const previous = { ...this.foot };
    this.velocity.y = Math.min(this.velocity.y + this.gravity * dt, MOVEMENT_PHYSICS.terminalSpeed);
    this.foot = { x: previous.x + this.velocity.x * dt, y: previous.y + this.velocity.y * dt };
    const wall = this.platforms.find((platform) => platform.windowId !== null &&
      platform.y < this.foot.y && this.foot.y - platform.y <= this.visibleSize.height &&
      (this.velocity.x > 0 ? previous.x < platform.x1 && this.foot.x >= platform.x1 :
        this.velocity.x < 0 && previous.x >= platform.x2 && this.foot.x < platform.x2));
    if (wall) {
      this.foot.x = this.velocity.x > 0 ? wall.x1 - EPSILON : wall.x2;
      this.velocity.x = 0;
    }
    if (this.state === "thrown" && this.velocity.y > 0) this.enter("falling");
    if (this.state === "descending" && this.descendStart) {
      const reachedX = this.velocity.x >= 0 ? this.foot.x >= this.descendTargetX : this.foot.x <= this.descendTargetX;
      if (reachedX) { this.foot.x = this.descendTargetX; this.velocity.x = 0; }
      if (reachedX || this.foot.y - this.descendStart.y >= this.visibleSize.height) this.enter("falling");
    }
    if (this.velocity.y >= 0) {
      const windowPlatforms = this.platforms.filter((platform) => platform.windowId !== null);
      const crossedWindow = findCrossedPlatform(windowPlatforms, this.foot.x, previous.y, this.foot.y);
      if (crossedWindow) { this.land(crossedWindow); return; }
      const floor = floorAtX(this.platforms, this.foot.x);
      if (floor && previous.y <= floor.y && floor.y < this.foot.y) {
        if (this.throwDownEligible && !this.passedFloor && this.velocity.y >= MOVEMENT_PHYSICS.floorPassSpeed) {
          this.passedFloor = true;
          this.wrapTopAtX();
          return;
        }
        this.land(floor);
        return;
      }
    }
    this.wrap(previous);
  }

  private land(platform: TerrainPlatform): void {
    this.foot.y = platform.y;
    this.velocity = { x: 0, y: 0 };
    this.standing = platform;
    this.throwDownEligible = false;
    this.landingDurationMs = this.softLanding ? Math.max(this.landingMs, MOVEMENT_PHYSICS.softLandingMs) : this.landingMs;
    this.softLanding = false;
    this.enter("landing");
  }

  private inDisplay(point: TerrainPoint): boolean {
    return this.displays.some(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width &&
      point.y >= bounds.y && point.y < bounds.y + bounds.height);
  }

  private wrapTopAtX(): void {
    const screens = this.displays.filter(({ bounds }) => bounds.x <= this.foot.x &&
      this.foot.x < bounds.x + bounds.width);
    if (screens.length === 0) return;
    this.foot.y = Math.min(...screens.map(({ workArea }) => workArea.y)) + EPSILON;
    this.wrapExempt = true;
  }

  private wrap(previous: TerrainPoint): void {
    if (this.wrapExempt || this.inDisplay(this.foot)) return;
    const bounds = displayUnionBounds(this.displays);
    if (!bounds) return;
    const right = bounds.x + bounds.width;
    if (this.foot.x < bounds.x || this.foot.x >= right) {
      this.foot.x = this.foot.x < bounds.x ? right - EPSILON : bounds.x + EPSILON;
      this.clampToNearestWorkArea("y");
    } else if (this.foot.y < bounds.y) {
      const screens = this.displays.filter(({ bounds: screen }) => screen.x <= this.foot.x &&
        this.foot.x < screen.x + screen.width);
      if (screens.length > 0) this.foot.y = Math.max(...screens.map(({ workArea }) =>
        workArea.y + workArea.height)) - EPSILON;
      else this.clampToNearestWorkArea("both");
    } else if (previous.x !== this.foot.x || previous.y !== this.foot.y) {
      this.clampToNearestWorkArea("both");
    }
    this.wrapExempt = true;
  }

  private clampToNearestWorkArea(axis: "y" | "both"): void {
    let nearest: TerrainPoint | null = null;
    let distance = Infinity;
    for (const { workArea } of this.displays) {
      const point = { x: Math.max(workArea.x, Math.min(this.foot.x, workArea.x + workArea.width - EPSILON)),
        y: Math.max(workArea.y, Math.min(this.foot.y, workArea.y + workArea.height - EPSILON)) };
      const measure = (point.x - this.foot.x) ** 2 + (point.y - this.foot.y) ** 2;
      if (measure < distance) { nearest = point; distance = measure; }
    }
    if (nearest) this.foot = axis === "y" ? { x: this.foot.x, y: nearest.y } : nearest;
  }
}
