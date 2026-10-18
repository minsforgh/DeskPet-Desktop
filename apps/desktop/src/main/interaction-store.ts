import type { Interactions } from "@deskpet/core";
import { copyFileSync } from "node:fs";
import { writeSettings, type DeskpetSettings } from "./settings.js";
import { getDefaultInteractions, sanitizeInteractions, type PetInteraction } from "./pet-menu.js";
import { createPackService } from "./pack-service.js";

/**
 * Where the user's own interactions (edited shipped ones and added ones) live. The app uses the current pack;
 * the settings implementation remains here for the one-time migration tests.
 */
export interface InteractionStore {
  load(): Promise<PetInteraction[]>;
  /** Replaces the stored list; rejects when it could not be written. */
  save(items: PetInteraction[]): Promise<void>;
}

type PackService = ReturnType<typeof createPackService>;

export function fromPackInteractions(interactions: Interactions): PetInteraction[] {
  const hidden = new Set(interactions.hidden);
  const items: PetInteraction[] = interactions.items.map((item) => ({ id: item.id, label: item.label, mood: item.mood,
    speak: item.bubble, lines: [...item.lines], builtin: false, ...(hidden.has(item.id) ? { hidden: true } : {}),
    ...(item.play !== undefined ? { play: item.play } : {}), ...(item.sequence !== undefined ? { sequence: item.sequence } : {}) }));
  for (const base of getDefaultInteractions()) {
    if (hidden.has(base.id) && !items.some((item) => item.id === base.id)) items.push({ ...base, hidden: true });
  }
  return items;
}

export function toPackInteractions(items: readonly PetInteraction[]): { version: 1 } & Interactions {
  return { version: 1, items: items.map(({ id, label, mood, speak, lines, play, sequence }) =>
    ({ id, label, mood, bubble: speak, lines: [...lines], ...(play !== undefined ? { play } : {}),
      ...(sequence !== undefined ? { sequence } : {}) })), hidden: items.filter(({ hidden }) => hidden === true).map(({ id }) => id) };
}

export function createPackInteractionStore(packs: PackService): InteractionStore {
  return {
    load: async () => {
      const current = packs.current();
      if (!current) return [];
      return fromPackInteractions((await packs.loadInteractions(current.id)).interactions);
    },
    save: async (items) => {
      const current = packs.current();
      if (!current) throw new Error("No current character pack");
      await packs.saveInteractions(current.id, toPackInteractions(items));
    },
  };
}

/** Move legacy settings interactions only after a pack file is safely written. */
export async function migrateSettingsInteractions(options: {
  packs: PackService;
  path: string;
  get: () => DeskpetSettings;
  set: (next: DeskpetSettings) => void;
  notify: (message: string) => void;
  write?: typeof writeSettings;
  backup?: (source: string, destination: string) => void;
}): Promise<boolean> {
  const { packs, path, get, set, notify, write = writeSettings, backup = copyFileSync } = options;
  const original = get();
  if (original.interactions === undefined || original.migrations?.interactionsToPack === true) return false;
  const current = packs.current();
  if (!current) return false;
  if (current.source === "user" && packs.hasOwnInteractions(current.id)) {
    console.warn(`Character ${current.id} already has interactions; legacy settings migration deferred`);
    return false;
  }
  try {
    const result = await packs.saveMigratedInteractions(current.id, toPackInteractions(sanitizeInteractions(original.interactions)));
    const next: DeskpetSettings = { ...original, characterId: result.packId,
      migrations: { ...original.migrations, interactionsToPack: true } };
    delete next.interactions;
    backup(path, `${path}.bak`);
    write(path, next);
    try { await packs.select(result.packId, false); }
    catch (error) {
      write(path, original);
      throw error;
    }
    set(next);
    const name = packs.current()?.pack.manifest.name ?? result.packId;
    notify(`상호작용 설정을 '${name}' 팩으로 옮겼어요`);
    return true;
  } catch (error) {
    console.warn("Cannot migrate settings interactions to character pack:", error);
    return false;
  }
}

/** The settings.json implementation; `settings` is the app's live copy, `write` defaults to the atomic file save. */
export function createSettingsInteractionStore(options: {
  path: string;
  get: () => DeskpetSettings;
  set: (next: DeskpetSettings) => void;
  write?: (path: string, settings: DeskpetSettings) => void;
}): InteractionStore {
  const { path, get, set, write = writeSettings } = options;
  return {
    load: () => Promise.resolve((get().interactions ?? []).map((item) => ({ ...item, lines: [...item.lines] }))),
    save: (items) => {
      const updated: DeskpetSettings = { ...get(), interactions: items };
      if (items.length === 0) delete updated.interactions;
      try { write(path, updated); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
      set(updated);
      return Promise.resolve();
    },
  };
}
