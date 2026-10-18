import { expect, test } from "vitest";
import { BUBBLE_GAP, BUBBLE_TAIL_MARGIN, placeBubble } from "./bubble-position.js";
import type { DisplayArea, Rectangle } from "./position.js";

const primary: DisplayArea = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const left: DisplayArea = { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 0, width: 1280, height: 984 }, scaleFactor: 1.5 };
const size = { width: 200, height: 60 };
const footOf = (content: Rectangle) => ({ x: content.x + content.width / 2, y: content.y + content.height });

function inside(bounds: Rectangle, area: Rectangle): boolean {
  return bounds.x >= area.x && bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;
}

test("the bubble sits centered above the visible character when there is room", () => {
  const content = { x: 900, y: 500, width: 180, height: 180 };
  const placed = placeBubble(size, content, footOf(content), [primary]);
  expect(placed).toEqual({ bounds: { x: 890, y: 500 - BUBBLE_GAP - 60, width: 200, height: 60 }, side: "above", tailX: 100 });
});

test("the bubble moves below the character at the top edge", () => {
  const content = { x: 900, y: 0, width: 180, height: 180 };
  const placed = placeBubble(size, content, footOf(content), [primary]);
  expect(placed.side).toBe("below");
  expect(placed.bounds.y).toBe(180 + BUBBLE_GAP);
  // One pixel short of fitting above still selects below; exactly fitting selects above.
  expect(placeBubble(size, { ...content, y: 60 + BUBBLE_GAP - 1 }, footOf(content), [primary]).side).toBe("below");
  expect(placeBubble(size, { ...content, y: 60 + BUBBLE_GAP }, footOf(content), [primary]).bounds.y).toBe(0);
});

test("the bubble stays above at the bottom edge", () => {
  const content = { x: 900, y: 860, width: 180, height: 180 };
  const placed = placeBubble(size, content, footOf(content), [primary]);
  expect(placed.side).toBe("above");
  expect(inside(placed.bounds, primary.workArea)).toBe(true);
});

test("left and right edges push the bubble into the work area and keep the tail on the character", () => {
  const small = { x: 0, y: 500, width: 40, height: 40 };
  const atLeft = placeBubble(size, small, footOf(small), [primary]);
  expect(atLeft.bounds.x).toBe(0);
  expect(atLeft.tailX).toBe(20);
  const atRight = placeBubble(size, { ...small, x: 1880 }, footOf({ ...small, x: 1880 }), [primary]);
  expect(atRight.bounds.x).toBe(1720);
  expect(atRight.tailX).toBe(180);
  const tiny = { x: 0, y: 500, width: 10, height: 10 };
  expect(placeBubble(size, tiny, footOf(tiny), [primary]).tailX).toBe(BUBBLE_TAIL_MARGIN);
  expect(placeBubble(size, { ...tiny, x: 1910 }, footOf({ ...tiny, x: 1910 }), [primary]).tailX).toBe(200 - BUBBLE_TAIL_MARGIN);
});

test("a bubble that fits on neither side stays inside the work area", () => {
  const short: DisplayArea = { ...primary, workArea: { x: 0, y: 0, width: 1920, height: 220 } };
  const content = { x: 900, y: 30, width: 180, height: 180 };
  const placed = placeBubble(size, content, footOf(content), [short]);
  expect(inside(placed.bounds, short.workArea)).toBe(true);
  const huge = placeBubble({ width: 4000, height: 4000 }, content, footOf(content), [short]);
  expect(huge.bounds).toEqual(short.workArea);
});

test("with two monitors the bubble stays on the monitor that holds the pet's foot", () => {
  const displays = [primary, left];
  const onLeft = { x: -700, y: 400, width: 180, height: 180 };
  const placedLeft = placeBubble(size, onLeft, footOf(onLeft), displays);
  expect(inside(placedLeft.bounds, left.workArea)).toBe(true);
  expect(placedLeft.bounds.x).toBe(-710);

  // The character straddles the seam with its foot on the left monitor.
  const straddling = { x: -100, y: 400, width: 180, height: 180 };
  const placedSeam = placeBubble(size, straddling, footOf(straddling), displays);
  expect(inside(placedSeam.bounds, left.workArea)).toBe(true);
  expect(placedSeam.bounds.x + placedSeam.bounds.width).toBe(0);

  // One more step moves the foot, and with it the bubble, onto the primary monitor.
  const crossed = { x: -80, y: 400, width: 180, height: 180 };
  const placedPrimary = placeBubble(size, crossed, { x: 10, y: 580 }, displays);
  expect(inside(placedPrimary.bounds, primary.workArea)).toBe(true);
  expect(placedPrimary.bounds.x).toBe(0);

  // The left monitor's work area is shorter, so its bottom edge is used rather than the primary's.
  const lowLeft = { x: -700, y: 900, width: 180, height: 180 };
  expect(inside(placeBubble(size, lowLeft, footOf(lowLeft), displays).bounds, left.workArea)).toBe(true);
});
