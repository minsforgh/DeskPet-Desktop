import type { MotionKey, MotionLanding } from "@deskpet/core";
import type { PackSaveResult, StatePreviewData } from "../main/pack-service.js";
import type { FieldError } from "../main/settings-service.js";
import { createAnimationPreview, type AnimationPreview } from "./anim-preview.js";

export const MOTION_LABELS: ReadonlyArray<readonly [MotionKey, string]> = [
  ["climb-ready", "오르기 준비"], ["climb", "기어오르기"], ["climb-down", "타고 내려가기"], ["descend", "내려가기"],
  ["jump", "점프"], ["hop-down", "뛰어내리기"], ["fall", "낙하"], ["land", "착지"], ["thrown", "던져짐"],
];
const LANDINGS: ReadonlyArray<readonly [MotionLanding, string, string]> = [
  ["soft", "사뿐", "착지할 때 부드럽게 내려앉아요"],
  ["normal", "일반", "착지할 때 바로 내려앉아요"],
];

export interface MotionsView {
  motions: Partial<Record<MotionKey, { play: string }>>;
  landing: MotionLanding;
  afterLand?: { play: string };
  problems: string[];
  states: string[];
  nonLoopStates: string[];
  resolved: Record<string, string>;
}
export interface MotionsApi {
  motionsSave(payload: { packId: string; motions: { version: 1; motions: Partial<Record<MotionKey, { play: string }>>;
    landing: MotionLanding; afterLand?: { play: string } } }):
    Promise<({ ok: true } & PackSaveResult) | { ok: false; errors: FieldError[] }>;
  statePreview?(payload: { packId: string; state: string }): Promise<StatePreviewData>;
}
export interface MotionsHooks {
  setDirty(dirty: boolean): void;
  saved(result: PackSaveResult): Promise<void>;
}
export interface MotionsController { dirty(): boolean; discard(): void }

function option(doc: Document, label: string, value: string): HTMLOptionElement {
  const element = doc.createElement("option");
  element.textContent = label;
  element.value = value;
  return element;
}

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderMotionsPanel(doc: Document, panel: HTMLElement, view: MotionsView, packId: string,
  api: MotionsApi, hooks: MotionsHooks): MotionsController {
  const editable = view.problems.length === 0 && view.states.length > 0;
  const rows = new Map<MotionKey, { select: HTMLSelectElement; actual: HTMLElement; warning: HTMLElement; preview: HTMLElement;
    play: HTMLButtonElement; animation?: AnimationPreview }>();
  const root = make(doc, "div", "motions-editor");
  root.append(make(doc, "h2", "", "이동"));
  root.append(make(doc, "p", "description", "이동 동작마다 재생할 그림을 고르세요. 고르지 않으면 앱이 알맞은 그림을 골라요."));
  if (!editable) root.append(make(doc, "p", "status error", view.problems.length
    ? "이동 설정 파일에 문제가 있어 이 팩은 여기서 저장할 수 없어요" : "이 팩에는 고를 수 있는 그림이 없어요"));
  const savedMotions: MotionsView["motions"] = view.motions;
  let abandoned = false;
  const note = make(doc, "span", "dirty-note");
  const status = make(doc, "span", "status");
  status.id = "mo-status";
  status.setAttribute("role", "status");
  const landingInputs = new Map<MotionLanding, HTMLInputElement>();
  const readMotions = (): MotionsView["motions"] => {
    const motions: MotionsView["motions"] = {};
    for (const [key, row] of rows) if (row.select.value) motions[key] = { play: row.select.value };
    return motions;
  };
  const readLanding = (): MotionLanding => (landingInputs.get("soft")?.checked ? "soft" : "normal");
  const afterLandSelect = make(doc, "select");
  const readAfterLand = (): { play: string } | undefined => afterLandSelect.value ? { play: afterLandSelect.value } : undefined;
  const snapshot = (): string => JSON.stringify([readMotions(), readLanding(), readAfterLand()]);
  let saved = JSON.stringify([savedMotions, view.landing,
    view.afterLand && view.nonLoopStates.includes(view.afterLand.play) ? view.afterLand : undefined]);
  const changed = (): boolean => snapshot() !== saved;
  const updateDirty = (): void => {
    const dirty = changed();
    note.textContent = dirty ? "저장하지 않은 변경이 있어요" : "";
    hooks.setDirty(dirty);
  };
  /** The state a row will draw, or undefined when only saving can tell (the app's own choice is not known here). */
  const drawn = (key: MotionKey): string | undefined => {
    const row = rows.get(key);
    if (!row) return undefined;
    if (row.select.value) return view.states.includes(row.select.value) ? row.select.value : "idle";
    return savedMotions[key] === undefined ? view.resolved[key] : undefined;
  };
  const refresh = (key: MotionKey): void => {
    const row = rows.get(key);
    if (!row) return;
    row.animation?.stop();
    row.animation = undefined;
    row.preview.replaceChildren();
    const state = drawn(key);
    row.actual.textContent = state === undefined ? "저장하면 앱이 고른 그림으로 돌아가요" : `재생될 그림: ${state}`;
    row.warning.textContent = row.select.value && !view.states.includes(row.select.value) ? "없는 상태예요"
      : state === "idle" ? "idle로 떨어지는 동작이에요" : "";
    row.play.disabled = state === undefined || state === "idle" || !api.statePreview;
  };
  for (const [key, label] of MOTION_LABELS) {
    const row = make(doc, "div", "row motions-row");
    row.dataset.motion = key;
    const title = make(doc, "div", "reactions-title");
    title.append(make(doc, "strong", "", label), make(doc, "span", "description", key));
    const selectLabel = make(doc, "label", "prop", "재생 그림");
    const select = make(doc, "select");
    select.setAttribute("aria-label", `${label} 재생 그림`);
    select.append(option(doc, "기본 (앱이 고름)", ""));
    for (const name of view.states) select.append(option(doc, name, name));
    const mapped = savedMotions[key]?.play;
    if (mapped && !view.states.includes(mapped)) select.append(option(doc, `${mapped} (없음)`, mapped));
    select.value = mapped ?? "";
    select.disabled = !editable;
    selectLabel.append(select);
    const actual = make(doc, "span", "motions-actual");
    const warning = make(doc, "span", "field-error");
    const play = make(doc, "button", "", "▶ 미리보기");
    play.type = "button";
    const preview = make(doc, "div", "reactions-preview");
    play.addEventListener("click", () => {
      const state = drawn(key);
      if (!state || state === "idle" || !api.statePreview) return;
      rows.get(key)?.animation?.stop();
      void api.statePreview({ packId, state }).then((data) => {
        const current = rows.get(key);
        if (abandoned || !current || drawn(key) !== state) return;
        current.animation?.stop();
        current.animation = createAnimationPreview(doc, data);
        preview.replaceChildren(current.animation.element);
      }).catch(() => { preview.textContent = "미리보기를 불러오지 못했어요"; });
    });
    select.addEventListener("change", () => { refresh(key); updateDirty(); });
    row.append(title, selectLabel, actual, warning, play, preview);
    root.append(row);
    rows.set(key, { select, actual, warning, preview, play });
  }
  const landing = make(doc, "fieldset", "motions-landing");
  landing.append(make(doc, "legend", "", "착지 방식"));
  for (const [value, label, hint] of LANDINGS) {
    const item = make(doc, "label", "motions-landing-option");
    const input = make(doc, "input");
    input.type = "radio";
    input.name = "motions-landing";
    input.value = value;
    input.checked = view.landing === value;
    input.disabled = !editable;
    input.addEventListener("change", updateDirty);
    landingInputs.set(value, input);
    item.append(input, make(doc, "span", "", label), make(doc, "span", "description", hint));
    landing.append(item);
  }
  root.append(landing);
  const afterLand = make(doc, "div", "row motions-after-land");
  const afterLandLabel = make(doc, "label", "prop", "착지 후");
  afterLandSelect.setAttribute("aria-label", "착지 후");
  afterLandSelect.append(option(doc, "(없음)", ""));
  for (const name of view.nonLoopStates) afterLandSelect.append(option(doc, name, name));
  const mappedAfterLand = view.afterLand?.play;
  afterLandSelect.value = mappedAfterLand && view.nonLoopStates.includes(mappedAfterLand) ? mappedAfterLand : "";
  afterLandSelect.disabled = !editable;
  afterLandSelect.addEventListener("change", updateDirty);
  afterLandLabel.append(afterLandSelect);
  afterLand.append(afterLandLabel);
  if (mappedAfterLand && !view.nonLoopStates.includes(mappedAfterLand))
    afterLand.append(make(doc, "span", "field-error", `${mappedAfterLand} 상태는 착지 후에 재생할 수 없어요`));
  root.append(afterLand);
  const save = make(doc, "button", "", "저장");
  save.type = "button";
  save.id = "mo-save";
  save.disabled = !editable;
  save.addEventListener("click", () => { void (async () => {
    save.disabled = true;
    try {
      const selected = readAfterLand();
      const result = await api.motionsSave({ packId, motions: { version: 1, motions: readMotions(), landing: readLanding(),
        ...(selected ? { afterLand: selected } : {}) } });
      if (!result.ok) { status.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; status.className = "status error"; return; }
      saved = snapshot();
      updateDirty();
      await hooks.saved(result);
      status.textContent = "저장했어요";
      status.className = "status ok";
    } catch { status.textContent = "저장하지 못했어요"; status.className = "status error"; }
    finally { save.disabled = !editable; }
  })(); });
  const reset = make(doc, "button", "", "기본값으로");
  reset.type = "button";
  reset.id = "mo-reset";
  reset.disabled = !editable;
  reset.addEventListener("click", () => {
    for (const [key, row] of rows) { row.select.value = ""; refresh(key); }
    const normal = landingInputs.get("normal");
    if (normal) normal.checked = true;
    afterLandSelect.value = "";
    updateDirty();
  });
  const actions = make(doc, "div", "actions");
  actions.append(save, reset, note, status);
  root.append(actions);
  panel.replaceChildren(root);
  for (const [key] of MOTION_LABELS) refresh(key);
  updateDirty();
  return { dirty: changed, discard: () => { abandoned = true; for (const row of rows.values()) row.animation?.stop(); hooks.setDirty(false); } };
}
