import { displayForPoint, type DisplayArea, type Point, type Rectangle } from "./position.js";

export type BubbleSide = "above" | "below";
export type BubblePlacement = { bounds: Rectangle; side: BubbleSide; tailX: number };

/** Height of the tail strip that the bubble window adds on the pet's side. */
export const BUBBLE_TAIL_HEIGHT = 10;
/** Space between the tail tip and the visible character. */
export const BUBBLE_GAP = 4;
/** The tail tip stays this far from the window's left and right edges so it meets the rounded body. */
export const BUBBLE_TAIL_MARGIN = 18;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.max(minimum, Math.min(value, Math.max(minimum, maximum))));
}

/**
 * Place a bubble window of `size` next to the visible character (`content`, in screen DIP).
 * The bubble stays inside the work area of the display that holds the pet's foot:
 * above the character when it fits, below it otherwise, and pushed in from the side edges.
 * `tailX` is the tail tip measured from the window's left edge, pointing at the character's center.
 */
export function placeBubble(size: { width: number; height: number }, content: Rectangle, foot: Point,
  displays: readonly DisplayArea[]): BubblePlacement {
  const area = displayForPoint(foot, displays).workArea;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const centerX = content.x + content.width / 2;
  const x = clamp(centerX - width / 2, area.x, area.x + area.width - width);
  const aboveY = content.y - BUBBLE_GAP - height;
  const belowY = content.y + content.height + BUBBLE_GAP;
  const bottom = area.y + area.height;
  const side: BubbleSide = aboveY >= area.y ? "above"
    : belowY + height <= bottom ? "below"
      // Neither side fits: use the roomier one and let the bubble overlap the character.
      : content.y - area.y >= bottom - content.y - content.height ? "above" : "below";
  const y = clamp(side === "above" ? aboveY : belowY, area.y, bottom - height);
  const tailX = clamp(centerX - x, Math.min(BUBBLE_TAIL_MARGIN, width / 2), width - BUBBLE_TAIL_MARGIN);
  return { bounds: { x, y, width, height }, side, tailX };
}
