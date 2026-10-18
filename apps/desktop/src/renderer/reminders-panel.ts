import type { PluginSettingsEntry } from "../main/plugin-host-app.js";
import type { PluginSaveResult, VoiceSendResult } from "../main/settings-service.js";
import { describeRules } from "./reminder-notes.js";
import { evaluateRules, nextOccurrence } from "../../../../plugins/reminders/src/schedule.js";

type Saved = { key: number; value: unknown };
type Api = {
  savePlugin(payload: { pluginId: string; config: Record<string, unknown>; secrets: Record<string, string> }): Promise<PluginSaveResult>;
  voiceSend(payload: { kind: "reminder"; slots: { task: string; message: string } }): Promise<VoiceSendResult>;
  enableReminder(): Promise<{ ok: boolean; message?: string }>;
  load(): Promise<{ plugins: PluginSettingsEntry[] }>;
};
type Card = { key?: number; element: HTMLElement; read(): Record<string, unknown>; dirty(): boolean; refresh(): void; saved?: unknown };

export function createReminderLoadGuard(apply: (plugins: readonly PluginSettingsEntry[]) => void, dirty: () => boolean) {
  let latest = 0;
  return {
    begin: (): number => ++latest,
    apply: (request: number, plugins: readonly PluginSettingsEntry[]): void => {
      if (request === latest && !dirty()) apply(plugins);
    },
  };
}
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (value: number): string => String(value).padStart(2, "0");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: string): number => Array.from(value).length;

export function toClock(period: string, hour: number, minute: number): string | undefined {
  if ((period !== "am" && period !== "pm") || !Number.isInteger(hour) || hour < 1 || hour > 12 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return `${pad(hour % 12 + (period === "pm" ? 12 : 0))}:${pad(minute)}`;
}

export function fromClock(value: unknown): { period: "am" | "pm"; hour: number; minute: number } | undefined {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) return undefined;
  const hour = Number(value.slice(0, 2));
  return { period: hour < 12 ? "am" : "pm", hour: hour % 12 || 12, minute: Number(value.slice(3)) };
}

export function newReminderId(now: number, used: ReadonlySet<string>): string {
  const prefix = `r-${Math.max(0, Math.floor(now)).toString(36)}`;
  let id = prefix;
  for (let suffix = 1; used.has(id); suffix += 1) id = `${prefix}-${suffix.toString(36)}`;
  return id;
}

export function saveOne(saved: readonly Saved[], key: number | undefined, value: Record<string, unknown>): unknown[] {
  if (key === undefined) return [...saved.map(({ value: row }) => row), value];
  return saved.map((row) => row.key === key ? value : row.value);
}

export function priorityFor(saved: unknown, touched: boolean, checked: boolean): unknown {
  return touched ? checked ? "urgent" : undefined : saved;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", label?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}
function button(label: string, className = ""): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  return element;
}

export function renderRemindersPanel(root: HTMLElement, entry: PluginSettingsEntry | undefined, api: Api,
  setDirty: (dirty: boolean, count: number) => void): void {
  let sequence = 0;
  let saved: Saved[] = (Array.isArray(entry?.form?.values.rules) ? entry.form.values.rules : [])
    .map((value) => ({ key: ++sequence, value }));
  const cards: Card[] = [];
  const issuedIds = new Set<string>();
  const list = make("div", "reminder-list");
  const heading = make("div", "reminder-heading");
  const add = button("+ 새 알림", "reminder-add");
  add.disabled = entry?.state !== "running";
  heading.append(make("h2", "", "알림"), add);
  const disabled = make("div", "reminder-disabled");
  if (entry?.state === "disabled") {
    disabled.append(make("span", "", "reminders 플러그인이 꺼져 있어요 "));
    const enable = button("켜기", "reminder-enable");
    enable.addEventListener("click", () => { void (async () => {
      enable.disabled = true;
      const result = await api.enableReminder();
      if (result.ok) renderRemindersPanel(root, (await api.load()).plugins.find(({ id }) => id === "reminders"), api, setDirty);
      else { disabled.append(make("span", "status error", result.message ?? "켜지 못했어요")); enable.disabled = false; }
    })(); });
    disabled.append(enable);
  }
  root.replaceChildren(heading, disabled, list);

  const dirtyCount = (): number => cards.filter((card) => card.dirty()).length;
  const updateDirty = (): void => setDirty(dirtyCount() > 0, dirtyCount());
  const usedIds = (): Set<string> => new Set([...issuedIds, ...saved.map(({ value }) => record(value).id)
    .filter((id): id is string => typeof id === "string")]);
  const sortClean = (): void => {
    const now = new Date();
    const times = new Map<Card, number>();
    const statuses = evaluateRules(saved.map(({ value }) => value));
    for (const card of cards) {
      if (card.dirty()) continue;
      const result = statuses[saved.findIndex(({ key }) => key === card.key)];
      times.set(card, result?.ok ? nextOccurrence(result.rule, now).getTime() : Number.POSITIVE_INFINITY);
    }
    const clean = cards.filter((card) => times.has(card)).sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
    const positions = cards.map((card, index) => times.has(card) ? index : -1).filter((index) => index >= 0);
    positions.forEach((position, index) => { const card = clean[index]; if (card) cards[position] = card; });
    list.replaceChildren(...cards.map(({ element }) => element));
  };

  const addCard = (initial: unknown, key?: number): Card => {
    const original = record(initial);
    const clock = fromClock(original.time);
    const nextHour = new Date(); nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const fallback = fromClock(`${pad(nextHour.getHours())}:00`) ?? { period: "am", hour: 12, minute: 0 };
    const card = make("section", "reminder-card");
    card.dataset.reminderKey = String(key ?? "new");
    const title = make("h3", "reminder-title");
    const time = make("div", "reminder-time");
    const period = make("select", "reminder-period");
    for (const [value, label] of [["am", "오전"], ["pm", "오후"]] as const) {
      const option = make("option", "", label); option.value = value; period.append(option);
    }
    period.value = (clock ?? fallback).period;
    const hour = make("select", "reminder-hour");
    for (let number = 1; number <= 12; number += 1) { const option = make("option", "", String(number)); option.value = String(number); hour.append(option); }
    hour.value = String((clock ?? fallback).hour);
    const minute = make("input", "reminder-minute"); minute.type = "number"; minute.min = "0"; minute.max = "59"; minute.step = "1";
    minute.value = pad((clock ?? fallback).minute);
    time.append(period, hour, make("span", "", "시"), minute, make("span", "", "분"));
    const days = make("div", "reminder-days");
    const dayInputs = DAYS.map((label, index) => {
      const wrapper = make("label", "reminder-day");
      const input = make("input"); input.type = "checkbox"; input.value = String(index);
      input.checked = Array.isArray(original.days) && original.days.includes(index);
      wrapper.append(input, make("span", "", label)); days.append(wrapper);
      return input;
    });
    for (const [label, values] of [["매일", []], ["평일", [1, 2, 3, 4, 5]], ["주말", [0, 6]]] as const) {
      const quick = button(label, "reminder-quick");
      quick.addEventListener("click", () => { dayInputs.forEach((input, index) => { input.checked = values.some((day) => day === index); }); daysTouched = true; changed(); });
      days.append(quick);
    }
    const textLabel = make("label", "reminder-text-label", "문구 ");
    const input = make("input", "reminder-text"); input.type = "text";
    input.value = typeof original.text === "string" ? original.text : "";
    const remaining = make("span", "reminder-remaining");
    textLabel.append(input, remaining);
    const priorityLabel = make("label", "reminder-priority-label");
    const priority = make("input", "reminder-priority"); priority.type = "checkbox"; priority.checked = original.priority === "urgent";
    priorityLabel.append(priority, make("span", "", "방해 금지 중에도 알림"));
    const preserved = make("p", "description reminder-preserved");
    if (original.priority === "low" || original.priority === "high") preserved.textContent = `기타 우선순위(${original.priority}) 유지 중`;
    const note = make("p", "rule-note reminder-next");
    const error = make("p", "field-error reminder-error");
    const actions = make("div", "actions reminder-actions");
    const preview = button("▶ 미리보기", "reminder-preview");
    const revert = button(key === undefined ? "취소" : "되돌리기", "reminder-revert");
    const save = button("저장", "reminder-save");
    const remove = button("삭제", "reminder-remove");
    const confirm = make("div", "reminder-confirm"); confirm.hidden = true;
    const confirmDelete = button("삭제", "reminder-confirm-delete");
    const cancelDelete = button("취소", "reminder-cancel-delete");
    confirm.append(make("span", "", "이 알림을 삭제할까요? "), confirmDelete, cancelDelete);
    actions.append(preview, revert, save, remove);
    card.append(title, time, days, textLabel, priorityLabel, preserved, note, error, actions, confirm);
    let timeTouched = key === undefined;
    let daysTouched = key === undefined;
    let textTouched = key === undefined;
    let priorityTouched = key === undefined;
    let edited = key === undefined;
    const generatedId = newReminderId(Date.now(), usedIds());
    issuedIds.add(generatedId);
    const duplicateId = saved.some((row) => row.key !== key && record(row.value).id === original.id);
    const model: Card = {
      key, element: card, saved: initial,
      dirty: () => model.key === undefined || edited && JSON.stringify(model.read()) !== JSON.stringify(model.saved),
      read: () => {
        const value: Record<string, unknown> = { ...original };
        if (key === undefined || timeTouched || daysTouched || textTouched || priorityTouched) {
          if (typeof original.id !== "string" || original.id === "" || duplicateId) value.id = generatedId;
        }
        if (timeTouched || clock) value.time = toClock(period.value, Number(hour.value), minute.value === "" ? NaN : Number(minute.value)) ?? "";
        if (daysTouched || !Object.hasOwn(original, "days")) {
          const chosen = dayInputs.flatMap((day, index) => day.checked ? [index] : []);
          if (chosen.length > 0) value.days = chosen; else delete value.days;
        }
        if (textTouched) value.text = input.value;
        const nextPriority = priorityFor(original.priority, priorityTouched, priority.checked);
        if (nextPriority === undefined) delete value.priority; else value.priority = nextPriority;
        return value;
      },
      refresh: () => {
        const draft = model.read();
        const dirty = model.dirty();
        title.textContent = model.key === undefined ? "새 알림 · 아직 저장 안 됨" : dirty ? "● 변경 있음" : "저장됨";
        revert.hidden = !dirty; save.hidden = !dirty; remove.hidden = dirty && model.key !== undefined;
        const length = count(input.value); remaining.textContent = `${length}/120`;
        save.disabled = length < 1 || length > 120 || draft.time === "";
        error.textContent = length === 0 ? "문구를 입력해 주세요" : length > 120 ? "문구는 120자까지 입력할 수 있어요" : draft.time === "" ? "분은 0부터 59까지 입력해 주세요" : "";
        const rows = dirty ? saveOne(saved, model.key, draft) : saved.map(({ value }) => value);
        const index = model.key === undefined ? rows.length - 1 : saved.findIndex(({ key: rowKey }) => rowKey === model.key);
        const reason = describeRules(rows, new Date())[index];
        note.textContent = reason?.kind === "skipped" && !dirty ? `이 알림은 형식이 맞지 않아 울리지 않아요: ${reason.text}` :
          reason?.kind === "next" && dirty ? `저장하면 ${reason.text}` : reason?.text ?? "";
        note.classList.toggle("skipped", reason?.kind === "skipped");
        updateDirty();
      },
    };
    const changed = (): void => { edited = true; model.refresh(); };
    for (const item of [period, hour, minute]) item.addEventListener("change", () => { timeTouched = true; changed(); });
    minute.addEventListener("input", () => { timeTouched = true; changed(); });
    days.addEventListener("change", () => { daysTouched = true; changed(); });
    input.addEventListener("input", () => { textTouched = true; changed(); });
    priority.addEventListener("change", () => { priorityTouched = true; preserved.textContent = ""; changed(); });
    revert.addEventListener("click", () => {
      if (model.key === undefined) { cards.splice(cards.indexOf(model), 1); card.remove(); updateDirty(); return; }
      const old = model.saved;
      const index = cards.indexOf(model); cards.splice(index, 1); card.remove();
      const replacement = addCard(old, model.key); cards.splice(cards.indexOf(replacement), 1); cards.splice(index, 0, replacement);
      list.replaceChildren(...cards.map(({ element }) => element)); updateDirty();
    });
    preview.addEventListener("click", () => { void (async () => {
      const result = await api.voiceSend({ kind: "reminder", slots: { task: input.value, message: input.value } });
      if (!result.ok) error.textContent = result.message;
    })(); });
    const busy = (value: boolean): void => { save.disabled = value; remove.disabled = value; confirmDelete.disabled = value; };
    save.addEventListener("click", () => { void (async () => {
      if (save.disabled) return;
      busy(true); error.textContent = "";
      const value = model.read();
      const result = await api.savePlugin({ pluginId: "reminders", config: { rules: saveOne(saved, model.key, value) }, secrets: {} });
      if (!result.ok) { error.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; busy(false); return; }
      if (model.key === undefined) model.key = ++sequence;
      const position = saved.findIndex(({ key: savedKey }) => savedKey === model.key);
      if (position < 0) saved.push({ key: model.key, value }); else saved[position] = { key: model.key, value };
      model.saved = value; card.dataset.reminderKey = String(model.key);
      title.textContent = "저장했어요"; model.refresh(); sortClean(); busy(false);
    })(); });
    remove.addEventListener("click", () => { confirm.hidden = false; });
    cancelDelete.addEventListener("click", () => { confirm.hidden = true; });
    confirmDelete.addEventListener("click", () => { void (async () => {
      if (model.key === undefined) return;
      busy(true);
      const result = await api.savePlugin({ pluginId: "reminders", config: { rules: saved.filter(({ key: rowKey }) => rowKey !== model.key).map(({ value }) => value) }, secrets: {} });
      if (!result.ok) { error.textContent = result.errors[0]?.message ?? "삭제하지 못했어요"; busy(false); return; }
      saved = saved.filter(({ key: rowKey }) => rowKey !== model.key);
      cards.splice(cards.indexOf(model), 1); card.remove(); updateDirty();
    })(); });
    cards.push(model); list.append(card); model.refresh();
    return model;
  };
  const initial = [...saved];
  const statuses = evaluateRules(initial.map(({ value }) => value));
  const now = new Date();
  initial.sort((a, b) => {
    const left = statuses[saved.indexOf(a)]; const right = statuses[saved.indexOf(b)];
    return (left?.ok ? nextOccurrence(left.rule, now).getTime() : Number.POSITIVE_INFINITY) -
      (right?.ok ? nextOccurrence(right.rule, now).getTime() : Number.POSITIVE_INFINITY);
  });
  initial.forEach(({ value, key }) => addCard(value, key));
  add.addEventListener("click", () => {
    const card = addCard({}, undefined);
    cards.splice(cards.indexOf(card), 1); cards.unshift(card);
    list.prepend(card.element);
    card.element.querySelector<HTMLInputElement>(".reminder-text")?.focus();
    updateDirty();
  });
  updateDirty();
}
