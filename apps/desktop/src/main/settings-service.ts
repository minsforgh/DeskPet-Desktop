import { lineVariantText, parseReactions, parseVoicePack, renderVoice, validatePetEvent, type DoNotDisturbConfig, type LineCatalog,
  type LinePetEvent, type PetEvent, type VoiceKind, type VoiceLines, type VoiceTemplates } from "@deskpet/core";
import { validSecretKey } from "@deskpet/plugin-host";
import type { ConfigFieldSchema, ConfigSchema, ObjectItemField } from "@deskpet/plugin-sdk";
import { checkInteraction, getDefaultInteractions, MAX_CUSTOM_INTERACTIONS, mergeInteractions, userInteractionsToStore, type PetInteraction } from "./pet-menu.js";
import { fromPackInteractions, type InteractionStore } from "./interaction-store.js";
import type { PluginHostApp, PluginSettingsEntry } from "./plugin-host-app.js";
import type { createPackService } from "./pack-service.js";
import type { LaunchAtLoginView } from "./login-item.js";
import { DEFAULT_BADGE_PLACEMENT, DEFAULT_BUBBLE_DISPLAY, validBadgePlacement, validBubbleDisplay,
  type BadgePlacement, type BubbleDisplay, type DeskpetSettings } from "./settings.js";

/** One wrong value, shown next to its field; `path` is dotted ("rules.0.time"), empty for the whole form. */
export interface FieldError { path: string; message: string }
export interface GeneralSettings { enabled: boolean; schedule: Array<{ start: string; end: string }> }
/** Developer mode switch (D-044); `available` is false in a packaged build, where the switch is not shown. */
export interface DeveloperModeView { available: boolean; enabled: boolean }
export interface SettingsView { general: GeneralSettings; badge: BadgePlacement; bubble: BubbleDisplay; plugins: PluginSettingsEntry[]; developerMode: DeveloperModeView; launchAtLogin: LaunchAtLoginView }
export type GeneralResult = { ok: true } | { ok: false; errors: FieldError[] };
/** The current character's voice as the window shows it: every kind in display order, with its usable variants. */
export interface VoiceView { characterName: string; kinds: Array<{ kind: VoiceKind; variants: string[] }>; problems: string[] }
export type VoicePreviewResult = { ok: true; text: string | null; variantCount: number } | { ok: false; message: string };
export type VoiceSendResult = { ok: true } | { ok: false; message: string };
/** The 상호작용 tab: every interaction as the menu knows it (hidden ones too) and the shipped list to compare with. */
export interface InteractionsView { items: PetInteraction[]; defaults: PetInteraction[]; states?: string[]; fallbacks?: Record<string, string>;
  /** The pack's sequences (from whichever pack supplies them), for the 동작 selector. */
  sequences?: Array<{ id: string; label?: string }> }
export type InteractionsSaveResult = { ok: true; view: InteractionsView } | { ok: false; errors: FieldError[] };
export type InteractionTryResult = { ok: true } | { ok: false; message: string };
export type PluginSaveResult = { ok: true; secrets: Record<string, boolean> } | { ok: false; errors: FieldError[] };

type HostAccess = Pick<PluginHostApp, "settingsPlugins" | "savePluginSettings" | "clearPluginSecret" | "menu" | "idle">;
export interface SettingsBackend {
  packs?: ReturnType<typeof createPackService>;
  doNotDisturb(): DoNotDisturbConfig;
  /** Developer mode as the window shows it; absent means unavailable. */
  developerMode?(): DeveloperModeView;
  /** Persists developer mode; false when it could not be written or is unavailable. */
  saveDeveloperMode?(enabled: boolean): boolean;
  /** The Windows login item as the window shows it; absent means unavailable. */
  launchAtLogin?(): LaunchAtLoginView;
  /** Applies the login item and records it; false when it could not be done or is unavailable. */
  saveLaunchAtLogin?(enabled: boolean): boolean;
  /** Persists and applies the new setting; false when it could not be written. */
  saveDoNotDisturb(next: DoNotDisturbConfig): boolean;
  badgePlacement?(): BadgePlacement;
  saveBadgePlacement?(next: BadgePlacement): boolean;
  bubbleDisplay?(): BubbleDisplay;
  saveBubbleDisplay?(next: BubbleDisplay): boolean;
  host(): HostAccess | undefined;
  lineSettings?(): { settings: DeskpetSettings; packId: string; catalogs: readonly { pluginId: string; catalog: LineCatalog }[];
    packLines?: VoiceLines;
    sequenceIds?: ReadonlySet<string> };
  saveLineSettings?(next: DeskpetSettings): boolean;
  /** The current character's name, templates and the notes the parser made about its voice file. */
  voice(): { characterName: string; templates: VoiceTemplates; problems: readonly string[] };
  /** Hands a preview event to the pet's normal event path; only a button press in the window reaches this. */
  sendVoicePreview(event: PetEvent): void;
  /**
   * Hands one plugin line to the normal receive path. `previewText` replaces the rendered sentence for this one
   * event only; it exists on this backend call, never on PetEvent, so HTTP and plugins cannot set it.
   */
  sendLinePreview?(event: LinePetEvent, previewText?: string, variant?: number): void;
  /** Where the user's interactions (edited shipped ones and added ones) are kept; saving also applies them to the menu. */
  interactionStore: InteractionStore;
  /** Runs one interaction as a menu press would; only a button press in the window reaches this. */
  runInteraction(interaction: PetInteraction): void;
  /** Clock for the send rate limit; tests replace it. */
  now?(): number;
}

export const VOICE_KINDS: readonly VoiceKind[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];
const VOICE_SEND_INTERVAL_MS = 1_000;
const VOICE_PREVIEW_INTERVAL_MS = 1_000;
const INTERACTION_TRY_INTERVAL_MS = 1_000;
const TOO_FAST = "너무 빨라요. 잠시 후 다시 눌러 주세요";
const MAX_VARIANT_SEED = 1_000_000;
const PREVIEW_TEXT_CODE_POINTS = 60;
const VOICE_REQUEST_REFUSED = "요청이 올바르지 않습니다";

// Ceilings for what the window may send: far above any real form, small enough to bound one write.
const MAX_TEXT_LENGTH = 1_000;
const MAX_LIST_LENGTH = 100;
const MAX_SCHEDULE_ROWS = 20;
// The secrets store refuses values larger than this (ADR-0005 §5).
const MAX_SECRET_BYTES = 8_192;
const hhmmPattern = /^([01]\d|2[0-3]):[0-5]\d$/u;
const GENERIC_FAILURE = "저장하지 못했습니다";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (record: Record<string, unknown>, name: string): unknown => Object.hasOwn(record, name) ? record[name] : undefined;
const failure = (path: string, message: string): { ok: false; errors: FieldError[] } => ({ ok: false, errors: [{ path, message }] });

/** The dirty flag the renderer may send: exactly one boolean, anything else is refused. */
export function parseDirtyFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function put(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

export function validateGeneral(input: unknown): { ok: true; value: DoNotDisturbConfig } | { ok: false; errors: FieldError[] } {
  if (!isRecord(input) || typeof input.enabled !== "boolean" || !Array.isArray(input.schedule) || input.schedule.length > MAX_SCHEDULE_ROWS)
    return failure("", "요청이 올바르지 않습니다");
  const errors: FieldError[] = [];
  const schedule: Array<{ start: string; end: string }> = [];
  input.schedule.forEach((row: unknown, index: number) => {
    const entry = isRecord(row) ? row : {};
    const times: string[] = [];
    for (const name of ["start", "end"] as const) {
      const value = own(entry, name);
      if (typeof value === "string" && hhmmPattern.test(value)) times.push(value);
      else errors.push({ path: `schedule.${index}.${name}`, message: "HH:MM 형식(예: 22:00)으로 입력하세요" });
    }
    if (times.length === 2) schedule.push({ start: times[0] ?? "", end: times[1] ?? "" });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: schedule.length > 0 ? { enabled: input.enabled, schedule } : { enabled: input.enabled } };
}

type Scalar = { type: "string" | "number" | "boolean"; enum?: readonly (string | number)[] };

function checkScalar(value: unknown, spec: Scalar, path: string, errors: FieldError[]): boolean {
  const valid = spec.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === spec.type;
  if (!valid) {
    errors.push({ path, message: spec.type === "number" ? "숫자를 입력하세요" : "값이 올바르지 않습니다" });
    return false;
  }
  if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) {
    errors.push({ path, message: `${MAX_TEXT_LENGTH}자 이하로 입력하세요` });
    return false;
  }
  if (spec.enum !== undefined && !spec.enum.includes(value as string | number)) {
    errors.push({ path, message: "목록에 있는 값을 고르세요" });
    return false;
  }
  return true;
}

/** Elements of a flat array: every one must match the element type, and the enum when declared. */
function checkFlatArray(value: unknown, element: Scalar, path: string, errors: FieldError[]): boolean {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    errors.push({ path, message: "목록이 올바르지 않습니다" });
    return false;
  }
  let valid = true;
  value.forEach((item: unknown, index: number) => {
    if (element.type === "string" && item === "") {
      errors.push({ path: `${path}.${index}`, message: "비워 둘 수 없습니다" });
      valid = false;
    } else if (!checkScalar(item, element, `${path}.${index}`, errors)) valid = false;
  });
  return valid;
}

/** Absent, an empty string or an empty list: the form left it blank. */
const blank = (value: unknown): boolean => value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

function checkItem(item: unknown, items: Extract<NonNullable<ConfigFieldSchema["items"]>, { type: "object" }>,
  path: string, errors: FieldError[]): Record<string, unknown> | undefined {
  if (!isRecord(item)) {
    errors.push({ path, message: "항목이 올바르지 않습니다" });
    return undefined;
  }
  const result: Record<string, unknown> = {};
  let valid = true;
  for (const [name, field] of Object.entries(items.properties) as Array<[string, ObjectItemField]>) {
    const value = own(item, name);
    const propertyPath = `${path}.${name}`;
    if (blank(value)) {
      if (items.required?.includes(name)) { errors.push({ path: propertyPath, message: "필수 항목입니다" }); valid = false; }
      continue;
    }
    const ok = field.type === "array"
      ? checkFlatArray(value, { type: field.items.type, enum: field.enum }, propertyPath, errors)
      : checkScalar(value, field, propertyPath, errors);
    if (ok) put(result, name, value);
    else valid = false;
  }
  return valid ? result : undefined;
}

function checkTopLevel(value: unknown, field: ConfigFieldSchema, required: boolean, path: string,
  errors: FieldError[]): { present: boolean; value?: unknown } {
  if (value === undefined || value === "") {
    if (required) errors.push({ path, message: "필수 항목입니다" });
    return { present: false };
  }
  if (field.type !== "array")
    return checkScalar(value, { type: field.type, enum: field.enum }, path, errors) ? { present: true, value } : { present: false };
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    errors.push({ path, message: "목록이 올바르지 않습니다" });
    return { present: false };
  }
  if (field.items?.type !== "object") {
    // Without declared items the host does not check elements; the form only offers strings.
    return checkFlatArray(value, { type: "string" }, path, errors) ? { present: true, value } : { present: false };
  }
  const items = field.items;
  const kept = value.map((item: unknown, index: number) => checkItem(item, items, `${path}.${index}`, errors));
  return kept.every((item) => item !== undefined) ? { present: true, value: kept } : { present: false };
}

type VoiceInput = NonNullable<PetEvent["voice"]>;

/**
 * A voice request from the window: only kind, optional slots and an optional variant number. Kind and slots
 * are checked by the same event validation the HTTP endpoint uses (known kind, four slot names, strings of at
 * most 500 code points without control characters); slots that are blank are dropped.
 */
export function validateVoiceRequest(input: unknown): { ok: true; voice: VoiceInput; variant: number } | { ok: false } {
  if (!isRecord(input) || Object.keys(input).some((name) => name !== "kind" && name !== "slots" && name !== "variant")) return { ok: false };
  const variant = own(input, "variant") ?? 0;
  if (typeof variant !== "number" || !Number.isSafeInteger(variant) || variant < 0 || variant > MAX_VARIANT_SEED) return { ok: false };
  const slots = own(input, "slots");
  const checked = validatePetEvent({ source: "settings", type: "notify", voice: slots === undefined ? { kind: input.kind } : { kind: input.kind, slots } });
  if (!checked.ok || checked.value.voice === undefined) return { ok: false };
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(checked.value.voice.slots ?? {})) if (value.trim() !== "") put(kept, name, value);
  return { ok: true, voice: { kind: checked.value.voice.kind, slots: kept }, variant };
}

/** The short sentence a sent preview carries as its plain text, used when the character has no usable variant. */
function previewText(slots: Record<string, string> | undefined): string {
  const first = [slots?.message, slots?.task, slots?.result, slots?.folder].find((value) => value !== undefined && value.trim() !== "");
  const shown = Array.from((first ?? "").replace(/\s+/gu, " ").trim()).slice(0, PREVIEW_TEXT_CODE_POINTS).join("");
  return `(미리보기) ${shown === "" ? "어투 테스트" : shown}`;
}

export interface ValidatedPlugin { config: Record<string, unknown>; secrets: Record<string, string> }

/**
 * Checks a form submission against the plugin's own schema. Nothing is saved unless every field passes;
 * secret fields never enter `config` and are accepted only for a plugin that holds the secrets permission.
 */
export function validatePluginInput(schema: ConfigSchema, canStoreSecrets: boolean, stored: Readonly<Record<string, boolean>>,
  config: Record<string, unknown>, secrets: Record<string, unknown>): { ok: true; value: ValidatedPlugin } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const cleaned: Record<string, unknown> = {};
  const cleanedSecrets: Record<string, string> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    const required = schema.required?.includes(name) === true;
    if (field.secret === true) {
      const entered = own(secrets, name);
      if (entered === undefined || entered === "") {
        if (required && stored[name] !== true) errors.push({ path: name, message: "필수 항목입니다" });
      } else if (!canStoreSecrets) errors.push({ path: name, message: "이 플러그인은 비밀 값을 저장할 권한이 없습니다" });
      else if (typeof entered !== "string" || field.type !== "string" || !validSecretKey(name) || Buffer.byteLength(entered, "utf8") > MAX_SECRET_BYTES)
        errors.push({ path: name, message: "비밀 값이 올바르지 않습니다" });
      else put(cleanedSecrets, name, entered);
      continue;
    }
    const result = checkTopLevel(own(config, name), field, required, name, errors);
    if (result.present) put(cleaned, name, result.value);
  }
  for (const name of Object.keys(secrets)) {
    if (!Object.hasOwn(schema.properties, name) || schema.properties[name]?.secret !== true)
      errors.push({ path: name, message: "비밀 항목이 아닙니다" });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { config: cleaned, secrets: cleanedSecrets } };
}

/**
 * The settings window's backend. Every argument arrives from a renderer, which is outside the trust
 * boundary, so all of it is checked again here; secret values only ever travel into this process.
 */
export function createSettingsService(backend: SettingsBackend): {
  load(): Promise<SettingsView>;
  general(): GeneralSettings;
  saveGeneral(payload: unknown): GeneralResult;
  saveBadge(payload: unknown): GeneralResult;
  saveBubble(payload: unknown): GeneralResult;
  saveDeveloperMode(payload: unknown): GeneralResult;
  saveLaunchAtLogin(payload: unknown): GeneralResult;
  savePlugin(payload: unknown): Promise<PluginSaveResult>;
  enableReminder(): Promise<{ ok: boolean; message?: string }>;
  clearSecret(payload: unknown): Promise<PluginSaveResult>;
  voiceLoad(): VoiceView;
  voicePreview(payload: unknown): VoicePreviewResult;
  voiceSend(payload: unknown): VoiceSendResult;
  lineSend(payload: unknown): Promise<VoiceSendResult>;
  lineSettingsLoad(): unknown;
  lineOverridesSave(payload: unknown): GeneralResult;
  lineOverridesReset(): GeneralResult;
  lineReactionsSave(payload: unknown): GeneralResult;
  lineReactionsReset(): GeneralResult;
  interactionsLoad(): Promise<InteractionsView>;
  interactionsSave(payload: unknown): Promise<InteractionsSaveResult>;
  interactionsTry(payload: unknown): InteractionTryResult;
  packsList(): ReturnType<ReturnType<typeof createPackService>["list"]>;
  packSelect(payload: unknown): Promise<unknown>;
  packDelete(payload: unknown): Promise<unknown>;
  packSaveVoice(payload: unknown): Promise<unknown>;
  packSaveInteractions(payload: unknown): Promise<unknown>;
  sequencesLoad(payload: unknown): Promise<unknown>;
  sequencesSave(payload: unknown): Promise<unknown>;
  reactionsLoad(payload: unknown): Promise<unknown>;
  reactionsSave(payload: unknown): Promise<unknown>;
  motionsLoad(payload: unknown): Promise<unknown>;
  motionsSave(payload: unknown): Promise<unknown>;
  packSaveMeta(payload: unknown): Promise<unknown>;
  packVoiceLoad(payload: unknown): Promise<unknown>;
  packInteractionsLoad(payload: unknown): Promise<unknown>;
} {
  let lastVoiceSend = Number.NEGATIVE_INFINITY;
  let lastVoicePreview = Number.NEGATIVE_INFINITY;
  let lastInteractionTry = Number.NEGATIVE_INFINITY;
  const interactionsView = async (): Promise<InteractionsView> => {
    const defaults = getDefaultInteractions();
    return { items: mergeInteractions(defaults, await backend.interactionStore.load()), defaults };
  };
  let queue: Promise<unknown> = Promise.resolve();
  // Saves run one at a time so two quick clicks cannot interleave their writes.
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const general = (): GeneralSettings => {
    const current = backend.doNotDisturb();
    return { enabled: current.enabled, schedule: (current.schedule ?? []).map(({ start, end }) => ({ start, end })) };
  };
  const runningForm = async (payload: unknown): Promise<{ id: string; form: NonNullable<PluginSettingsEntry["form"]>;
    host: HostAccess; body: Record<string, unknown> } | undefined> => {
    const host = backend.host();
    if (!host || !isRecord(payload) || typeof payload.pluginId !== "string") return undefined;
    const entry = (await host.settingsPlugins()).find(({ id }) => id === payload.pluginId);
    return entry?.form ? { id: entry.id, form: entry.form, host, body: payload } : undefined;
  };
  const unavailable = failure("", "이 플러그인은 지금 설정할 수 없습니다");
  const retainedUnknownLines = <T>(current: Record<string, T>, catalogs: readonly { catalog: LineCatalog }[]): Record<string, T> => {
    const known = new Set(catalogs.flatMap(({ catalog }) => catalog.lines.map(({ id }) => id)));
    return Object.fromEntries(Object.entries(current).filter(([id]) => !known.has(id)));
  };

  return {
    packsList: () => backend.packs?.list() ?? [],
    packSelect: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { const selection = await backend.packs.select(own(payload, "packId")); return { ok: true, packId: selection.id }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    packDelete: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.deletePack(own(payload, "packId")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    packSaveVoice: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.saveVoice(own(payload, "packId"), own(payload, "voicePack")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    packSaveInteractions: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.saveInteractions(own(payload, "packId"), own(payload, "interactions")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    sequencesLoad: async (payload) => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.loadSequences(own(payload, "packId")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    },
    sequencesSave: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.saveSequences(own(payload, "packId"), own(payload, "sequences")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    reactionsLoad: async (payload) => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않아요");
      try { return { ok: true, ...await backend.packs.loadReactions(own(payload, "packId")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    },
    reactionsSave: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않아요");
      try { return { ok: true, ...await backend.packs.saveReactions(own(payload, "packId"), own(payload, "reactions")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    motionsLoad: async (payload) => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않아요");
      try { return { ok: true, ...await backend.packs.loadMotions(own(payload, "packId")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    },
    motionsSave: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않아요");
      try { return { ok: true, ...await backend.packs.saveMotions(own(payload, "packId"), own(payload, "motions")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    packSaveMeta: (payload) => serialized(async () => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.saveMeta(own(payload, "packId"), own(payload, "meta")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    }),
    packVoiceLoad: async (payload) => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try { return { ok: true, ...await backend.packs.voiceLoad(own(payload, "packId")) }; }
      catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    },
    packInteractionsLoad: async (payload) => {
      if (!backend.packs || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      try {
        const loaded = await backend.packs.loadInteractions(own(payload, "packId"));
        const defaults = getDefaultInteractions();
        return { ok: true, view: { items: mergeInteractions(defaults, fromPackInteractions(loaded.interactions)), defaults,
          states: loaded.states, fallbacks: loaded.fallbacks, sequences: loaded.sequences },
          problems: loaded.problems };
      } catch (error) { return failure("", error instanceof Error ? error.message : String(error)); }
    },
    async load() {
      const host = backend.host();
      return { general: general(), badge: backend.badgePlacement?.() ?? DEFAULT_BADGE_PLACEMENT,
        bubble: backend.bubbleDisplay?.() ?? DEFAULT_BUBBLE_DISPLAY,
        plugins: host ? await host.settingsPlugins() : [],
        developerMode: backend.developerMode?.() ?? { available: false, enabled: false },
        launchAtLogin: backend.launchAtLogin?.() ?? { available: false, enabled: false } };
    },
    general,
    voiceLoad() {
      const { characterName, templates, problems } = backend.voice();
      return { characterName, kinds: VOICE_KINDS.map((kind) => ({ kind, variants: (templates[kind] ?? []).map(lineVariantText) })), problems: [...problems] };
    },
    lineSettingsLoad() {
      const current = backend.lineSettings?.();
      if (!current) return { ok: false, errors: [{ path: "", message: "지금 설정할 수 없습니다" }] };
      return { ok: true, packId: current.packId, catalogs: current.catalogs, packLines: current.packLines ?? {},
        overrides: current.settings.lineOverrides?.[current.packId] ?? {},
        reactions: current.settings.lineReactions?.[current.packId] ?? {} };
    },
    lineOverridesSave(payload) {
      const current = backend.lineSettings?.();
      if (!current || !backend.saveLineSettings || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      const parsed = parseVoicePack({ version: 1, templates: {}, lines: own(payload, "lines") });
      if (parsed.problems.length > 0) return failure("lines", "대사 변형이 올바르지 않습니다");
      const next = { ...current.settings, lineOverrides: { ...current.settings.lineOverrides,
        [current.packId]: { ...retainedUnknownLines(current.settings.lineOverrides?.[current.packId] ?? {}, current.catalogs),
          ...parsed.lines } } };
      return backend.saveLineSettings(next) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    lineOverridesReset() {
      const current = backend.lineSettings?.();
      if (!current || !backend.saveLineSettings) return failure("", "요청이 올바르지 않습니다");
      const kept = retainedUnknownLines(current.settings.lineOverrides?.[current.packId] ?? {}, current.catalogs);
      const lineOverrides = Object.fromEntries(Object.entries(current.settings.lineOverrides ?? {})
        .filter(([id]) => id !== current.packId));
      if (Object.keys(kept).length > 0) lineOverrides[current.packId] = kept;
      return backend.saveLineSettings({ ...current.settings, lineOverrides }) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    lineReactionsSave(payload) {
      const current = backend.lineSettings?.();
      if (!current || !backend.saveLineSettings || !isRecord(payload)) return failure("", "요청이 올바르지 않습니다");
      const parsed = parseReactions({ version: 1, kinds: {}, lines: own(payload, "lines") });
      if (parsed.problems.length > 0) return failure("lines", "대사 반응이 올바르지 않습니다");
      if (Object.values(parsed.reactions.lines ?? {}).some((target) =>
        target.sequence !== undefined && !current.sequenceIds?.has(target.sequence)))
        return failure("lines", "없는 시퀀스는 선택할 수 없습니다");
      const next = { ...current.settings, lineReactions: { ...current.settings.lineReactions,
        [current.packId]: { ...retainedUnknownLines(current.settings.lineReactions?.[current.packId] ?? {}, current.catalogs),
          ...parsed.reactions.lines } } };
      return backend.saveLineSettings(next) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    lineReactionsReset() {
      const current = backend.lineSettings?.();
      if (!current || !backend.saveLineSettings) return failure("", "요청이 올바르지 않습니다");
      const kept = retainedUnknownLines(current.settings.lineReactions?.[current.packId] ?? {}, current.catalogs);
      const lineReactions = Object.fromEntries(Object.entries(current.settings.lineReactions ?? {})
        .filter(([id]) => id !== current.packId));
      if (Object.keys(kept).length > 0) lineReactions[current.packId] = kept;
      return backend.saveLineSettings({ ...current.settings, lineReactions }) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    // Rendering with an explicit variant number never touches the rotation the real events use.
    voicePreview(payload) {
      const request = validateVoiceRequest(payload);
      if (!request.ok) return { ok: false, message: VOICE_REQUEST_REFUSED };
      const at = backend.now?.() ?? Date.now();
      if (at - lastVoicePreview < VOICE_PREVIEW_INTERVAL_MS) return { ok: false, message: TOO_FAST };
      lastVoicePreview = at;
      const templates = backend.voice().templates;
      return { ok: true, text: renderVoice(templates, request.voice, request.variant), variantCount: templates[request.voice.kind]?.length ?? 0 };
    },
    voiceSend(payload) {
      const hasTemplate = isRecord(payload) && Object.hasOwn(payload, "template");
      const request = validateVoiceRequest(hasTemplate ? { kind: payload.kind, slots: payload.slots } : payload);
      if (!request.ok) return { ok: false, message: VOICE_REQUEST_REFUSED };
      let rendered: string | null = null;
      if (hasTemplate) {
        if (typeof payload.template !== "string" || Object.keys(payload).some((name) => !["kind", "slots", "template"].includes(name)))
          return { ok: false, message: VOICE_REQUEST_REFUSED };
        const parsed = parseVoicePack({ version: 1, templates: { [request.voice.kind]: [payload.template] } });
        if (parsed.problems.length > 0) return { ok: false, message: "버려질 변형은 보낼 수 없어요" };
        rendered = renderVoice(parsed.templates, request.voice, 0);
        if (rendered === null) return { ok: false, message: "이 샘플로는 변형을 보낼 수 없어요" };
      }
      const now = backend.now?.() ?? Date.now();
      if (now - lastVoiceSend < VOICE_SEND_INTERVAL_MS) return { ok: false, message: TOO_FAST };
      lastVoiceSend = now;
      backend.sendVoicePreview({ source: "settings", type: "notify", key: "settings.voice-preview",
        text: rendered ?? previewText(request.voice.slots), ...(rendered === null ? { voice: request.voice } : {}) });
      return { ok: true };
    },
    async lineSend(payload) {
      if (!isRecord(payload) || Object.keys(payload).some((name) => !["lineId", "vars", "previewText", "variant"].includes(name)))
        return { ok: false, message: VOICE_REQUEST_REFUSED };
      const lineId = own(payload, "lineId");
      const vars = own(payload, "vars");
      const text = own(payload, "previewText");
      const variant = own(payload, "variant");
      const checked = validatePetEvent({ source: "settings", type: "notify",
        ...(typeof text === "string" ? { text } : {}), ...(typeof lineId === "string" ? { line: { id: lineId, ...(vars === undefined ? {} : { vars }) } } : {}) });
      if (typeof lineId !== "string" || !checked.ok || checked.value.line === undefined || (text !== undefined && typeof text !== "string") ||
          (variant !== undefined && (!Number.isInteger(variant) || typeof variant !== "number" || variant < 0 || variant >= 8)))
        return { ok: false, message: VOICE_REQUEST_REFUSED };
      const found = backend.lineSettings?.().catalogs.flatMap(({ pluginId, catalog }) =>
        catalog.lines.map((line) => ({ pluginId, line }))).find(({ line }) => line.id === lineId);
      if (!found || !backend.sendLinePreview) return { ok: false, message: "등록되지 않은 대사예요" };
      const entry = (await backend.host()?.settingsPlugins())?.find(({ id }) => id === found.pluginId);
      if (entry?.state !== "running") return { ok: false, message: `${entry?.name ?? found.pluginId}: 지금은 켜져 있지 않아 보낼 수 없어요` };
      const given = checked.value.line.vars ?? {};
      if (Object.keys(given).some((name) => !found.line.variables.includes(name)))
        return { ok: false, message: "이 대사에 없는 변수가 있어요" };
      const filled: Record<string, string> = {};
      for (const name of found.line.variables) put(filled, name, given[name] ?? "예시");
      const now = backend.now?.() ?? Date.now();
      if (now - lastVoiceSend < VOICE_SEND_INTERVAL_MS) return { ok: false, message: TOO_FAST };
      lastVoiceSend = now;
      backend.sendLinePreview({ source: found.pluginId, type: "notify", key: "settings.line-preview", line: { id: lineId, vars: filled } },
        typeof text === "string" && text.trim() !== "" ? text : undefined, typeof variant === "number" ? variant : undefined);
      return { ok: true };
    },
    interactionsLoad: interactionsView,
    interactionsSave: (payload) => serialized(async () => {
      const defaults = getDefaultInteractions();
      const rows = isRecord(payload) ? own(payload, "items") : undefined;
      if (!Array.isArray(rows) || rows.length > defaults.length + MAX_CUSTOM_INTERACTIONS) return failure("", "요청이 올바르지 않습니다");
      const errors: FieldError[] = [];
      const items: PetInteraction[] = [];
      const seen = new Set<string>();
      rows.forEach((row: unknown, index: number) => {
        const checked = checkInteraction(row);
        if (!checked.ok) { errors.push({ path: String(index), message: checked.message }); return; }
        if (seen.has(checked.value.id)) { errors.push({ path: String(index), message: "같은 id가 이미 있어요" }); return; }
        seen.add(checked.value.id);
        if (checked.value.speak && checked.value.lines.length === 0) { errors.push({ path: String(index), message: "대사를 한 줄 이상 적어 주세요" }); return; }
        items.push(checked.value);
      });
      if (errors.length > 0) return { ok: false, errors };
      if (items.filter(({ id }) => !defaults.some((base) => base.id === id)).length > MAX_CUSTOM_INTERACTIONS)
        return failure("", `새 상호작용은 ${MAX_CUSTOM_INTERACTIONS}개까지 만들 수 있어요`);
      // A shipped interaction left out of the request stays as it was shipped.
      try { await backend.interactionStore.save(userInteractionsToStore(defaults, items)); }
      catch (error) { console.error("Save interactions:", error); return failure("", GENERIC_FAILURE); }
      return { ok: true, view: await interactionsView() };
    }),
    interactionsTry(payload) {
      const checked = checkInteraction(payload);
      if (!checked.ok) return { ok: false, message: checked.message };
      const at = backend.now?.() ?? Date.now();
      if (at - lastInteractionTry < INTERACTION_TRY_INTERVAL_MS) return { ok: false, message: TOO_FAST };
      lastInteractionTry = at;
      backend.runInteraction(checked.value);
      return { ok: true };
    },
    saveGeneral(payload) {
      const checked = validateGeneral(payload);
      if (!checked.ok) return checked;
      return backend.saveDoNotDisturb(checked.value) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    saveBadge(payload) {
      if (!validBadgePlacement(payload)) return failure("", "배지 위치 또는 간격이 올바르지 않아요");
      return backend.saveBadgePlacement?.(payload) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    saveBubble(payload) {
      if (!validBubbleDisplay(payload)) return failure("", "말풍선 최대 폭 또는 최대 줄 수가 올바르지 않아요");
      return backend.saveBubbleDisplay?.(payload) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    saveDeveloperMode(payload) {
      const enabled = isRecord(payload) ? own(payload, "enabled") : undefined;
      if (typeof enabled !== "boolean" || !backend.developerMode?.().available) return failure("", "요청이 올바르지 않습니다");
      return backend.saveDeveloperMode?.(enabled) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    saveLaunchAtLogin(payload) {
      const enabled = isRecord(payload) ? own(payload, "enabled") : undefined;
      if (typeof enabled !== "boolean" || !backend.launchAtLogin?.().available) return failure("", "요청이 올바르지 않습니다");
      return backend.saveLaunchAtLogin?.(enabled) ? { ok: true } : failure("", GENERIC_FAILURE);
    },
    savePlugin: (payload) => serialized(async () => {
      const target = await runningForm(payload);
      if (!target) return unavailable;
      const { config, secrets } = target.body;
      if (!isRecord(config) || !isRecord(secrets)) return failure("", "요청이 올바르지 않습니다");
      const checked = validatePluginInput(target.form.schema, target.form.canStoreSecrets, target.form.secrets, config, secrets);
      if (!checked.ok) return checked;
      try {
        await target.host.savePluginSettings(target.id, checked.value.config, checked.value.secrets);
        const current = (await target.host.settingsPlugins()).find(({ id }) => id === target.id);
        return { ok: true, secrets: current?.form?.secrets ?? {} };
      } catch (error) {
        console.error("Save plugin settings:", error);
        return failure("", GENERIC_FAILURE);
      }
    }),
    enableReminder: () => serialized(async () => {
      const host = backend.host();
      const entry = (await host?.settingsPlugins())?.find(({ id }) => id === "reminders");
      if (!host || entry?.state !== "disabled") return { ok: false, message: "지금 켤 수 없어요" };
      const action = host.menu().find(({ label, click }) => label === "다시 켜기 (reminders)" && click)?.click;
      if (!action) return { ok: false, message: "켜기 메뉴를 찾지 못했어요" };
      action();
      await host.idle();
      return (await host.settingsPlugins()).find(({ id }) => id === "reminders")?.state === "running"
        ? { ok: true } : { ok: false, message: "켜지 못했어요" };
    }),
    clearSecret: (payload) => serialized(async () => {
      const target = await runningForm(payload);
      const field = target?.body.field;
      if (!target || typeof field !== "string" || !Object.hasOwn(target.form.schema.properties, field) ||
          target.form.schema.properties[field]?.secret !== true) return unavailable;
      try {
        await target.host.clearPluginSecret(target.id, field);
        const current = (await target.host.settingsPlugins()).find(({ id }) => id === target.id);
        return { ok: true, secrets: current?.form?.secrets ?? {} };
      } catch (error) {
        console.error("Clear plugin secret:", error);
        return failure(field, GENERIC_FAILURE);
      }
    }),
  };
}
