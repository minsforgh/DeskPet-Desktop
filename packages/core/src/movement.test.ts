import { describe, expect, it } from "vitest";
import { DEFAULT_MOVEMENT_FALLBACKS, MOVEMENT_PHYSICS, PetMovement, dragReleaseVelocity } from "./index.js";
import type { MovementOptions, MovementSnapshot, TerrainDisplay, TerrainPlatform, TerrainWall } from "./index.js";

const screen = (id: number, x = 0, y = 0, width = 800, height = 600): TerrainDisplay => ({
  id, bounds: { x, y, width, height }, workArea: { x, y, width, height: height - 40 },
});
const floor = (display: TerrainDisplay): TerrainPlatform => ({
  x1: display.workArea.x, x2: display.workArea.x + display.workArea.width,
  y: display.workArea.y + display.workArea.height, windowId: null, displayId: display.id,
});
const ledge = (id: string, x1: number, x2: number, y: number, displayId = 1): TerrainPlatform =>
  ({ x1, x2, y, windowId: id, displayId });
/** The visible body of window `id` under its top edge; the wall check reads this, not the top platform. */
const body = (id: string, x1: number, x2: number, y1: number, y2 = 600, displayId = 1): TerrainWall =>
  ({ windowId: id, displayId, x1, x2, y1, y2 });
const base = screen(1);
const ground = floor(base);
const options = (foot = { x: 100, y: 200 }, extras: Partial<MovementOptions> = {}): MovementOptions => ({
  foot, nowMs: 0, platforms: [ground], displays: [base], visibleSize: { width: 80, height: 60 }, ...extras,
});
const movement = (foot = { x: 100, y: 200 }, extras: Partial<MovementOptions> = {}) =>
  new PetMovement(options(foot, extras));

describe("PetMovement transitions", () => {
  it("uses the default wall and ledge chances and exposes the built-in animation fallbacks", () => {
    expect(MOVEMENT_PHYSICS).toMatchObject({ climbChance: 0.5, descendChance: 0.5 });
    expect(DEFAULT_MOVEMENT_FALLBACKS).toEqual({ "climb-ready": "surprised", climb: "walk",
      descend: "walk", fall: "drag", land: "idle", thrown: "fall", jump: "happy", "hop-down": "fall",
      "climb-down": "climb" });
    const high = ledge("high", 100, 200, 200);
    const pet = movement({ x: 199, y: 200 }, { platforms: [high, ground], random: () => 0.25 });
    pet.requestWalk("right", 100);
    expect(pet.advance(16).state).toBe("climbing-down");
    pet.setChances(0, 0);
    expect(() => pet.setChances(-1, 0)).toThrow(RangeError);
    expect(() => pet.setChances(0, 1.1)).toThrow(RangeError);
  });

  it("repositions the foot and resumes gravity when movement is reenabled", () => {
    const pet = movement({ x: 100, y: 560 }, { enabled: false });
    expect(pet.placeFoot({ x: 100, y: 200 }).state).toBe("grounded");
    expect(pet.setEnabled(true).state).toBe("falling");
    expect(pet.advance(1_000).foot.y).toBe(560);
  });
  it("starts a drag from every state and releases still on a platform to grounded", () => {
    const pet = movement({ x: 100, y: 560 });
    expect(pet.startDrag(0).state).toBe("dragging");
    expect(pet.snapshot().request).toBe("drag");
    expect(pet.endDrag(10).state).toBe("grounded");
    expect(pet.snapshot().standingPlatformId).toBe("floor:1");
    pet.startDrag(20);
    expect(pet.snapshot().state).toBe("dragging");
  });

  it("releases still in air to falling, then lands and finishes landing", () => {
    const pet = movement();
    pet.startDrag(0);
    expect(pet.endDrag(10).state).toBe("falling");
    expect(pet.snapshot().request).toBe("fall");
    expect(pet.advance(700).state).toBe("landing");
    expect(pet.snapshot().foot.y).toBe(560);
    expect(pet.snapshot().request).toBe("land");
    expect(pet.advance(1_020).state).toBe("grounded");
  });

  it("releases a moving drag to thrown and changes to falling at the apex", () => {
    const pet = movement({ x: 200, y: 300 });
    pet.startDrag(0, { x: 200, y: 300 });
    pet.sampleDrag(50, { x: 210, y: 280 });
    expect(pet.endDrag(100, { x: 220, y: 260 }).state).toBe("thrown");
    expect(pet.snapshot().request).toBe("thrown");
    expect(pet.advance(500).state).toBe("falling");
    expect(pet.snapshot().velocity.x).toBeGreaterThan(0);
  });

  it("falls in place when the window it stands on moves 2 DIP or more, but stays for smaller moves and resizes (D-055)", () => {
    const first = ledge("w", 100, 300, 200);
    const stand = () => movement({ x: 150, y: 200 }, { platforms: [first, ground] });
    const small = stand();
    expect(small.setTerrain([ledge("w", 101, 301, 201), ground], [base])).toMatchObject({ state: "grounded" });
    expect(small.snapshot().standingPlatformId).toBe("w");
    const moveX = stand().setTerrain([ledge("w", 102, 302, 200), ground], [base]);
    expect(moveX).toMatchObject({ state: "falling", foot: { x: 150, y: 200 } });
    const moveY = stand().setTerrain([ledge("w", 100, 300, 240), ground], [base]);
    expect(moveY).toMatchObject({ state: "falling", foot: { x: 150, y: 200 } });
    const resized = stand();
    expect(resized.setTerrain([ledge("w", 100, 360, 200), ground], [base])).toMatchObject({ state: "grounded" });
    expect(resized.setTerrain([ledge("w", 100, 120, 200), ground], [base]).state).toBe("falling");
    expect(stand().setTerrain([ground], [base]).state).toBe("falling");
  });

  it("reverses or descends at a ledge with deterministic 0 and 1 chances", () => {
    const high = ledge("high", 100, 200, 200);
    const turn = movement({ x: 199, y: 200 }, { platforms: [high, ground], descendChance: 0, random: () => 0 });
    turn.requestWalk("right", 100);
    expect(turn.advance(16)).toMatchObject({ state: "grounded", reverseWalk: true, foot: { x: 199, y: 200 } });
    const descend = movement({ x: 199, y: 200 },
      { platforms: [high, ground], descendChance: 1, random: () => 0 });
    descend.requestWalk("right", 100);
    expect(descend.advance(16).state).toBe("climbing-down");
    expect(descend.snapshot().request).toBe("climb-down");
    expect(descend.advance(3_100).state).toBe("grounded");
    expect(descend.snapshot()).toMatchObject({ standingPlatformId: "floor:1", foot: { y: 560 } });
  });

  /** A pet on the floor (y 560) walking right into a window whose top is at `top` and whose body reaches `bottom`. */
  const atWall = (top: number, extras: Partial<MovementOptions> = {}, bottom = 600) => {
    const pet = movement({ x: 199, y: 560 }, { platforms: [ledge("w", 200, 400, top), ground],
      walls: [body("w", 200, 400, top, bottom)], climbChance: 1, random: () => 0, ...extras });
    pet.requestWalk("right", 100);
    return pet;
  };
  const run = (pet: PetMovement, until: (snapshot: MovementSnapshot) => boolean, fromMs = 0): number => {
    let now = fromMs;
    while (!until(pet.snapshot()) && now < fromMs + 20_000) { now += 16; pet.advance(now); }
    return now;
  };

  it("jumps onto a window top up to the reference height, with the apex jumpClearance above the top", () => {
    const pet = atWall(460);
    expect(pet.advance(16)).toMatchObject({ state: "jumping", request: "jump" });
    let now = 16;
    let apex = Infinity;
    while (pet.snapshot().state === "jumping") { now += 16; pet.advance(now); apex = Math.min(apex, pet.snapshot().foot.y); }
    expect(apex).toBeCloseTo(460 - MOVEMENT_PHYSICS.jumpClearance, 0);
    expect(pet.snapshot()).toMatchObject({ state: "landing", request: "land", standingPlatformId: "w",
      foot: { x: 240, y: 460 } });
    pet.advance(now + 316);
    expect(pet.snapshot().state).toBe("grounded");
  });

  it("switches from jump to climb exactly above the reference height", () => {
    expect(atWall(410).advance(16).state).toBe("jumping");
    expect(atWall(409).advance(16)).toMatchObject({ state: "climb-ready", request: "climb-ready" });
    expect(atWall(410, { jumpMaxHeight: 149 }).advance(16).state).toBe("climb-ready");
    expect(atWall(100, { jumpMaxHeight: 460 }).advance(16).state).toBe("jumping");
  });

  it("climbs a wall of any height at chance 1 and stands on its top", () => {
    for (const top of [100, 0]) {
      const pet = atWall(top);
      expect(pet.advance(16).state).toBe("climb-ready");
      expect(pet.advance(416)).toMatchObject({ state: "climbing", request: "climb" });
      pet.advance(416 + Math.ceil((560 - top) / 120 * 1_000) + 32);
      expect(pet.snapshot()).toMatchObject({ state: "grounded", standingPlatformId: "w", foot: { y: top } });
    }
  });

  it("turns around at a wall at chance 0 instead of walking past it", () => {
    for (const top of [460, 100]) {
      const pet = atWall(top, { climbChance: 0 });
      expect(pet.advance(16)).toMatchObject({ state: "grounded", reverseWalk: true });
      pet.advance(1_500);
      expect(pet.snapshot().foot.x).toBeLessThan(200);
    }
  });

  it("walks under a floating window but turns at one that reaches the floor", () => {
    const floating = atWall(100, {}, 400);
    floating.advance(500);
    expect(floating.snapshot()).toMatchObject({ state: "grounded", reverseWalk: false });
    expect(floating.snapshot().foot.x).toBeGreaterThan(200);
    expect(atWall(100, {}, 559).advance(16).state).toBe("climb-ready");
    expect(atWall(100, { climbChance: 0 }, 560).advance(16).reverseWalk).toBe(true);
  });

  it("turns around when no visible top is left at the wall edge", () => {
    const pet = movement({ x: 199, y: 560 }, { platforms: [ground], walls: [body("w", 200, 400, 460)],
      climbChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    expect(pet.advance(16)).toMatchObject({ state: "grounded", reverseWalk: true });
  });

  it("climbs a wall to the left as well", () => {
    const pet = movement({ x: 401, y: 560 }, { platforms: [ledge("w", 200, 400, 460), ground],
      walls: [body("w", 200, 400, 460)], climbChance: 1, random: () => 0 });
    pet.requestWalk("left", 100);
    expect(pet.advance(16).state).toBe("jumping");
    pet.advance(700);
    expect(pet.snapshot()).toMatchObject({ state: "landing", foot: { x: 360, y: 460 } });
  });

  it("falls when a jump or climb target disappears", () => {
    const jump = atWall(460);
    jump.advance(100);
    jump.setTerrain([ground], [base]);
    expect(jump.advance(116).state).toBe("falling");
    const climb = atWall(100);
    climb.advance(432);
    climb.setTerrain([ground], [base]);
    expect(climb.advance(448).state).toBe("falling");
  });

  it("keeps climbing when an unchanged terrain snapshot uses new platform objects", () => {
    const pet = atWall(100);
    pet.advance(432);
    pet.setTerrain([ledge("w", 200, 400, 100), ground], [base], [body("w", 200, 400, 100)]);
    expect(pet.advance(448).state).toBe("climbing");
  });

  it("changes the jump with gravity, clearance and the reference height, and the climb with climbSpeed", () => {
    const jumpMs = (extras: Partial<MovementOptions>) => {
      const pet = atWall(460, extras);
      pet.advance(16);
      return run(pet, (snapshot) => snapshot.state === "landing", 16) - 16;
    };
    const normal = jumpMs({});
    expect(jumpMs({ gravity: 4_000 })).toBeLessThan(normal - 100);
    expect(jumpMs({ gravity: 500 })).toBeGreaterThan(normal + 100);
    expect(jumpMs({ jumpClearance: 100 })).toBeGreaterThan(normal);
    expect(jumpMs({ jumpClearance: 0 })).toBeLessThan(normal);
    const climbMs = (extras: Partial<MovementOptions>) => {
      const pet = atWall(100, extras);
      pet.advance(16);
      return run(pet, (snapshot) => snapshot.state === "grounded", 16) - 16;
    };
    expect(climbMs({ climbSpeed: 240 })).toBeLessThan(climbMs({}) - 1_500);
    const configured = atWall(460);
    configured.configure({ jumpMaxHeight: 50 });
    expect(configured.advance(16).state).toBe("climb-ready");
  });

  it("hops down a ledge up to the reference height and lands softly on the platform below", () => {
    const high = ledge("high", 100, 200, 500);
    const pet = movement({ x: 199, y: 500 }, { platforms: [high, ground], descendChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    expect(pet.advance(16)).toMatchObject({ state: "hop-down", request: "hop-down" });
    const landedAt = run(pet, (snapshot) => snapshot.state === "landing", 16);
    expect(pet.snapshot()).toMatchObject({ request: "land", standingPlatformId: "floor:1", foot: { y: 560 } });
    expect(pet.snapshot().foot.x).toBeGreaterThan(200);
    pet.advance(landedAt + 350);
    expect(pet.snapshot().state).toBe("landing");
    pet.advance(landedAt + 416);
    expect(pet.snapshot().state).toBe("grounded");
  });

  it("hops onto a window top under the ledge, and the boundary 150 hops while 151 climbs down", () => {
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("high", 100, 200, 300), ledge("mid", 200, 400, 400), ground],
      descendChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    expect(pet.advance(16).state).toBe("hop-down");
    run(pet, (snapshot) => snapshot.state === "landing", 16);
    expect(pet.snapshot().standingPlatformId).toBe("mid");
    const drop = (y: number, extras: Partial<MovementOptions> = {}) => {
      const walker = movement({ x: 199, y }, { platforms: [ledge("high", 100, 200, y), ground],
        descendChance: 1, random: () => 0, ...extras });
      walker.requestWalk("right", 100);
      return walker.advance(16).state;
    };
    expect(drop(410)).toBe("hop-down");
    expect(drop(409)).toBe("climbing-down");
    expect(drop(409, { jumpMaxHeight: 151 })).toBe("hop-down");
    expect(drop(410, { jumpMaxHeight: 149 })).toBe("climbing-down");
  });

  it("climbs down along the side at climbSpeed onto the platform below and stands there", () => {
    const climbDown = (climbSpeed: number) => {
      const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("high", 100, 200, 300), ground],
        descendChance: 1, random: () => 0, climbSpeed });
      pet.requestWalk("right", 100);
      expect(pet.advance(16)).toMatchObject({ state: "climbing-down", request: "climb-down" });
      pet.advance(16 + 160);
      expect(pet.snapshot().foot.y).toBeCloseTo(300 + 10 * 0.016 * climbSpeed, 3);
      return run(pet, (snapshot) => snapshot.state === "grounded", 176);
    };
    const slow = climbDown(120);
    const fast = climbDown(240);
    expect(slow).toBeGreaterThan(fast + 1_000);
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("high", 100, 200, 300), ground],
      descendChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    pet.advance(16);
    run(pet, (snapshot) => snapshot.state === "grounded", 16);
    expect(pet.snapshot()).toMatchObject({ standingPlatformId: "floor:1", foot: { y: 560 } });
    expect(pet.snapshot().foot.x).toBeGreaterThan(200);
  });

  it("falls when the platform below a climb-down or hop-down disappears", () => {
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("high", 100, 200, 300), ground],
      descendChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    pet.advance(16);
    pet.setTerrain([], [base]);
    expect(pet.advance(32).state).toBe("falling");
  });
});

describe("PetMovement physics", () => {
  it("uses the first and last recent drag samples and caps vector speed", () => {
    expect(dragReleaseVelocity([{ timeMs: 0, foot: { x: 0, y: 0 } }], 0)).toEqual({ x: 0, y: 0 });
    expect(dragReleaseVelocity([
      { timeMs: 0, foot: { x: 0, y: 0 } }, { timeMs: 50, foot: { x: 10, y: 0 } },
      { timeMs: 100, foot: { x: 20, y: 0 } },
    ], 100)).toEqual({ x: 200, y: 0 });
    expect(dragReleaseVelocity([
      { timeMs: 0, foot: { x: 0, y: 0 } }, { timeMs: 100, foot: { x: 1_000, y: 0 } },
    ], 100).x).toBe(MOVEMENT_PHYSICS.maxThrowSpeed);
    expect(dragReleaseVelocity([
      { timeMs: 0, foot: { x: 0, y: 0 } }, { timeMs: 200, foot: { x: 20, y: 0 } },
    ], 200)).toEqual({ x: 0, y: 0 });
  });

  it("gives one large advance the same result as many smaller advances", () => {
    const a = movement();
    const b = movement();
    a.advance(5_000);
    for (let time = 16; time <= 4_992; time += 16) b.advance(time);
    b.advance(5_000);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it("crosses a thin platform without tunneling and never lands while rising", () => {
    const thin = ledge("thin", 100, 300, 400);
    const pet = movement({ x: 150, y: 0 }, { platforms: [thin, ground] });
    pet.advance(700);
    expect(pet.snapshot()).toMatchObject({ state: "landing", foot: { x: 150, y: 400 }, standingPlatformId: "thin" });
    const rising = movement({ x: 150, y: 430 }, { platforms: [thin, ground] });
    rising.startDrag(0, { x: 150, y: 430 });
    rising.sampleDrag(50, { x: 150, y: 420 });
    rising.endDrag(100, { x: 150, y: 410 });
    rising.advance(116);
    expect(rising.snapshot().state).toBe("thrown");
  });

  it("lands on the highest platform crossed in one step and stops horizontal velocity", () => {
    const upper = ledge("upper", 100, 300, 400);
    const lower = ledge("lower", 100, 300, 405);
    const pet = movement({ x: 150, y: 300 }, { platforms: [lower, upper, ground] });
    pet.startDrag(0, { x: 150, y: 300 });
    pet.sampleDrag(50, { x: 155, y: 349.5 });
    pet.endDrag(100, { x: 160, y: 399 });
    pet.advance(116);
    expect(pet.snapshot()).toMatchObject({ state: "landing", standingPlatformId: "upper", velocity: { x: 0, y: 0 } });
  });

  it("stops horizontal flight at a wall without bouncing", () => {
    const wall = ledge("wall", 200, 300, 180);
    const pet = movement({ x: 150, y: 200 }, { platforms: [wall, ground] });
    pet.startDrag(0, { x: 150, y: 200 });
    pet.sampleDrag(50, { x: 170, y: 200 });
    pet.endDrag(100, { x: 190, y: 200 });
    pet.advance(132);
    expect(pet.snapshot().foot.x).toBeLessThan(200);
    expect(pet.snapshot().velocity.x).toBe(0);
  });

  it("passes the floor once only for a downward throw above the threshold", () => {
    const pet = movement({ x: 100, y: 100 });
    pet.startDrag(0, { x: 100, y: 100 });
    pet.sampleDrag(50, { x: 100, y: 180 });
    pet.endDrag(100, { x: 100, y: 260 });
    pet.advance(320);
    expect(pet.snapshot().state).toBe("falling");
    expect(pet.snapshot().foot.y).toBeLessThan(100);
    pet.advance(1_500);
    expect(pet.snapshot().state).toBe("grounded");
    expect(pet.snapshot().foot.y).toBe(560);
    const still = movement({ x: 100, y: 0 });
    still.startDrag(0);
    still.endDrag(10);
    expect(still.advance(1_000).foot.y).toBe(560);
  });

  it("keeps grounded and position unchanged when disabled", () => {
    const pet = movement({ x: 100, y: 200 }, { enabled: false });
    expect(pet.advance(5_000)).toMatchObject({ state: "grounded", foot: { x: 100, y: 200 } });
    const active = movement();
    expect(active.setEnabled(false).state).toBe("grounded");
    expect(active.advance(5_000).foot.y).toBe(200);
  });

  it("uses the configured soft landing duration", () => {
    const pet = movement({ x: 100, y: 550 }, { landing: "soft" });
    pet.advance(112);
    expect(pet.snapshot().state).toBe("landing");
    pet.advance(480);
    expect(pet.snapshot().state).toBe("landing");
    pet.advance(512);
    expect(pet.snapshot().state).toBe("grounded");
  });
});

describe("display edges", () => {
  const throwAcross = (start: { x: number; y: number }, end: { x: number; y: number },
    displays: TerrainDisplay[]) => {
    const pet = movement(start, { displays, platforms: displays.map(floor) });
    pet.startDrag(0, start);
    pet.sampleDrag(50, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
    pet.endDrag(100, end);
    return pet;
  };

  it("wraps left and right for one screen and side-by-side monitors", () => {
    const right = screen(2, 800);
    const pet = throwAcross({ x: 100, y: 100 }, { x: 1, y: 100 }, [base, right]);
    pet.advance(116);
    expect(pet.snapshot().foot.x).toBeGreaterThan(1_500);
    const other = throwAcross({ x: 700, y: 100 }, { x: 799, y: 100 }, [base]);
    other.advance(116);
    expect(other.snapshot().foot.x).toBeLessThan(100);
  });

  it("wraps upward to the lowest work-area floor in a stacked column", () => {
    const bottom = screen(2, 0, 600, 800, 400);
    const pet = throwAcross({ x: 100, y: 150 }, { x: 100, y: 10 }, [base, bottom]);
    pet.advance(116);
    expect(pet.snapshot().foot.y).toBeGreaterThan(900);
    expect(pet.snapshot().velocity.y).toBeLessThan(0);
  });

  it("clamps a staggered monitor gap to the nearest work area", () => {
    const staggered = screen(2, 400, 600, 800, 400);
    const pet = throwAcross({ x: 350, y: 300 }, { x: 450, y: 500 }, [base, staggered]);
    pet.advance(116);
    const { foot } = pet.snapshot();
    expect(foot.y).toBeLessThan(600);
    expect(foot.x).toBeLessThan(800);
  });

  it("keeps speed after a sideways wrap and clamps y into a staggered destination", () => {
    const staggered = screen(2, 800, 300, 800, 600);
    const pet = throwAcross({ x: 100, y: 100 }, { x: 1, y: 100 }, [base, staggered]);
    const before = pet.snapshot().velocity;
    pet.advance(116);
    expect(pet.snapshot().velocity.x).toBe(before.x);
    expect(pet.snapshot().foot.y).toBeGreaterThanOrEqual(300);
    expect(pet.snapshot().foot.x).toBeGreaterThan(1_500);
  });
});

describe("PetMovement behavior values", () => {
  const fallDistance = (extras: Partial<MovementOptions>): number => {
    const pet = movement({ x: 100, y: 100 }, extras);
    return pet.advance(320).foot.y - 100;
  };

  it("falls faster with a larger gravity option and configure applies at once", () => {
    const normal = fallDistance({});
    expect(fallDistance({ gravity: 4_000 })).toBeGreaterThan(normal);
    expect(fallDistance({ gravity: 500 })).toBeLessThan(normal);
    const pet = movement({ x: 100, y: 100 });
    pet.configure({ gravity: 4_000 });
    expect(pet.advance(320).foot.y - 100).toBeCloseTo(fallDistance({ gravity: 4_000 }), 5);
  });

  it("stores jump values and rejects out-of-range configure values without changing anything", () => {
    const pet = movement({ x: 100, y: 200 }, { jumpMaxHeight: 300, jumpClearance: 40 });
    expect(pet.jumpSettings()).toEqual({ jumpMaxHeight: 300, jumpClearance: 40 });
    pet.configure({ jumpMaxHeight: 0 });
    expect(pet.jumpSettings()).toEqual({ jumpMaxHeight: 0, jumpClearance: 40 });
    for (const bad of [{ gravity: 199 }, { climbSpeed: 19 }, { jumpClearance: 301 }, { climbChance: 1.1 }, { jumpMaxHeight: Number.NaN }])
      expect(() => pet.configure({ jumpClearance: 10, ...bad })).toThrow(RangeError);
    expect(pet.jumpSettings()).toEqual({ jumpMaxHeight: 0, jumpClearance: 40 });
    expect(movement().jumpSettings()).toEqual({ jumpMaxHeight: 150, jumpClearance: 24 });
  });
});

describe("PetMovement gap jump (ADR-0009 §18)", () => {
  // The pet stands at the right end of window "a" (y 300) and walks right toward "b".
  const across = (target: TerrainPlatform, extras: Partial<MovementOptions> = {}) => {
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("a", 100, 200, 300), target, ground],
      descendChance: 0, gapJumpChance: 1, random: () => 0, ...extras });
    pet.requestWalk("right", 100);
    return pet;
  };
  const stateAfterStep = (target: TerrainPlatform, extras: Partial<MovementOptions> = {}) => across(target, extras).advance(16).state;
  const finish = (pet: PetMovement): number => {
    let now = 16;
    while (pet.snapshot().state === "jumping" && now < 5_000) { now += 16; pet.advance(now); }
    return now;
  };

  it("jumps at exactly the distance and not one DIP further", () => {
    expect(stateAfterStep(ledge("b", 400, 600, 300))).toBe("jumping");
    expect(stateAfterStep(ledge("b", 401, 600, 300))).not.toBe("jumping");
    expect(stateAfterStep(ledge("b", 301, 600, 300), { gapJumpDistance: 100 })).not.toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 300), { gapJumpDistance: 100 })).toBe("jumping");
  });

  it("requests jump, peaks jumpClearance above the higher top and lands a step inside the far window", () => {
    const pet = across(ledge("b", 300, 600, 300));
    expect(pet.advance(16)).toMatchObject({ state: "jumping", request: "jump" });
    let now = 16;
    let apex = Infinity;
    while (pet.snapshot().state === "jumping") { now += 16; pet.advance(now); apex = Math.min(apex, pet.snapshot().foot.y); }
    expect(apex).toBeCloseTo(300 - MOVEMENT_PHYSICS.jumpClearance, 0);
    expect(pet.snapshot()).toMatchObject({ state: "landing", request: "land", standingPlatformId: "b",
      foot: { x: 340, y: 300 } });
  });

  it("allows a higher far window only up to jumpMaxHeight, and a lower one at any height", () => {
    expect(stateAfterStep(ledge("b", 300, 600, 150))).toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 149))).not.toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 149), { jumpMaxHeight: 151 })).toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 500))).toBe("jumping");
    const high = across(ledge("b", 300, 600, 160));
    high.advance(16);
    let apex = Infinity;
    for (let now = 32; high.snapshot().state === "jumping"; now += 16) { high.advance(now); apex = Math.min(apex, high.snapshot().foot.y); }
    expect(apex).toBeCloseTo(160 - MOVEMENT_PHYSICS.jumpClearance, 0);
    expect(high.snapshot()).toMatchObject({ standingPlatformId: "b", foot: { y: 160 } });
  });

  it("jumps by gapJumpChance: 0 never, 1 always, and the roll uses the configured value", () => {
    expect(stateAfterStep(ledge("b", 300, 600, 300), { gapJumpChance: 0 })).not.toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 300), { gapJumpChance: 0.5, random: () => 0.49 })).toBe("jumping");
    expect(stateAfterStep(ledge("b", 300, 600, 300), { gapJumpChance: 0.5, random: () => 0.5 })).not.toBe("jumping");
  });

  it("falls back to descend and turn-around when it does not jump", () => {
    expect(stateAfterStep(ledge("b", 300, 600, 300), { gapJumpChance: 0, descendChance: 1 })).toBe("climbing-down");
    const turning = across(ledge("b", 300, 600, 300), { gapJumpChance: 0 });
    expect(turning.advance(16).reverseWalk).toBe(true);
  });

  it("never jumps at distance 0, and configure changes the distance and chance at once", () => {
    expect(stateAfterStep(ledge("b", 201, 600, 300), { gapJumpDistance: 0 })).not.toBe("jumping");
    const pet = across(ledge("b", 300, 600, 300), { gapJumpDistance: 0 });
    pet.configure({ gapJumpDistance: 100 });
    expect(pet.advance(16).state).toBe("jumping");
    expect(() => pet.configure({ gapJumpDistance: 1001 })).toThrow(RangeError);
    expect(() => pet.configure({ gapJumpChance: 1.1 })).toThrow(RangeError);
  });

  it("picks the nearest window and ignores windows behind it, touching ones and the floor", () => {
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("a", 100, 200, 300), ledge("far", 350, 600, 300),
      ledge("near", 250, 330, 250), ground], descendChance: 0, gapJumpChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    pet.advance(16);
    finish(pet);
    expect(pet.snapshot().standingPlatformId).toBe("near");
    const behind = movement({ x: 199, y: 300 }, { platforms: [ledge("a", 100, 200, 300), ledge("left", 0, 90, 300), ground],
      descendChance: 0, gapJumpChance: 1, random: () => 0 });
    behind.requestWalk("right", 100);
    expect(behind.advance(16).state).not.toBe("jumping");
  });

  it("jumps leftwards too", () => {
    const pet = movement({ x: 101, y: 300 }, { platforms: [ledge("a", 100, 200, 300), ledge("b", 0, 50, 300), ground],
      descendChance: 0, gapJumpChance: 1, random: () => 0 });
    pet.requestWalk("left", 100);
    expect(pet.advance(16).state).toBe("jumping");
    finish(pet);
    expect(pet.snapshot()).toMatchObject({ state: "landing", standingPlatformId: "b", foot: { x: 25, y: 300 } });
  });

  it("falls when the target window disappears in flight", () => {
    const pet = across(ledge("b", 300, 600, 300));
    pet.advance(16);
    pet.advance(100);
    expect(pet.snapshot().state).toBe("jumping");
    pet.setTerrain([ledge("a", 100, 200, 300), ground], [base]);
    expect(pet.advance(116).state).toBe("falling");
  });
});

describe("PetMovement exceptions during movement (ADR-0009 §19)", () => {
  const wallPet = (top: number, extras: Partial<MovementOptions> = {}) => {
    const pet = movement({ x: 199, y: 560 }, { platforms: [ledge("w", 200, 400, top), ground],
      walls: [body("w", 200, 400, top)], climbChance: 1, random: () => 0, ...extras });
    pet.requestWalk("right", 100);
    return pet;
  };
  const shifted = (dx: number, dy: number) => ({
    platforms: [ledge("w", 200 + dx, 400 + dx, 100 + dy), ground], walls: [body("w", 200 + dx, 400 + dx, 100 + dy)],
  });
  const climbing = () => {
    const pet = wallPet(100);
    pet.advance(432);
    expect(pet.snapshot().state).toBe("climbing");
    return pet;
  };

  it("keeps climbing when the gripped window moves 1 DIP and falls at 2 DIP", () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, -1]] as const) {
      const pet = climbing();
      const before = pet.snapshot().foot;
      const next = shifted(dx, dy);
      expect(pet.setTerrain(next.platforms, [base], next.walls).state).toBe("climbing");
      expect(pet.snapshot().foot).toEqual({ x: before.x + dx, y: before.y + dy });
      expect(pet.advance(448).state).toBe("climbing");
    }
    for (const [dx, dy] of [[2, 0], [0, 2], [0, -2], [-3, 0]] as const) {
      const pet = climbing();
      const before = pet.snapshot().foot;
      const next = shifted(dx, dy);
      expect(pet.setTerrain(next.platforms, [base], next.walls)).toMatchObject({ state: "falling", foot: before });
    }
  });

  it("falls at once when the gripped window closes during a climb", () => {
    expect(climbing().setTerrain([ground], [base], []).state).toBe("falling");
  });

  it("falls where the side is cut off below the window bottom", () => {
    const pet = climbing();
    pet.setTerrain([ledge("w", 200, 400, 100), ground], [base], [body("w", 200, 400, 100, 500)]);
    expect(pet.advance(448).state).toBe("falling");
  });

  it("falls where a higher window covers the side at the foot height", () => {
    const pet = climbing();
    pet.setTerrain([ledge("w", 200, 400, 100), ground], [base], [
      body("w", 200, 400, 100, 300), body("w", 200, 400, 340, 600),
    ]);
    const states = new Set<string>();
    for (let now = 448; now < 5_000; now += 16) states.add(pet.advance(now).state);
    expect(states.has("falling")).toBe(true);
    expect(pet.snapshot().foot.y).toBeGreaterThan(300);
  });

  it("keeps climbing where the side is visible all the way", () => {
    const pet = climbing();
    for (let now = 448; now < 5_000; now += 16) pet.advance(now);
    expect(pet.snapshot()).toMatchObject({ state: expect.stringMatching(/grounded|landing/), standingPlatformId: "w" });
  });

  it("applies the same 1 and 2 DIP boundary to a climb-down and checks its ledge side", () => {
    const down = () => {
      const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("high", 100, 200, 300), ground],
        walls: [body("high", 100, 200, 300, 500)], descendChance: 1, random: () => 0 });
      pet.requestWalk("right", 100);
      expect(pet.advance(16).state).toBe("climbing-down");
      return pet;
    };
    const moved = (dx: number, dy: number) => down().setTerrain([ledge("high", 100 + dx, 200 + dx, 300 + dy), ground],
      [base], [body("high", 100 + dx, 200 + dx, 300 + dy, 500)]).state;
    expect(moved(1, 1)).toBe("climbing-down");
    expect(moved(2, 0)).toBe("falling");
    expect(moved(0, -2)).toBe("falling");
    const pet = down();
    pet.setTerrain([ledge("high", 100, 200, 300), ground], [base], [body("high", 100, 200, 300, 301)]);
    for (let now = 32; now < 400; now += 16) pet.advance(now);
    expect(pet.snapshot().state).toBe("falling");
  });

  it("returns a climb-ready pet to the ground, turned around, when the wall disappears or moves", () => {
    const ready = () => {
      const pet = wallPet(100);
      expect(pet.advance(16).state).toBe("climb-ready");
      return pet;
    };
    const gone = ready();
    expect(gone.setTerrain([ground], [base], [])).toMatchObject({ state: "grounded", reverseWalk: true,
      standingPlatformId: "floor:1" });
    const far = shifted(2, 0);
    expect(ready().setTerrain(far.platforms, [base], far.walls)).toMatchObject({ state: "grounded", reverseWalk: true });
    const near = shifted(1, 0);
    expect(ready().setTerrain(near.platforms, [base], near.walls).state).toBe("climb-ready");
    gone.advance(116);
    expect(gone.snapshot().foot.x).toBeLessThan(199);
  });

  const hopOver = () => {
    const pet = movement({ x: 199, y: 300 }, { platforms: [ledge("a", 100, 200, 300), ledge("b", 300, 600, 300), ground],
      descendChance: 0, gapJumpChance: 1, random: () => 0 });
    pet.requestWalk("right", 100);
    pet.advance(16);
    pet.advance(116);
    expect(pet.snapshot().state).toBe("jumping");
    return pet;
  };

  it("keeps jumping when the target window moves 1 DIP and abandons it at 2 DIP", () => {
    const near = hopOver();
    near.setTerrain([ledge("a", 100, 200, 300), ledge("b", 301, 601, 300), ground], [base]);
    expect(near.advance(132).state).toBe("jumping");
    let now = 132;
    while (near.snapshot().state === "jumping" && now < 5_000) { now += 16; near.advance(now); }
    expect(near.snapshot()).toMatchObject({ state: "landing", standingPlatformId: "b" });
    const far = hopOver();
    far.setTerrain([ledge("a", 100, 200, 300), ledge("b", 300, 600, 302), ground], [base]);
    expect(far.snapshot().state).toBe("falling");
  });

  it("keeps flying after losing the target and lands on another platform or the floor", () => {
    const another = hopOver();
    const speed = another.snapshot().velocity;
    another.setTerrain([ledge("a", 100, 200, 300), ledge("c", 250, 700, 380), ground], [base]);
    expect(another.snapshot()).toMatchObject({ state: "falling", velocity: speed });
    let now = 116;
    while (another.snapshot().state === "falling" && now < 5_000) { now += 16; another.advance(now); }
    expect(another.snapshot()).toMatchObject({ state: "landing", standingPlatformId: "c" });
    const lost = hopOver();
    lost.setTerrain([ledge("a", 100, 200, 300), ground], [base]);
    expect(lost.snapshot().velocity.x).toBeGreaterThan(0);
    now = 116;
    while (lost.snapshot().state !== "landing" && now < 5_000) { now += 16; lost.advance(now); }
    expect(lost.snapshot()).toMatchObject({ standingPlatformId: "floor:1", foot: { y: 560 } });
    expect(lost.snapshot().foot.x).toBeGreaterThan(200);
  });

  it("abandons a hop-down target that disappears or moves 2 DIP and keeps its velocity", () => {
    const hop = () => {
      const pet = movement({ x: 199, y: 400 }, { platforms: [ledge("high", 100, 200, 400), ledge("mid", 200, 500, 500), ground],
        descendChance: 1, random: () => 0 });
      pet.requestWalk("right", 100);
      expect(pet.advance(16).state).toBe("hop-down");
      return pet;
    };
    const lost = hop();
    const velocity = lost.snapshot().velocity;
    expect(lost.setTerrain([ledge("high", 100, 200, 400), ground], [base])).toMatchObject({ state: "falling", velocity });
    const moved = hop();
    expect(moved.setTerrain([ledge("high", 100, 200, 400), ledge("mid", 202, 502, 500), ground], [base]).state).toBe("falling");
    const near = hop();
    expect(near.setTerrain([ledge("high", 100, 200, 400), ledge("mid", 201, 501, 500), ground], [base]).state).toBe("hop-down");
  });
});

describe("setLanding", () => {
  it("changes the length of later landings", () => {
    const length = (landing: "normal" | "soft"): number => {
      const pet = new PetMovement(options({ x: 100, y: 200 }));
      pet.setLanding(landing);
      pet.startDrag(0);
      pet.endDrag(10);
      let ms = 10;
      while (pet.snapshot().state !== "landing") pet.advance(ms += 16);
      const start = ms;
      while (pet.snapshot().state === "landing") pet.advance(ms += 16);
      return ms - start;
    };
    expect(length("soft")).toBeGreaterThanOrEqual(MOVEMENT_PHYSICS.softLandingMs);
    expect(length("soft")).toBeGreaterThan(length("normal"));
    expect(length("normal")).toBeGreaterThanOrEqual(MOVEMENT_PHYSICS.normalLandingMs);
  });
});
