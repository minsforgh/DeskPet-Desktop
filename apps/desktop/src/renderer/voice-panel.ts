import { lineVariantText, parseLines, parseVoicePack, renderLine, renderVoiceParts, VOICE_MAX_VARIANTS, VOICE_MAX_VARIANT_CODE_POINTS, type Line, type LineCatalog, type LineParts, type LineVariant, type VoiceKind, type VoiceTemplates } from "@deskpet/core";
import type { PackSaveResult } from "../main/pack-service.js";
import type { PluginSettingsEntry } from "../main/plugin-host-app.js";
import type { VoicePreviewResult, VoiceSendResult, VoiceView } from "../main/settings-service.js";

/**
 * The 어투 tab. Templates come from a character pack, which is outside the trust boundary, so every string
 * reaches the page through textContent, value or attributes only, never as markup.
 */
export interface VoiceApi {
  voicePreview(payload: { kind: VoiceKind; slots: Record<string, string>; variant: number }): Promise<VoicePreviewResult>;
  voiceSend(payload: { kind: VoiceKind; slots: Record<string, string>; template?: string }): Promise<VoiceSendResult>;
  packSaveVoice?(payload: { packId: string; voicePack: { version: 1; templates: VoiceTemplates } }): Promise<
    ({ ok: true } & PackSaveResult) | { ok: false; errors: Array<{ message: string }> }>;
}

export interface VoiceEditorOptions {
  packId: string;
  templates?: VoiceTemplates;
  baseTemplates?: VoiceTemplates;
  setDirty(dirty: boolean): void;
  onSaved(packId: string, derived: boolean): Promise<void>;
  confirmDiscarded(count: number): boolean;
}

export interface VoiceEditorController { dirty(): boolean; save(): Promise<boolean>; discard(): void }

export interface PluginLinesView {
  packId: string;
  catalogs: Array<{ pluginId: string; catalog: LineCatalog }>;
  overrides: Record<string, LineVariant[]>;
  packLines?: Record<string, LineVariant[]>;
}

export interface PluginLinesApi {
  lineOverridesSave(payload: { lines: Record<string, LineVariant[]> }): Promise<{ ok: true } | { ok: false; errors: Array<{ message: string }> }>;
  lineSend(payload: { lineId: string; vars?: Record<string, string>; previewText?: string; variant?: number }): Promise<VoiceSendResult>;
}

/** A load may finish after a later request or after the user starts editing. */
export function createVoiceLoadGate(isDirty: () => boolean) {
  let latest = 0;
  return { begin: () => ++latest, accepts: (request: number) => request === latest && !isDirty() };
}

export const KIND_LABELS: Record<VoiceKind, string> = {
  done: "작업 완료",
  waiting: "확인 대기",
  failed: "실패",
  info: "알림",
  deadline: "마감 임박",
  reminder: "일정",
  alert: "상태 경고",
};
const SLOTS = [["task", "작업명"], ["result", "결과"], ["folder", "폴더"], ["message", "메시지"]] as const;
const SLOT_MAX_LENGTH = 500;
export const NO_TEMPLATE_TEXT = "템플릿 없음 → 기본 문구";
export const NO_VOICE_TEXT = "이 캐릭터는 어투 템플릿이 없어요. 알림은 보낸 쪽의 기본 문구로 나와요.";
export const UNUSABLE_TEXT = "템플릿이 없거나 슬롯이 비어 보낸 문구가 그대로 나가요";

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStatus(element: HTMLElement, text: string, kind: "" | "ok" | "error"): void {
  element.textContent = text;
  element.classList.remove("ok", "error");
  if (kind) element.classList.add(kind);
}

export function renderVoicePanel(doc: Document, panel: HTMLElement, view: VoiceView, api: VoiceApi, label = "현재 캐릭터",
  editor?: VoiceEditorOptions): VoiceEditorController | undefined {
  const heading = make(doc, "h2", "", "어투");
  const character = make(doc, "p", "voice-character", `${label}: ${view.characterName}`);
  character.id = "voice-character";
  const parts: HTMLElement[] = [heading, character];
  if (view.kinds.every(({ variants }) => variants.length === 0)) {
    const empty = make(doc, "p", "description", NO_VOICE_TEXT);
    empty.id = "voice-empty";
    parts.push(empty);
  }
  if (view.problems.length > 0) {
    const box = make(doc, "div", "voice-problems");
    box.id = "voice-problems";
    box.setAttribute("role", "alert");
    box.append(make(doc, "p", "voice-problems-title", "어투 파일에 문제가 있어요. 아래 항목은 무시됐어요"));
    const list = make(doc, "ul");
    for (const problem of view.problems) list.append(make(doc, "li", "voice-problem", problem));
    box.append(list);
    parts.push(box);
  }

  const kinds = make(doc, "fieldset");
  kinds.append(make(doc, "legend", "", editor ? "종류별 문구" : "종류별 문구 (읽기 전용)"));
  for (const { kind, variants } of view.kinds) {
    const block = make(doc, "div", "voice-kind");
    block.dataset.kind = kind;
    block.append(make(doc, "h3", "", `${KIND_LABELS[kind]} (${kind})`));
    if (variants.length === 0) block.append(make(doc, "p", "muted voice-none", NO_TEMPLATE_TEXT));
    else {
      const list = make(doc, "ol", "voice-variants");
      for (const variant of variants) list.append(make(doc, "li", "voice-variant", variant));
      block.append(list);
    }
    kinds.append(block);
  }
  if (!editor) parts.push(kinds);

  const preview = make(doc, "fieldset", "voice-preview-box");
  preview.append(make(doc, "legend", "", "미리보기"));
  const kindLabel = make(doc, "label");
  const select = make(doc, "select");
  select.id = "voice-kind";
  for (const { kind } of view.kinds) {
    const option = make(doc, "option", "", `${KIND_LABELS[kind]} (${kind})`);
    option.value = kind;
    select.append(option);
  }
  kindLabel.append(make(doc, "span", "prop-title", "종류"), select);
  preview.append(kindLabel);
  const inputs = new Map<string, HTMLInputElement>();
  const slotRow = make(doc, "div", "row");
  for (const [name, title] of SLOTS) {
    const label = make(doc, "label", "prop");
    label.append(make(doc, "span", "prop-title", title));
    const input = make(doc, "input");
    input.type = "text";
    input.id = `voice-slot-${name}`;
    input.maxLength = SLOT_MAX_LENGTH;
    label.append(input);
    slotRow.append(label);
    inputs.set(name, input);
  }
  preview.append(slotRow);
  const previewButton = make(doc, "button", "", "미리보기");
  previewButton.type = "button";
  previewButton.id = "voice-preview";
  const nextButton = make(doc, "button", "", "다음 변형");
  nextButton.type = "button";
  nextButton.id = "voice-next";
  const sendButton = make(doc, "button", "", "펫에게 보내기");
  sendButton.type = "button";
  sendButton.id = "voice-send";
  const info = make(doc, "span", "muted");
  info.id = "voice-variant-info";
  const actions = make(doc, "div", "actions");
  actions.append(previewButton, nextButton, sendButton, info);
  const result = make(doc, "p", "voice-result");
  result.id = "voice-result";
  result.setAttribute("role", "status");
  const status = make(doc, "p", "status");
  status.id = "voice-status";
  status.setAttribute("role", "status");
  preview.append(actions, result, status);
  parts.push(preview);
  panel.replaceChildren(...parts);
  const controller = editor ? createVoiceEditor(doc, panel, view, api, editor) : undefined;

  const request = (): { kind: VoiceKind; slots: Record<string, string> } => {
    const slots: Record<string, string> = {};
    for (const [name, input] of inputs) if (input.value !== "") Object.defineProperty(slots, name, { value: input.value, enumerable: true, writable: true, configurable: true });
    return { kind: select.value as VoiceKind, slots };
  };
  let variant = 0;
  const show = async (undo?: () => void): Promise<void> => {
    setStatus(status, "", "");
    try {
      const answer = await api.voicePreview({ ...request(), variant });
      if (!answer.ok) { undo?.(); setStatus(status, answer.message, "error"); return; }
      result.textContent = answer.text ?? UNUSABLE_TEXT;
      result.classList.toggle("fallback", answer.text === null);
      info.textContent = answer.variantCount === 0 ? "" : `변형 ${(variant % answer.variantCount) + 1}/${answer.variantCount}부터 시도`;
    } catch { setStatus(status, "미리보기를 만들지 못했어요", "error"); }
  };
  previewButton.addEventListener("click", () => { variant = 0; void show(); });
  // A refused step (the one-a-second limit) leaves the variant where it was.
  nextButton.addEventListener("click", () => { variant += 1; void show(() => { variant -= 1; }); });
  select.addEventListener("change", () => { variant = 0; result.textContent = ""; info.textContent = ""; });
  sendButton.addEventListener("click", () => {
    void (async () => {
      setStatus(status, "", "");
      try {
        const answer = await api.voiceSend(request());
        if (answer.ok) setStatus(status, "펫에게 보냈어요", "ok");
        else setStatus(status, answer.message, "error");
      } catch { setStatus(status, "보내지 못했어요", "error"); }
    })();
  });
  return controller;
}

export const EDITOR_LABELS: Record<VoiceKind, [string, string]> = {
  done: ["완료", "작업이 끝났을 때"], waiting: ["대기", "입력이 필요할 때"], failed: ["실패", "작업이 실패했을 때"],
  info: ["정보", "일반 소식을 전할 때"], deadline: ["마감", "마감이 가까울 때"],
  reminder: ["알림", "일정을 알려 줄 때"], alert: ["경고", "문제가 생겼을 때"],
};

/** The plugin editor keeps only user overrides; removing one reveals the pack or catalog sentence. */
export function renderPluginLinesPanel(doc: Document, panel: HTMLElement, view: PluginLinesView,
  plugins: readonly PluginSettingsEntry[], api: PluginLinesApi, setDirty: (dirty: boolean) => void): VoiceEditorController {
  const catalogs = new Map(view.catalogs.map(({ pluginId, catalog }) => [pluginId, catalog]));
  const original: Record<string, LineVariant[]> = structuredClone(view.overrides);
  let rows: Record<string, LineVariant[]> = structuredClone(original);
  let busy = false;
  const root = make(doc, "section", "plugin-lines-editor"); root.id = "plugin-lines-editor";
  root.append(make(doc, "h2", "", "플러그인별 대사"));
  const note = make(doc, "span", "dirty-note"); note.id = "plugin-lines-dirty";
  const save = make(doc, "button", "", "저장"); save.type = "button"; save.id = "plugin-lines-save";
  const cancel = make(doc, "button", "", "취소"); cancel.type = "button"; cancel.id = "plugin-lines-cancel";
  const toolbar = make(doc, "div", "actions voice-editor-toolbar"); toolbar.append(note, cancel, save); root.append(toolbar);
  const list = make(doc, "div", "plugin-lines-list"); root.append(list);
  const status = make(doc, "p", "status"); status.id = "plugin-lines-status"; status.setAttribute("role", "status"); root.append(status);
  panel.append(root);
  const known = view.catalogs.flatMap(({ catalog }) => catalog.lines.map(({ id }) => id));
  const snapshot = (value: Record<string, LineVariant[]>): string => JSON.stringify(known.map((id) => value[id] ?? null));
  const dirty = (): boolean => snapshot(rows) !== snapshot(original);
  const updateDirty = (): void => {
    const count = known.filter((id) => JSON.stringify(rows[id] ?? null) !== JSON.stringify(original[id] ?? null)).length;
    note.textContent = count ? `● 변경 있음 (${count})` : "";
    save.disabled = cancel.disabled = count === 0 || busy;
    setDirty(count > 0);
  };
  const effective = (line: Line): { variants: LineVariant[]; source: string } => {
    const override = rows[line.id];
    if (override) return { variants: override, source: "내 수정" };
    const pack = view.packLines?.[line.id];
    if (pack) return { variants: pack, source: "캐릭터 팩" };
    return { variants: line.variants, source: "기본" };
  };
  const issue = (line: Line, variants: LineVariant[]): string | undefined =>
    parseLines({ version: 1, lines: [{ ...line, variants }] }, line.id.split(".")[0] ?? "").problems[0];
  const draw = (): void => {
    const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>("details[open]"))
      .map((item) => item.dataset.linesPlugin ?? item.dataset.lineId));
    list.replaceChildren(...plugins.filter((plugin) => catalogs.has(plugin.id) || plugin.state === "invalid").map((plugin) => {
      const catalog = catalogs.get(plugin.id);
      const section = make(doc, "details", "plugin-lines-plugin"); section.dataset.linesPlugin = plugin.id;
      section.open = open.has(plugin.id);
      const state = !catalog || plugin.state === "invalid" ? "목록 오류"
        : plugin.state === "running" ? "켜짐" : plugin.state === "disabled" ? "꺼짐"
        : plugin.state === "needs-permission" || plugin.state === "denied" ? "권한 대기"
          : "꺼짐";
      section.append(make(doc, "summary", "plugin-lines-title", `${plugin.name} · ${catalog?.lines.length ?? 0}개 · ${state}`));
      const search = make(doc, "input", "plugin-lines-search"); search.type = "search";
      search.setAttribute("aria-label", `${plugin.name} 대사 검색`);
      section.append(search);
      const lineList = make(doc, "div", "plugin-lines-rows"); section.append(lineList);
      if (!catalog) section.append(make(doc, "p", "muted", "대사 목록을 읽을 수 없어요"));
      else for (const line of catalog.lines) {
        const row = make(doc, "details", "line-row"); row.dataset.lineId = line.id; row.open = open.has(line.id);
        const current = effective(line);
        row.append(make(doc, "summary", "plugin-line-title", `${line.label} · ${current.variants[0] ? lineVariantText(current.variants[0]) : ""} · ${current.source}`));
        row.append(make(doc, "p", "muted plugin-line-variables", line.variables.length
          ? `변수: ${line.variables.map((name) => `{${name}}`).join(", ")} (미리보기 값을 입력하세요)` : "변수 없음"));
        const vars: Record<string, HTMLInputElement> = {};
        const varRow = make(doc, "div", "row plugin-line-samples");
        for (const name of line.variables) {
          const label = make(doc, "label", "prop"); label.append(make(doc, "span", "prop-title", name));
          const input = make(doc, "input"); input.type = "text"; input.value = "예시"; input.maxLength = SLOT_MAX_LENGTH;
          label.append(input); varRow.append(label); vars[name] = input;
        }
        row.append(varRow);
        const variantList = make(doc, "div", "plugin-line-variants"); row.append(variantList);
        const preview = make(doc, "p", "voice-row-preview plugin-line-preview"); preview.setAttribute("role", "status");
        let selected = 0;
        const values = (): Record<string, string> => Object.fromEntries(Object.entries(vars).map(([name, input]) => [name, input.value]));
        const show = (): string | undefined => {
          const variants = effective(line).variants;
          const error = issue(line, variants);
          const text = error ? undefined : renderLine({ version: 1, lines: [{ ...line, variants }] }, line.id, values(), selected);
          preview.textContent = error ? `⚠ ${error}` : text ?? "이 변수 값으로는 문장을 만들 수 없어요";
          return text;
        };
        for (const input of Object.values(vars)) input.addEventListener("input", show);
        const renderVariants = (): void => {
          const variants = effective(line).variants;
          add.disabled = variants.length >= VOICE_MAX_VARIANTS;
          variantList.replaceChildren(...variants.map((value, index) => {
            const item = make(doc, "div", "voice-variant plugin-line-variant"); item.dataset.index = String(index);
            const mode = make(doc, "select", "plugin-line-mode");
            mode.setAttribute("aria-label", `${line.label} ${index + 1}번째 변형 형식`);
            for (const [key, label] of [["sentence", "한 문장"], ["parts", "줄 나눔"]] as const) {
              const option = make(doc, "option", "", label); option.value = key; mode.append(option);
            }
            mode.value = typeof value === "string" ? "sentence" : "parts";
            const fields = make(doc, "div", "plugin-line-fields");
            const remaining = make(doc, "span", "voice-remaining");
            const count = (): void => {
              const current = effective(line).variants[index];
              const length = current === undefined ? 0 : Array.from(typeof current === "string" ? current
                : current.prefix + current.content + current.suffix).length;
              remaining.textContent = String(VOICE_MAX_VARIANT_CODE_POINTS - length);
            };
            const update = (next: LineVariant): void => {
              const updated = [...effective(line).variants]; updated[index] = next; rows[line.id] = updated;
              count(); show(); updateDirty();
            };
            const insert = make(doc, "select", "voice-slot-insert");
            const prompt = make(doc, "option", "", "{} 변수 ▾"); prompt.value = ""; insert.append(prompt);
            for (const name of line.variables) { const option = make(doc, "option", "", `{${name}}`); option.value = name; insert.append(option); }
            let contentInput: HTMLInputElement;
            const field = (name: keyof LineParts, label: string, initial: string): HTMLInputElement => {
              const wrapper = make(doc, "label", "plugin-line-field");
              wrapper.append(make(doc, "span", "prop-title", label));
              const input = make(doc, "input", `voice-variant-input plugin-line-${name}`);
              input.type = "text"; input.value = initial;
              input.setAttribute("aria-label", `${line.label} ${index + 1}번째 변형 ${label}`);
              input.addEventListener("input", () => {
                const current = effective(line).variants[index];
                if (typeof current !== "string" && current) update({ ...current, [name]: input.value });
              });
              wrapper.append(input); fields.append(wrapper);
              return input;
            };
            if (typeof value === "string") {
              const input = make(doc, "input", "voice-variant-input"); input.type = "text"; input.value = value;
              input.setAttribute("aria-label", `${line.label} ${index + 1}번째 변형`);
              input.addEventListener("input", () => update(input.value));
              fields.append(input); contentInput = input;
            } else {
              field("prefix", "앞말", value.prefix);
              contentInput = field("content", "내용", value.content);
              field("suffix", "끝말", value.suffix);
            }
            count();
            mode.addEventListener("change", () => {
              const before = effective(line).variants[index]; if (before === undefined) return;
              const previousText = lineVariantText(before);
              const next: LineVariant = mode.value === "parts"
                ? { prefix: "", content: previousText, suffix: "" } : previousText;
              update(next); renderVariants();
              const converted = variantList.children[index];
              converted?.append(make(doc, "span", "plugin-line-conversion", `전: ${previousText} / 후: ${lineVariantText(next)}`));
            });
            const move = (direction: number): void => { const updated = [...effective(line).variants];
              const other = index + direction; [updated[index], updated[other]] = [updated[other] ?? "", updated[index] ?? ""];
              rows[line.id] = updated;
              renderVariants(); updateDirty(); };
            const up = make(doc, "button", "", "▲"); up.type = "button"; up.disabled = index === 0; up.addEventListener("click", () => move(-1));
            const down = make(doc, "button", "", "▼"); down.type = "button"; down.disabled = index === variants.length - 1;
            down.addEventListener("click", () => move(1));
            const remove = make(doc, "button", "", "삭제"); remove.type = "button"; remove.disabled = variants.length === 1;
            remove.addEventListener("click", () => { rows[line.id] = variants.filter((_item, at) => at !== index); renderVariants(); updateDirty(); });
            insert.addEventListener("change", () => { if (!insert.value) return;
              const start = contentInput.selectionStart ?? contentInput.value.length;
              const end = contentInput.selectionEnd ?? start;
              contentInput.value = `${contentInput.value.slice(0, start)}{${insert.value}}${contentInput.value.slice(end)}`;
              contentInput.selectionStart = contentInput.selectionEnd = start + insert.value.length + 2;
              contentInput.dispatchEvent(new Event("input", { bubbles: true })); contentInput.focus(); insert.value = ""; });
            item.append(make(doc, "span", "voice-number", String(index + 1)), mode, fields, remaining, up, down, remove, insert);
            return item;
          }));
          show();
        };
        const add = make(doc, "button", "voice-add", "+ 변형 추가"); add.type = "button";
        add.addEventListener("click", () => { const variants = effective(line).variants;
          if (variants.length >= VOICE_MAX_VARIANTS) return;
          rows[line.id] = [...variants, ""]; renderVariants(); updateDirty(); });
        const previewButton = make(doc, "button", "", "미리보기"); previewButton.type = "button";
        previewButton.addEventListener("click", show);
        const next = make(doc, "button", "", "다음 변형"); next.type = "button";
        next.addEventListener("click", () => { selected += 1; show(); });
        const send = make(doc, "button", "plugin-line-send", "펫에게 보내기"); send.type = "button";
        send.disabled = plugin.state !== "running";
        const reason = make(doc, "span", "muted plugin-line-send-reason", send.disabled ? `${plugin.name}: ${state} 상태에서는 보낼 수 없어요` : "");
        send.addEventListener("click", () => { const text = show(); if (!text) return;
          void api.lineSend({ lineId: line.id, vars: values(), previewText: text, variant: selected }).then((answer) => {
            status.textContent = answer.ok ? "펫에게 보냈어요" : answer.message;
          }).catch(() => { status.textContent = "보내지 못했어요"; }); });
        const reset = make(doc, "button", "voice-reset", "기본값으로 되돌리기"); reset.type = "button";
        reset.addEventListener("click", () => { Reflect.deleteProperty(rows, line.id); renderVariants(); updateDirty(); });
        row.append(add, previewButton, next, send, reason, reset, preview);
        renderVariants(); lineList.append(row);
      }
      const filter = (): void => { for (const row of Array.from(lineList.children) as HTMLElement[]) {
        row.hidden = !row.textContent?.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
      } };
      search.addEventListener("input", filter);
      return section;
    }));
    updateDirty();
  };
  const discard = (): void => { rows = structuredClone(original); draw(); status.textContent = ""; };
  const saveRows = async (): Promise<boolean> => {
    if (busy || !dirty()) return false;
    for (const { catalog } of view.catalogs) for (const line of catalog.lines) {
      const variants = rows[line.id];
      if (variants && issue(line, variants)) { status.textContent = `${line.label}: 대사 변형을 확인해 주세요`; return false; }
    }
    busy = true; updateDirty();
    try {
      const lines = Object.fromEntries(known.flatMap((id) => rows[id] ? [[id, rows[id]]] : []));
      const result = await api.lineOverridesSave({ lines });
      if (!result.ok) { status.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; return false; }
      for (const id of known) { if (rows[id]) original[id] = structuredClone(rows[id]); else Reflect.deleteProperty(original, id); }
      draw(); status.textContent = "저장했어요"; return true;
    } catch { status.textContent = "저장하지 못했어요"; return false; }
    finally { busy = false; updateDirty(); }
  };
  cancel.addEventListener("click", discard);
  save.addEventListener("click", () => { void saveRows(); });
  draw();
  return { dirty, save: saveRows, discard };
}
const SAMPLES: Array<[string, Record<string, string>]> = [
  ["빌드 끝", { task: "빌드 정리", result: "테스트 통과" }],
  ["입력 대기", { task: "리뷰", message: "확인이 필요해요" }],
  ["실패", { task: "배포", result: "오류 3건" }],
  ["출석 마감", { task: "학습 시작", result: "10시까지 20분 남았어요" }],
  ["알림", { task: "회의", message: "회의 시작이에요" }],
  ["폴더만", { folder: "deskpet" }],
];

function createVoiceEditor(doc: Document, panel: HTMLElement, view: VoiceView, api: VoiceApi,
  options: VoiceEditorOptions): VoiceEditorController {
  const order = view.kinds.map(({ kind }) => kind);
  const original: VoiceTemplates = structuredClone(options.templates ?? Object.fromEntries(view.kinds.map(({ kind, variants }) => [kind, variants])));
  let rows: VoiceTemplates = structuredClone(original);
  const sample = make(doc, "select");
  sample.id = "voice-sample";
  SAMPLES.forEach(([name], index) => { const option = make(doc, "option", "", name); option.value = String(index); sample.append(option); });
  const sampleFields = new Map<string, HTMLInputElement>();
  const sampleRow = make(doc, "div", "row voice-sample-fields");
  const sections = make(doc, "div", "voice-editor-sections");
  const dirtyNote = make(doc, "span", "dirty-note");
  dirtyNote.id = "voice-dirty";
  const save = make(doc, "button", "", "저장"); save.type = "button"; save.id = "voice-editor-save";
  const cancel = make(doc, "button", "", "취소"); cancel.type = "button"; cancel.id = "voice-editor-cancel";
  const status = make(doc, "p", "status"); status.id = "voice-editor-status"; status.setAttribute("role", "status");
  const toolbar = make(doc, "div", "actions voice-editor-toolbar");
  toolbar.append(dirtyNote, cancel, save, make(doc, "span", "prop-title", "샘플 상황"), sample);
  for (const [name, title] of SLOTS) {
    const label = make(doc, "label", "prop");
    label.append(make(doc, "span", "prop-title", title));
    const input = make(doc, "input"); input.type = "text"; input.id = `voice-editor-slot-${name}`; input.maxLength = SLOT_MAX_LENGTH;
    input.addEventListener("input", () => updatePreviews());
    label.append(input); sampleRow.append(label); sampleFields.set(name, input);
  }
  const editorRoot = make(doc, "div", "voice-editor");
  editorRoot.append(toolbar, sampleRow, sections, status);
  panel.insertBefore(editorRoot, panel.querySelector(".voice-preview-box"));
  let focused: HTMLInputElement | undefined;
  let busy = false;
  const slots = (): Record<string, string> => Object.fromEntries([...sampleFields].map(([name, input]) => [name, input.value]));
  const snapshot = (value: VoiceTemplates): string => JSON.stringify(order.map((kind) => value[kind] ?? []));
  const difference = (): number => order.reduce((sum, kind) => {
    const before = original[kind] ?? []; const after = rows[kind] ?? [];
    let changed = 0;
    for (let index = 0; index < Math.max(before.length, after.length); index += 1)
      if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) changed += 1;
    return sum + changed;
  }, 0);
  const problem = (value: LineVariant): string | undefined => {
    const parsed = parseVoicePack({ version: 1, templates: { done: [value] } });
    const issue = parsed.problems[0];
    if (!issue) return undefined;
    if (issue.includes("non-empty")) return "빈 문자열";
    if (issue.includes("longer")) return "400자 초과";
    if (issue.includes("unknown slot")) return `알 수 없는 슬롯 ${issue.slice(issue.indexOf("{"))}`;
    return issue;
  };
  const preview = (value: LineVariant): string => {
    const issue = problem(value);
    if (issue) return `⚠ 저장 때 버려져요: ${issue}`;
    const values = slots();
    const missing = SLOTS.find(([name]) => lineVariantText(value).includes(`{${name}}`) && values[name]?.trim() === "");
    const result = renderVoiceParts({ done: [value] }, { kind: "done", slots: values }, 0);
    if (result === null) return missing ? `건너뜀 (${missing[0]} 비어 있음)` : "건너뜀 (결과 비어 있음)";
    const text = result.parts ? [result.parts.prefix, result.parts.content, result.parts.suffix].filter(Boolean).join("\n") : result.text;
    return Array.from(result.text).length === 120 && result.text.endsWith("…") ? `${text} (120자에서 잘림)` : text;
  };
  const updateFallback = (block: HTMLElement): void => {
    const previews = Array.from(block.querySelectorAll<HTMLElement>(".voice-row-preview"));
    const fallback = block.querySelector<HTMLElement>(".voice-fallback");
    if (fallback) fallback.textContent = previews.length > 0 && previews.every((item) => item.textContent?.startsWith("건너뜀"))
      ? "이 샘플로는 원래 문구(text)가 그대로 나와요" : "";
  };
  function updatePreviews(): void {
    for (const row of Array.from(sections.querySelectorAll<HTMLElement>(".voice-variant"))) {
      const kind = row.dataset.kind as VoiceKind | undefined;
      const value = kind ? rows[kind]?.[Number(row.dataset.index)] : undefined;
      const result = row.querySelector<HTMLElement>(".voice-row-preview");
      if (value !== undefined && result) result.textContent = preview(value);
    }
    for (const block of Array.from(sections.querySelectorAll<HTMLElement>(".voice-kind"))) updateFallback(block);
  }
  const updateDirty = (): void => {
    const count = difference();
    dirtyNote.textContent = count ? `● 변경 있음 (${count})` : "";
    cancel.disabled = save.disabled = count === 0 || busy;
    options.setDirty(count > 0);
  };
  const draw = (): void => {
    const open = new Set(Array.from(sections.querySelectorAll<HTMLDetailsElement>("details[open]")).map((item) => item.dataset.kind));
    sections.replaceChildren(...order.map((kind) => {
      const variants = rows[kind] ?? [];
      const block = make(doc, "details", "voice-kind"); block.dataset.kind = kind;
      block.open = open.has(kind) || (sections.children.length === 0 && kind === "done");
      const warningCount = variants.filter((value) => problem(value)).length;
      const summary = make(doc, "summary", "voice-kind-title",
        `${EDITOR_LABELS[kind][0]} · ${EDITOR_LABELS[kind][1]} · ${variants.length}개${warningCount ? ` · ⚠ ${warningCount}` : ""}`);
      block.append(summary);
      if (variants.length === 0) block.append(make(doc, "p", "muted voice-none", "(원문 그대로)"));
      variants.forEach((value, index) => {
        const row = make(doc, "div", "voice-variant"); row.dataset.index = String(index); row.dataset.kind = kind;
        const mode = make(doc, "select", "voice-variant-mode");
        mode.setAttribute("aria-label", `${EDITOR_LABELS[kind][0]} ${index + 1}번째 변형 형식`);
        for (const [key, label] of [["sentence", "한 문장"], ["parts", "줄 나눔"]] as const) {
          const option = make(doc, "option", "", label); option.value = key; mode.append(option);
        }
        mode.value = typeof value === "string" ? "sentence" : "parts";
        const fields = make(doc, "div", "plugin-line-fields");
        const previewNode = make(doc, "div", "voice-row-preview", preview(value));
        const remaining = make(doc, "span", "voice-remaining");
        const update = (next: LineVariant): void => {
          variants[index] = next;
          remaining.textContent = String(VOICE_MAX_VARIANT_CODE_POINTS - Array.from(typeof next === "string" ? next
            : next.prefix + next.content + next.suffix).length);
          previewNode.textContent = preview(next);
          const warnings = variants.filter((item) => problem(item)).length;
          summary.textContent = `${EDITOR_LABELS[kind][0]} · ${EDITOR_LABELS[kind][1]} · ${variants.length}개${warnings ? ` · ⚠ ${warnings}` : ""}`;
          updateFallback(block);
          updateDirty();
        };
        let contentInput: HTMLInputElement;
        const field = (name: keyof LineParts, label: string, initial: string): HTMLInputElement => {
          const wrapper = make(doc, "label", "plugin-line-field");
          wrapper.append(make(doc, "span", "prop-title", label));
          const input = make(doc, "input", `voice-variant-input voice-${name}`);
          input.type = "text"; input.value = initial;
          input.setAttribute("aria-label", `${EDITOR_LABELS[kind][0]} ${index + 1}번째 변형 ${label}`);
          input.addEventListener("focus", () => { focused = input; });
          input.addEventListener("input", () => {
            const current = variants[index];
            if (current && typeof current !== "string") update({ ...current, [name]: input.value });
          });
          wrapper.append(input); fields.append(wrapper);
          return input;
        };
        if (typeof value === "string") {
          const input = make(doc, "input", "voice-variant-input"); input.type = "text"; input.value = value;
          input.setAttribute("aria-label", `${EDITOR_LABELS[kind][0]} ${index + 1}번째 변형`);
          input.addEventListener("focus", () => { focused = input; });
          input.addEventListener("input", () => update(input.value));
          fields.append(input); contentInput = input;
        } else {
          field("prefix", "앞말", value.prefix);
          contentInput = field("content", "내용", value.content);
          field("suffix", "끝말", value.suffix);
        }
        update(value);
        mode.addEventListener("change", () => {
          const current = variants[index]; if (current === undefined) return;
          const text = lineVariantText(current);
          update(mode.value === "parts" ? { prefix: "", content: text, suffix: "" } : text);
          draw();
        });
        const up = make(doc, "button", "", "▲"); up.type = "button"; up.disabled = index === 0;
        up.addEventListener("click", () => {
          const before = variants[index - 1]; const current = variants[index];
          if (before === undefined || current === undefined) return;
          variants[index - 1] = current; variants[index] = before; draw();
        });
        const down = make(doc, "button", "", "▼"); down.type = "button"; down.disabled = index === variants.length - 1;
        down.addEventListener("click", () => {
          const after = variants[index + 1]; const current = variants[index];
          if (after === undefined || current === undefined) return;
          variants[index + 1] = current; variants[index] = after; draw();
        });
        const remove = make(doc, "button", "", "삭제"); remove.type = "button";
        remove.addEventListener("click", () => { variants.splice(index, 1); draw(); });
        const send = make(doc, "button", "", "▶ 펫에게 보내기"); send.type = "button";
        send.addEventListener("click", () => { void (async () => {
          const answer = await api.voiceSend({ kind, slots: slots(), template: lineVariantText(variants[index] ?? "") });
          status.textContent = answer.ok ? "펫에게 보냈어요" : answer.message;
        })(); });
        const insert = make(doc, "select", "voice-slot-insert");
        const prompt = make(doc, "option", "", "{} 슬롯 ▾"); prompt.value = ""; insert.append(prompt);
        for (const [name] of SLOTS) { const option = make(doc, "option", "", `{${name}}`); option.value = name; insert.append(option); }
        insert.addEventListener("change", () => {
          if (focused !== contentInput || !panel.contains(focused) || !insert.value) return;
          const start = focused.selectionStart ?? focused.value.length;
          const end = focused.selectionEnd ?? start;
          contentInput.value = `${contentInput.value.slice(0, start)}{${insert.value}}${contentInput.value.slice(end)}`;
          contentInput.selectionStart = contentInput.selectionEnd = start + insert.value.length + 2;
          contentInput.dispatchEvent(new Event("input", { bubbles: true }));
          contentInput.focus(); insert.value = "";
        });
        row.append(make(doc, "span", "voice-number", String(index + 1)), mode, fields, remaining, up, down, remove, send, insert,
          previewNode);
        block.append(row);
      });
      const fallback = make(doc, "p", "voice-fallback muted");
      block.append(fallback);
      const add = make(doc, "button", "voice-add", "+ 변형 추가"); add.type = "button"; add.disabled = variants.length >= VOICE_MAX_VARIANTS;
      add.addEventListener("click", () => { variants.push(""); draw(); }); block.append(add);
      if (options.baseTemplates) {
        const reset = make(doc, "button", "voice-reset", "기본값으로 되돌리기"); reset.type = "button";
        reset.addEventListener("click", () => { rows[kind] = structuredClone(options.baseTemplates?.[kind] ?? []); draw(); }); block.append(reset);
      }
      updateFallback(block);
      return block;
    }));
    updateDirty();
  };
  const applySample = (): void => {
    const values = SAMPLES[Number(sample.value)]?.[1] ?? {};
    for (const [name, input] of sampleFields) input.value = values[name] ?? "";
    updatePreviews();
  };
  sample.addEventListener("change", applySample);
  sample.value = "0"; applySample(); draw();
  const discard = (): void => { rows = structuredClone(original); draw(); status.textContent = ""; };
  const saveRows = async (): Promise<boolean> => {
    if (!api.packSaveVoice || busy || snapshot(rows) === snapshot(original)) return false;
    const count = order.reduce((total, kind) => total + (rows[kind] ?? []).filter((value) => problem(value)).length, 0);
    if (count && !options.confirmDiscarded(count)) return false;
    busy = true; updateDirty();
    try {
      const templates: VoiceTemplates = {};
      for (const kind of order) { const variants = rows[kind]; if (variants && variants.length > 0) templates[kind] = structuredClone(variants); }
      const result = await api.packSaveVoice({ packId: options.packId, voicePack: { version: 1, templates } });
      if (!result.ok) { status.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; return false; }
      for (const kind of order) original[kind] = structuredClone(rows[kind] ?? []);
      status.textContent = result.derived ? `내장 팩은 바꿀 수 없어 '${view.characterName} (내 버전)' 으로 저장했어요` : "저장했어요";
      await options.onSaved(result.packId, result.derived);
      return true;
    } catch { status.textContent = "저장하지 못했어요"; return false; }
    finally { busy = false; updateDirty(); }
  };
  cancel.addEventListener("click", discard);
  save.addEventListener("click", () => { void saveRows(); });
  return { dirty: () => snapshot(rows) !== snapshot(original), save: saveRows, discard };
}
