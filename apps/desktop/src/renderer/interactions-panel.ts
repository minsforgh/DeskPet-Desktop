import { checkInteraction, INTERACTION_MOODS, MAX_CUSTOM_INTERACTIONS, MAX_LABEL_LENGTH, MAX_LINE_LENGTH, MAX_LINES, sameInteraction, type InteractionMood, type PetInteraction } from "../main/pet-menu.js";
import type { FieldError, InteractionTryResult, InteractionsView } from "../main/settings-service.js";
import type { PackSaveResult } from "../main/pack-service.js";

export interface InteractionsApi {
  packSaveInteractions(payload: { packId: string; interactions: unknown }): Promise<({ ok: true } & PackSaveResult) | { ok: false; errors: FieldError[] }>;
  interactionsTry(payload: unknown): Promise<InteractionTryResult>;
}
export interface InteractionsHooks {
  setDirty(dirty: boolean): void;
  saved(result: PackSaveResult): Promise<void>;
}

/** Keeps slow pack reads from replacing a newer selection or a form edited while the read ran. */
export function createInteractionsReload<T>(load: (packId: string) => Promise<T>, apply: (packId: string, value: T) => void,
  failed: () => void, isDirty: () => boolean) {
  let request = 0;
  let drawnFor = "";
  return {
    async reload(packId: string): Promise<void> {
      const current = ++request;
      if (isDirty() || drawnFor === packId) return;
      try {
        const value = await load(packId);
        if (current !== request || isDirty()) return;
        apply(packId, value);
        drawnFor = packId;
      } catch {
        if (current !== request || isDirty()) return;
        drawnFor = "";
        failed();
      }
    },
    invalidate(): void { request += 1; drawnFor = ""; },
  };
}

export const MOOD_LABELS: Record<InteractionMood, string> = {
  happy: "기쁨", surprised: "놀람", sleepy: "졸림", worried: "걱정", neutral: "평온",
};
export const SAVED_TEXT = "저장했어요";
export const FIX_TEXT = "저장하지 못했어요. 표시된 항목을 고치세요";
export const DIRTY_TEXT = "저장하지 않은 변경이 있어요";
const copy = (item: PetInteraction): PetInteraction => ({ ...item, lines: [...item.lines] });
const lineCount = (item: PetInteraction): number => item.lines.filter((line) => line.trim() !== "").length;
const raw = (item: PetInteraction): Record<string, unknown> => ({ id: item.id, label: item.label, mood: item.mood,
  speak: item.speak, lines: [...item.lines], ...(item.hidden ? { hidden: true } : {}),
  ...(item.play !== undefined ? { play: item.play } : {}), ...(item.sequence !== undefined ? { sequence: item.sequence } : {}) });
const packData = (items: PetInteraction[]) => ({ version: 1, items: items.map((item) => ({ id: item.id,
  label: item.label, mood: item.mood, bubble: item.speak, lines: item.lines.map((line) => line.trim()).filter(Boolean),
  ...(item.play !== undefined ? { play: item.play } : {}), ...(item.sequence !== undefined ? { sequence: item.sequence } : {}) })),
  hidden: items.filter((item) => item.hidden).map((item) => item.id) });

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
export function rowProblem(item: PetInteraction): string | undefined {
  const checked = checkInteraction(raw(item));
  if (!checked.ok) return checked.message;
  if (item.speak && lineCount(item) === 0) return "대사를 한 줄 이상 적어 주세요";
  return undefined;
}

/** All pack strings are assigned through textContent or value, including labels and speech. */
export function renderInteractionsPanel(doc: Document, panel: HTMLElement, initial: InteractionsView, packId: string,
  api: InteractionsApi, hooks: InteractionsHooks): void {
  const defaults = initial.defaults;
  const states = new Set(initial.states ?? []);
  const fallbacks = initial.fallbacks ?? {};
  const sequences = initial.sequences ?? [];
  const fallsToIdle = (name: string): boolean => {
    const visited = new Set<string>();
    let current = name;
    while (!visited.has(current)) {
      if (states.has(current)) return current === "idle";
      visited.add(current);
      if (!Object.hasOwn(fallbacks, current)) break;
      current = fallbacks[current] ?? "idle";
    }
    return true;
  };
  let rows = initial.items.map(copy);
  let baseline = JSON.stringify(rows);
  const opened = new Set<string>();
  const errors = new Map<string, string>();
  const heading = make(doc, "h2", "", "상호작용");
  const intro = make(doc, "p", "description", "펫 우클릭 메뉴에 표시돼요. 대사는 누를 때마다 차례로 바뀌며 쓴 그대로 나와요.");
  const list = make(doc, "div", "ix-list");
  const hiddenList = make(doc, "div", "ix-hidden-list");
  const add = button(doc, "", "+ 새 상호작용", () => {
    if (rows.filter((item) => !item.builtin).length >= MAX_CUSTOM_INTERACTIONS) return;
    let number = 1;
    while (rows.some(({ id }) => id === `custom-${number}`)) number += 1;
    const item: PetInteraction = { id: `custom-${number}`, label: "새 상호작용", mood: "neutral", speak: true,
      lines: ["…"], builtin: false };
    rows.push(item);
    opened.add(item.id);
    draw();
  });
  add.id = "ix-add";
  const resetAll = button(doc, "", "기본 항목으로 되돌리기", () => { rows = defaults.map(copy); opened.clear(); errors.clear(); draw(); });
  resetAll.id = "ix-reset-all";
  const cancel = button(doc, "", "취소", () => { rows = JSON.parse(baseline) as PetInteraction[]; errors.clear(); opened.clear(); draw(); });
  cancel.id = "ix-cancel";
  const save = button(doc, "", "저장", () => { void saveRows(); });
  save.id = "ix-save";
  const note = make(doc, "span", "dirty-note");
  note.id = "ix-dirty";
  const status = make(doc, "p", "status");
  status.id = "ix-status";
  status.setAttribute("role", "status");
  const actions = make(doc, "div", "actions");
  actions.append(add, resetAll, cancel, save, note);
  panel.replaceChildren(heading, intro, list, hiddenList, actions, status);

  const setStatus = (value: string, kind: "" | "ok" | "error"): void => {
    status.textContent = value;
    status.classList.remove("ok", "error");
    if (kind) status.classList.add(kind);
  };
  const refreshDirty = (): void => {
    const dirty = JSON.stringify(rows) !== baseline;
    note.textContent = dirty ? DIRTY_TEXT : "";
    hooks.setDirty(dirty);
    cancel.disabled = !dirty;
  };
  const move = (item: PetInteraction, direction: -1 | 1): void => {
    const visible = rows.filter((entry) => !entry.hidden);
    const at = visible.indexOf(item);
    const other = visible[at + direction];
    if (!other) return;
    const from = rows.indexOf(item);
    const to = rows.indexOf(other);
    rows[from] = other;
    rows[to] = item;
    draw();
  };
  const drawRow = (item: PetInteraction): HTMLElement => {
    const section = make(doc, "section", "ix-row ix-section");
    section.dataset.id = item.id;
    const header = make(doc, "div", "ix-heading");
    const title = button(doc, "ix-toggle", item.label, () => { if (opened.has(item.id)) opened.delete(item.id); else opened.add(item.id); draw(); });
    title.setAttribute("aria-expanded", String(opened.has(item.id)));
    const mood = make(doc, "select", "ix-mood");
    mood.setAttribute("aria-label", `표정 (${item.label})`);
    for (const key of INTERACTION_MOODS) {
      const option = make(doc, "option", "", MOOD_LABELS[key]);
      option.value = key;
      mood.append(option);
    }
    mood.value = item.mood;
    mood.addEventListener("change", () => { item.mood = mood.value as InteractionMood; refreshDirty(); });
    const speakLabel = make(doc, "label", "ix-speak-label");
    const speak = make(doc, "input", "ix-speak");
    speak.type = "checkbox";
    speak.checked = item.speak;
    speak.addEventListener("change", () => { item.speak = speak.checked; refreshDirty(); });
    speakLabel.append(speak, make(doc, "span", "", "말풍선"));
    const count = make(doc, "span", "ix-line-count", `대사 ${lineCount(item)}줄`);
    const visible = rows.filter((entry) => !entry.hidden);
    const at = visible.indexOf(item);
    const up = button(doc, "ix-up", "▲", () => move(item, -1));
    up.disabled = at === 0;
    const down = button(doc, "ix-down", "▼", () => move(item, 1));
    down.disabled = at === visible.length - 1;
    const hide = button(doc, "ix-hide", "숨김", () => { item.hidden = true; opened.delete(item.id); draw(); });
    header.append(title);
    if (item.sequence !== undefined && !sequences.some(({ id }) => id === item.sequence))
      header.append(make(doc, "span", "field-error ix-sequence-missing", "⚠ 없는 시퀀스"));
    header.append(mood, speakLabel, count, up, down, hide);
    section.append(header);
    const body = make(doc, "div", "ix-body");
    body.hidden = !opened.has(item.id);
    const labelBox = make(doc, "label", "prop ix-label-box");
    labelBox.append(make(doc, "span", "prop-title", `라벨 (최대 ${MAX_LABEL_LENGTH}자)`));
    const label = make(doc, "input", "ix-label");
    label.type = "text";
    label.value = item.label;
    label.addEventListener("input", () => { item.label = label.value; title.textContent = item.label; refreshDirty(); });
    labelBox.append(label);
    body.append(labelBox);
    const playBox = make(doc, "label", "prop ix-play-box");
    playBox.append(make(doc, "span", "prop-title", "재생 동작"));
    const playSelect = make(doc, "select", "ix-play");
    playSelect.setAttribute("aria-label", `재생 동작 (${item.label})`);
    const automatic = make(doc, "option", "", "없음 = 표정 규칙");
    automatic.value = "";
    playSelect.append(automatic);
    const names = new Set([...states, ...Object.keys(fallbacks), ...(item.play === undefined ? [] : [item.play])]);
    for (const name of [...names].sort()) {
      const option = make(doc, "option", "", name);
      option.value = name;
      playSelect.append(option);
    }
    playSelect.value = item.play ?? "";
    const playWarning = make(doc, "div", "rule-note ix-play-warning");
    const updatePlayWarning = (): void => {
      playWarning.textContent = item.play !== undefined && fallsToIdle(item.play)
        ? "이 동작은 idle로 재생돼요" : "";
    };
    playSelect.addEventListener("change", () => {
      if (playSelect.value === "") delete item.play;
      else item.play = playSelect.value;
      updatePlayWarning();
      refreshDirty();
    });
    updatePlayWarning();
    playBox.append(playSelect, playWarning);
    body.append(playBox);
    const sequenceBox = make(doc, "label", "prop ix-sequence-box");
    sequenceBox.append(make(doc, "span", "prop-title", "동작(시퀀스)"));
    const sequenceSelect = make(doc, "select", "ix-sequence");
    sequenceSelect.setAttribute("aria-label", `동작(시퀀스) (${item.label})`);
    const noSequence = make(doc, "option", "", "없음");
    noSequence.value = "";
    sequenceSelect.append(noSequence);
    for (const entry of sequences) {
      const option = make(doc, "option", "", entry.label?.trim() || entry.id);
      option.value = entry.id;
      sequenceSelect.append(option);
    }
    const missing = item.sequence !== undefined && !sequences.some(({ id }) => id === item.sequence);
    if (missing) {
      const option = make(doc, "option", "", `${item.sequence} (없는 시퀀스)`);
      option.value = item.sequence ?? "";
      sequenceSelect.append(option);
    }
    sequenceSelect.value = item.sequence ?? "";
    const sequenceWarning = make(doc, "div", "rule-note ix-sequence-warning");
    const updateSequenceWarning = (): void => {
      const unknown = item.sequence !== undefined && !sequences.some(({ id }) => id === item.sequence);
      sequenceWarning.textContent = unknown ? "없는 시퀀스예요. 무시하고 재생 동작·대사로 동작해요"
        : item.sequence !== undefined ? "시퀀스를 실행하고 위의 재생 동작·대사는 쓰지 않아요" : "";
    };
    sequenceSelect.addEventListener("change", () => {
      if (sequenceSelect.value === "") delete item.sequence;
      else item.sequence = sequenceSelect.value;
      updateSequenceWarning();
      refreshDirty();
    });
    updateSequenceWarning();
    sequenceBox.append(sequenceSelect, sequenceWarning);
    body.append(sequenceBox);
    const lines = make(doc, "div", "ix-lines-list");
    item.lines.forEach((value, index) => {
      const lineRow = make(doc, "div", "ix-line-row");
      const line = make(doc, "input", "ix-line");
      line.type = "text";
      line.value = value;
      line.setAttribute("aria-label", `대사 ${index + 1}`);
      const length = make(doc, "span", "rule-note ix-counts", `${Array.from(value).length}/${MAX_LINE_LENGTH}`);
      line.addEventListener("input", () => { item.lines[index] = line.value; length.textContent = `${Array.from(line.value).length}/${MAX_LINE_LENGTH}`;
        count.textContent = `대사 ${lineCount(item)}줄`; refreshDirty(); });
      const send = button(doc, "ix-try", "▶ 펫에게 보내기", () => {
        void (async () => {
          const problem = rowProblem(item);
          if (problem) { errors.set(item.id, problem); error.textContent = problem; return; }
          const preview = { ...raw(item), lines: [line.value] };
          try { const result = await api.interactionsTry(preview); setStatus(result.ok ? "펫에게 보냈어요" : result.message, result.ok ? "ok" : "error"); }
          catch { setStatus("보내지 못했어요", "error"); }
        })();
      });
      const remove = button(doc, "ix-line-delete", "삭제", () => { item.lines.splice(index, 1); draw(); });
      lineRow.append(line, length, send, remove);
      lines.append(lineRow);
    });
    body.append(lines);
    const addLine = button(doc, "ix-add-line", "+ 대사 추가", () => { if (item.lines.length < MAX_LINES) { item.lines.push(""); draw(); } });
    addLine.disabled = item.lines.length >= MAX_LINES;
    body.append(addLine);
    if (item.builtin) {
      const reset = button(doc, "ix-reset", "기본값으로 되돌리기", () => {
        const base = defaults.find(({ id }) => id === item.id);
        if (base) rows[rows.indexOf(item)] = copy(base);
        errors.delete(item.id);
        draw();
      });
      reset.disabled = defaults.some((base) => sameInteraction(base, item));
      body.append(reset);
    } else body.append(button(doc, "ix-delete", "항목 삭제", () => { rows = rows.filter((entry) => entry !== item); draw(); }));
    const error = make(doc, "div", "field-error ix-error", errors.get(item.id) ?? "");
    error.setAttribute("role", "alert");
    body.append(error);
    section.append(body);
    return section;
  };
  const draw = (): void => {
    list.replaceChildren(...rows.filter((item) => !item.hidden).map(drawRow));
    hiddenList.replaceChildren();
    const hidden = rows.filter((item) => item.hidden);
    if (hidden.length) {
      hiddenList.append(make(doc, "h3", "", "숨긴 항목"));
      for (const item of hidden) {
        const entry = make(doc, "div", "ix-hidden-row", item.label);
        entry.dataset.id = item.id;
        entry.append(button(doc, "ix-show", "다시 보이기", () => { item.hidden = false; draw(); }));
        hiddenList.append(entry);
      }
    }
    add.disabled = rows.filter((item) => !item.builtin).length >= MAX_CUSTOM_INTERACTIONS;
    refreshDirty();
  };
  const saveRows = async (): Promise<void> => {
    errors.clear();
    setStatus("", "");
    for (const item of rows) {
      const problem = rowProblem(item);
      if (problem) { errors.set(item.id, problem); opened.add(item.id); }
    }
    if (errors.size) { draw(); setStatus(FIX_TEXT, "error"); return; }
    try {
      const snapshot = JSON.stringify(rows);
      const result = await api.packSaveInteractions({ packId, interactions: packData(rows) });
      if (!result.ok) { setStatus(result.errors[0]?.message ?? FIX_TEXT, "error"); return; }
      if (JSON.stringify(rows) === snapshot) { baseline = snapshot; refreshDirty(); }
      setStatus(result.derived ? "'(내 버전)'으로 저장했어요" : SAVED_TEXT, "ok");
      await hooks.saved(result);
    } catch { setStatus("저장하지 못했어요", "error"); }
  };
  draw();
}
