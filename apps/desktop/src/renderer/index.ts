import { pointerToCanvasPixel, startsDrag } from "./pointer.js";
import { shouldMirror } from "./mirror.js";
import type { BadgePlacement } from "../main/settings.js";

const canvas = document.querySelector<HTMLCanvasElement>("#pet");
const context = canvas?.getContext("2d");

if (!canvas || !context) {
  throw new Error("Pet canvas is unavailable");
}
const petCanvas = canvas;
const petContext = context;
const badgeChip = document.querySelector<HTMLElement>("#badge-chip");
const badgeLabel = document.querySelector<HTMLElement>(".badge-label");
const badgeMore = document.querySelector<HTMLElement>(".badge-more");
const badgeTooltip = document.querySelector<HTMLElement>("#badge-tooltip");
if (!badgeChip || !badgeLabel || !badgeMore || !badgeTooltip) throw new Error("Badge elements are unavailable");
const chip = badgeChip;
const label = badgeLabel;
const more = badgeMore;
const tooltip = badgeTooltip;

const ALPHA_THRESHOLD = 1;
let dragging = false;
let activePointerId: number | undefined;
let currentPack: CharacterPayload["pack"];
let currentSnapshot: AnimationSnapshot = { state: "idle", frame: 0, movement: null };
let sheetImages: Record<string, HTMLImageElement> = {};
let badges: DisplayBadge[] = [];
let bubbleVisible = false;
let chipHovered = false;
let chosenBadge: DisplayBadge | undefined;
let badgePointerMoved = false;
let badgePointerStart: { x: number; y: number } | undefined;
let badgeClickResult: Promise<void> | undefined;
let badgePlacement: BadgePlacement = { side: "above", gap: 3 };
let badgeWorkArea: { x: number; y: number; width: number; height: number } | undefined;

function invokeBadge(badge: DisplayBadge): void {
  badgeClickResult = window.pet.clickBadge(badge.pluginId, badge.id);
  void badgeClickResult.catch((error: unknown) => { console.error("Badge action:", error); });
}

function placeBadge(): void {
  if (chip.hidden) return;
  const rect = currentPack?.contentRect ?? { x: 38, y: 47, width: 180, height: 180 };
  const scale = petCanvas.clientWidth / (currentPack ? currentPack.manifest.cellSize[0] * currentPack.manifest.scale : 256);
  const content = { left: petCanvas.offsetLeft + rect.x * scale, right: petCanvas.offsetLeft + (rect.x + rect.width) * scale,
    top: petCanvas.offsetTop + rect.y * scale, centerY: petCanvas.offsetTop + (rect.y + rect.height / 2) * scale };
  const visibleLeft = Math.max(2, (badgeWorkArea?.x ?? window.screenX) - window.screenX + 2);
  const visibleRight = Math.min(window.innerWidth - 2,
    (badgeWorkArea ? badgeWorkArea.x + badgeWorkArea.width - window.screenX : window.innerWidth) - 2);
  const visibleTop = Math.max(2, (badgeWorkArea?.y ?? window.screenY) - window.screenY + 2);
  const visibleBottom = Math.min(window.innerHeight - 2,
    (badgeWorkArea ? badgeWorkArea.y + badgeWorkArea.height - window.screenY : window.innerHeight) - 2);
  const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
  let side = badgePlacement.side;
  const leftX = content.left - badgePlacement.gap - chip.offsetWidth;
  const rightX = content.right + badgePlacement.gap;
  if (side === "left" && leftX < visibleLeft && rightX + chip.offsetWidth <= visibleRight) side = "right";
  if (side === "right" && rightX + chip.offsetWidth > visibleRight && leftX >= visibleLeft) side = "left";
  const left = side === "above" ? (content.left + content.right - chip.offsetWidth) / 2 : side === "left" ? leftX : rightX;
  const top = side === "above" ? content.top - badgePlacement.gap - chip.offsetHeight : content.centerY - chip.offsetHeight / 2;
  chip.style.left = `${clamp(left, visibleLeft, visibleRight - chip.offsetWidth)}px`;
  chip.style.top = `${clamp(top, visibleTop, visibleBottom - chip.offsetHeight)}px`;
  const tooltipLeft = clamp(chip.offsetLeft, visibleLeft, visibleRight - tooltip.offsetWidth);
  const below = chip.offsetTop + chip.offsetHeight;
  const tooltipTop = below + tooltip.offsetHeight <= visibleBottom ? below : chip.offsetTop - tooltip.offsetHeight;
  tooltip.style.left = `${tooltipLeft}px`;
  tooltip.style.top = `${clamp(tooltipTop, visibleTop, visibleBottom - tooltip.offsetHeight)}px`;
}

function renderBadges(): void {
  const visible = badges.filter((badge) => badge.tone !== "ok");
  // The separate bubble window covers the pet's head; hide the chip while it is visible.
  const shown = !bubbleVisible && visible.length > 0;
  chip.hidden = !shown;
  if (!shown) { chosenBadge = undefined; chipHovered = false; tooltip.hidden = true; return; }
  const chosen = [...visible].reverse().find((badge) => badge.tone === "warn") ?? visible.at(-1);
  if (!chosen) return;
  chosenBadge = chosen;
  const characters = Array.from(chosen.text);
  label.textContent = characters.length > 12 ? `${characters.slice(0, 11).join("")}…` : chosen.text;
  more.textContent = visible.length > 1 ? `+${visible.length - 1}` : "";
  chip.dataset.tone = chosen.tone;
  chip.classList.toggle("badge-action", chosen.action !== undefined);
  tooltip.replaceChildren(...badges.map((badge) => {
    const row = document.createElement("div");
    row.className = badge.action === undefined ? "badge-tooltip-row" : "badge-tooltip-row badge-action";
    row.textContent = `${badge.pluginName}: ${badge.text}`;
    if (badge.action !== undefined) row.addEventListener("click", () => invokeBadge(badge));
    return row;
  }));
  tooltip.hidden = !chipHovered;
  placeBadge();
}

chip.addEventListener("mouseenter", () => { chipHovered = true; tooltip.hidden = false; placeBadge(); });
chip.addEventListener("mouseleave", (event) => {
  if (event.relatedTarget instanceof Node && tooltip.contains(event.relatedTarget)) return;
  chipHovered = false; tooltip.hidden = true;
});
tooltip.addEventListener("mouseleave", (event) => {
  if (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
  chipHovered = false; tooltip.hidden = true;
});
// A pointer that starts on the chip never starts a pet drag; movement cancels its click.
chip.addEventListener("pointerdown", (event) => { badgePointerStart = { x: event.clientX, y: event.clientY }; badgePointerMoved = false; });
chip.addEventListener("pointermove", (event) => {
  if (badgePointerStart && Math.hypot(event.clientX - badgePointerStart.x, event.clientY - badgePointerStart.y) > 5)
    badgePointerMoved = true;
});
chip.addEventListener("pointerup", () => { badgePointerStart = undefined; });
chip.addEventListener("click", () => {
  if (!badgePointerMoved && chosenBadge?.action) invokeBadge(chosenBadge);
  badgePointerMoved = false;
});
window.petBadgeClickForTest = async (x, y) => {
  badgeClickResult = undefined;
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof HTMLElement)) return { clicked: false };
  target.click();
  if (badgeClickResult) await badgeClickResult;
  return { clicked: badgeClickResult !== undefined };
};
window.petBadgeDragForTest = async (x, y) => {
  badgeClickResult = undefined;
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof HTMLElement)) return { clicked: false };
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
  target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 20, clientY: y }));
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 20, clientY: y }));
  target.click();
  if (badgeClickResult) await badgeClickResult;
  return { clicked: badgeClickResult !== undefined };
};
window.petBadgeState = () => {
  const rect = chip.hidden ? null : chip.getBoundingClientRect();
  return { visible: !chip.hidden, text: chip.hidden ? null : `${label.textContent}${more.textContent ? ` ${more.textContent}` : ""}`,
    tooltip: tooltip.hidden ? null : badges.map((badge) => `${badge.pluginName}: ${badge.text}`).join("\n"), hovered: chipHovered,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    tooltipRows: tooltip.hidden ? [] : [...tooltip.children].map((row) => {
      const bounds = row.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }) };
};

function prepareCanvas(width: number, height: number): void {
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (petCanvas.width !== pixelWidth || petCanvas.height !== pixelHeight) {
    petCanvas.width = pixelWidth;
    petCanvas.height = pixelHeight;
  }
  petContext.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
  petContext.clearRect(0, 0, width, height);
}

function drawFallback(): void {
  prepareCanvas(256, 256);
  petContext.fillStyle = "#f5b7d2";
  petContext.beginPath();
  petContext.arc(128, 137, 90, 0, Math.PI * 2);
  petContext.fill();
  petContext.fillStyle = "#2b2630";
  petContext.beginPath();
  petContext.arc(99, 125, 7, 0, Math.PI * 2);
  petContext.arc(157, 125, 7, 0, Math.PI * 2);
  petContext.fill();
  petContext.strokeStyle = "#2b2630";
  petContext.lineWidth = 5;
  petContext.lineCap = "round";
  petContext.beginPath();
  petContext.arc(128, 143, 17, 0.12 * Math.PI, 0.88 * Math.PI);
  petContext.stroke();
  placeBadge();
}

function drawFrame(): void {
  if (!currentPack) { drawFallback(); return; }
  const { manifest } = currentPack;
  const state = manifest.states[currentSnapshot.state];
  const image = state ? sheetImages[state.sheet] : undefined;
  if (!state || !image) { drawFallback(); return; }
  const [cellWidth, cellHeight] = manifest.cellSize;
  const width = Math.round(cellWidth * manifest.scale);
  const height = Math.round(cellHeight * manifest.scale);
  prepareCanvas(width, height);
  petContext.imageSmoothingEnabled = false;
  const mirrored = shouldMirror(currentSnapshot.state, state.facing, currentSnapshot);
  if (mirrored) {
    petContext.save();
    petContext.translate(2 * manifest.anchor[0] * manifest.scale, 0);
    petContext.scale(-1, 1);
  }
  petContext.drawImage(image, currentSnapshot.frame * cellWidth, 0, cellWidth, cellHeight,
    0, 0,
    cellWidth * manifest.scale, cellHeight * manifest.scale);
  if (mirrored) petContext.restore();
  placeBadge();
}

async function installCharacter(payload: CharacterPayload): Promise<void> {
  const images: Record<string, HTMLImageElement> = {};
  if (payload.pack) {
    await Promise.all(Object.entries(payload.pack.sheets).map(async ([sheet, url]) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      images[sheet] = image;
    }));
  }
  currentPack = payload.pack;
  sheetImages = images;
  currentSnapshot = payload.snapshot;
  drawFrame();
  window.pet.characterRendered(payload.version);
}

function hitTest(x: number, y: number): { interactive: boolean; alpha: number } {
  if (!chip.hidden) {
    const rect = chip.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return { interactive: true, alpha: 255 };
  }
  if (!tooltip.hidden) {
    const rect = tooltip.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return { interactive: true, alpha: 255 };
  }
  const pixel = pointerToCanvasPixel({ x, y }, petCanvas, { width: petCanvas.clientWidth, height: petCanvas.clientHeight });
  if (!pixel) return { interactive: false, alpha: 0 };
  try {
    const alpha = petContext.getImageData(pixel.x, pixel.y, 1, 1).data[3] ?? 0;
    return { interactive: alpha >= ALPHA_THRESHOLD, alpha };
  } catch (error) {
    console.error("Pixel hit test:", error);
    window.pet.setMousePassThrough(true);
    return { interactive: false, alpha: 0 };
  }
}

window.petHitTest = hitTest;

function updatePassThrough(x: number, y: number): void {
  if (dragging) return;
  try {
    window.pet.setMousePassThrough(!hitTest(x, y).interactive);
  } catch (error) {
    console.error("Pixel hit test:", error);
    window.pet.setMousePassThrough(true);
  }
}

window.addEventListener("mousemove", (event) => updatePassThrough(event.clientX, event.clientY));
window.addEventListener("mouseleave", () => updatePassThrough(-1, -1));

canvas.addEventListener("pointerdown", (event) => {
  if (!startsDrag(event) || !hitTest(event.clientX, event.clientY).interactive) return;
  dragging = true;
  activePointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  window.pet.startDrag();
});

canvas.addEventListener("contextmenu", (event) => {
  // The window only receives the mouse over an opaque pixel, but check again in case the pass-through lagged.
  event.preventDefault();
  if (dragging || !hitTest(event.clientX, event.clientY).interactive) return;
  window.pet.showContextMenu();
});

function endDrag(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointerId) return;
  dragging = false;
  activePointerId = undefined;
  window.pet.endDrag();
  updatePassThrough(event.clientX, event.clientY);
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
window.addEventListener("blur", () => {
  if (!dragging) return;
  dragging = false;
  activePointerId = undefined;
  window.pet.endDrag();
  updatePassThrough(-1, -1);
});

window.pet.onCharacter((payload) => { void installCharacter(payload); });
window.pet.onBadges((next) => { badges = next; renderBadges(); updatePassThrough(-1, -1); });
window.pet.onBadgePlacement((next) => { badgePlacement = next; document.body.classList.toggle("badge-side", next.side !== "above"); document.body.classList.toggle("badge-above", next.side === "above"); drawFrame(); updatePassThrough(-1, -1); });
window.pet.onBubbleVisible((visible) => { bubbleVisible = visible; renderBadges(); updatePassThrough(-1, -1); });
window.pet.onScaleChanged(() => {
  void window.pet.getBadgeDisplay().then((display) => { badgeWorkArea = display.workArea; drawFrame(); });
});
window.addEventListener("resize", drawFrame);
window.pet.onFrame(({ sequence, snapshot }) => {
  currentSnapshot = snapshot;
  drawFrame();
  window.pet.frameRendered(sequence);
});
void window.pet.getCharacter().then(async (payload) => {
  await installCharacter(payload);
  const display = await window.pet.getBadgeDisplay();
  badges = display.badges;
  bubbleVisible = display.bubbleVisible;
  badgePlacement = display.placement;
  badgeWorkArea = display.workArea;
  document.body.classList.toggle("badge-side", badgePlacement.side !== "above"); document.body.classList.toggle("badge-above", badgePlacement.side === "above");
  drawFrame();
  renderBadges();
  window.pet.markReady();
});
