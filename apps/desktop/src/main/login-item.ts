import type { DeskpetSettings } from "./settings.js";

/** ADR-0010 §6: the Run value's name is fixed so the uninstaller (build/installer.nsh) knows which one to delete. */
export const LOGIN_ITEM_NAME = "DeskPet";

export interface LoginItemApi {
  getLoginItemSettings(options: { name: string }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; name: string }): void;
}
/** What the settings window shows: `available` is false when no login item may be written (a plain development run). */
export interface LaunchAtLoginView { available: boolean; enabled: boolean }
export interface LoginItem {
  view(): LaunchAtLoginView;
  /** Writes the system login item; false when it could not be changed. */
  set(enabled: boolean): boolean;
}

/** The truth about "is it on" lives in the system item (the user may turn it off in Task Manager), not in settings.json. */
export function createLoginItem(api: LoginItemApi | undefined): LoginItem {
  return {
    view() {
      if (!api) return { available: false, enabled: false };
      try { return { available: true, enabled: api.getLoginItemSettings({ name: LOGIN_ITEM_NAME }).openAtLogin }; }
      catch (error) { console.error("Read login item:", error); return { available: true, enabled: false }; }
    },
    set(enabled) {
      if (!api) return false;
      try { api.setLoginItemSettings({ openAtLogin: enabled, name: LOGIN_ITEM_NAME }); return true; }
      catch (error) { console.error("Write login item:", error); return false; }
    },
  };
}

/** A stand-in for development runs and e2e: remembers the state and every call, and never touches the registry. */
export function createFakeLoginItemApi(): LoginItemApi & { calls: Array<{ openAtLogin: boolean; name: string }> } {
  let openAtLogin = false;
  const calls: Array<{ openAtLogin: boolean; name: string }> = [];
  return {
    calls,
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings(settings) { openAtLogin = settings.openAtLogin; calls.push({ ...settings }); },
  };
}

/**
 * ADR-0010 §6 / question 2: an installed build turns the item on once, when settings.json has no `launchAtLogin`
 * key yet. A key (true or false) means the user's toggle rules from then on. An isolated userData folder (a check run)
 * never turns it on, so it cannot touch the real user's startup items.
 */
export function shouldEnableOnFirstRun(input: { packaged: boolean; defaultUserData: boolean; stored: boolean | undefined }): boolean {
  return input.packaged && input.defaultUserData && input.stored === undefined;
}

/** Runs the first-run default; returns the settings to keep and whether the item was just turned on (so a bubble can say so). */
export function applyFirstRunDefault(input: { packaged: boolean; defaultUserData: boolean; settings: DeskpetSettings;
  item: LoginItem; save(next: DeskpetSettings): void }): { settings: DeskpetSettings; enabled: boolean } {
  const { settings, item } = input;
  if (!shouldEnableOnFirstRun({ packaged: input.packaged, defaultUserData: input.defaultUserData, stored: settings.launchAtLogin }))
    return { settings, enabled: false };
  if (!item.set(true)) return { settings, enabled: false };
  const next = { ...settings, launchAtLogin: true };
  try { input.save(next); }
  catch (error) {
    console.error("Save launchAtLogin:", error);
    item.set(false); // not recorded, so the next start tries again instead of leaving an item the settings do not know about
    return { settings, enabled: false };
  }
  return { settings: next, enabled: true };
}

/** The toggle's save: system item first, then the record; a failed record puts the item back. */
export function saveLaunchAtLogin(input: { enabled: boolean; settings: DeskpetSettings; item: LoginItem;
  save(next: DeskpetSettings): void }): DeskpetSettings | undefined {
  const { item } = input;
  if (!item.view().available) return undefined;
  const before = item.view().enabled;
  if (!item.set(input.enabled)) return undefined;
  const next = { ...input.settings, launchAtLogin: input.enabled };
  try { input.save(next); }
  catch (error) { console.error("Save launchAtLogin:", error); item.set(before); return undefined; }
  return next;
}
