const bubble = document.querySelector<HTMLElement>("#bubble");
const text = document.querySelector<HTMLElement>("#text");
const body = document.querySelector<HTMLElement>("#body");
const actions = document.querySelector<HTMLElement>("#actions");
const tail = document.querySelector<HTMLElement>("#tail");
const content = document.querySelector<HTMLElement>("#content");
const detail = document.querySelector<HTMLElement>("#detail");
const expandHint = document.querySelector<HTMLElement>("#expand-hint");
const close = document.querySelector<HTMLButtonElement>("#close");

if (!bubble || !body || !text || !actions || !tail || !content || !detail || !expandHint || !close) {
  throw new Error("Bubble elements are unavailable");
}
const bubbleElement = bubble;
const bodyElement = body;
const textElement = text;
const actionsElement = actions;
const tailElement = tail;
const contentElement = content;
const detailElement = detail;
const expandHintElement = expandHint;
const closeElement = close;
const actionBridge = window.bubble as typeof window.bubble & { chooseAction(index: number): void };
let fullText = "";
type LineParts = import("@deskpet/core").LineParts;
let closedParts: LineParts | undefined;
let expandedParts: LineParts | undefined;
let truncated = false;
let drawnLines = 1;
let expanded = false;
let expandable = false;
let detailText = "";
let currentVersion = -1;
let currentSequence = 0;
let maxHeightDip = 0;
let clickResult: Promise<boolean> = Promise.resolve(false);

function textLines(): number {
  const style = getComputedStyle(textElement);
  const height = textElement.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.max(1, Math.round(height / parseFloat(style.lineHeight)));
}

/** The expanded body shows about ten lines, or less where the work area is shorter; the rest scrolls. */
const EXPANDED_VISIBLE_LINES = 10;
function contentCap(chrome: number): string {
  const lineHeight = parseFloat(getComputedStyle(textElement).lineHeight);
  return `${Math.max(1, Math.min(maxHeightDip - chrome, lineHeight * EXPANDED_VISIBLE_LINES))}px`;
}

function box(element: Element): { x: number; y: number; width: number; height: number } {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function paint(value: string, parts?: LineParts): void {
  if (!parts) { textElement.textContent = value; return; }
  textElement.replaceChildren();
  for (const name of ["prefix", "content", "suffix"] as const) {
    if (!parts[name]) continue;
    const block = document.createElement("div");
    block.className = "line-part";
    block.dataset.part = name;
    block.textContent = parts[name];
    textElement.append(block);
  }
}

function paintedParts(): LineParts | null {
  if (!textElement.querySelector("[data-part]")) return null;
  return { prefix: textElement.querySelector('[data-part="prefix"]')?.textContent ?? "",
    content: textElement.querySelector('[data-part="content"]')?.textContent ?? "",
    suffix: textElement.querySelector('[data-part="suffix"]')?.textContent ?? "" };
}

/** Only the painted body and tail take clicks; the transparent strip and corners pass through. */
function hitTest(x: number, y: number): boolean {
  const element = document.elementFromPoint(x, y);
  return element === bodyElement || element === textElement || (element !== null && textElement.contains(element)) || element === tailElement ||
    element === contentElement || element === detailElement || element === expandHintElement ||
    element === closeElement || element === actionsElement || element?.parentElement === actionsElement;
}

window.bubbleHitTest = hitTest;
window.bubbleContainsText = (value) => expanded &&
  (textElement.textContent === value || (detailElement.offsetParent !== null && detailElement.textContent === value));
window.bubbleMetrics = () => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  box: box(bubbleElement),
  textBox: box(textElement),
  body: box(bodyElement),
  tail: box(tailElement),
  buttons: Array.from(actionsElement.querySelectorAll("button"), (button) =>
    ({ label: button.textContent ?? "", box: box(button),
      clipped: button.scrollWidth > button.clientWidth || button.scrollHeight > button.clientHeight,
      overflow: { width: button.scrollWidth - button.clientWidth, height: button.scrollHeight - button.clientHeight } })),
  textContent: textElement.textContent ?? "",
  parts: paintedParts(),
  partBoxes: Object.fromEntries(Array.from(textElement.querySelectorAll<HTMLElement>("[data-part]"), (part) =>
    [part.dataset.part ?? "", box(part)])),
  lines: drawnLines,
  truncated,
  expanded,
  expandable,
  detailVisible: detailElement.offsetParent !== null,
  closeVisible: closeElement.offsetParent !== null,
  closeBox: box(closeElement),
  hintVisible: expandHintElement.offsetParent !== null,
  scroll: { height: contentElement.scrollHeight, clientHeight: contentElement.clientHeight,
    overflowY: getComputedStyle(contentElement).overflowY, top: contentElement.scrollTop },
  textChildElements: textElement.childElementCount,
  elements: document.body.querySelectorAll("*").length,
  overflow: { width: textElement.scrollWidth - textElement.clientWidth, height: textElement.scrollHeight - textElement.clientHeight },
  fontFamily: getComputedStyle(textElement).fontFamily,
});

function measure(): { width: number; height: number } {
  const { width, height } = bubbleElement.getBoundingClientRect();
  return { width, height };
}

async function toggle(): Promise<boolean> {
  if (!expandable) { window.bubble.dismiss(); return false; }
  expanded = !expanded;
  paint(expanded ? fullText : closedText, expanded ? expandedParts : closedParts);
  detailElement.textContent = expanded && detailText !== fullText ? detailText : "";
  contentElement.classList.toggle("expanded", expanded);
  contentElement.classList.toggle("detail-only", !expanded && !truncated && !!detailText);
  closeElement.classList.toggle("visible", expanded);
  contentElement.scrollTop = 0;
  if (expanded) {
    contentElement.style.removeProperty("--bubble-content-max-height");
    const natural = measure().height;
    const contentHeight = contentElement.getBoundingClientRect().height;
    contentElement.style.setProperty("--bubble-content-max-height", contentCap(natural - contentHeight));
  }
  drawnLines = textLines();
  const resize = { sequence: currentSequence, expanded, ...measure() };
  await window.bubble.resized(resize);
  return true;
}

let closedText = "";
window.bubbleClickText = () => { textElement.click(); return clickResult; };
window.bubbleClickHint = () => { expandHintElement.click(); return clickResult; };
window.bubble.onClear(() => {
  fullText = "";
  detailText = "";
  closedText = "";
  closedParts = undefined;
  expandedParts = undefined;
  expanded = false;
  expandable = false;
  currentVersion = -1;
  textElement.textContent = "";
  detailElement.textContent = "";
  contentElement.classList.remove("expanded", "detail-only");
  closeElement.classList.remove("visible");
});

window.bubble.onRender((payload) => {
  const { sequence, version, text: value, side, tailX, maxWidthDip, maxLines } = payload;
  const fresh = version !== currentVersion;
  currentVersion = version;
  currentSequence = sequence;
  maxHeightDip = payload.maxHeightDip;
  // The event text is data, never markup.
  fullText = payload.fullText ?? value;
  closedParts = payload.parts;
  expandedParts = payload.parts === undefined ? undefined : {
    prefix: payload.parts.prefix,
    content: fullText.slice(payload.parts.prefix ? payload.parts.prefix.length + 1 : 0,
      payload.parts.suffix ? -payload.parts.suffix.length - 1 : undefined),
    suffix: payload.parts.suffix,
  };
  detailText = payload.detail ?? "";
  bubbleElement.style.width = "max-content";
  bubbleElement.style.setProperty("--bubble-max-width", `${maxWidthDip}px`);
  if (fresh) expanded = false;
  truncated = false;
  paint(value, closedParts);
  detailElement.textContent = "";
  contentElement.classList.remove("expanded", "detail-only");
  closeElement.classList.remove("visible");
  contentElement.style.removeProperty("--bubble-content-max-height");
  actionsElement.replaceChildren();
  const labels = "labels" in payload && Array.isArray(payload.labels) ? payload.labels : [];
  for (const [index, label] of labels.slice(0, 3).entries()) {
    if (typeof label !== "string") continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => actionBridge.chooseAction(index));
    actionsElement.append(button);
  }
  // Preserve the full-layout width while shortening text, so truncation cannot cause a narrower second wrap.
  bubbleElement.style.width = `${Math.ceil(bubbleElement.getBoundingClientRect().width)}px`;
  if (textLines() > maxLines) {
    const characters = Array.from(closedParts?.content ?? value);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (closedParts) paint(value, { ...closedParts, content: `${characters.slice(0, middle).join("")}…` });
      else paint(`${characters.slice(0, middle).join("")}…`);
      if (textLines() <= maxLines) low = middle;
      else high = middle - 1;
    }
    if (closedParts) closedParts = { ...closedParts, content: `${characters.slice(0, low).join("")}…` };
    paint(closedParts ? value : `${characters.slice(0, low).join("")}…`, closedParts);
    truncated = true;
  }
  if (closedParts && fullText !== value) truncated = true;
  closedText = textElement.textContent ?? "";
  expandable = truncated || fullText !== value || (!!detailText && detailText !== fullText);
  if (expanded) {
    paint(fullText, expandedParts);
    detailElement.textContent = detailText !== fullText ? detailText : "";
    contentElement.classList.add("expanded");
    closeElement.classList.add("visible");
    const natural = measure().height;
    const contentHeight = contentElement.getBoundingClientRect().height;
    contentElement.style.setProperty("--bubble-content-max-height", contentCap(natural - contentHeight));
  } else {
    contentElement.classList.toggle("detail-only", !truncated && expandable);
  }
  drawnLines = textLines();
  document.body.classList.toggle("below", side === "below");
  bubbleElement.style.setProperty("--tail-x", `${tailX}px`);
  const { width, height } = measure();
  window.bubble.rendered({ sequence, width, height });
});

window.addEventListener("mousemove", (event) => window.bubble.setMousePassThrough(!hitTest(event.clientX, event.clientY)));
window.addEventListener("mouseleave", () => window.bubble.setMousePassThrough(true));
bubbleElement.addEventListener("click", (event) => {
  if (event.target === expandHintElement || (event.target instanceof Node && textElement.contains(event.target))) clickResult = toggle();
  else if (event.target === tailElement || event.target === closeElement) window.bubble.dismiss();
});

window.bubble.markReady();
