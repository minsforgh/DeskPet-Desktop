export type PixelPoint = { x: number; y: number };

export function pointerToCanvasPixel(point: PixelPoint, canvasSize: { width: number; height: number },
  cssSize: { width: number; height: number }): PixelPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || cssSize.width <= 0 || cssSize.height <= 0) return null;
  const x = Math.floor(point.x * canvasSize.width / cssSize.width);
  const y = Math.floor(point.y * canvasSize.height / cssSize.height);
  return x >= 0 && y >= 0 && x < canvasSize.width && y < canvasSize.height ? { x, y } : null;
}

/** Only the primary pointer's main (left) button drags the pet; the right button is left for the context menu. */
export function startsDrag(event: { button: number; isPrimary: boolean }): boolean {
  return event.button === 0 && event.isPrimary;
}
