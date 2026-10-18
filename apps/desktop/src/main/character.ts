import { nativeImage } from "electron";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CHARACTER_PACK_MAX_SHEET_BYTES, CHARACTER_SHEET_MAX_BYTES, CHARACTER_SHEET_MAX_PIXELS,
  CHARACTER_JSON_MAX_BYTES, mergeCharacterManifest, parseInteractions, parseMotions, parseReactions, parseSequences, parseVoicePack, selectReaction, validUserCharacterId,
  validateCharacterManifest, type CharacterManifest, type Interactions, type Motions, type LinePetEvent,
  type ReactionRule, type ReactionTarget, type Reactions, type Sequences, type VoiceTemplates, type VoiceLines } from "@deskpet/core";
import type { Rectangle } from "./position.js";
import { mirroredHorizontalBounds } from "../renderer/mirror.js";

export interface CharacterPack {
  manifest: CharacterManifest;
  sheets: Record<string, string>;
  contentRect: Rectangle;
}

const assetRoots = new WeakMap<CharacterPack, { interactions: string; sequences: string; reactions: string; motions: string; voice: string }>();

const OPAQUE_ALPHA = 128;

function scaledContentRect(bounds: { left: number; top: number; right: number; bottom: number },
  manifest: CharacterManifest): Rectangle {
  const width = Math.round(manifest.cellSize[0] * manifest.scale);
  const height = Math.round(manifest.cellSize[1] * manifest.scale);
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return { x: 0, y: 0, width, height };
  const x = Math.max(0, Math.floor(bounds.left * manifest.scale));
  const y = Math.floor(bounds.top * manifest.scale);
  const right = Math.min(width, Math.ceil(bounds.right * manifest.scale));
  const bottom = Math.min(height, Math.ceil(bounds.bottom * manifest.scale));
  return { x, y, width: right - x, height: bottom - y };
}

export function validCharacterId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." &&
    !id.includes("/") && !id.includes("\\") && !id.includes(":") && basename(id) === id;
}

async function readManifest(root: string): Promise<unknown> {
  const manifestPath = await realpath(join(root, "manifest.json"));
  const manifestRelative = relative(root, manifestPath);
  if (!manifestRelative || manifestRelative === ".." || manifestRelative.startsWith(".." + sep) || isAbsolute(manifestRelative))
    throw new Error("Manifest resolves outside pack folder");
  if ((await stat(manifestPath)).size > CHARACTER_JSON_MAX_BYTES) throw new Error("Manifest exceeds 256 KiB");
  return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
}

export async function loadCharacter(directory: string, id: string, builtinDirectory?: string): Promise<CharacterPack> {
  if (!validCharacterId(id)) throw new Error(`Invalid character id: ${id}`);
  const charactersRoot = await realpath(directory);
  const root = await realpath(resolve(directory, id));
  if (dirname(root) !== charactersRoot) throw new Error("Pack folder resolves outside character folder");
  const raw = await readManifest(root);
  const extension = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "extends");
  let sheetRoot = root;
  let interactionRoot = root;
  let sequenceRoot = root;
  let reactionRoot = root;
  let motionRoot = root;
  let voiceRoot = root;
  let previewRoot = root;
  let result;
  if (extension) {
    const baseId = (raw as Record<string, unknown>).extends;
    if (!validUserCharacterId(baseId)) throw new Error("Invalid manifest: extends must be a valid pack id");
    if (baseId === id) throw new Error("Invalid manifest: pack cannot extend itself");
    if (builtinDirectory === undefined) throw new Error("Invalid manifest: built-in pack root is required for extends");
    const builtinRoot = await realpath(builtinDirectory);
    if (builtinRoot === charactersRoot) throw new Error("Invalid manifest: base must come from a separate built-in folder");
    let baseRoot: string;
    try { baseRoot = await realpath(resolve(builtinDirectory, baseId)); }
    catch { throw new Error(`Invalid manifest: base pack missing: ${baseId}`); }
    if (dirname(baseRoot) !== builtinRoot) throw new Error("Invalid manifest: base pack resolves outside built-in folder");
    let baseRaw: unknown;
    try { baseRaw = await readManifest(baseRoot); }
    catch { throw new Error(`Invalid manifest: base pack missing or unreadable: ${baseId}`); }
    result = mergeCharacterManifest(baseRaw, raw);
    sheetRoot = baseRoot;
    if (!Object.hasOwn(raw, "interactions")) interactionRoot = baseRoot;
    if (!Object.hasOwn(raw, "sequences")) sequenceRoot = baseRoot;
    if (!Object.hasOwn(raw, "reactions")) reactionRoot = baseRoot;
    if (!Object.hasOwn(raw, "motions")) motionRoot = baseRoot;
    if (!Object.hasOwn(raw, "voice")) voiceRoot = baseRoot;
    if (!Object.hasOwn(raw, "preview")) previewRoot = baseRoot;
  } else result = validateCharacterManifest(raw);
  if (!result.ok) throw new Error(`Invalid manifest: ${result.errors.join("; ")}`);
  const manifest = result.value;
  if (manifest.id !== id) throw new Error(`Manifest id ${manifest.id} does not match ${id}`);
  if (manifest.preview !== undefined) {
    const path = await realpath(resolve(previewRoot, manifest.preview));
    const within = relative(previewRoot, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Preview outside character folder: ${manifest.preview}`);
    if ((await stat(path)).size > 512 * 1024) throw new Error(`Preview exceeds 512 KiB: ${manifest.preview}`);
    const bytes = await readFile(path);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
      throw new Error(`Invalid preview PNG: ${manifest.preview}`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const decoded = nativeImage.createFromBuffer(bytes).getSize();
    if (!width || !height || width > 256 || height > 256 ||
      decoded.width !== width || decoded.height !== height)
      throw new Error(`Invalid preview dimensions: ${manifest.preview}`);
  }
  const sheets: Record<string, string> = {};
  const opaque = { left: manifest.cellSize[0], top: manifest.cellSize[1], right: 0, bottom: 0 };
  const mirroredSheets = new Set(Object.values(manifest.states).filter((state) => state.facing !== undefined)
    .map((state) => state.sheet));
  let totalBytes = 0;
  for (const state of Object.values(manifest.states)) {
    if (Object.hasOwn(sheets, state.sheet)) continue;
    const path = await realpath(resolve(sheetRoot, state.sheet));
    const within = relative(sheetRoot, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
      throw new Error(`Sheet outside character folder: ${state.sheet}`);
    }
    const fileBytes = (await stat(path)).size;
    if (fileBytes > CHARACTER_SHEET_MAX_BYTES) throw new Error(`Sheet exceeds 8 MiB: ${state.sheet}`);
    totalBytes += fileBytes;
    if (totalBytes > CHARACTER_PACK_MAX_SHEET_BYTES) throw new Error("Pack exceeds 64 MiB sheet limit");
    const bytes = await readFile(path);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
      throw new Error(`Invalid PNG header: ${state.sheet}`);
    const headerWidth = bytes.readUInt32BE(16);
    const headerHeight = bytes.readUInt32BE(20);
    if (!headerWidth || !headerHeight || headerWidth * headerHeight > CHARACTER_SHEET_MAX_PIXELS)
      throw new Error(`Sheet exceeds pixel limit: ${state.sheet}`);
    if (headerWidth !== manifest.cellSize[0] * state.frames || headerHeight !== manifest.cellSize[1])
      throw new Error(`Invalid sheet dimensions: ${state.sheet}`);
    const image = nativeImage.createFromBuffer(bytes);
    const size = image.getSize();
    if (size.width !== manifest.cellSize[0] * state.frames || size.height !== manifest.cellSize[1]) {
      throw new Error(`Invalid sheet dimensions: ${state.sheet}`);
    }
    try {
      const bitmap = image.toBitmap();
      const cellWidth = manifest.cellSize[0];
      const sheetOpaque = { left: cellWidth, top: manifest.cellSize[1], right: 0, bottom: 0 };
      for (let y = 0; y < size.height; y += 1) {
        for (let x = 0; x < size.width; x += 1) {
          if ((bitmap[(y * size.width + x) * 4 + 3] ?? 0) < OPAQUE_ALPHA) continue;
          const cellX = x % cellWidth;
          sheetOpaque.left = Math.min(sheetOpaque.left, cellX);
          sheetOpaque.top = Math.min(sheetOpaque.top, y);
          sheetOpaque.right = Math.max(sheetOpaque.right, cellX + 1);
          sheetOpaque.bottom = Math.max(sheetOpaque.bottom, y + 1);
        }
      }
      opaque.left = Math.min(opaque.left, sheetOpaque.left);
      opaque.top = Math.min(opaque.top, sheetOpaque.top);
      opaque.right = Math.max(opaque.right, sheetOpaque.right);
      opaque.bottom = Math.max(opaque.bottom, sheetOpaque.bottom);
      if (mirroredSheets.has(state.sheet) && sheetOpaque.right > sheetOpaque.left) {
        const mirrored = mirroredHorizontalBounds(sheetOpaque, manifest.anchor[0]);
        opaque.left = Math.min(opaque.left, mirrored.left);
        opaque.right = Math.max(opaque.right, mirrored.right);
      }
    } catch (error) {
      console.error(`Read content bounds from ${state.sheet}:`, error);
      opaque.left = 0;
      opaque.top = 0;
      opaque.right = manifest.cellSize[0];
      opaque.bottom = manifest.cellSize[1];
    }
    sheets[state.sheet] = `data:image/png;base64,${bytes.toString("base64")}`;
  }
  const pack = { manifest, sheets, contentRect: scaledContentRect(opaque, manifest) };
  assetRoots.set(pack, { interactions: interactionRoot, sequences: sequenceRoot, reactions: reactionRoot, motions: motionRoot, voice: voiceRoot });
  return pack;
}

export interface LoadedInteractions { interactions: Interactions; problems: string[] }

/** Reads the interaction file from the pack that declared it, keeping parse errors as warnings. */
export async function loadInteractions(pack: CharacterPack, sequenceIds?: ReadonlySet<string>): Promise<LoadedInteractions> {
  const empty: Interactions = { items: [], hidden: [] };
  const { interactions, id } = pack.manifest;
  if (interactions === undefined) return { interactions: empty, problems: [] };
  try {
    const approvedRoot = assetRoots.get(pack)?.interactions;
    if (approvedRoot === undefined) throw new Error("Pack has no approved interaction root");
    const root = await realpath(approvedRoot);
    const path = await realpath(resolve(root, interactions));
    const within = relative(root, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Interactions file outside pack folder: ${interactions}`);
    if ((await stat(path)).size > CHARACTER_JSON_MAX_BYTES) throw new Error("Interactions file exceeds 256 KiB");
    const result = parseInteractions(JSON.parse(await readFile(path, "utf8")));
    for (const problem of result.problems) console.warn(`Character ${id} interactions: ${problem}`);
    if (sequenceIds !== undefined) {
      for (const item of result.interactions.items) {
        if (item.sequence !== undefined && !sequenceIds.has(item.sequence)) {
          const problem = `interactions ${item.id} references missing sequence ${item.sequence}`;
          result.problems.push(problem);
          console.warn(`Character ${id} interactions: ${problem}`);
        }
      }
    }
    return result;
  } catch (error) {
    console.warn(`Character ${id} interactions unavailable:`, error instanceof Error ? error.message : String(error));
    return { interactions: empty, problems: ["interactions file could not be read"] };
  }
}

export interface LoadedSequences { sequences: Sequences; problems: string[] }

export interface LoadedReactions { reactions: Reactions; problems: string[] }

type VoiceKind = NonNullable<LinePetEvent["voice"]>["kind"];

/** Pack choices precede plugin rules; a silent event cannot run a sequence. */
export function selectPackReaction(event: LinePetEvent, reactions: Reactions, rules: readonly ReactionRule[] = [],
  lineOverrides: Readonly<Record<string, ReactionTarget>> = {}, registeredLines?: ReadonlyMap<string, VoiceKind>,
  availableSequences?: ReadonlySet<string>):
  { sequence?: string; selected?: ReturnType<typeof selectReaction>; mapped: boolean } {
  const showBubble = event.type === "notify" && !!event.text && event.priority !== "low";
  const lineId = event.line?.id;
  const usableLineId = lineId !== undefined && (registeredLines === undefined || registeredLines.has(lineId)) ? lineId : undefined;
  // A line-only event (no voice) takes its kind from the registered catalog entry.
  const kind = event.voice?.kind ?? (lineId === undefined ? undefined : registeredLines?.get(lineId));
  const candidates = [usableLineId === undefined ? undefined : lineOverrides[usableLineId],
    usableLineId === undefined ? undefined : reactions.lines?.[usableLineId],
    kind === undefined ? undefined : reactions.kinds[kind]];
  for (const mapped of candidates) {
    if (mapped?.sequence !== undefined && showBubble &&
        (availableSequences === undefined || availableSequences.has(mapped.sequence))) return { sequence: mapped.sequence, mapped: true };
    if (mapped?.play !== undefined) return { selected: { play: mapped.play }, mapped: true };
  }
  return { selected: selectReaction(event, rules), mapped: false };
}

/** Reads a complete reaction map from the pack that declared it. */
export async function loadReactions(pack: CharacterPack, sequenceIds?: ReadonlySet<string>): Promise<LoadedReactions> {
  const empty: Reactions = { kinds: {} };
  const { reactions, id } = pack.manifest;
  if (reactions === undefined) return { reactions: empty, problems: [] };
  try {
    const approvedRoot = assetRoots.get(pack)?.reactions;
    if (approvedRoot === undefined) throw new Error("Pack has no approved reaction root");
    const root = await realpath(approvedRoot);
    const path = await realpath(resolve(root, reactions));
    const within = relative(root, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Reactions file outside pack folder: ${reactions}`);
    if ((await stat(path)).size > CHARACTER_JSON_MAX_BYTES) throw new Error("Reactions file exceeds 256 KiB");
    const result = parseReactions(JSON.parse(await readFile(path, "utf8")));
    const usable: Reactions["kinds"] = {};
    for (const [kind, target] of Object.entries(result.reactions.kinds)) {
      if (target?.sequence !== undefined && sequenceIds !== undefined && !sequenceIds.has(target.sequence)) {
        result.problems.push(`reactions ${kind} references missing sequence ${target.sequence}`);
      } else Object.defineProperty(usable, kind, { value: target, enumerable: true, writable: true, configurable: true });
    }
    result.reactions.kinds = usable;
    if (result.reactions.lines !== undefined) {
      const lines: NonNullable<Reactions["lines"]> = {};
      for (const [id, target] of Object.entries(result.reactions.lines)) {
        if (target.sequence !== undefined && sequenceIds !== undefined && !sequenceIds.has(target.sequence))
          result.problems.push(`reactions ${id} references missing sequence ${target.sequence}`);
        else Object.defineProperty(lines, id, { value: target, enumerable: true, writable: true, configurable: true });
      }
      result.reactions.lines = lines;
    }
    for (const problem of result.problems) console.warn(`Character ${id} reactions: ${problem}`);
    return result;
  } catch (error) {
    console.warn(`Character ${id} reactions unavailable:`, error instanceof Error ? error.message : String(error));
    return { reactions: empty, problems: ["reactions file could not be read"] };
  }
}

export interface LoadedMotions { motions: Motions; problems: string[] }

/** Reads the movement map and landing style from the pack that declared them; a broken file gives the defaults. */
export async function loadMotions(pack: CharacterPack): Promise<LoadedMotions> {
  const empty = (): Motions => ({ motions: {}, landing: "normal" });
  const { motions, id } = pack.manifest;
  if (motions === undefined) return { motions: empty(), problems: [] };
  try {
    const approvedRoot = assetRoots.get(pack)?.motions;
    if (approvedRoot === undefined) throw new Error("Pack has no approved motions root");
    const root = await realpath(approvedRoot);
    const path = await realpath(resolve(root, motions));
    const within = relative(root, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Motions file outside pack folder: ${motions}`);
    if ((await stat(path)).size > CHARACTER_JSON_MAX_BYTES) throw new Error("Motions file exceeds 256 KiB");
    const result = parseMotions(JSON.parse(await readFile(path, "utf8")));
    for (const problem of result.problems) console.warn(`Character ${id} motions: ${problem}`);
    return result;
  } catch (error) {
    console.warn(`Character ${id} motions unavailable:`, error instanceof Error ? error.message : String(error));
    return { motions: empty(), problems: ["motions file could not be read"] };
  }
}

/** Reads the sequence file from its approved pack root, retaining malformed entries as warnings. */
export async function loadSequences(pack: CharacterPack): Promise<LoadedSequences> {
  const empty: Sequences = { sequences: [] };
  const { sequences, id } = pack.manifest;
  if (sequences === undefined) return { sequences: empty, problems: [] };
  try {
    const approvedRoot = assetRoots.get(pack)?.sequences;
    if (approvedRoot === undefined) throw new Error("Pack has no approved sequence root");
    const root = await realpath(approvedRoot);
    const path = await realpath(resolve(root, sequences));
    const within = relative(root, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Sequences file outside pack folder: ${sequences}`);
    if ((await stat(path)).size > CHARACTER_JSON_MAX_BYTES) throw new Error("Sequences file exceeds 256 KiB");
    const result = parseSequences(JSON.parse(await readFile(path, "utf8")));
    for (const problem of result.problems) console.warn(`Character ${id} sequences: ${problem}`);
    return result;
  } catch (error) {
    console.warn(`Character ${id} sequences unavailable:`, error instanceof Error ? error.message : String(error));
    return { sequences: empty, problems: ["sequences file could not be read"] };
  }
}

/** What the pack's voice file gave: usable templates plus the parser's notes about what it dropped. */
export interface LoadedVoice { templates: VoiceTemplates; lines: VoiceLines; problems: string[] }

const VOICE_FILE_MAX_BYTES = 64 * 1024;

/**
 * Reads the pack's voice template file named by manifest.voice. A missing manifest field, missing file,
 * unsafe path, or broken JSON gives empty templates and a warning; this never throws.
 */
export async function loadVoiceTemplates(directory: string, manifest: CharacterManifest,
  pack?: CharacterPack, builtinDirectory?: string): Promise<LoadedVoice> {
  if (manifest.voice === undefined) return { templates: {}, lines: {}, problems: [] };
  try {
    if (pack !== undefined && pack.manifest !== manifest) throw new Error("Pack manifest does not match approved assets");
    const charactersRoot = await realpath(directory);
    const approvedRoot = pack === undefined ? resolve(directory, manifest.id) : assetRoots.get(pack)?.voice;
    if (approvedRoot === undefined) throw new Error("Pack has no approved voice root");
    const root = await realpath(approvedRoot);
    const builtinRoot = builtinDirectory === undefined ? undefined : await realpath(builtinDirectory);
    if (dirname(root) !== charactersRoot && dirname(root) !== builtinRoot)
      throw new Error("Pack folder resolves outside allowed character folders");
    const path = await realpath(resolve(root, manifest.voice));
    const within = relative(root, path);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error(`Voice file outside character folder: ${manifest.voice}`);
    if ((await stat(path)).size > VOICE_FILE_MAX_BYTES) throw new Error("Voice file exceeds 64 KiB");
    const { templates, lines, problems } = parseVoicePack(JSON.parse(await readFile(path, "utf8")));
    for (const problem of problems) console.warn(`Character ${manifest.id} voice: ${problem}`);
    return { templates, lines, problems };
  } catch (error) {
    console.warn(`Character ${manifest.id} voice unavailable:`, error instanceof Error ? error.message : String(error));
    // The settings window shows this; the reason stays in the log because it may name local paths.
    return { templates: {}, lines: {}, problems: ["voice file could not be read"] };
  }
}
