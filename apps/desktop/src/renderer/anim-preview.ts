import type { StatePreviewData } from "../main/pack-service.js";

export interface AnimationPreview {
  element: HTMLElement;
  stop(): void;
}

/** The clock is supplied by the caller so frame progression can be checked without wall time. */
export function frameAt(data: Pick<StatePreviewData, "frames" | "fps" | "loop">, elapsedMs: number): { frame: number; ended: boolean } {
  const index = Math.max(0, Math.floor(elapsedMs * data.fps / 1_000));
  const ended = !data.loop && index >= data.frames - 1;
  return { frame: data.loop ? index % data.frames : Math.min(index, data.frames - 1), ended };
}

/** Canvas playback shared by the 애니메이션, 동작 and 알림 반응 tabs. The returned stop handle cancels the pending frame. */
export function createAnimationPreview(doc: Document, data: StatePreviewData): AnimationPreview {
  const wrapper = doc.createElement("div");
  wrapper.className = "anim-preview";
  const canvas = doc.createElement("canvas");
  canvas.className = "anim-preview-canvas";
  canvas.width = data.cellSize[0];
  canvas.height = data.cellSize[1];
  canvas.dataset.frame = "0";
  const controls = doc.createElement("div");
  controls.className = "anim-preview-controls";
  const replay = doc.createElement("button");
  replay.type = "button";
  replay.textContent = "▶ 다시 재생";
  replay.hidden = true;
  const scale = doc.createElement("select");
  scale.setAttribute("aria-label", "미리보기 크기");
  for (const size of [1, 2, 3]) {
    const option = doc.createElement("option");
    option.value = String(size);
    option.textContent = `${size}배`;
    scale.append(option);
  }
  const background = doc.createElement("button");
  background.type = "button";
  background.textContent = "밝은 배경";
  background.setAttribute("aria-pressed", "false");
  controls.append(replay, scale, background);
  wrapper.append(canvas, controls);
  const context = canvas.getContext("2d");
  const image = doc.createElement("img");
  let handle: number | undefined;
  let started = 0;
  let lastFrame = -1;
  let stopped = false;
  const win = doc.defaultView;
  const stop = (): void => {
    stopped = true;
    if (handle !== undefined) win?.cancelAnimationFrame(handle);
    handle = undefined;
  };
  const draw = (frame: number): void => {
    if (!context || !image.complete || image.naturalWidth === 0) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, frame * data.cellSize[0], 0, data.cellSize[0], data.cellSize[1],
      0, 0, canvas.width, canvas.height);
    canvas.dataset.frame = String(frame);
    lastFrame = frame;
  };
  const tick = (now: number): void => {
    handle = undefined;
    if (stopped || !wrapper.isConnected || wrapper.closest("[hidden]") || doc.hidden) { stop(); return; }
    const next = frameAt(data, now - started);
    if (next.frame !== lastFrame) draw(next.frame);
    if (next.ended) { replay.hidden = false; return; }
    handle = win?.requestAnimationFrame(tick);
  };
  const start = (): void => {
    stop();
    stopped = false;
    started = win?.performance.now() ?? 0;
    lastFrame = -1;
    replay.hidden = true;
    draw(0);
    handle = win?.requestAnimationFrame(tick);
  };
  image.addEventListener("load", start);
  image.src = data.sheet;
  if (image.complete && image.naturalWidth > 0) start();
  replay.addEventListener("click", start);
  scale.addEventListener("change", () => {
    const size = Number(scale.value);
    canvas.style.width = `${data.cellSize[0] * size}px`;
    canvas.style.height = `${data.cellSize[1] * size}px`;
  });
  background.addEventListener("click", () => {
    const light = background.getAttribute("aria-pressed") !== "true";
    background.setAttribute("aria-pressed", String(light));
    background.textContent = light ? "어두운 배경" : "밝은 배경";
    wrapper.classList.toggle("anim-preview-light", light);
  });
  return { element: wrapper, stop };
}
