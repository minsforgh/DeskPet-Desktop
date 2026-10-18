import { CHARACTER_PACK_MAX_SHEET_BYTES, MOTION_KEYS, DEFAULT_MOVEMENT_FALLBACKS, mergeCharacterManifest, parseInteractions, parseMotions, parseReactions, resolveMotionPlay, parseSequences, parseVoicePack,
  validUserCharacterId, validateCharacterManifest } from "@deskpet/core";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCharacter, loadInteractions, loadMotions, loadReactions, loadSequences, loadVoiceTemplates, type CharacterPack } from "./character.js";
import { createPackStore, generatedSheetPattern } from "./pack-store.js";
import { freshToken, inspectSelectedSheet, newSheetPath, tokenExpiresAt,
  validNewStateName, type CheckedSheet } from "./sheet-import.js";
import { writeSettings, type DeskpetSettings } from "./settings.js";

export interface PackListItem {
  id: string;
  name: string;
  source: "builtin" | "user";
  extends?: string;
  valid: boolean;
  error?: string;
  current: boolean;
  meta?: CharacterPack["manifest"]["meta"];
  cellSize?: [number, number];
  /** Built-in pack that developer mode edits in place (D-044). */
  directEdit?: boolean;
  /** States of a directly edited built-in pack, for the developer 그림 tab (no sheet paths). */
  states?: Record<string, { frames: number; fps: number; loop: boolean; next?: string; facing?: "left" | "right" }>;
}

export interface PackSelection { id: string; source: "builtin" | "user"; pack: CharacterPack }
export interface PackSaveResult { packId: string; derived: boolean; problems?: string[] }
export interface StatePreviewData { sheet: string; frames: number; fps: number; loop: boolean;
  cellSize: [number, number]; facing?: "left" | "right" }

interface Options {
  builtinDir: string;
  userDataDir: string;
  settingsPath: string;
  getSettings(): DeskpetSettings;
  setSettings(settings: DeskpetSettings): void;
  /** A bare id means "no pack": the app records the load error and draws its fallback. */
  apply(selection: PackSelection | { id: string }): Promise<void>;
  refresh(selection: PackSelection): Promise<void>;
  notify(message: string): void;
  confirmDelete(id: string): Promise<boolean>;
  chooseSheetFile?(): Promise<string | undefined>;
  /** A packaged install never edits built-in packs, whatever settings.json says (D-044). */
  isPackaged?: boolean;
}

/** An error whose message is already fit for the window; anything else is logged and replaced by a generic phrase. */
class PackMessageError extends Error {}
const MAX_FIRST_ERROR = 120;
/** First-run pack of an installed app (D-058); development and e2e keep the placeholder. A pack that cannot load falls back to the placeholder. */
const PACKAGED_DEFAULT_PACK = "wolf-maid";
const INTERACTIONS_MIGRATION_MARKER = "deskpet-interactions-migration";

function userFacing(error: unknown): string {
  if (error instanceof PackMessageError) return error.message;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "manifest.json 이 없어요";
  if (error instanceof SyntaxError) return "manifest.json 형식이 깨졌어요";
  return "팩 형식이 맞지 않아요";
}

/** The first validation error on one line, without drive paths or home directories. */
function oneLine(value: string | undefined): string {
  const line = (value ?? "").split("\n")[0] ?? "";
  const cleaned = line.replace(/(?:[A-Za-z]:)?[\\/][^\s;:,)]*/gu, "…").trim();
  return cleaned.length > MAX_FIRST_ERROR ? `${cleaned.slice(0, MAX_FIRST_ERROR)}…` : cleaned;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function packId(value: unknown): string {
  if (!validUserCharacterId(value)) throw new Error("올바른 캐릭터 ID가 아닙니다");
  return value;
}

function safeJson(value: unknown, maxBytes: number): string {
  const seen = new WeakSet<object>();
  function check(entry: unknown, depth: number): void {
    if (depth > 20) throw new Error("입력 깊이가 너무 큽니다");
    if (entry === null || typeof entry !== "object") return;
    if (seen.has(entry)) throw new Error("순환 참조는 허용되지 않습니다");
    seen.add(entry);
    for (const [key, child] of Object.entries(entry)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("허용되지 않는 항목입니다");
      check(child, depth + 1);
    }
  }
  check(value, 0);
  // The limit stays on the compact form so pretty printing never changes what is accepted.
  const compact = JSON.stringify(value);
  if (compact === undefined || Buffer.byteLength(compact, "utf8") > maxBytes) throw new Error("입력 크기가 너무 큽니다");
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readManifest(root: string, id: string): unknown {
  const directory = realpathSync(join(root, id));
  if (dirname(directory) !== realpathSync(root)) throw new PackMessageError("팩 폴더가 허용 범위를 벗어났어요");
  const path = realpathSync(join(directory, "manifest.json"));
  if (dirname(path) !== directory) throw new PackMessageError("manifest.json 위치가 올바르지 않아요");
  if (statSync(path).size > 256 * 1024) throw new PackMessageError("manifest.json 이 너무 커요");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Every state or fallback name a step may play, with the state it resolves to and that state's one-cycle length (as the runner computes them). */
export function sequencePlays(manifest: Pick<CharacterPack["manifest"], "states" | "fallbacks">): Record<string, { resolved: string; cycleMs: number }> {
  const resolve = (play: string): string => {
    const visited = new Set<string>();
    let current = play;
    while (!visited.has(current)) {
      if (Object.hasOwn(manifest.states, current)) return current === "walk" || current === "drag" ? "idle" : current;
      visited.add(current);
      const next = Object.hasOwn(manifest.fallbacks, current) ? manifest.fallbacks[current] : undefined;
      if (next === undefined) break;
      current = next;
    }
    return "idle";
  };
  const plays: Record<string, { resolved: string; cycleMs: number }> = {};
  for (const name of new Set([...Object.keys(manifest.states), ...Object.keys(manifest.fallbacks)])) {
    if (name === "walk" || name === "drag") continue;
    const resolved = resolve(name);
    const state = manifest.states[resolved];
    plays[name] = { resolved, cycleMs: state ? state.frames * 1_000 / state.fps : 300 };
  }
  return plays;
}

export function createPackService(options: Options) {
  const { builtinDir, userDataDir } = options;
  const userDir = join(userDataDir, "characters");
  const developerMode = (): boolean => options.isPackaged !== true && options.getSettings().developerMode === true;
  const store = createPackStore({ userDataDir, builtinDir, allowBuiltinWrites: developerMode });
  let current: PackSelection | undefined;
  // cellSize and anchor are what the sheet was checked against; apply refuses a manifest that changed since.
  const pendingSheets = new Map<string, { packId: string; frames: number; sheet: CheckedSheet; expiresAt: number;
    cellSize: readonly [number, number]; anchor: readonly [number, number] }>();
  let applyChain: Promise<unknown> = Promise.resolve();
  store.cleanupStaging();

  function sourceOf(id: string): "builtin" | "user" {
    if (existsSync(join(builtinDir, id))) return "builtin";
    if (store.listUserPackIds().includes(id)) return "user";
    throw new Error("캐릭터 팩을 찾을 수 없습니다");
  }

  /** Developer mode: drop app-generated sheets and temp files the manifest no longer points to (never original sheets). */
  function cleanOrphanSheets(id: string): void {
    if (!developerMode()) return;
    try {
      const raw = readManifest(builtinDir, id);
      if (!isRecord(raw) || !isRecord(raw.states)) return;
      const referenced = new Set(Object.values(raw.states).flatMap((state) =>
        isRecord(state) && typeof state.sheet === "string" ? [state.sheet] : []));
      store.cleanupBuiltinPack(id, referenced);
    } catch (error) { console.warn("Cannot clean orphan sheets:", error); }
  }

  async function loaded(id: string): Promise<PackSelection> {
    const source = sourceOf(id);
    if (source === "builtin") cleanOrphanSheets(id);
    const pack = await loadCharacter(source === "user" ? userDir : builtinDir, id,
      source === "user" ? builtinDir : undefined);
    return { id, source, pack };
  }

  async function statePreview(value: unknown): Promise<StatePreviewData> {
    if (!isRecord(value) || typeof value.packId !== "string" || typeof value.state !== "string" ||
        !validUserCharacterId(value.packId)) throw new PackMessageError("미리보기 요청이 올바르지 않아요");
    try {
      // loadCharacter approves the merged manifest, real paths, decoded dimensions, and both sheet byte limits.
      const { pack } = await loaded(value.packId);
      if (!Object.hasOwn(pack.manifest.states, value.state)) throw new Error("Missing state");
      const state = pack.manifest.states[value.state];
      if (!state) throw new Error("Missing state");
      const sheet = pack.sheets[state.sheet];
      if (!sheet) throw new Error("Missing sheet");
      return { sheet, frames: state.frames, fps: state.fps, loop: state.loop,
        cellSize: pack.manifest.cellSize, ...(state.facing === undefined ? {} : { facing: state.facing }) };
    } catch { throw new PackMessageError("상태 미리보기를 불러오지 못했어요"); }
  }

  async function activate(selection: PackSelection, persist: boolean): Promise<void> {
    await options.apply(selection);
    current = selection;
    if (persist) {
      const next = { ...options.getSettings(), characterId: selection.id };
      writeSettings(options.settingsPath, next);
      options.setSettings(next);
    }
  }

  async function select(value: unknown, persist = true): Promise<PackSelection> {
    const selection = await loaded(packId(value));
    await activate(selection, persist);
    return selection;
  }

  /** Never throws: when even the placeholder cannot load, the app starts with no pack (error shown, fallback drawing). */
  async function start(commandLineId?: string): Promise<PackSelection | undefined> {
    const wanted = commandLineId ?? options.getSettings().characterId ?? (options.isPackaged === true ? PACKAGED_DEFAULT_PACK : "placeholder");
    try {
      const selection = await loaded(packId(wanted));
      await activate(selection, false);
      return selection;
    } catch (error) {
      console.warn(`Character ${wanted} unavailable:`, error);
      if (wanted !== "placeholder") {
        try {
          const selection = await loaded("placeholder");
          await activate(selection, false);
          options.notify("선택한 캐릭터를 찾지 못해 기본 캐릭터로 돌아왔어요");
          return selection;
        } catch (fallbackError) { console.warn("Placeholder character unavailable:", fallbackError); }
      }
      try { await options.apply({ id: "placeholder" }); }
      catch (applyError) { console.warn("Cannot apply the empty character selection:", applyError); }
      current = undefined;
      return undefined;
    }
  }

  function list(): PackListItem[] {
    const builtins = readdirSync(builtinDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const builtinIds = new Set(builtins);
    const users = store.listUserPackIds().filter((id) => {
      if (!builtinIds.has(id)) return true;
      console.warn(`Ignoring user pack ${id}: built-in id collision`);
      return false;
    });
    return [...builtins.map((id) => ({ id, source: "builtin" as const })),
      ...users.map((id) => ({ id, source: "user" as const }))].map(({ id, source }) => {
      let name = id;
      let baseId: string | undefined;
      try {
        const raw = readManifest(source === "user" ? userDir : builtinDir, id);
        if (isRecord(raw)) {
          if (typeof raw.name === "string") name = raw.name;
          if (typeof raw.extends === "string") baseId = raw.extends;
        }
        let result;
        if (source === "user" && baseId !== undefined) {
          if (!validUserCharacterId(baseId)) throw new PackMessageError("원본 팩 ID가 올바르지 않아요");
          let base: unknown;
          try { base = readManifest(builtinDir, baseId); }
          catch { throw new PackMessageError(`원본 팩 ${baseId} 이 없어요`); }
          result = mergeCharacterManifest(base, raw);
        } else result = validateCharacterManifest(raw);
        if (!result.ok) throw new PackMessageError(`팩 형식이 맞지 않아요: ${oneLine(result.errors[0])}`);
        if (result.value.id !== id) throw new PackMessageError("manifest.json 의 id 와 폴더 이름이 달라요");
        const meta = isRecord(raw) && isRecord(raw.meta) ? {
          ...(typeof raw.meta.author === "string" ? { author: raw.meta.author } : {}),
          ...(typeof raw.meta.version === "string" ? { version: raw.meta.version } : {}),
          ...(typeof raw.meta.license === "string" ? { license: raw.meta.license } : {}),
          ...(typeof raw.meta.description === "string" ? { description: raw.meta.description } : {}),
        } : undefined;
        return { id, name, source, ...(baseId ? { extends: baseId } : {}), valid: true, cellSize: result.value.cellSize,
          current: current?.id === id, ...(meta ? { meta } : {}), ...(source === "builtin" && developerMode() ? { directEdit: true,
            states: Object.fromEntries(Object.entries(result.value.states).map(([key, state]) =>
              [key, { frames: state.frames, fps: state.fps, loop: state.loop,
                ...(state.next === undefined ? {} : { next: state.next }), ...(state.facing === undefined ? {} : { facing: state.facing }) }])) } : {}) };
      } catch (error) {
        console.warn(`Pack ${id} is invalid:`, error);
        return { id, name, source, ...(baseId ? { extends: baseId } : {}), valid: false,
          error: userFacing(error), current: current?.id === id };
      }
    });
  }

  async function ensureEditable(value: unknown, switchCurrent = true, migration = false): Promise<{ packId: string; derived: boolean }> {
    const id = packId(value);
    const source = sourceOf(id);
    // User packs, and built-in ones while developer mode is on, are written in place.
    if (source === "user" || developerMode()) {
      await loaded(id);
      return { packId: id, derived: false };
    }
    const original = await loaded(id);
    const base = `${id}-mine`;
    let candidate = base;
    const userIds = store.listUserPackIds();
    for (let number = 2; userIds.includes(candidate) || existsSync(join(builtinDir, candidate)); number += 1) {
      if (migration && userIds.includes(candidate)) {
        try {
          const raw = readManifest(userDir, candidate);
          if (isRecord(raw) && raw.extends === id && isRecord(raw.meta)
            && raw.meta.createdWith === INTERACTIONS_MIGRATION_MARKER) {
            await loaded(candidate);
            return { packId: candidate, derived: true };
          }
        } catch { /* An invalid existing pack still occupies this id. */ }
      }
      candidate = `${base}-${number}`;
      if (!validUserCharacterId(candidate)) throw new Error("새 팩 ID를 만들 수 없습니다");
    }
    const manifest = { id: candidate, name: `${original.pack.manifest.name} (내 버전)`, apiVersion: "1",
      extends: id, meta: { createdWith: migration ? INTERACTIONS_MIGRATION_MARKER : "deskpet-editor" } };
    const json = safeJson(manifest, 256 * 1024);
    await store.stagePack(candidate, [{ path: "manifest.json", data: json }], async (stagingRoot, stagedId) => {
      await loadCharacter(stagingRoot, stagedId, builtinDir);
    });
    if (switchCurrent && current?.id === id) await select(candidate);
    return { packId: candidate, derived: true };
  }

  function dirOf(id: string): string {
    return sourceOf(id) === "user" ? userDir : builtinDir;
  }

  function writeFile(id: string, path: string, data: string): void {
    if (sourceOf(id) === "user") store.writePackFile(id, path, data);
    else store.writeBuiltinPackFile(id, path, data);
  }

  function manifestFor(id: string): Record<string, unknown> {
    const raw = readManifest(dirOf(id), id);
    if (!isRecord(raw)) throw new Error("매니페스트가 올바르지 않습니다");
    return raw;
  }

  async function updateManifest(id: string, patch: Record<string, unknown>): Promise<void> {
    const merged = { ...manifestFor(id), ...patch };
    // A patch value of undefined removes the key, so saveMeta can drop meta entirely.
    for (const key of Object.keys(patch)) if (patch[key] === undefined) Reflect.deleteProperty(merged, key);
    const baseId = merged.extends;
    const result = baseId === undefined ? validateCharacterManifest(merged)
      : mergeCharacterManifest(readManifest(builtinDir, packId(baseId)), merged);
    if (!result.ok) throw new Error(result.errors.join("; "));
    writeFile(id, "manifest.json", safeJson(merged, 256 * 1024));
  }

  /** The pack's current file for a manifest field, following `extends` to the base pack; {} when no pack supplies one. */
  function readPackJson(pack: string, field: string): Record<string, unknown> {
    const manifest = manifestFor(pack);
    const file = manifest[field];
    if (typeof file === "string") {
      const directory = realpathSync(join(dirOf(pack), pack));
      const path = realpathSync(join(directory, file));
      if (dirname(path) !== directory) throw new Error("팩 파일 위치가 올바르지 않습니다");
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(raw)) throw new Error("팩 파일이 올바르지 않습니다");
      return raw;
    }
    return typeof manifest.extends === "string" ? readPackJson(packId(manifest.extends), field) : {};
  }

  /**
   * Saves replace the whole file with what the editor knows, so keys the editor never sees (hand-edited
   * extras, fields of a newer app) are carried over from the current file: top-level keys outside `known`,
   * and keys outside `knownItem` on array entries matched by id (sequence steps by position). An unreadable current file carries nothing.
   */
  function keepUnknown(pack: string, field: string, next: unknown, known: readonly string[],
    list?: { key: string; knownItem: readonly string[]; steps?: readonly string[] }): unknown {
    if (!isRecord(next)) return next;
    let existing: Record<string, unknown>;
    try { existing = readPackJson(pack, field); } catch { return next; }
    const merged: Record<string, unknown> = { ...next };
    for (const [key, value] of Object.entries(existing))
      if (!known.includes(key) && !Object.hasOwn(merged, key))
        Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
    const before = list ? existing[list.key] : undefined;
    const after = list ? merged[list.key] : undefined;
    if (list && Array.isArray(before) && Array.isArray(after)) {
      merged[list.key] = after.map((item: unknown) => {
        const old = isRecord(item) ? before.find((entry: unknown) => isRecord(entry) && entry.id === item.id) : undefined;
        if (!isRecord(item) || !isRecord(old)) return item;
        const extra = Object.entries(old).filter(([key]) => !list.knownItem.includes(key) && !Object.hasOwn(item, key));
        const result = extra.length ? { ...item, ...Object.fromEntries(extra) } : item;
        const oldSteps = old.steps;
        const knownStep = list.steps;
        if (knownStep && Array.isArray(oldSteps) && Array.isArray(item.steps)) {
          // Steps have no id, so they pair by position.
          result.steps = item.steps.map((step: unknown, index: number) => {
            const previous: unknown = oldSteps[index];
            if (!isRecord(step) || !isRecord(previous)) return step;
            const more = Object.entries(previous).filter(([key]) => !knownStep.includes(key) && !Object.hasOwn(step, key));
            return more.length ? { ...step, ...Object.fromEntries(more) } : step;
          });
        }
        return result;
      });
    }
    return merged;
  }

  async function afterSave(id: string): Promise<void> {
    if (current?.id !== id) return;
    const selection = await loaded(id);
    await options.refresh(selection);
    current = selection;
  }

  async function saveVoice(value: unknown, voicePack: unknown): Promise<PackSaveResult> {
    const id = packId(value);
    if (!isRecord(voicePack) || voicePack.version !== 1 || !isRecord(voicePack.templates))
      throw new Error("어투 데이터가 올바르지 않습니다");
    // Validate the request before deriving a pack or touching any file.
    safeJson(voicePack, 64 * 1024);
    const existing = readPackJson(id, "voice");
    const merged = { ...existing, version: 1, templates: voicePack.templates };
    const json = safeJson(merged, 64 * 1024);
    const { problems } = parseVoicePack(merged);
    const target = await ensureEditable(id);
    writeFile(target.packId, "voice.json", json);
    await updateManifest(target.packId, { voice: "voice.json" });
    await afterSave(target.packId);
    return { ...target, problems };
  }

  async function saveInteractions(value: unknown, interactions: unknown, activateCurrent = true,
    migration = false): Promise<PackSaveResult> {
    const id = packId(value);
    safeJson(interactions, 256 * 1024);
    const parsed = parseInteractions(interactions);
    if (parsed.problems.length) throw new Error(parsed.problems.join("; "));
    const target = await ensureEditable(id, activateCurrent, migration);
    const json = safeJson(keepUnknown(target.packId, "interactions", interactions, ["version", "items", "hidden"], { key: "items", knownItem: ["id", "label", "mood", "bubble", "lines", "play", "sequence"] }), 256 * 1024);
    writeFile(target.packId, "interactions.json", json);
    await updateManifest(target.packId, { interactions: "interactions.json" });
    if (activateCurrent) await afterSave(target.packId);
    return target;
  }

  async function saveSequences(value: unknown, sequences: unknown): Promise<PackSaveResult> {
    const id = packId(value);
    safeJson(sequences, 256 * 1024);
    const parsed = parseSequences(sequences);
    if (parsed.problems.length) throw new Error(parsed.problems.join("; "));
    const target = await ensureEditable(id);
    const json = safeJson(keepUnknown(target.packId, "sequences", sequences, ["version", "sequences"], { key: "sequences", knownItem: ["id", "label", "steps"], steps: ["play", "ms", "say"] }), 256 * 1024);
    writeFile(target.packId, "sequences.json", json);
    await updateManifest(target.packId, { sequences: "sequences.json" });
    await afterSave(target.packId);
    return target;
  }

  async function saveReactions(value: unknown, reactions: unknown): Promise<PackSaveResult> {
    const id = packId(value);
    safeJson(reactions, 256 * 1024);
    const parsed = parseReactions(reactions);
    if (parsed.problems.length) throw new Error(parsed.problems.join("; "));
    const target = await ensureEditable(id);
    const json = safeJson(keepUnknown(target.packId, "reactions", reactions, ["version", "kinds", "lines"]), 256 * 1024);
    writeFile(target.packId, "reactions.json", json);
    await updateManifest(target.packId, { reactions: "reactions.json" });
    await afterSave(target.packId);
    return target;
  }

  async function saveMotions(value: unknown, motions: unknown): Promise<PackSaveResult> {
    const id = packId(value);
    safeJson(motions, 256 * 1024);
    const parsed = parseMotions(motions);
    if (parsed.problems.length) throw new Error(parsed.problems.join("; "));
    const target = await ensureEditable(id);
    const json = safeJson(keepUnknown(target.packId, "motions", motions, ["version", "motions", "landing", "afterLand"]), 256 * 1024);
    writeFile(target.packId, "motions.json", json);
    await updateManifest(target.packId, { motions: "motions.json" });
    await afterSave(target.packId);
    return target;
  }

  async function saveMeta(value: unknown, payload: unknown): Promise<PackSaveResult> {
    const id = packId(value);
    if (!isRecord(payload) || typeof payload.name !== "string" || !isRecord(payload.meta))
      throw new Error("팩 정보가 올바르지 않습니다");
    if (Object.keys(payload.meta).some((key) => !["author", "version", "license", "description", "createdWith"].includes(key)))
      throw new Error("팩 정보에 허용되지 않는 항목이 있습니다");
    safeJson(payload, 256 * 1024);
    const meta = Object.fromEntries(Object.entries(payload.meta).filter(([, item]) => item !== ""));
    const hasMeta = Object.keys(meta).length > 0;
    const source = sourceOf(id);
    const raw = readManifest(source === "user" ? userDir : builtinDir, id);
    if (!isRecord(raw)) throw new Error("매니페스트가 올바르지 않습니다");
    const candidate: Record<string, unknown> = { ...raw, name: payload.name };
    if (hasMeta) candidate.meta = meta;
    else delete candidate.meta;
    const checked = source === "builtin" ? validateCharacterManifest(candidate)
      : raw.extends === undefined ? validateCharacterManifest(candidate)
        : mergeCharacterManifest(readManifest(builtinDir, packId(raw.extends)), candidate);
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    const target = await ensureEditable(id);
    await updateManifest(target.packId, { name: payload.name, meta: hasMeta ? meta : undefined });
    await afterSave(target.packId);
    return target;
  }

  async function voiceLoad(value: unknown) {
    const selection = await loaded(packId(value));
    const directory = selection.source === "user" ? userDir : builtinDir;
    const own = await loadVoiceTemplates(directory, selection.pack.manifest, selection.pack, builtinDir);
    let base;
    if (selection.pack.manifest.extends !== undefined) {
      const original = await loaded(selection.pack.manifest.extends);
      base = await loadVoiceTemplates(builtinDir, original.pack.manifest, original.pack, builtinDir);
    }
    return { templates: own.templates, problems: own.problems, ...(base ? { baseTemplates: base.templates } : {}) };
  }

  async function deletePack(value: unknown): Promise<{ deleted: boolean }> {
    const id = packId(value);
    if (sourceOf(id) !== "user") throw new Error("내장 팩은 삭제할 수 없습니다");
    if (!await options.confirmDelete(id)) return { deleted: false };
    if (current?.id === id) await select("placeholder");
    store.removePack(id);
    return { deleted: true };
  }

  /** With developer mode off, no earlier selection may survive a later switch-on. */
  function requireDeveloperMode(): void {
    if (developerMode()) return;
    pendingSheets.clear();
    throw new Error("개발자 모드에서만 시트를 편집할 수 있습니다");
  }

  function requireDeveloperPack(value: unknown): string {
    requireDeveloperMode();
    const id = packId(value);
    if (sourceOf(id) !== "builtin") throw new Error("내장 팩만 시트를 편집할 수 있습니다");
    return id;
  }

  async function pickSheet(value: unknown): Promise<unknown> {
    requireDeveloperMode();
    if (!isRecord(value) || !Number.isInteger(value.frames) || typeof value.frames !== "number" ||
        value.frames < 1 || value.frames > 64) throw new Error("프레임 수가 올바르지 않습니다");
    const id = requireDeveloperPack(value.packId);
    const selection = await loaded(id);
    const path = await options.chooseSheetFile?.();
    if (path === undefined) return { canceled: true };
    const sheet = await inspectSelectedSheet(path, selection.pack.manifest.cellSize, selection.pack.manifest.anchor, value.frames);
    const token = freshToken();
    pendingSheets.clear();
    pendingSheets.set(token, { packId: id, frames: value.frames, sheet, expiresAt: tokenExpiresAt(),
      cellSize: [...selection.pack.manifest.cellSize], anchor: [...selection.pack.manifest.anchor] });
    return { canceled: false, token, preview: sheet.preview, footCheck: sheet.footCheck };
  }

  /** Takes the token at once (before any check can fail) and queues the write behind earlier applies. */
  function applySheet(value: unknown): Promise<{ packId: string; state: string; sheet: string }> {
    if (!isRecord(value)) return Promise.reject(new Error("시트 요청이 올바르지 않습니다"));
    const pending = typeof value.token === "string" ? pendingSheets.get(value.token) : undefined;
    if (typeof value.token === "string") pendingSheets.delete(value.token);
    const run = applyChain.then(() => applyPending(value, pending));
    applyChain = run.catch(() => undefined);
    return run;
  }

  async function applyPending(value: Record<string, unknown>, pending: ReturnType<typeof pendingSheets.get>):
    Promise<{ packId: string; state: string; sheet: string }> {
    const id = requireDeveloperPack(value.packId);
    if (!pending || pending.packId !== id || performance.now() > pending.expiresAt)
      throw new Error("시트 선택이 만료되었습니다. 다시 골라 주세요");
    const { frames } = pending;
    if (value.frames !== frames || !validNewStateName(value.state) ||
        typeof value.fps !== "number" || !Number.isFinite(value.fps) || value.fps <= 0 || value.fps > 60 ||
        typeof value.loop !== "boolean" ||
        (value.next !== undefined && typeof value.next !== "string") ||
        (value.facing !== undefined && value.facing !== "left" && value.facing !== "right") ||
        (value.overrideFootIssues !== undefined && typeof value.overrideFootIssues !== "boolean"))
      throw new Error("상태 설정이 올바르지 않습니다");
    if (pending.sheet.footCheck.issueFrames > 0 && value.overrideFootIssues !== true)
      throw new Error("발 위치 이상을 확인하고 '그래도 사용'을 선택해 주세요");
    const selection = await loaded(id);
    const manifest = selection.pack.manifest;
    if (manifest.cellSize[0] !== pending.cellSize[0] || manifest.cellSize[1] !== pending.cellSize[1] ||
        manifest.anchor[0] !== pending.anchor[0] || manifest.anchor[1] !== pending.anchor[1])
      throw new Error("시트를 다시 골라 주세요");
    const states = manifest.states;
    const existing = Object.hasOwn(states, value.state) ? states[value.state] : undefined;
    if (!existing && Object.keys(states).length >= 32) throw new Error("상태는 최대 32개입니다");
    const used = new Set(Object.entries(states).filter(([name]) => name !== value.state).map(([, state]) => state.sheet));
    let total = pending.sheet.bytes.length;
    for (const sheet of used) total += statSync(realpathSync(join(builtinDir, id, sheet))).size;
    if (total > CHARACTER_PACK_MAX_SHEET_BYTES) throw new Error("팩 시트 합계는 64 MiB 이하여야 합니다");
    let sheetPath = newSheetPath(value.state);
    for (let attempt = 0; existsSync(join(builtinDir, id, sheetPath)); attempt += 1) {
      if (attempt >= 10) throw new Error("새 시트 이름을 만들 수 없습니다");
      sheetPath = newSheetPath(value.state);
    }
    const state = { sheet: sheetPath, frames, fps: value.fps, loop: value.loop,
      ...(value.next === undefined ? {} : { next: value.next }),
      ...(value.facing === undefined ? {} : { facing: value.facing }) };
    const updated = { ...manifest, states: { ...states, [value.state]: state } };
    store.writeBuiltinPackFile(id, sheetPath, pending.sheet.bytes);
    try {
      const checked = validateCharacterManifest(updated);
      if (!checked.ok) throw new Error(checked.errors.join("; "));
      store.writeBuiltinPackFile(id, "manifest.json", safeJson(updated, 256 * 1024));
    }
    catch (error) { store.removeBuiltinPackFile(id, sheetPath); throw error; }
    if (existing && generatedSheetPattern.test(existing.sheet) && !Object.values(updated.states).some((item) => item.sheet === existing.sheet)) {
      try { store.removeBuiltinPackFile(id, existing.sheet); }
      catch (error) { console.warn("Cannot clean old generated sheet:", error); }
    }
    if (current?.id === id) await activate(await loaded(id), false);
    return { packId: id, state: value.state, sheet: sheetPath };
  }

  return { list, start, select, ensureEditable, saveVoice, saveInteractions, saveSequences, saveReactions, saveMotions, saveMeta, voiceLoad, deletePack, pickSheet, applySheet, statePreview,
    saveMigratedInteractions: (value: unknown, interactions: unknown) => saveInteractions(value, interactions, false, true),
    current: () => current, hasOwnInteractions: (id: string) => manifestFor(packId(id)).interactions !== undefined,
    loadInteractions: async (id: unknown) => {
      const pack = (await loaded(packId(id))).pack;
      const sequences = await loadSequences(pack);
      return { ...await loadInteractions(pack, new Set(sequences.sequences.sequences.map((item) => item.id))),
        states: Object.keys(pack.manifest.states), fallbacks: { ...pack.manifest.fallbacks },
        sequences: sequences.sequences.sequences.map(({ id, label }) => ({ id, ...(label !== undefined ? { label } : {}) })) };
    },
    loadSequences: async (id: unknown) => {
      const pack = (await loaded(packId(id))).pack;
      return { ...await loadSequences(pack), plays: sequencePlays(pack.manifest) };
    },
    /** The nine movement keys as saved, the landing style, the pack's state names, and what each key really draws. */
    loadMotions: async (id: unknown) => {
      const pack = (await loaded(packId(id))).pack;
      const { motions, problems } = await loadMotions(pack);
      return { motions: motions.motions, landing: motions.landing,
        ...(motions.afterLand ? { afterLand: motions.afterLand } : {}), problems,
        states: Object.keys(pack.manifest.states),
        nonLoopStates: Object.entries(pack.manifest.states).filter(([, state]) => !state.loop).map(([name]) => name),
        resolved: Object.fromEntries(MOTION_KEYS.map((key) =>
          [key, resolveMotionPlay(key, motions, pack.manifest, DEFAULT_MOVEMENT_FALLBACKS)])) };
    },
    loadReactions: async (id: unknown) => {
      const pack = (await loaded(packId(id))).pack;
      const sequences = await loadSequences(pack);
      return { ...await loadReactions(pack, new Set(sequences.sequences.sequences.map((item) => item.id))),
        plays: sequencePlays(pack.manifest), sequences: sequences.sequences.sequences.map(({ id, label, steps }) => ({ id, label, firstPlay: steps[0]?.play })) };
    } };
}
