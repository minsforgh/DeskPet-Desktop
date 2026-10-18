export const FOOT_TOLERANCE_PX = 2;
export const OPAQUE_ALPHA_THRESHOLD = 128;
export const FOOT_BAND_HEIGHT_PX = 8;

export interface SpriteFootCheckInput {
  pixels: Uint8Array;
  pixelFormat: "rgba" | "alpha";
  width: number;
  height: number;
  cellSize: readonly [number, number];
  frames: number;
  anchor: readonly [number, number];
}

export interface SpriteFootIssue {
  frame: number;
  reason: string;
  measured?: number | string;
  expected?: number | string;
}

export interface SpriteFootFrameResult {
  frame: number;
  issues: SpriteFootIssue[];
  decorations: number;
}

export function inspectSpriteFootFrame(input: SpriteFootCheckInput, frame: number): SpriteFootFrameResult {
  const { pixels, pixelFormat, width: sheetWidth, cellSize: [width, height], anchor: [anchorX, anchorY] } = input;
  const opaque = new Uint8Array(width * height);
  const issues: SpriteFootIssue[] = [];
  let total = 0;
  let translucentBelow: string | undefined;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = y * sheetWidth + frame * width + x;
    const alpha = pixels[pixelFormat === "rgba" ? pixel * 4 + 3 : pixel] ?? 0;
    if (alpha >= OPAQUE_ALPHA_THRESHOLD) { opaque[y * width + x] = 1; total += 1; }
    else if (alpha > 0 && y > anchorY + FOOT_TOLERANCE_PX && !translucentBelow) translucentBelow = `${x},${y}`;
  }
  const frameNumber = frame + 1;
  if (translucentBelow) issues.push({ frame: frameNumber, reason: "발 아래 반투명 잔여", measured: translucentBelow });
  const visited = new Uint8Array(opaque.length);
  const components: number[][] = [];
  for (let start = 0; start < opaque.length; start += 1) {
    if (!opaque[start] || visited[start]) continue;
    const component: number[] = [];
    const queue = [start];
    visited[start] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      if (index === undefined) continue;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (opaque[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    components.push(component);
  }
  const minimumBodyPixels = Math.max(4, Math.ceil(total * 0.01));
  const bodies = components.filter((component) => component.length >= minimumBodyPixels);
  if (!bodies.length) {
    issues.push({ frame: frameNumber, reason: "empty frame", measured: "no body pixels" });
    return { frame: frameNumber, issues, decorations: 0 };
  }
  let bottomY = -1;
  for (const body of bodies) for (const index of body) bottomY = Math.max(bottomY, Math.floor(index / width));
  if (Math.abs(bottomY - anchorY) > FOOT_TOLERANCE_PX)
    issues.push({ frame: frameNumber, reason: "foot y exceeds tolerance", measured: bottomY, expected: anchorY });
  let minX = width, maxX = -1;
  for (const body of bodies) for (const index of body) {
    if (Math.floor(index / width) >= bottomY - FOOT_BAND_HEIGHT_PX + 1) {
      const x = index % width;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    }
  }
  const centerX = (minX + maxX) / 2;
  if (Math.abs(centerX - anchorX) > FOOT_TOLERANCE_PX)
    issues.push({ frame: frameNumber, reason: "foot x exceeds tolerance", measured: centerX, expected: anchorX });
  const small = components.filter((component) => component.length < minimumBodyPixels);
  for (const component of small) {
    const near = component.find((index) => Math.floor(index / width) > anchorY - FOOT_TOLERANCE_PX);
    if (near !== undefined) issues.push({ frame: frameNumber, reason: "발 근처 잡점",
      measured: `${near % width},${Math.floor(near / width)}` });
  }
  return { frame: frameNumber, issues, decorations: small.length };
}

export function inspectSpriteFootFrames(input: SpriteFootCheckInput): SpriteFootFrameResult[] {
  return Array.from({ length: input.frames }, (_, frame) => inspectSpriteFootFrame(input, frame));
}
