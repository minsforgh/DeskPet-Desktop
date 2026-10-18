import type { ConfigFieldSchema, ObjectItemField } from "@deskpet/plugin-sdk";
import { lineVariantText } from "@deskpet/core";
import type { PluginSettingsEntry } from "../main/plugin-host-app.js";
import { describeRules } from "./reminder-notes.js";
import { createReminderLoadGuard, renderRemindersPanel } from "./reminders-panel.js";
import { createInteractionsReload, renderInteractionsPanel, type InteractionsApi } from "./interactions-panel.js";
import { createVoiceLoadGate, renderPluginLinesPanel, renderVoicePanel, type PluginLinesApi, type PluginLinesView, type VoiceApi, type VoiceEditorController } from "./voice-panel.js";
import { createCharacterPanel, type CharacterApi } from "./character-panel.js";
import { renderSequencesPanel, type SequencesApi, type SequencesView } from "./sequences-panel.js";
import { renderMotionsPanel, type MotionsApi, type MotionsController, type MotionsView } from "./motions-panel.js";
import { renderReactionsPanel, type LineReactionsInput, type ReactionsApi, type ReactionsController, type ReactionsView } from "./reactions-panel.js";
import { renderSheetsPanel, type SheetsApi } from "./sheets-panel.js";
import { createBehaviorPanel, type BehaviorApi } from "./behavior-panel.js";
import { createTerrainSection, type TerrainApi } from "./terrain-panel.js";
import type { PackListItem } from "../main/pack-service.js";
import type { ReactionTarget, VoiceKind, VoiceTemplates } from "@deskpet/core";
import type { LaunchAtLoginView } from "../main/login-item.js";
import type { BadgePlacement, BubbleDisplay } from "../main/settings.js";
import type { DeveloperModeView, FieldError, GeneralResult, GeneralSettings, InteractionsView, PluginSaveResult, SettingsView, VoiceView } from "../main/settings-service.js";

declare global {
  interface Window {
    settings: CharacterApi & BehaviorApi & TerrainApi & SheetsApi & {
      confirm(message: string): boolean;
      load(): Promise<SettingsView>;
      saveGeneral(payload: GeneralSettings): Promise<GeneralResult>;
      saveBadge(payload: BadgePlacement): Promise<GeneralResult>;
      saveBubble(payload: BubbleDisplay): Promise<GeneralResult>;
      saveDeveloperMode(payload: { enabled: boolean }): Promise<GeneralResult>;
      saveLaunchAtLogin(payload: { enabled: boolean }): Promise<GeneralResult>;
      savePlugin(payload: { pluginId: string; config: Record<string, unknown>; secrets: Record<string, string> }): Promise<PluginSaveResult>;
      enableReminder(): Promise<{ ok: boolean; message?: string }>;
      setReminderDirty(count: number): void;
      clearSecret(payload: { pluginId: string; field: string }): Promise<PluginSaveResult>;
      voiceLoad(): Promise<VoiceView>;
      packVoiceLoad(payload: { packId: string }): Promise<{ ok: true; templates: VoiceTemplates; problems: string[];
        baseTemplates?: VoiceTemplates } | { ok: false; errors: FieldError[] }>;
      packSaveVoice: NonNullable<VoiceApi["packSaveVoice"]>;
      voicePreview: VoiceApi["voicePreview"];
      voiceSend: VoiceApi["voiceSend"];
      lineSend: PluginLinesApi["lineSend"];
      lineSettingsLoad(): Promise<({ ok: true } & PluginLinesView & { reactions?: Record<string, ReactionTarget> }) | { ok: false; errors: FieldError[] }>;
      lineOverridesSave: PluginLinesApi["lineOverridesSave"];
      lineReactionsSave: LineReactionsInput["lineReactionsSave"];
      interactionsTry: InteractionsApi["interactionsTry"];
      packSaveInteractions: InteractionsApi["packSaveInteractions"];
      packInteractionsLoad(payload: { packId: string }): Promise<{ ok: true; view: InteractionsView; problems: string[] } | { ok: false; errors: FieldError[] }>;
      sequencesLoad(payload: { packId: string }): Promise<{ ok: true; sequences: { sequences: SequencesView["sequences"] }; plays: SequencesView["plays"]; problems: string[] } | { ok: false; errors: FieldError[] }>;
      sequencesSave: SequencesApi["sequencesSave"];
      reactionsLoad(payload: { packId: string }): Promise<({ ok: true } & ReactionsView) | { ok: false; errors: FieldError[] }>;
      reactionsSave: ReactionsApi["reactionsSave"];
      motionsLoad(payload: { packId: string }): Promise<({ ok: true } & MotionsView) | { ok: false; errors: FieldError[] }>;
      motionsSave: MotionsApi["motionsSave"];
      onGeneralChanged(callback: (payload: GeneralSettings) => void): void;
      setDirty(dirty: boolean): void;
      markReady(): void;
    };
  }
}

/**
 * Everything a plugin supplies (titles, descriptions, names, status lines, enum values) reaches the page
 * through textContent, value or attributes only, never as markup.
 */
type Reader = () => unknown;
interface Control { element: HTMLElement; read: Reader }
type FormEntry = PluginSettingsEntry & { form: NonNullable<PluginSettingsEntry["form"]> };
type ScalarSpec = { type: "string" | "number" | "boolean"; enum?: readonly (string | number)[]; default?: unknown };
const VOICE_KINDS: readonly VoiceKind[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** One entry per rendered form; the window is dirty while any entry is, which is all main learns. */
const dirtyByKey = new Map<string, boolean>();

function setFormDirty(key: string, dirty: boolean): void {
  if (dirtyByKey.get(key) === dirty) return;
  dirtyByKey.set(key, dirty);
  window.settings.setDirty(Array.from(dirtyByKey.values()).some(Boolean));
}

/** Refresh drops every plugin form (and its dirty state) and rebuilds them from stored values. */
function clearPluginDirty(): void {
  for (const key of Array.from(dirtyByKey.keys())) if (key.startsWith("plugin:")) dirtyByKey.delete(key);
  window.settings.setDirty(Array.from(dirtyByKey.values()).some(Boolean));
}

/** Shown beside a save button while the form differs from what was last loaded or saved. */
function dirtyNote(): HTMLSpanElement {
  return make("span", "dirty-note");
}

const DIRTY_TEXT = "저장하지 않은 변경이 있어요";

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  return element;
}

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Settings page element is missing");
  return element;
}

const isWeekdayEnum = (values: readonly (string | number)[] | undefined): boolean =>
  values?.length === 7 && values.every((value, index) => value === index);

function setStatus(element: HTMLElement, text: string, kind: "" | "ok" | "error"): void {
  element.textContent = text;
  element.classList.remove("ok", "error");
  if (kind) element.classList.add(kind);
}

function clearErrors(root: ParentNode): void {
  for (const message of root.querySelectorAll(".field-error")) message.textContent = "";
  for (const invalid of root.querySelectorAll("[aria-invalid]")) invalid.removeAttribute("aria-invalid");
}

function showError(target: Element | null, message: string): void {
  const text = target?.querySelector(":scope > .field-error");
  if (text) text.textContent = message;
  const input = target?.querySelector("[data-role='input']");
  if (input) input.setAttribute("aria-invalid", "true");
}

/* ---------- general ---------- */

const generalPanel = mustFind<HTMLElement>("#general");
/** Set while a general form is on the page; follows do-not-disturb changes made outside the window (the tray). */
let generalSync: ((general: GeneralSettings) => void) | undefined;
/** The settings page counts as ready only after the terrain section has its values (AGENTS.md: async init joins waitReady). */
let terrainLoaded: Promise<void> = Promise.resolve();

function addScheduleRow(rows: HTMLElement, start = "", end = ""): void {
  const row = make("div", "row dnd-row");
  const times = [["시작", "dnd-start", start], ["끝", "dnd-end", end]] as const;
  for (const [title, className, value] of times) {
    const label = make("label", "prop");
    label.append(make("span", "prop-title", title));
    const input = make("input", className);
    input.type = "text";
    input.value = value;
    input.placeholder = "22:00";
    input.maxLength = 5;
    input.dataset.role = "input";
    const holder = make("div");
    holder.append(input, make("div", "field-error"));
    label.append(holder);
    row.append(label);
  }
  const remove = button("삭제", "row-remove");
  remove.addEventListener("click", () => { row.remove(); });
  row.append(remove);
  rows.append(row);
}

/** D-044: the switch is not drawn at all in a packaged build. It saves on its own, not with the do-not-disturb form. */
function developerModeBox(view: DeveloperModeView): HTMLElement | undefined {
  if (!view.available) return undefined;
  const box = make("fieldset");
  box.append(make("legend", "", "개발자"));
  const label = make("label");
  const toggle = make("input");
  toggle.type = "checkbox";
  toggle.id = "developer-mode";
  toggle.checked = view.enabled;
  label.append(toggle, make("span", "", "개발자 모드: 내장 팩 직접 편집"));
  const status = make("span", "status");
  status.id = "developer-mode-status";
  status.setAttribute("role", "status");
  box.append(label, make("p", "description", "저장하면 characters 폴더의 원본 파일이 바뀝니다. git 으로 되돌릴 수 있어요"), status);
  toggle.addEventListener("change", () => {
    void (async () => {
      const wanted = toggle.checked;
      try {
        const result = await window.settings.saveDeveloperMode({ enabled: wanted });
        if (!result.ok) throw new Error("refused");
        setStatus(status, "저장했어요", "ok");
        await character.refresh();
      } catch {
        toggle.checked = !wanted;
        setStatus(status, "저장하지 못했어요", "error");
      }
    })();
  });
  return box;
}

/** ADR-0010 §6: saves on its own, straight into the system login item. Not drawn when no login item may be written (a plain development run). */
function launchAtLoginBox(view: LaunchAtLoginView): HTMLElement | undefined {
  if (!view.available) return undefined;
  const box = make("fieldset");
  box.append(make("legend", "", "시작"));
  const label = make("label");
  const toggle = make("input");
  toggle.type = "checkbox";
  toggle.id = "launch-at-login";
  toggle.checked = view.enabled;
  label.append(toggle, make("span", "", "Windows 시작 시 실행"));
  const status = make("span", "status");
  status.id = "launch-at-login-status";
  status.setAttribute("role", "status");
  box.append(label, status);
  toggle.addEventListener("change", () => {
    void (async () => {
      const wanted = toggle.checked;
      try {
        const result = await window.settings.saveLaunchAtLogin({ enabled: wanted });
        if (!result.ok) throw new Error("refused");
        setStatus(status, "저장했어요", "ok");
      } catch {
        toggle.checked = !wanted;
        setStatus(status, "저장하지 못했어요", "error");
      }
    })();
  });
  return box;
}

function badgePlacementBox(current: BadgePlacement): HTMLElement {
  const box = make("fieldset");
  box.id = "badge-display";
  box.append(make("legend", "", "배지 표시"));
  const sideLabel = make("label", "badge-field");
  sideLabel.append(make("span", "", "위치"));
  const side = make("select");
  side.id = "badge-side";
  side.append(new Option("위", "above"), new Option("왼쪽", "left"), new Option("오른쪽", "right"));
  side.value = current.side;
  sideLabel.append(side);
  const gapLabel = make("label", "badge-field");
  gapLabel.append(make("span", "", "간격 (px)"));
  const gap = make("input");
  gap.id = "badge-gap";
  gap.type = "number";
  gap.min = "0";
  gap.max = "40";
  gap.step = "1";
  gap.value = String(current.gap);
  gapLabel.append(gap);
  const status = make("span", "status");
  status.id = "badge-status";
  status.setAttribute("role", "status");
  box.append(sideLabel, gapLabel, status);
  let saved = current;
  const save = (): void => {
    const next: BadgePlacement = { side: side.value === "left" ? "left" : side.value === "right" ? "right" : "above", gap: Number(gap.value) };
    if (gap.value === "" || !Number.isInteger(next.gap) || next.gap < 0 || next.gap > 40) {
      setStatus(status, "간격은 0~40 사이의 정수로 입력하세요", "error");
      return;
    }
    // Inputs stay enabled (a disabled input drops focus mid-typing); saves run one after another.
    queue = queue.then(() => window.settings.saveBadge(next)).then((result) => {
      if (!result.ok) throw new Error("refused");
      saved = next;
      setStatus(status, "저장했어요", "ok");
    }).catch(() => {
      side.value = saved.side;
      gap.value = String(saved.gap);
      setStatus(status, "저장하지 못했어요", "error");
    });
  };
  let queue: Promise<void> = Promise.resolve();
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  side.addEventListener("change", save);
  gap.addEventListener("input", () => { clearTimeout(gapTimer); gapTimer = setTimeout(save, 250); });
  gap.addEventListener("change", () => { clearTimeout(gapTimer); save(); });
  return box;
}

function bubbleDisplayBox(current: BubbleDisplay): HTMLElement {
  const box = make("fieldset");
  box.id = "bubble-display";
  box.append(make("legend", "", "말풍선 표시"));
  const widthLabel = make("label", "badge-field");
  widthLabel.append(make("span", "", "최대 폭 (DIP)"));
  const width = make("input");
  width.id = "bubble-max-width";
  width.type = "number";
  width.min = "180";
  width.max = "600";
  width.step = "1";
  width.value = String(current.maxWidthDip);
  widthLabel.append(width);
  const linesLabel = make("label", "badge-field");
  linesLabel.append(make("span", "", "최대 줄 수"));
  const lines = make("input");
  lines.id = "bubble-max-lines";
  lines.type = "number";
  lines.min = "3";
  lines.max = "12";
  lines.step = "1";
  lines.value = String(current.maxLines);
  linesLabel.append(lines);
  const status = make("span", "status");
  status.id = "bubble-status";
  status.setAttribute("role", "status");
  box.append(widthLabel, linesLabel, status);
  let saved = current;
  const save = (): void => {
    const next = { maxWidthDip: Number(width.value), maxLines: Number(lines.value) };
    if (width.value === "" || !Number.isInteger(next.maxWidthDip) || next.maxWidthDip < 180 || next.maxWidthDip > 600 ||
        lines.value === "" || !Number.isInteger(next.maxLines) || next.maxLines < 3 || next.maxLines > 12) {
      setStatus(status, "최대 폭은 180~600, 최대 줄 수는 3~12 사이의 정수로 입력하세요", "error");
      return;
    }
    width.disabled = true;
    lines.disabled = true;
    void window.settings.saveBubble(next).then((result) => {
      if (!result.ok) throw new Error("refused");
      saved = next;
      setStatus(status, "저장했어요", "ok");
    }).catch(() => {
      width.value = String(saved.maxWidthDip);
      lines.value = String(saved.maxLines);
      setStatus(status, "저장하지 못했어요", "error");
    }).finally(() => { width.disabled = false; lines.disabled = false; });
  };
  width.addEventListener("input", save);
  lines.addEventListener("input", save);
  return box;
}

function renderGeneral(general: GeneralSettings, badge: BadgePlacement, bubble: BubbleDisplay, developerMode: DeveloperModeView, launchAtLogin: LaunchAtLoginView): void {
  const box = make("fieldset");
  box.append(make("legend", "", "방해 금지"));
  const enabledLabel = make("label");
  const enabled = make("input");
  enabled.type = "checkbox";
  enabled.id = "dnd-enabled";
  enabled.checked = general.enabled;
  enabledLabel.append(enabled, make("span", "", "방해 금지 켜기 (항상 조용히)"));
  box.append(enabledLabel);
  box.append(make("p", "description", "아래 시간대에는 말풍선 알림을 보류합니다. 끝 시각이 시작보다 이르면 자정을 넘기는 시간대입니다."));
  const rows = make("div");
  rows.id = "dnd-rows";
  for (const { start, end } of general.schedule) addScheduleRow(rows, start, end);
  const add = button("시간대 추가", "");
  add.id = "dnd-add";
  add.addEventListener("click", () => { addScheduleRow(rows); });
  const save = button("저장", "");
  save.id = "general-save";
  const note = dirtyNote();
  const status = make("span", "status");
  status.id = "general-status";
  status.setAttribute("role", "status");
  const actions = make("div", "actions");
  actions.append(save, note, status);
  box.append(rows, add, actions);
  const terrain = createTerrainSection(document, window.settings, make, (dirty) => { setFormDirty("terrain", dirty); });
  terrainLoaded = terrain.loaded;
  generalPanel.replaceChildren(...[box, badgePlacementBox(badge), bubbleDisplayBox(bubble), terrain.element, launchAtLoginBox(launchAtLogin), developerModeBox(developerMode)].filter((part): part is HTMLElement => part !== undefined));

  const readSchedule = () => Array.from(rows.querySelectorAll(".dnd-row"), (row) => ({
    start: row.querySelector<HTMLInputElement>(".dnd-start")?.value.trim() ?? "",
    end: row.querySelector<HTMLInputElement>(".dnd-end")?.value.trim() ?? "",
  }));
  // What the form was last loaded or saved with; editing back to it clears the note.
  let baseline = JSON.stringify({ enabled: general.enabled, schedule: general.schedule.map(({ start, end }) => ({ start, end })) });
  const updateDirty = (): void => {
    const dirty = JSON.stringify({ enabled: enabled.checked, schedule: readSchedule() }) !== baseline;
    note.textContent = dirty ? DIRTY_TEXT : "";
    setFormDirty("general", dirty);
  };
  for (const type of ["input", "change", "click"] as const) box.addEventListener(type, updateDirty);
  updateDirty();

  generalSync = (next) => {
    // The tray saved this change already, so the form follows it without becoming dirty.
    enabled.checked = next.enabled;
    baseline = JSON.stringify({ ...JSON.parse(baseline) as { schedule: unknown }, enabled: next.enabled });
    updateDirty();
  };

  save.addEventListener("click", () => {
    void (async () => {
      clearErrors(box);
      setStatus(status, "저장 중…", "");
      const schedule = readSchedule();
      try {
        const result = await window.settings.saveGeneral({ enabled: enabled.checked, schedule });
        if (result.ok) {
          baseline = JSON.stringify({ enabled: enabled.checked, schedule });
          updateDirty();
          setStatus(status, "저장했어요", "ok");
          return;
        }
        for (const { path, message } of result.errors) {
          const [, index, name] = path.split(".");
          const input = rows.querySelectorAll(".dnd-row")[Number(index)]?.querySelector(name === "end" ? ".dnd-end" : ".dnd-start");
          showError(input?.parentElement ?? null, message);
        }
        setStatus(status, result.errors.some(({ path }) => path !== "") ? "저장하지 못했어요. 표시된 항목을 고치세요" :
          result.errors[0]?.message ?? "저장하지 못했어요", "error");
      } catch { setStatus(status, "저장하지 못했어요", "error"); }
    })();
  });
}

/* ---------- plugin form controls ---------- */

function scalarControl(spec: ScalarSpec, value: unknown, required: boolean): Control {
  if (spec.type === "boolean") {
    const label = make("label");
    const input = make("input");
    input.type = "checkbox";
    input.dataset.role = "input";
    input.checked = value === true;
    label.append(input);
    return { element: label, read: () => input.checked };
  }
  if (spec.enum) {
    const select = make("select");
    select.dataset.role = "input";
    if (!required) select.append(new Option("(선택 안 함)", ""));
    for (const choice of spec.enum) select.append(new Option(String(choice), String(choice)));
    select.value = value === undefined || value === null ? "" : String(value);
    return { element: select, read: () => select.value === "" ? undefined : spec.type === "number" ? Number(select.value) : select.value };
  }
  const input = make("input");
  input.type = spec.type === "number" ? "number" : "text";
  if (spec.type === "number") input.step = "any";
  input.dataset.role = "input";
  input.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return { element: input, read: () => input.value === "" ? undefined : spec.type === "number" ? Number(input.value) : input.value };
}

/** A flat array property of a row: checkboxes when the elements come from an enum, otherwise a comma-separated line. */
function flatArrayControl(field: Extract<ObjectItemField, { type: "array" }>, value: unknown): Control {
  const values = Array.isArray(value) ? value : [];
  const convert = (text: string): string | number => field.items.type === "number" ? Number(text) : text;
  if (field.enum) {
    const group = make("div", "days");
    const weekdays = isWeekdayEnum(field.enum);
    const boxes = field.enum.map((choice) => {
      const label = make("label");
      const box = make("input");
      box.type = "checkbox";
      box.value = String(choice);
      box.dataset.role = "input";
      box.checked = values.includes(choice);
      label.append(box, make("span", "", weekdays && typeof choice === "number" ? WEEKDAYS[choice] ?? String(choice) : String(choice)));
      group.append(label);
      return box;
    });
    return { element: group, read: () => boxes.filter((box) => box.checked).map((box) => convert(box.value)) };
  }
  const input = make("input");
  input.type = "text";
  input.dataset.role = "input";
  input.placeholder = "쉼표로 구분";
  input.value = values.join(", ");
  return { element: input, read: () => input.value.split(",").map((part) => part.trim()).filter((part) => part !== "").map(convert) };
}

function objectRow(items: Extract<NonNullable<ConfigFieldSchema["items"]>, { type: "object" }>, value: unknown): { row: HTMLElement; read: Reader } {
  const row = make("div", "row");
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const readers: Array<[string, Reader]> = [];
  for (const [name, field] of Object.entries(items.properties)) {
    const required = items.required?.includes(name) === true;
    const initial = Object.hasOwn(record, name) ? record[name] : field.default;
    const control = field.type === "array" ? flatArrayControl(field, initial) : scalarControl(field, initial, required);
    const prop = make("div", "prop");
    prop.dataset.prop = name;
    prop.append(make("span", required ? "prop-title required" : "prop-title", field.title ?? name));
    if (field.description) prop.append(make("span", "description", field.description));
    prop.append(control.element, make("div", "field-error"));
    row.append(prop);
    readers.push([name, control.read]);
  }
  return { row, read: () => {
    const result: Record<string, unknown> = {};
    for (const [name, read] of readers) {
      const item = read();
      if (item !== undefined) Object.defineProperty(result, name, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } };
}

function listControl(field: ConfigFieldSchema, values: unknown): Control {
  const wrapper = make("div", "array");
  const list = make("div", "array-list");
  const readers = new Map<HTMLElement, Reader>();
  const addRow = (value: unknown): void => {
    let row: HTMLElement;
    let read: Reader;
    if (field.items?.type === "object") ({ row, read } = objectRow(field.items, value));
    else {
      row = make("div", "row");
      const control = scalarControl({ type: "string" }, value, true);
      row.append(control.element);
      read = control.read;
    }
    const remove = button("삭제", "row-remove");
    remove.addEventListener("click", () => { readers.delete(row); row.remove(); });
    row.append(remove, make("div", "field-error"), make("div", "rule-note"));
    readers.set(row, read);
    list.append(row);
  };
  for (const value of Array.isArray(values) ? values : []) addRow(value);
  const add = button("추가", "array-add");
  add.addEventListener("click", () => { addRow(undefined); });
  wrapper.append(list, add);
  // The map keeps insertion order and rows only ever append, so reading in map order is display order and error indexes match.
  return { element: wrapper, read: () => Array.from(readers.values(), (read) => read()) };
}

function secretControl(entry: FormEntry, name: string): { element: HTMLElement; input: HTMLInputElement; refresh(saved: boolean): void } {
  const wrapper = make("div", "secret");
  const input = make("input");
  input.type = "password";
  input.autocomplete = "off";
  input.dataset.role = "input";
  input.disabled = !entry.form.canStoreSecrets;
  const state = make("span", "secret-state");
  const clear = button("지우기", "secret-clear");
  const refresh = (saved: boolean): void => {
    state.textContent = saved ? "저장됨" : "없음";
    clear.hidden = !saved;
  };
  refresh(entry.form.secrets[name] === true);
  clear.addEventListener("click", () => {
    void (async () => {
      const status = wrapper.closest(".plugin")?.querySelector<HTMLElement>(".plugin-status");
      try {
        const result = await window.settings.clearSecret({ pluginId: entry.id, field: name });
        if (result.ok) { refresh(result.secrets[name] === true); if (status) setStatus(status, "비밀 값을 지웠어요", "ok"); }
        else if (status) setStatus(status, result.errors[0]?.message ?? "지우지 못했어요", "error");
      } catch { if (status) setStatus(status, "지우지 못했어요", "error"); }
    })();
  });
  wrapper.append(input, state, clear);
  if (!entry.form.canStoreSecrets) wrapper.append(make("div", "description", "이 플러그인은 비밀 값을 저장할 권한이 없어 입력할 수 없습니다"));
  return { element: wrapper, input, refresh };
}

/* ---------- plugins ---------- */

const pluginsPanel = mustFind<HTMLElement>("#plugins");
const remindersPanel = mustFind<HTMLElement>("#reminders");
const remindersTab = mustFind<HTMLButtonElement>("#tab-reminders");

function renderReminders(plugins: readonly PluginSettingsEntry[]): void {
  renderRemindersPanel(remindersPanel, plugins.find(({ id }) => id === "reminders"), window.settings,
    (dirty, count) => { setFormDirty("reminders", dirty); window.settings.setReminderDirty(count); });
}
const reminderLoad = createReminderLoadGuard(renderReminders, () => dirtyByKey.get("reminders") === true);

function applyErrors(form: HTMLElement, errors: readonly FieldError[]): string {
  let general = "";
  for (const { path, message } of errors) {
    const [name = "", ...rest] = path.split(".");
    const field = Array.from(form.querySelectorAll<HTMLElement>(".field")).find((candidate) => candidate.dataset.field === name);
    if (!field) { general = message; continue; }
    if (rest.length === 0) { showError(field, message); continue; }
    const row = field.querySelectorAll(":scope .array-list > .row")[Number(rest[0])];
    if (!row) { showError(field, message); continue; }
    const prop = rest[1] === undefined ? undefined : Array.from(row.querySelectorAll<HTMLElement>(":scope > .prop")).find((candidate) => candidate.dataset.prop === rest[1]);
    showError(prop ?? row, message);
  }
  return general;
}

function buildForm(entry: FormEntry): HTMLElement {
  const form = make("form", "plugin-form");
  form.noValidate = true;
  const { schema } = entry.form;
  const readers: Array<[string, Reader]> = [];
  const secretInputs: Array<[string, HTMLInputElement, (saved: boolean) => void]> = [];
  for (const [name, field] of Object.entries(schema.properties)) {
    const required = schema.required?.includes(name) === true;
    const container = make("div", "field");
    container.dataset.field = name;
    container.append(make("div", required ? "field-title required" : "field-title", field.title ?? name));
    if (field.description) container.append(make("p", "description", field.description));
    if (field.secret === true) {
      const secret = secretControl(entry, name);
      container.append(secret.element);
      secretInputs.push([name, secret.input, secret.refresh]);
    } else {
      const initial = Object.hasOwn(entry.form.values, name) ? entry.form.values[name] : field.default;
      const control = field.type === "array" ? listControl(field, initial) : scalarControl({ type: field.type, enum: field.enum }, initial, required);
      container.append(control.element);
      readers.push([name, control.read]);
    }
    container.append(make("div", "field-error"));
    form.append(container);
  }
  // Reminders only: each rule row says when it fires next, or why the plugin skips it, from the values being edited.
  const rulesField = entry.id === "reminders" ? readers.find(([name]) => name === "rules") : undefined;
  let formDirty = false;
  const annotateRules = (): void => {
    if (!rulesField) return;
    const value = rulesField[1]();
    const rows = form.querySelectorAll<HTMLElement>("[data-field='rules'] .array-list > .row");
    const notes = describeRules(Array.isArray(value) ? value : [], new Date());
    rows.forEach((row, index) => {
      const target = row.querySelector<HTMLElement>(":scope > .rule-note");
      const note = notes[index];
      if (!target || !note) return;
      target.textContent = note.kind === "next" && formDirty ? `${note.text} (저장하면 적용돼요)` : note.text;
      target.className = `rule-note ${note.kind}`;
    });
  };
  const readConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const [name, read] of readers) {
      const value = read();
      if (value !== undefined) Object.defineProperty(config, name, { value, enumerable: true, writable: true, configurable: true });
    }
    return config;
  };
  const save = make("button", "plugin-save", "저장");
  save.type = "submit";
  const note = dirtyNote();
  const status = make("span", "status plugin-status");
  status.setAttribute("role", "status");
  const actions = make("div", "actions");
  actions.append(save, note, status);
  form.append(actions);
  // What the form was last loaded or saved with; a typed secret counts as a change until it is saved.
  let baseline = JSON.stringify({ config: readConfig(), secrets: secretInputs.map(([, input]) => input.value !== "") });
  const updateDirty = (): void => {
    const dirty = JSON.stringify({ config: readConfig(), secrets: secretInputs.map(([, input]) => input.value !== "") }) !== baseline;
    note.textContent = dirty ? DIRTY_TEXT : "";
    setFormDirty(`plugin:${entry.id}`, dirty);
    formDirty = dirty;
    annotateRules();
  };
  if (rulesField) {
    // "오늘"/"내일" go stale while the window stays open.
    const timer = setInterval(() => { if (form.isConnected) annotateRules(); else clearInterval(timer); }, 60_000);
  }
  for (const type of ["input", "change", "click"] as const) form.addEventListener(type, updateDirty);
  updateDirty();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      clearErrors(form);
      setStatus(status, "저장 중…", "");
      save.disabled = true;
      const config = readConfig();
      const secrets: Record<string, string> = {};
      for (const [name, input] of secretInputs) if (input.value !== "") Object.defineProperty(secrets, name, { value: input.value, enumerable: true, writable: true, configurable: true });
      try {
        const result = await window.settings.savePlugin({ pluginId: entry.id, config, secrets });
        if (result.ok) {
          // The typed value must not linger on the page once it is stored.
          for (const [name, input, refresh] of secretInputs) { input.value = ""; refresh(result.secrets[name] === true); }
          baseline = JSON.stringify({ config: readConfig(), secrets: secretInputs.map(([, input]) => input.value !== "") });
          updateDirty();
          setStatus(status, "저장했어요", "ok");
        } else {
          const general = applyErrors(form, result.errors);
          setStatus(status, general || "저장하지 못했어요. 표시된 항목을 고치세요", "error");
        }
      } catch { setStatus(status, "저장하지 못했어요", "error"); }
      finally { save.disabled = false; }
    })();
  });
  return form;
}

function renderPlugins(plugins: readonly PluginSettingsEntry[]): void {
  clearPluginDirty();
  const refresh = button("새로 고침", "");
  refresh.id = "plugins-refresh";
  refresh.addEventListener("click", () => { void reloadPlugins(); });
  const heading = make("div", "actions");
  heading.append(make("h2", "", "플러그인"), refresh);
  const cards = plugins.map((entry) => {
    const card = make("section", "plugin");
    card.dataset.pluginId = entry.id;
    card.append(make("p", "plugin-line", entry.statusLine));
    if (entry.id === "reminders") {
      const link = button("규칙은 [알림] 탭에서 편집", "reminder-tab-link");
      link.addEventListener("click", () => remindersTab.click());
      card.append(link);
      if (entry.notice) card.append(make("p", "muted plugin-notice", entry.notice));
    }
    else if (entry.form) card.append(buildForm({ ...entry, form: entry.form }));
    else card.append(make("p", "muted plugin-notice", entry.notice));
    return card;
  });
  pluginsPanel.replaceChildren(heading, ...(cards.length > 0 ? cards : [make("p", "muted", "설치된 플러그인이 없습니다")]));
}

async function reloadPlugins(): Promise<void> {
  const request = reminderLoad.begin();
  try { const plugins = (await window.settings.load()).plugins; renderPlugins(plugins); reminderLoad.apply(request, plugins); }
  catch { pluginsPanel.replaceChildren(make("p", "status error", "플러그인 목록을 불러오지 못했어요")); }
}

/* ---------- voice ---------- */

const voicePanel = mustFind<HTMLElement>("#voice");
/** What the panel was last drawn from; a tab visit redraws only when the character's voice changed, so typed slots survive. */
let drawnVoice = "";
let voiceController: VoiceEditorController | undefined;
let pluginLinesController: VoiceEditorController | undefined;
const voiceLoadGate = createVoiceLoadGate(() => voiceController?.dirty() === true || pluginLinesController?.dirty() === true);

async function reloadVoice(pack: PackListItem): Promise<void> {
  const request = voiceLoadGate.begin();
  try {
    const [result, lineResult, pluginResult] = await Promise.all([
      window.settings.packVoiceLoad({ packId: pack.id }), window.settings.lineSettingsLoad(), window.settings.load(),
    ]);
    if (!voiceLoadGate.accepts(request)) return;
    if (!result.ok) throw new Error(result.errors[0]?.message ?? "Voice unavailable");
    const view: VoiceView = { characterName: pack.name, kinds: VOICE_KINDS.map((kind) => ({ kind, variants: (result.templates[kind] ?? []).map(lineVariantText) })),
      problems: result.problems };
    const json = JSON.stringify({ id: pack.id, view, current: pack.current, lines: lineResult, plugins: pluginResult.plugins });
    if (json === drawnVoice) return;
    drawnVoice = json;
    voiceController = renderVoicePanel(document, voicePanel, view, window.settings,
      pack.current ? "현재 캐릭터" : "선택한 캐릭터", {
        packId: pack.id,
        templates: result.templates,
        baseTemplates: result.baseTemplates,
        setDirty: (dirty) => setFormDirty("voice", dirty),
        onSaved: async (packId, derived) => {
          await character.refresh(packId);
          const status = voicePanel.querySelector<HTMLElement>("#voice-editor-status");
          if (status) status.textContent = derived
            ? `내장 팩은 바꿀 수 없어 '${pack.name} (내 버전)' 으로 저장했어요` : "저장했어요";
        },
        confirmDiscarded: (count) => window.settings.confirm(`${count}개 변형이 저장 때 버려져요. 계속 저장할까요?`),
      });
    pluginLinesController = undefined;
    setFormDirty("plugin-lines", false);
    if (lineResult.ok && lineResult.packId === pack.id) {
      pluginLinesController = renderPluginLinesPanel(document, voicePanel, lineResult, pluginResult.plugins,
        window.settings, (dirty) => setFormDirty("plugin-lines", dirty));
    } else voicePanel.append(make("p", "muted", "플러그인별 대사는 현재 캐릭터를 선택하면 편집할 수 있어요"));
  } catch {
    if (!voiceLoadGate.accepts(request)) return;
    voiceController = undefined;
    pluginLinesController = undefined;
    setFormDirty("plugin-lines", false);
    voicePanel.replaceChildren(make("p", "status error", "어투 정보를 불러오지 못했어요"));
    drawnVoice = "";
  }
}

/* ---------- interactions ---------- */

const interactionsPanel = mustFind<HTMLElement>("#interactions");
const interactionReload = createInteractionsReload(
  async (packId: string) => {
    const result = await window.settings.packInteractionsLoad({ packId });
    if (!result.ok) throw new Error(result.errors[0]?.message ?? "Interactions unavailable");
    return result.view;
  },
  (packId, view) => {
    renderInteractionsPanel(document, interactionsPanel, view, packId, window.settings, {
      setDirty: (dirty) => { setFormDirty("interactions", dirty); },
      saved: async ({ packId: savedPackId, derived }) => {
        interactionReload.invalidate();
        sequenceReload.invalidate();
        await character.refresh(savedPackId);
        const status = mustFind<HTMLElement>("#pack-status");
        status.textContent = derived ? "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요" : "저장했어요";
        const interactionStatus = interactionsPanel.querySelector<HTMLElement>("#ix-status");
        if (interactionStatus) interactionStatus.textContent = "저장했어요";
      },
    });
  },
  () => {
    interactionsPanel.replaceChildren(make("p", "status error", "상호작용 정보를 불러오지 못했어요"));
  },
  () => dirtyByKey.get("interactions") === true,
);

async function reloadInteractions(pack: PackListItem): Promise<void> { await interactionReload.reload(pack.id); }

/* ---------- sequences (동작) ---------- */

const sequencesPanel = mustFind<HTMLElement>("#sequences");
const sequenceReload = createInteractionsReload<SequencesView>(
  async (packId: string) => {
    const [loaded, interactions] = await Promise.all([window.settings.sequencesLoad({ packId }), window.settings.packInteractionsLoad({ packId })]);
    if (!loaded.ok) throw new Error(loaded.errors[0]?.message ?? "Sequences unavailable");
    const refs = interactions.ok ? interactions.view.items.flatMap((item) => item.sequence === undefined ? []
      : [{ id: item.id, label: item.label, sequence: item.sequence }]) : [];
    return { sequences: loaded.sequences.sequences, plays: loaded.plays, refs };
  },
  (packId, view) => {
    renderSequencesPanel(document, sequencesPanel, view, packId, window.settings, {
      setDirty: (dirty) => { setFormDirty("sequences", dirty); },
      saved: async ({ packId: savedPackId, derived }) => {
        sequenceReload.invalidate();
        interactionReload.invalidate();
        await character.refresh(savedPackId);
        const status = mustFind<HTMLElement>("#pack-status");
        status.textContent = derived ? "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요" : "저장했어요";
        const sequenceStatus = sequencesPanel.querySelector<HTMLElement>("#sq-status");
        if (sequenceStatus) sequenceStatus.textContent = "저장했어요";
      },
    });
  },
  () => {
    sequencesPanel.replaceChildren(make("p", "status error", "동작 정보를 불러오지 못했어요"));
  },
  () => dirtyByKey.get("sequences") === true,
);

async function reloadSequences(pack: PackListItem): Promise<void> { await sequenceReload.reload(pack.id); }

/* ---------- notification reactions ---------- */

const reactionsPanel = mustFind<HTMLElement>("#reactions");
let reactionsController: ReactionsController | undefined;
let reactionsGeneration = 0;
async function reloadReactions(pack: PackListItem): Promise<void> {
  const generation = ++reactionsGeneration;
  if (reactionsController?.dirty()) return;
  try {
    const [result, lineResult, pluginResult] = await Promise.all([
      window.settings.reactionsLoad({ packId: pack.id }), window.settings.lineSettingsLoad(), window.settings.load(),
    ]);
    if (generation !== reactionsGeneration || reactionsController?.dirty()) return;
    if (!result.ok) throw new Error(result.errors[0]?.message ?? "Reactions unavailable");
    reactionsController?.discard();
    reactionsController = renderReactionsPanel(document, reactionsPanel, result, pack.id, window.settings, {
      setDirty: (dirty) => setFormDirty("reactions", dirty),
      saved: async ({ packId: savedPackId, derived }) => {
        await character.refresh(savedPackId);
        const status = mustFind<HTMLElement>("#pack-status");
        status.textContent = derived ? "내장 팩을 복제한 편집 팩에 저장했어요" : "저장했어요";
      },
    }, lineResult.ok && lineResult.packId === pack.id
      ? { catalogs: lineResult.catalogs, plugins: pluginResult.plugins, reactions: lineResult.reactions ?? {},
        lineReactionsSave: window.settings.lineReactionsSave }
      : undefined);
  } catch {
    if (generation !== reactionsGeneration) return;
    reactionsPanel.replaceChildren(make("p", "status error", "알림 반응을 불러오지 못했어요"));
  }
}

/* ---------- movement motions ---------- */

const motionsPanel = mustFind<HTMLElement>("#motions");
let motionsController: MotionsController | undefined;
let motionsGeneration = 0;
async function reloadMotions(pack: PackListItem): Promise<void> {
  const generation = ++motionsGeneration;
  if (motionsController?.dirty()) return;
  try {
    const result = await window.settings.motionsLoad({ packId: pack.id });
    if (generation !== motionsGeneration || motionsController?.dirty()) return;
    if (!result.ok) throw new Error(result.errors[0]?.message ?? "Motions unavailable");
    motionsController?.discard();
    motionsController = renderMotionsPanel(document, motionsPanel, result, pack.id, window.settings, {
      setDirty: (dirty) => setFormDirty("motions", dirty),
      saved: async ({ packId: savedPackId, derived }) => {
        await character.refresh(savedPackId);
        const status = mustFind<HTMLElement>("#pack-status");
        status.textContent = derived ? "내장 팩을 복제한 편집 팩에 저장했어요" : "저장했어요";
      },
    });
  } catch {
    if (generation !== motionsGeneration) return;
    motionsPanel.replaceChildren(make("p", "status error", "이동 설정을 불러오지 못했어요"));
  }
}

/* ---------- sheets (애니메이션, developer mode) ---------- */

const sheetsPanel = mustFind<HTMLElement>("#sheets");
let sheetsNotice = "";
async function showSheets(pack: PackListItem): Promise<void> {
  const notice = sheetsNotice;
  sheetsNotice = "";
  renderSheetsPanel(document, sheetsPanel, pack, window.settings, {
    applied: async (packId, text) => { sheetsNotice = text; await character.refresh(packId); },
  }, notice);
}

/* ---------- tabs and start ---------- */

const characterPanel = mustFind<HTMLElement>("#character");
const behavior = createBehaviorPanel(document, mustFind<HTMLElement>("#behavior"), window.settings,
  (dirty) => setFormDirty("behavior", dirty));
async function beforePackChange(): Promise<boolean> {
  if (!voiceController?.dirty() && !pluginLinesController?.dirty()) return true;
  const prompt = make("div", "voice-leave-prompt");
  prompt.id = "voice-leave-prompt";
  prompt.setAttribute("role", "dialog");
  prompt.append(make("p", "", "저장하지 않은 어투 변경이 있어요"));
  return new Promise((resolve) => {
    const choose = (label: string, action: () => Promise<boolean>): void => {
      const button = make("button", "", label);
      button.type = "button";
      button.addEventListener("click", () => { void (async () => {
        const proceed = await action();
        prompt.remove();
        resolve(proceed);
      })(); });
      prompt.append(button);
    };
    choose("저장", async () => {
      if (pluginLinesController?.dirty() && !await pluginLinesController.save()) return false;
      if (voiceController?.dirty() && !await voiceController.save()) return false;
      return true;
    });
    choose("버리기", async () => { voiceController?.discard(); pluginLinesController?.discard(); return true; });
    choose("계속 편집", async () => false);
    characterPanel.append(prompt);
  });
}
const character = createCharacterPanel(document, characterPanel, window.settings, {
  setDirty: (dirty) => setFormDirty("pack-meta", dirty),
  showVoice: reloadVoice,
  showInteractions: reloadInteractions,
  showSequences: reloadSequences,
  showReactions: reloadReactions,
  showMotions: reloadMotions,
  showSheets,
  showBehavior: async (pack) => behavior.load(pack.id),
  beforePackChange,
  interactionsDirty: () => dirtyByKey.get("interactions") === true,
  discardInteractions: () => { interactionReload.invalidate(); setFormDirty("interactions", false); },
  sequencesDirty: () => dirtyByKey.get("sequences") === true,
  discardSequences: () => { sequenceReload.invalidate(); setFormDirty("sequences", false); },
  reactionsDirty: () => reactionsController?.dirty() === true,
  discardReactions: () => { reactionsGeneration += 1; reactionsController?.discard(); reactionsController = undefined; },
  motionsDirty: () => motionsController?.dirty() === true,
  discardMotions: () => { motionsGeneration += 1; motionsController?.discard(); motionsController = undefined; },
  behaviorDirty: () => behavior.dirty(),
  discardBehavior: () => behavior.discard(),
  confirmDiscard: () => window.settings.confirm("저장하지 않은 변경이 있어요. 버릴까요?"),
});
const tabs: Array<[HTMLElement, HTMLElement]> = [[mustFind("#tab-general"), generalPanel], [mustFind("#tab-character"), characterPanel],
  [remindersTab, remindersPanel], [mustFind("#tab-plugins"), pluginsPanel]];
for (const [tab, panel] of tabs) {
  tab.addEventListener("click", () => {
    for (const [otherTab, otherPanel] of tabs) {
      otherTab.setAttribute("aria-selected", String(otherTab === tab));
      otherPanel.hidden = otherPanel !== panel;
    }
  });
}

window.settings.onGeneralChanged((general) => generalSync?.(general));

void (async () => {
  const request = reminderLoad.begin();
  try {
    const view = await window.settings.load();
    renderGeneral(view.general, view.badge, view.bubble, view.developerMode, view.launchAtLogin);
    await terrainLoaded;
    renderPlugins(view.plugins);
    reminderLoad.apply(request, view.plugins);
    await character.load();
  } catch { generalPanel.replaceChildren(make("p", "status error", "설정을 불러오지 못했어요")); }
  window.settings.markReady();
})();
