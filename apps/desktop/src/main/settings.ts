import { MOVEMENT_FIELDS, parseReactions, parseVoicePack, validUserCharacterId, validateBehavior, validateDoNotDisturbConfig,
  type CharacterBehavior, type DoNotDisturbConfig, type ReactionTarget, type VoiceLines } from "@deskpet/core";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validExcludedNames } from "./terrain-watcher.js";
import { sanitizeInteractions, type PetInteraction } from "./pet-menu.js";

export interface DeskpetSettings {
  doNotDisturb: DoNotDisturbConfig;
  display?: { badge?: BadgePlacement; bubble?: BubbleDisplay };
  characterId?: string;
  characterBehavior?: Record<string, CharacterBehavior>;
  lineOverrides?: Record<string, VoiceLines>;
  lineReactions?: Record<string, Record<string, ReactionTarget>>;
  /** Each plugin owns the shape of its own object; the app only keeps it (ADR-0005 §6). */
  plugins?: Record<string, Record<string, unknown>>;
  /** Plugin action ids that POST /action/:id may run; core actions are always allowed (ADR-0005 §3). */
  httpActionAllowlist?: string[];
  /** The user's own pet-menu interactions: edited shipped ones and added ones (D-035). Shipped ones equal to the default are not stored. */
  interactions?: PetInteraction[];
  migrations?: { interactionsToPack?: true };
  /** Developer mode (D-044): saving a built-in pack edits its folder in place instead of deriving a copy. Ignored in packaged builds. */
  developerMode?: boolean;
  /** Moving over other windows (ADR-0009 §10): global switch (default on) and executable names that never count as footing. */
  terrain?: { enabled: boolean; excludedApps: string[] };
  /** Windows login item (ADR-0010 §6): only records that the first-run default was applied or the user chose; the system item is the truth. */
  launchAtLogin?: boolean;
}

export interface BadgePlacement { side: "above" | "left" | "right"; gap: number }
export const DEFAULT_BADGE_PLACEMENT: BadgePlacement = { side: "above", gap: 3 };
export interface BubbleDisplay { maxWidthDip: number; maxLines: number }
export const DEFAULT_BUBBLE_DISPLAY: BubbleDisplay = { maxWidthDip: 280, maxLines: 4 };

export function validBubbleDisplay(value: unknown): value is BubbleDisplay {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "maxWidthDip" in value && typeof value.maxWidthDip === "number" && Number.isInteger(value.maxWidthDip) &&
    value.maxWidthDip >= 180 && value.maxWidthDip <= 600 &&
    "maxLines" in value && typeof value.maxLines === "number" && Number.isInteger(value.maxLines) &&
    value.maxLines >= 3 && value.maxLines <= 12;
}

export function validBadgePlacement(value: unknown): value is BadgePlacement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "side" in value && (value.side === "above" || value.side === "left" || value.side === "right") &&
    "gap" in value && typeof value.gap === "number" && Number.isInteger(value.gap) && value.gap >= 0 && value.gap <= 40;
}

/** Names compare case-insensitively (ADR-0009 §10), so the first spelling wins. */
export function dedupeExcludedApps(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const MAX_EXCLUDED_APPS = 64;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const hhmmPattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function defaultSettings(): DeskpetSettings {
  return { doNotDisturb: { enabled: false } };
}

/** Parses settings.json contents; an absent doNotDisturb is a silent default, an invalid one warns once. */
export function parseSettings(value: unknown): DeskpetSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.warn("settings.json is not an object; using defaults (doNotDisturb disabled)");
    return defaultSettings();
  }
  const settings = defaultSettings();
  if ("display" in value) {
    const display = value.display;
    if (typeof display === "object" && display !== null && !Array.isArray(display)) {
      if ("badge" in display) {
        if (validBadgePlacement(display.badge)) settings.display = { badge: display.badge };
        else console.warn("Invalid settings.json display.badge: using defaults");
      }
      if ("bubble" in display) {
        const bubble = display.bubble;
        if (typeof bubble === "object" && bubble !== null && !Array.isArray(bubble)) {
          const parsed = { ...DEFAULT_BUBBLE_DISPLAY };
          if ("maxWidthDip" in bubble) {
            if (typeof bubble.maxWidthDip === "number" && Number.isInteger(bubble.maxWidthDip) &&
                bubble.maxWidthDip >= 180 && bubble.maxWidthDip <= 600) parsed.maxWidthDip = bubble.maxWidthDip;
            else console.warn("Invalid settings.json display.bubble.maxWidthDip: using default");
          }
          if ("maxLines" in bubble) {
            if (typeof bubble.maxLines === "number" && Number.isInteger(bubble.maxLines) &&
                bubble.maxLines >= 3 && bubble.maxLines <= 12) parsed.maxLines = bubble.maxLines;
            else console.warn("Invalid settings.json display.bubble.maxLines: using default");
          }
          settings.display = { ...settings.display, bubble: parsed };
        } else console.warn("Invalid settings.json display.bubble: using defaults");
      }
    } else console.warn("Invalid settings.json display: using defaults");
  }
  if ("lineOverrides" in value) {
    if (typeof value.lineOverrides === "object" && value.lineOverrides !== null && !Array.isArray(value.lineOverrides)) {
      settings.lineOverrides = Object.fromEntries(Object.entries(value.lineOverrides).flatMap(([packId, lines]) => {
        if (!validUserCharacterId(packId)) return [];
        const parsed = parseVoicePack({ version: 1, templates: {}, lines });
        for (const problem of parsed.problems) console.warn(`Invalid settings.json lineOverrides.${packId}: ${problem}`);
        return [[packId, parsed.lines]];
      }));
    } else console.warn("Invalid settings.json lineOverrides: expected an object; ignored");
  }
  if ("lineReactions" in value) {
    if (typeof value.lineReactions === "object" && value.lineReactions !== null && !Array.isArray(value.lineReactions)) {
      settings.lineReactions = Object.fromEntries(Object.entries(value.lineReactions).flatMap(([packId, lines]) => {
        if (!validUserCharacterId(packId)) return [];
        const parsed = parseReactions({ version: 1, kinds: {}, lines });
        for (const problem of parsed.problems) console.warn(`Invalid settings.json lineReactions.${packId}: ${problem}`);
        return [[packId, parsed.reactions.lines ?? {}]];
      }));
    } else console.warn("Invalid settings.json lineReactions: expected an object; ignored");
  }
  if ("characterId" in value) {
    if (validUserCharacterId(value.characterId)) settings.characterId = value.characterId;
    else console.warn("Invalid settings.json characterId: ignored");
  }
  if ("characterBehavior" in value) {
    const raw = value.characterBehavior;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const entries: Array<[string, CharacterBehavior]> = [];
      for (const [id, fields] of Object.entries(raw)) {
        if (entries.length >= 64) break;
        if (!validUserCharacterId(id) || typeof fields !== "object" || fields === null || Array.isArray(fields)) continue;
        const behavior: CharacterBehavior = {};
        for (const field of ["sleepAfterMs", "blinkIntervalMs", "walkIntervalMs", "walkDurationMs", "walkSpeedPxPerSecond", ...MOVEMENT_FIELDS] as const) {
          if (Object.hasOwn(fields, field) && validateBehavior({ [field]: fields[field] }).length === 0) {
            const selected = fields[field];
            if (field === "sleepAfterMs" && typeof selected === "number") behavior.sleepAfterMs = selected;
            if (field === "walkDurationMs" && typeof selected === "number") behavior.walkDurationMs = selected;
            if (field === "walkSpeedPxPerSecond" && typeof selected === "number") behavior.walkSpeedPxPerSecond = selected;
            if (typeof selected === "number" && (MOVEMENT_FIELDS as readonly string[]).includes(field))
              behavior[field as (typeof MOVEMENT_FIELDS)[number]] = selected;
            if (field === "blinkIntervalMs" && Array.isArray(selected)) behavior.blinkIntervalMs = [selected[0], selected[1]];
            if (field === "walkIntervalMs" && Array.isArray(selected)) behavior.walkIntervalMs = [selected[0], selected[1]];
          }
        }
        if (Object.keys(behavior).length > 0) entries.push([id, behavior]);
      }
      settings.characterBehavior = Object.fromEntries(entries);
    } else console.warn("Invalid settings.json characterBehavior: expected an object; ignored");
  }
  if ("doNotDisturb" in value) {
    const result = validateDoNotDisturbConfig(value.doNotDisturb);
    if (result.ok) settings.doNotDisturb = result.value;
    else console.warn(`Invalid settings.json doNotDisturb: ${result.errors.join("; ")}`);
  }
  if ("plugins" in value) {
    const plugins = value.plugins;
    if (typeof plugins === "object" && plugins !== null && !Array.isArray(plugins)) {
      // fromEntries defines own properties, so a plugin id such as "__proto__" cannot reach the prototype.
      settings.plugins = Object.fromEntries(Object.entries(plugins).filter((entry): entry is [string, Record<string, unknown>] => {
        const config = entry[1];
        const valid = typeof config === "object" && config !== null && !Array.isArray(config);
        if (!valid) console.warn(`Invalid settings.json plugins.${entry[0]}: expected an object; ignored`);
        return valid;
      }));
    } else console.warn("Invalid settings.json plugins: expected an object; ignored");
  }
  if ("httpActionAllowlist" in value) {
    const list = value.httpActionAllowlist;
    if (Array.isArray(list) && list.every((id: unknown) => typeof id === "string")) settings.httpActionAllowlist = list;
    else console.warn("Invalid settings.json httpActionAllowlist: expected an array of strings; ignored");
  }
  if ("interactions" in value) {
    const raw = value.interactions;
    if (Array.isArray(raw)) {
      const kept = sanitizeInteractions(raw);
      if (kept.length < raw.length) console.warn(`Invalid settings.json interactions: ${raw.length - kept.length} entries dropped`);
      settings.interactions = kept;
    } else console.warn("Invalid settings.json interactions: expected an array; ignored");
  }
  if ("developerMode" in value) {
    if (typeof value.developerMode === "boolean") settings.developerMode = value.developerMode;
    else console.warn("Invalid settings.json developerMode: expected a boolean; ignored");
  }
  if ("launchAtLogin" in value) {
    if (typeof value.launchAtLogin === "boolean") settings.launchAtLogin = value.launchAtLogin;
    else console.warn("Invalid settings.json launchAtLogin: expected a boolean; ignored");
  }
  if ("terrain" in value) {
    const raw = value.terrain;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const terrain = { enabled: true, excludedApps: [] as string[] };
      if (Object.hasOwn(raw, "enabled")) {
        if ("enabled" in raw && typeof raw.enabled === "boolean") terrain.enabled = raw.enabled;
        else console.warn("Invalid settings.json terrain.enabled: expected a boolean; ignored");
      }
      if (Object.hasOwn(raw, "excludedApps")) {
        const apps = "excludedApps" in raw ? raw.excludedApps : undefined;
        if (Array.isArray(apps)) {
          // Invalid names are dropped one by one so a single bad entry keeps the rest; the list is capped like the editor.
          const kept = apps.filter((name: unknown): name is string => validExcludedNames([name]));
          if (kept.length < apps.length) console.warn(`Invalid settings.json terrain.excludedApps: ${apps.length - kept.length} entries dropped`);
          terrain.excludedApps = dedupeExcludedApps(kept).slice(0, MAX_EXCLUDED_APPS);
        } else console.warn("Invalid settings.json terrain.excludedApps: expected an array; ignored");
      }
      settings.terrain = terrain;
    } else console.warn("Invalid settings.json terrain: expected an object; ignored");
  }
  if ("migrations" in value && typeof value.migrations === "object" && value.migrations !== null && !Array.isArray(value.migrations) &&
      "interactionsToPack" in value.migrations && value.migrations.interactionsToPack === true)
    settings.migrations = { interactionsToPack: true };
  return settings;
}

/** Reads settings.json; a missing file is a normal first run and stays silent. */
export async function loadSettings(path: string): Promise<DeskpetSettings> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return defaultSettings();
    console.warn(`Cannot read settings.json; using defaults (doNotDisturb disabled): ${String(error)}`);
    return defaultSettings();
  }
  try { return parseSettings(JSON.parse(text)); }
  catch {
    console.warn("settings.json is not valid JSON; using defaults (doNotDisturb disabled)");
    return defaultSettings();
  }
}

const KNOWN_KEYS = ["doNotDisturb", "display", "characterId", "characterBehavior", "lineOverrides", "lineReactions", "plugins",
  "httpActionAllowlist", "interactions", "migrations", "developerMode", "terrain", "launchAtLogin"] as const;
const KNOWN_NESTED: Readonly<Record<string, readonly string[]>> = { display: ["badge", "bubble"], terrain: ["enabled", "excludedApps"],
  migrations: ["interactionsToPack"] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * settings.json is hand-editable and parseSettings keeps only the keys it knows, so a save would drop the rest.
 * Read the file again and carry over top-level keys the app does not know, and unknown keys inside the
 * objects it owns (display, terrain, migrations). An unreadable file carries nothing.
 */
function withUnknownKeys(path: string, settings: DeskpetSettings): Record<string, unknown> {
  let existing: unknown;
  try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...settings }; }
  if (!isPlainObject(existing)) return { ...settings };
  const merged: Record<string, unknown> = { ...settings };
  const keep = (target: Record<string, unknown>, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };
  for (const [key, value] of Object.entries(existing)) {
    if ((KNOWN_KEYS as readonly string[]).includes(key)) {
      const nested = KNOWN_NESTED[key];
      const own = merged[key];
      if (nested === undefined || !isPlainObject(value) || !isPlainObject(own)) continue;
      const extra = Object.entries(value).filter(([name]) => !nested.includes(name) && !Object.hasOwn(own, name));
      if (extra.length === 0) continue;
      const copy = { ...own };
      for (const [name, item] of extra) keep(copy, name, item);
      merged[key] = copy;
    } else keep(merged, key, value);
  }
  return merged;
}

/** Atomic save (temporary file then rename), the same way pet-position.json is written. Unknown keys of the current file are kept. */
export function writeSettings(path: string, settings: DeskpetSettings): void {
  if (settings.display?.badge !== undefined && !validBadgePlacement(settings.display.badge))
    throw new Error("Invalid badge placement");
  if (settings.display?.bubble !== undefined && !validBubbleDisplay(settings.display.bubble))
    throw new Error("Invalid bubble display");
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify(withUnknownKeys(path, settings)), "utf8");
  renameSync(temporary, path);
}

function hhmmToMs(value: string): number | undefined {
  const match = hhmmPattern.exec(value);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * MS_PER_MINUTE : undefined;
}

/**
 * Milliseconds from `now` until the schedule can next flip the quiet boolean, or undefined when only
 * the manual switch or a fullscreen app can (nothing to wait for). Every clock reading is injected.
 */
export function msUntilNextQuietChange(config: DoNotDisturbConfig, now: Date): number | undefined {
  if (config.enabled) return undefined;
  const nowMs = ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  let soonest: number | undefined;
  for (const window of config.schedule ?? []) {
    const start = hhmmToMs(window.start);
    const end = hhmmToMs(window.end);
    // Empty or malformed windows never change quiet; isQuietNow ignores them too.
    if (start === undefined || end === undefined || start === end) continue;
    for (const edge of [start, end]) {
      // An edge at or before now has already passed today, so its next occurrence is tomorrow.
      const wait = edge > nowMs ? edge - nowMs : edge + MS_PER_DAY - nowMs;
      if (soonest === undefined || wait < soonest) soonest = wait;
    }
  }
  return soonest;
}
