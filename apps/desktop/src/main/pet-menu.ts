import { CHARACTER_INTERACTIONS_MAX_LINES, stateNamePattern, validSequenceId, type PetEvent } from "@deskpet/core";
import type { MenuItemConstructorOptions } from "electron";
import type { PluginMenuItem } from "./tray.js";

export type InteractionMood = "happy" | "surprised" | "sleepy" | "worried" | "neutral";
export interface PetInteraction {
  id: string;
  label: string;
  mood: InteractionMood;
  /** Whether the interaction shows a speech bubble; off, only the expression changes. */
  speak: boolean;
  /** What the pet says, one line per press in turn; shown as written (no voice template). */
  lines: string[];
  play?: string;
  sequence?: string;
  /** One of the shipped interactions (derived by mergeInteractions, never trusted from stored data). */
  builtin: boolean;
  hidden?: boolean;
}

export const INTERACTION_MOODS: readonly InteractionMood[] = ["happy", "surprised", "sleepy", "worried", "neutral"];
export const MAX_LABEL_LENGTH = 20;
export const MAX_LINES = CHARACTER_INTERACTIONS_MAX_LINES;
export const MAX_LINE_LENGTH = 120;
/** How many interactions the user may add on top of the shipped ones. */
export const MAX_CUSTOM_INTERACTIONS = 12;
const ID_PATTERN = /^[a-z0-9-]{1,32}$/u;
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** The shipped interactions; a fresh copy each call so nobody can change the defaults. */
export function getDefaultInteractions(): PetInteraction[] {
  return [
    { id: "pat", label: "쓰다듬기", mood: "happy", speak: true, lines: ["헤헤, 기분 좋아요!"], builtin: true },
    { id: "talk", label: "말 걸기", mood: "neutral", speak: true, lines: ["부르셨어요?"], builtin: true },
    { id: "scare", label: "놀래키기", mood: "surprised", speak: true, lines: ["꺄!"], builtin: true },
  ];
}

const codePoints = (text: string): number => Array.from(text).length;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One interaction as the user may store it, or the Korean reason it is refused (shown on its row). */
export type InteractionCheck = { ok: true; value: PetInteraction } | { ok: false; message: string };

export function checkInteraction(raw: unknown): InteractionCheck {
  if (!isRecord(raw)) return { ok: false, message: "항목이 올바르지 않아요" };
  const get = (name: string): unknown => Object.hasOwn(raw, name) ? raw[name] : undefined;
  const id = get("id");
  const rawLabel = get("label");
  const mood = get("mood");
  const speak = get("speak");
  const rawLines = get("lines");
  const hidden = get("hidden");
  const play = get("play");
  const sequence = get("sequence");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { ok: false, message: "id가 올바르지 않아요" };
  if (typeof rawLabel !== "string" || CONTROL_CHARACTERS.test(rawLabel)) return { ok: false, message: "이름에 쓸 수 없는 문자가 있어요" };
  const label = rawLabel.trim();
  if (label === "" || codePoints(label) > MAX_LABEL_LENGTH) return { ok: false, message: `이름은 1~${MAX_LABEL_LENGTH}자여야 해요` };
  if (typeof mood !== "string" || !INTERACTION_MOODS.includes(mood as InteractionMood)) return { ok: false, message: "표정이 올바르지 않아요" };
  if (typeof speak !== "boolean") return { ok: false, message: "말풍선 설정이 올바르지 않아요" };
  if (hidden !== undefined && typeof hidden !== "boolean") return { ok: false, message: "숨김 설정이 올바르지 않아요" };
  if (play !== undefined && (typeof play !== "string" || !stateNamePattern.test(play) ||
      ["__proto__", "constructor", "prototype"].includes(play))) return { ok: false, message: "재생 동작이 올바르지 않아요" };
  if (sequence !== undefined && !validSequenceId(sequence)) return { ok: false, message: "시퀀스가 올바르지 않아요" };
  if (!Array.isArray(rawLines)) return { ok: false, message: "대사가 올바르지 않아요" };
  const lines: string[] = [];
  for (const entry of rawLines as unknown[]) {
    if (typeof entry !== "string" || CONTROL_CHARACTERS.test(entry)) return { ok: false, message: "대사에 쓸 수 없는 문자가 있어요" };
    const line = entry.trim();
    if (line === "") continue;
    if (codePoints(line) > MAX_LINE_LENGTH) return { ok: false, message: `대사는 ${MAX_LINE_LENGTH}자 이하여야 해요` };
    lines.push(line);
  }
  if (lines.length > MAX_LINES) return { ok: false, message: `대사는 ${MAX_LINES}줄 이하여야 해요` };
  return { ok: true, value: { id, label, mood: mood as InteractionMood, speak, lines, builtin: false,
    ...(hidden === true ? { hidden: true } : {}), ...(typeof play === "string" ? { play } : {}),
    ...(typeof sequence === "string" ? { sequence } : {}) } };
}

/** The checked interaction, or undefined when anything is wrong with it. */
export function sanitizeInteraction(raw: unknown): PetInteraction | undefined {
  const checked = checkInteraction(raw);
  return checked.ok ? checked.value : undefined;
}

/** Stored user interactions: bad entries, repeated ids and anything past the new-item limit are dropped. */
export function sanitizeInteractions(raw: unknown, defaults: readonly PetInteraction[] = getDefaultInteractions()): PetInteraction[] {
  if (!Array.isArray(raw)) return [];
  const defaultIds = new Set(defaults.map(({ id }) => id));
  const seen = new Set<string>();
  const kept: PetInteraction[] = [];
  let added = 0;
  for (const entry of raw as unknown[]) {
    const item = sanitizeInteraction(entry);
    if (!item || seen.has(item.id)) continue;
    if (!defaultIds.has(item.id)) {
      if (added >= MAX_CUSTOM_INTERACTIONS) continue;
      added += 1;
    }
    seen.add(item.id);
    kept.push(item);
  }
  return kept;
}

/**
 * A full list (every shipped id is present, hidden ones included) is the order as written. Anything else is a partial
 * list (the old format: changed shipped entries and added ones only): shipped entries in shipped order, overwritten
 * in place by the same id, then the added ones in list order.
 */
export function mergeInteractions(defaults: readonly PetInteraction[], userItems: readonly unknown[]): PetInteraction[] {
  const user = new Map<string, PetInteraction>();
  for (const raw of userItems) {
    const item = sanitizeInteraction(raw);
    if (item && !user.has(item.id)) user.set(item.id, item);
  }
  const defaultIds = new Set(defaults.map(({ id }) => id));
  const full = defaults.every(({ id }) => user.has(id));
  const merged: PetInteraction[] = [];
  if (!full) {
    for (const base of defaults) {
      const item = user.get(base.id);
      merged.push(item ? { ...item, builtin: true } : { ...base, lines: [...base.lines] });
    }
  }
  let added = 0;
  for (const [id, item] of user) {
    const shipped = defaultIds.has(id);
    if (!full && shipped) continue;
    if (!shipped) {
      if (added >= MAX_CUSTOM_INTERACTIONS) continue;
      added += 1;
    }
    merged.push({ ...item, builtin: shipped });
  }
  return merged;
}

/** What the menu shows: the merged list without the hidden ones. */
export const visibleInteractions = (interactions: readonly PetInteraction[]): PetInteraction[] =>
  interactions.filter(({ hidden }) => hidden !== true);

/** The two interactions say the same thing (the builtin flag aside). */
export function sameInteraction(a: PetInteraction, b: PetInteraction): boolean {
  return a.id === b.id && a.label === b.label && a.mood === b.mood && a.play === b.play && a.sequence === b.sequence &&
    a.speak === b.speak && (a.hidden === true) === (b.hidden === true) &&
    a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index]);
}

/** The part worth storing: new interactions and shipped ones that differ from the default. */
export function userInteractionsToStore(defaults: readonly PetInteraction[], items: readonly PetInteraction[]): PetInteraction[] {
  return items.filter((item) => {
    const base = defaults.find(({ id }) => id === item.id);
    return !base || !sameInteraction(base, item);
  }).map((item) => ({ ...item, lines: [...item.lines], builtin: defaults.some(({ id }) => id === item.id) }));
}

/** The same interaction may fire at most once per this many milliseconds. */
export const INTERACTION_MIN_INTERVAL_MS = 500;

export interface PetMenuActions {
  interact: (interaction: PetInteraction) => void;
  openSettings: () => void;
  toggleDoNotDisturb: () => void;
  hidePet: () => void;
  openLogsFolder: () => void;
  quitApp: () => void;
}

/**
 * Marks an event the user fired directly (a menu interaction). A symbol key is main-process-internal:
 * JSON has no symbol keys, so nothing arriving over HTTP /event or the CLI can ever carry it.
 */
export const USER_DIRECT = Symbol("deskpet.user-direct");
export const INTERACTION_PLAY = Symbol("deskpet.interaction-play");
export type UserDirectPetEvent = PetEvent & { [USER_DIRECT]?: true; [INTERACTION_PLAY]?: string };

export function interactionPlay(event: PetEvent): string | undefined {
  const marked: UserDirectPetEvent = event;
  return marked[INTERACTION_PLAY];
}

export function isUserDirect(event: PetEvent): boolean {
  const marked: UserDirectPetEvent = event;
  return marked[USER_DIRECT] === true;
}

/**
 * The event an interaction sends. A speaking one is a notify carrying the line for this press (`press` counts from 0
 * and walks the lines in turn) exactly as written, with no voice. A silent one only changes the expression.
 * The user pressed it, so the event is marked user-direct: do-not-disturb and fullscreen hold must not defer it.
 */
export function interactionEvent(interaction: PetInteraction, press = 0): PetEvent {
  const key = `pet-menu.${interaction.id}`;
  const text = interaction.speak && interaction.lines.length > 0 ? interaction.lines[press % interaction.lines.length] : undefined;
  const event: UserDirectPetEvent = text === undefined
    ? { source: "pet-menu", type: "react", key, mood: interaction.mood, priority: "low", ttlMs: 4000, [USER_DIRECT]: true }
    : { source: "pet-menu", type: "notify", key, text, mood: interaction.mood, priority: "normal", ttlMs: 4000, [USER_DIRECT]: true };
  if (interaction.play !== undefined) event[INTERACTION_PLAY] = interaction.play;
  return event;
}

/** Wraps `send` so pressing the same interaction again within the interval is ignored; each interaction keeps its own line counter. */
export function createInteractionRunner(send: (event: PetEvent, interaction: PetInteraction) => void, now: () => number = Date.now): (interaction: PetInteraction) => boolean {
  const last = new Map<string, number>();
  const presses = new Map<string, number>();
  return (interaction) => {
    const at = now();
    const previous = last.get(interaction.id);
    if (previous !== undefined && at - previous >= 0 && at - previous < INTERACTION_MIN_INTERVAL_MS) return false;
    last.set(interaction.id, at);
    const press = presses.get(interaction.id) ?? 0;
    presses.set(interaction.id, press + 1);
    send(interactionEvent(interaction, press), interaction);
    return true;
  };
}

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

/** Interactions | plugin items (flat; omitted when there are none) | system items. Hidden interactions are left out. */
export function buildPetMenuTemplate(options: {
  interactions: readonly PetInteraction[];
  pluginItems: readonly PluginMenuItem[];
  doNotDisturbChecked: boolean;
  actions: PetMenuActions;
}): MenuItemConstructorOptions[] {
  const { interactions, pluginItems, doNotDisturbChecked, actions } = options;
  const template: MenuItemConstructorOptions[] = visibleInteractions(interactions).map((interaction) =>
    ({ label: interaction.label, click: () => actions.interact(interaction) }));
  if (pluginItems.length > 0) {
    template.push(SEPARATOR, ...pluginItems.map(({ label, click }): MenuItemConstructorOptions =>
      click ? { label, click } : { label, enabled: false }));
  }
  template.push(SEPARATOR,
    { label: "설정…", click: actions.openSettings },
    { label: "방해 금지", type: "checkbox", checked: doNotDisturbChecked, click: actions.toggleDoNotDisturb },
    { label: "숨김", click: actions.hidePet },
    { label: "오류 기록 폴더 열기", click: actions.openLogsFolder },
    { label: "종료", click: actions.quitApp });
  return template;
}

/** Labels as the user sees them; separators are "-". */
export function petMenuLabels(template: readonly MenuItemConstructorOptions[]): string[] {
  return template.map((item) => item.type === "separator" ? "-" : item.label ?? "");
}

/** The click callback of an enabled item with this label. */
export function findPetMenuClick(template: readonly MenuItemConstructorOptions[], label: string): (() => void) | undefined {
  const item = template.find((entry) => entry.type !== "separator" && entry.label === label && entry.enabled !== false && entry.click);
  return item?.click as (() => void) | undefined;
}
