import { SequencePlayer, stateNamePattern, validSequenceId, type SequenceItem } from "@deskpet/core";
import type { FieldError, InteractionTryResult } from "../main/settings-service.js";
import type { PackSaveResult, StatePreviewData } from "../main/pack-service.js";
import { createAnimationPreview, type AnimationPreview } from "./anim-preview.js";

export interface SequencesApi {
  sequencesSave(payload: { packId: string; sequences: unknown }): Promise<({ ok: true } & PackSaveResult) | { ok: false; errors: FieldError[] }>;
  interactionsTry(payload: unknown): Promise<InteractionTryResult>;
  statePreview?(payload: { packId: string; state: string }): Promise<StatePreviewData>;
}
export interface SequencesHooks {
  setDirty(dirty: boolean): void;
  saved(result: PackSaveResult): Promise<void>;
}
/** What the tab draws from: the pack's sequences, the names a step may play, and the interactions that point at a sequence. */
export interface SequencesView {
  sequences: SequenceItem[];
  plays: Record<string, { resolved: string; cycleMs: number }>;
  refs: Array<{ id: string; label: string; sequence: string }>;
}

export const SEQUENCE_MAX_ITEMS = 32;
export const SEQUENCE_MAX_STEPS = 8;
export const SEQUENCE_MIN_STEP_MS = 300;
export const SEQUENCE_MAX_STEP_MS = 10_000;
export const SEQUENCE_MAX_TOTAL_MS = 30_000;
export const SEQUENCE_MAX_TEXT = 120;
export const SEQ_SAVED_TEXT = "저장했어요";
export const SEQ_FIX_TEXT = "저장하지 못했어요. 표시된 항목을 고치세요";
export const SEQ_DIRTY_TEXT = "저장하지 않은 변경이 있어요";

interface StepRow { play: string; sec: string; say: string }
interface SequenceRow { key: number; savedId?: string; id: string; label: string; steps: StepRow[] }

const BAD_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
const length = (text: string): number => Array.from(text).length;
const seconds = (ms: number): string => String(ms / 1000);
/** Seconds typed by the user as whole milliseconds; undefined when blank (use the state's own cycle). */
export function stepMs(sec: string): number | undefined | "invalid" {
  if (sec.trim() === "") return undefined;
  const value = Number(sec);
  if (!Number.isFinite(value)) return "invalid";
  const ms = Math.round(value * 1000);
  return ms < SEQUENCE_MIN_STEP_MS || ms > SEQUENCE_MAX_STEP_MS ? "invalid" : ms;
}

/** Total playing time with the runner's rules: a blank length is one cycle of the resolved state, at least 300 ms. */
export function totalMs(steps: readonly { play: string; sec: string }[], plays: SequencesView["plays"]): number {
  let total = 0;
  for (const step of steps) {
    const ms = stepMs(step.sec);
    total += typeof ms === "number" ? ms : Math.max(SEQUENCE_MIN_STEP_MS, Math.round(plays[step.play]?.cycleMs ?? SEQUENCE_MIN_STEP_MS));
  }
  return total;
}

export function sequenceProblem(row: SequenceRow, rows: readonly SequenceRow[]): string | undefined {
  if (!validSequenceId(row.id)) return "id는 영문 소문자·숫자·-로 48자 이하여야 해요";
  if (rows.some((other) => other !== row && other.id === row.id)) return "같은 id가 이미 있어요";
  if (length(row.label) > SEQUENCE_MAX_TEXT || BAD_TEXT.test(row.label)) return `이름은 ${SEQUENCE_MAX_TEXT}자 이하여야 해요`;
  if (row.steps.length < 1 || row.steps.length > SEQUENCE_MAX_STEPS) return `단계는 1~${SEQUENCE_MAX_STEPS}개여야 해요`;
  for (const [index, step] of row.steps.entries()) {
    const at = `${index + 1}단계: `;
    if (!stateNamePattern.test(step.play) || step.play === "walk" || step.play === "drag") return `${at}재생 동작이 올바르지 않아요`;
    if (stepMs(step.sec) === "invalid") return `${at}시간은 0.3~10초여야 해요`;
    if (length(step.say) > SEQUENCE_MAX_TEXT || BAD_TEXT.test(step.say)) return `${at}대사는 ${SEQUENCE_MAX_TEXT}자 이하여야 해요`;
  }
  return undefined;
}

const packData = (rows: readonly SequenceRow[]) => ({ version: 1, sequences: rows.map((row) => ({ id: row.id,
  ...(row.label.trim() !== "" ? { label: row.label.trim() } : {}),
  steps: row.steps.map((step) => {
    const ms = stepMs(step.sec);
    return { play: step.play, ...(typeof ms === "number" ? { ms } : {}), ...(step.say.trim() !== "" ? { say: step.say.trim() } : {}) };
  }) })) });

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(doc: Document, className: string, text: string, click: () => void): HTMLButtonElement {
  const element = make(doc, "button", className, text);
  element.type = "button";
  element.addEventListener("click", click);
  return element;
}

/** All pack strings (ids, labels, speech, interaction names) are assigned through textContent or value, never as markup. */
export function renderSequencesPanel(doc: Document, panel: HTMLElement, initial: SequencesView, packId: string,
  api: SequencesApi, hooks: SequencesHooks): void {
  let currentPreview: AnimationPreview | undefined;
  let previewFrame: number | undefined;
  const win = doc.defaultView;
  const stopPreview = (): void => {
    if (previewFrame !== undefined) win?.cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
    currentPreview?.stop();
    currentPreview = undefined;
  };
  const plays = initial.plays;
  const playNames = Object.keys(plays).sort();
  const refs = initial.refs;
  let nextKey = 1;
  const toRow = (item: SequenceItem): SequenceRow => ({ key: nextKey++, savedId: item.id, id: item.id, label: item.label ?? "",
    steps: item.steps.map((step) => ({ play: step.play, sec: step.ms === undefined ? "" : seconds(step.ms), say: step.say ?? "" })) });
  let rows = initial.sequences.map(toRow);
  const snapshot = (): string => JSON.stringify(rows.map(({ savedId, id, label, steps }) => ({ savedId, id, label, steps })));
  let baseline = snapshot();
  const opened = new Set<number>();
  const errors = new Map<number, string>();
  const refsOf = (row: SequenceRow): string[] => row.savedId === undefined ? []
    : refs.filter(({ sequence }) => sequence === row.savedId).map(({ label }) => label);

  const heading = make(doc, "h2", "", "동작");
  const intro = make(doc, "p", "description",
    "여러 단계로 이어지는 동작이에요. 상호작용의 '동작(시퀀스)'에서 골라 연결하면 우클릭 메뉴에서 실행돼요.");
  const list = make(doc, "div", "ix-list sq-list");
  const add = button(doc, "", "+ 새 동작", () => {
    if (rows.length >= SEQUENCE_MAX_ITEMS) return;
    let number = 1;
    while (rows.some(({ id }) => id === `sequence-${number}`)) number += 1;
    const row: SequenceRow = { key: nextKey++, id: `sequence-${number}`, label: "새 동작",
      steps: [{ play: playNames.includes("happy") ? "happy" : playNames[0] ?? "idle", sec: "", say: "" }] };
    rows.push(row);
    opened.add(row.key);
    draw();
  });
  add.id = "sq-add";
  const cancel = button(doc, "", "취소", () => { rows = (JSON.parse(baseline) as Array<Omit<SequenceRow, "key">>).map((row) => ({ ...row, key: nextKey++ }));
    errors.clear(); opened.clear(); draw(); });
  cancel.id = "sq-cancel";
  const save = button(doc, "", "저장", () => { void saveRows(); });
  save.id = "sq-save";
  const note = make(doc, "span", "dirty-note");
  note.id = "sq-dirty";
  const status = make(doc, "p", "status");
  status.id = "sq-status";
  status.setAttribute("role", "status");
  const actions = make(doc, "div", "actions");
  actions.append(add, cancel, save, note);
  panel.replaceChildren(heading, intro, list, actions, status);

  const setStatus = (value: string, kind: "" | "ok" | "error"): void => {
    status.textContent = value;
    status.classList.remove("ok", "error");
    if (kind) status.classList.add(kind);
  };
  const refreshDirty = (): void => {
    const dirty = snapshot() !== baseline;
    note.textContent = dirty ? SEQ_DIRTY_TEXT : "";
    hooks.setDirty(dirty);
    cancel.disabled = !dirty;
  };
  const move = (row: SequenceRow, direction: -1 | 1): void => {
    const from = rows.indexOf(row);
    const to = from + direction;
    if (to < 0 || to >= rows.length) return;
    rows[from] = rows[to] as SequenceRow;
    rows[to] = row;
    draw();
  };

  const drawStep = (row: SequenceRow, step: StepRow, index: number, warn: () => void, summary: () => void): HTMLElement => {
    const line = make(doc, "div", "sq-step");
    line.append(make(doc, "span", "sq-step-number", `${index + 1}`));
    const play = make(doc, "select", "sq-play");
    play.setAttribute("aria-label", `재생 동작 (${index + 1}단계)`);
    for (const name of new Set([...playNames, step.play])) {
      const option = make(doc, "option", "", name);
      option.value = name;
      play.append(option);
    }
    play.value = step.play;
    const resolvedNote = make(doc, "span", "rule-note sq-resolved");
    const updateResolved = (): void => {
      const resolved = plays[step.play]?.resolved;
      resolvedNote.textContent = resolved !== undefined && resolved !== step.play ? `→ ${resolved}`
        : plays[step.play] === undefined ? "이 팩에 없는 동작이라 idle로 재생돼요" : "";
    };
    updateResolved();
    play.addEventListener("change", () => { step.play = play.value; updateResolved(); warn(); summary(); refreshDirty(); });
    const sec = make(doc, "input", "sq-sec");
    sec.type = "number";
    sec.min = "0.3";
    sec.max = "10";
    sec.step = "0.1";
    sec.placeholder = "자동";
    sec.value = step.sec;
    sec.setAttribute("aria-label", `시간 초 (${index + 1}단계)`);
    sec.addEventListener("input", () => { step.sec = sec.value; warn(); summary(); refreshDirty(); });
    const say = make(doc, "input", "sq-say");
    say.type = "text";
    say.value = step.say;
    say.placeholder = "말풍선 대사 (없으면 비움)";
    say.setAttribute("aria-label", `대사 (${index + 1}단계)`);
    const count = make(doc, "span", "rule-note ix-counts", `${length(step.say)}/${SEQUENCE_MAX_TEXT}`);
    say.addEventListener("input", () => { step.say = say.value; count.textContent = `${length(say.value)}/${SEQUENCE_MAX_TEXT}`; refreshDirty(); });
    const send = button(doc, "sq-try", "▶ 펫에게 보내기", () => {
      void (async () => {
        const text = step.say.trim();
        if (!stateNamePattern.test(step.play) || length(text) > SEQUENCE_MAX_TEXT || BAD_TEXT.test(text)) { setStatus("이 단계를 보낼 수 없어요", "error"); return; }
        const preview = { id: "sequence-preview", label: "미리보기", mood: "neutral", speak: text !== "", lines: text === "" ? [] : [text], play: step.play };
        try { const result = await api.interactionsTry(preview); setStatus(result.ok ? "펫에게 보냈어요" : result.message, result.ok ? "ok" : "error"); }
        catch { setStatus("보내지 못했어요", "error"); }
      })();
    });
    const up = button(doc, "sq-step-up", "▲", () => { const other = row.steps[index - 1]; if (!other) return; row.steps[index - 1] = step; row.steps[index] = other; draw(); });
    up.disabled = index === 0;
    const down = button(doc, "sq-step-down", "▼", () => { const other = row.steps[index + 1]; if (!other) return; row.steps[index + 1] = step; row.steps[index] = other; draw(); });
    down.disabled = index === row.steps.length - 1;
    const remove = button(doc, "sq-step-delete", "삭제", () => { row.steps.splice(index, 1); draw(); });
    remove.disabled = row.steps.length <= 1;
    line.append(play, resolvedNote, make(doc, "span", "rule-note", "초"), sec, say, count, send, up, down, remove);
    return line;
  };

  const drawRow = (row: SequenceRow): HTMLElement => {
    const section = make(doc, "section", "ix-section sq-row");
    section.dataset.id = row.id;
    const header = make(doc, "div", "ix-heading");
    const title = button(doc, "ix-toggle sq-toggle", row.label.trim() || row.id, () => { if (opened.has(row.key)) opened.delete(row.key); else opened.add(row.key); draw(); });
    title.setAttribute("aria-expanded", String(opened.has(row.key)));
    const summaryText = make(doc, "span", "ix-line-count sq-summary");
    const at = rows.indexOf(row);
    const up = button(doc, "ix-up sq-up", "▲", () => move(row, -1));
    up.disabled = at === 0;
    const down = button(doc, "ix-down sq-down", "▼", () => move(row, 1));
    down.disabled = at === rows.length - 1;
    const remove = button(doc, "sq-delete", "삭제", () => {
      const users = refsOf(row);
      rows = rows.filter((entry) => entry !== row);
      errors.delete(row.key);
      draw();
      setStatus(users.length ? `삭제했어요. 이 동작을 쓰던 상호작용(${users.join(", ")})은 저장하면 시퀀스 없이 동작해요` : "삭제했어요", "");
    });
    header.append(title, summaryText, up, down, remove);
    section.append(header);
    const body = make(doc, "div", "ix-body");
    body.hidden = !opened.has(row.key);

    const idBox = make(doc, "label", "prop ix-label-box");
    idBox.append(make(doc, "span", "prop-title", "id (영문 소문자·숫자·-)"));
    const id = make(doc, "input", "sq-id");
    id.type = "text";
    id.value = row.id;
    idBox.append(id);
    const labelBox = make(doc, "label", "prop ix-label-box");
    labelBox.append(make(doc, "span", "prop-title", `이름 (최대 ${SEQUENCE_MAX_TEXT}자)`));
    const label = make(doc, "input", "sq-label");
    label.type = "text";
    label.value = row.label;
    labelBox.append(label);
    const refsNote = make(doc, "div", "rule-note sq-refs");
    const updateRefs = (): void => {
      const users = refsOf(row);
      const changed = row.savedId !== undefined && row.id !== row.savedId;
      refsNote.textContent = users.length === 0 ? ""
        : changed ? `id를 바꾸면 이 동작을 쓰는 상호작용(${users.join(", ")})의 연결이 끊겨요`
          : `이 동작을 쓰는 상호작용: ${users.join(", ")}`;
    };
    id.addEventListener("input", () => { row.id = id.value; section.dataset.id = row.id; if (!label.value.trim()) title.textContent = row.id; updateRefs(); refreshDirty(); });
    label.addEventListener("input", () => { row.label = label.value; title.textContent = row.label.trim() || row.id; refreshDirty(); });
    updateRefs();
    body.append(idBox, labelBox, refsNote);

    const warning = make(doc, "div", "rule-note sq-warn");
    const summary = (): void => {
      const total = totalMs(row.steps, plays);
      summaryText.textContent = `${row.steps.length}단계 · ${seconds(total)}초`;
    };
    const warn = (): void => {
      const total = totalMs(row.steps, plays);
      const parts: string[] = [];
      if (row.steps.length >= SEQUENCE_MAX_STEPS) parts.push(`단계는 최대 ${SEQUENCE_MAX_STEPS}개예요`);
      if (total > SEQUENCE_MAX_TOTAL_MS) parts.push(`총 ${seconds(total)}초예요. ${SEQUENCE_MAX_TOTAL_MS / 1000}초를 넘는 뒷부분은 실행되지 않아요`);
      warning.textContent = parts.join(" · ");
    };
    const steps = make(doc, "div", "sq-steps");
    row.steps.forEach((step, index) => steps.append(drawStep(row, step, index, warn, summary)));
    const addStep = button(doc, "sq-add-step", "+ 단계 추가", () => {
      if (row.steps.length >= SEQUENCE_MAX_STEPS) return;
      row.steps.push({ play: row.steps.at(-1)?.play ?? "idle", sec: "", say: "" });
      draw();
    });
    addStep.disabled = row.steps.length >= SEQUENCE_MAX_STEPS;
    summary();
    warn();
    const error = make(doc, "div", "field-error ix-error", errors.get(row.key) ?? "");
    error.setAttribute("role", "alert");
    const previewArea = make(doc, "div", "sq-preview-area");
    const previewState = make(doc, "p", "sq-preview-state");
    const previewSay = make(doc, "p", "sq-preview-say");
    const previewCanvas = make(doc, "div", "sq-preview-canvas");
    previewArea.append(previewState, previewCanvas, previewSay);
    const previewButton = button(doc, "sq-preview", "▶ 미리보기", () => {
      const loadPreview = api.statePreview;
      if (!loadPreview) return;
      stopPreview();
      previewArea.replaceChildren(previewState, previewCanvas, previewSay);
      previewState.textContent = "";
      previewSay.textContent = "";
      const player = new SequencePlayer();
      const start = win?.performance.now() ?? 0;
      player.start(row.steps.map((step) => {
        const resolved = plays[step.play]?.resolved ?? "idle";
        const ms = stepMs(step.sec);
        return { play: resolved === "walk" || resolved === "drag" ? "idle" : resolved,
          cycleMs: plays[step.play]?.cycleMs ?? SEQUENCE_MIN_STEP_MS,
          ...(typeof ms === "number" ? { ms } : {}), ...(step.say.trim() ? { say: step.say } : {}) };
      }), start);
      let generation = 0;
      const tick = (now: number): void => {
        previewFrame = undefined;
        if (!previewArea.isConnected || previewArea.closest("[hidden]") || doc.hidden) { stopPreview(); return; }
        for (const event of player.tick(now)) {
          generation += 1;
          currentPreview?.stop();
          currentPreview = undefined;
          previewCanvas.replaceChildren();
          if (event.type === "end") {
            previewState.textContent = "끝남";
            previewSay.textContent = "";
            return;
          }
          previewState.textContent = event.play;
          previewSay.textContent = event.say ?? "";
          const request = generation;
          void loadPreview({ packId, state: event.play }).then((data) => {
            if (request !== generation || !previewArea.isConnected) return;
            currentPreview = createAnimationPreview(doc, data);
            previewCanvas.replaceChildren(currentPreview.element);
          }).catch(() => { if (request === generation) previewCanvas.textContent = "그림을 불러오지 못했어요"; });
        }
        if (player.active) previewFrame = win?.requestAnimationFrame(tick);
      };
      previewFrame = win?.requestAnimationFrame(tick);
    });
    body.append(steps, addStep, warning, previewButton, previewArea, error);
    section.append(body);
    return section;
  };
  const draw = (): void => {
    stopPreview();
    list.replaceChildren(...rows.map(drawRow));
    if (rows.length === 0) list.append(make(doc, "p", "description", "아직 동작이 없어요. '+ 새 동작'으로 만들어 보세요."));
    add.disabled = rows.length >= SEQUENCE_MAX_ITEMS;
    refreshDirty();
  };
  const saveRows = async (): Promise<void> => {
    errors.clear();
    setStatus("", "");
    for (const row of rows) {
      const problem = sequenceProblem(row, rows);
      if (problem) { errors.set(row.key, problem); opened.add(row.key); }
    }
    if (errors.size) { draw(); setStatus(SEQ_FIX_TEXT, "error"); return; }
    try {
      const before = snapshot();
      const result = await api.sequencesSave({ packId, sequences: packData(rows) });
      if (!result.ok) { setStatus(result.errors[0]?.message ?? SEQ_FIX_TEXT, "error"); return; }
      if (snapshot() === before) { baseline = before; refreshDirty(); }
      setStatus(result.derived ? "'(내 버전)'으로 저장했어요" : SEQ_SAVED_TEXT, "ok");
      await hooks.saved(result);
    } catch { setStatus("저장하지 못했어요", "error"); }
  };
  draw();
}
