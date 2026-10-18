import type { AnimationSnapshot } from "@deskpet/core";

type Facing = "left" | "right";
type HorizontalBounds = { left: number; right: number };

export function shouldMirror(stateName: string, facing: Facing | undefined, snapshot: AnimationSnapshot): boolean {
  return snapshot.state === stateName && facing !== undefined &&
    snapshot.movement !== null && snapshot.movement.direction !== facing;
}

/** Reflect half-open pixel bounds about the same anchor used by the canvas transform. */
export function mirroredHorizontalBounds(bounds: HorizontalBounds, anchorX: number): HorizontalBounds {
  return { left: 2 * anchorX - bounds.right, right: 2 * anchorX - bounds.left };
}
