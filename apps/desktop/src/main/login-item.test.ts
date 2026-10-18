import { describe, expect, test, vi } from "vitest";
import { LOGIN_ITEM_NAME, applyFirstRunDefault, createFakeLoginItemApi, createLoginItem, saveLaunchAtLogin, shouldEnableOnFirstRun } from "./login-item.js";
import type { DeskpetSettings } from "./settings.js";

const base: DeskpetSettings = { doNotDisturb: { enabled: false } };
const installed = { packaged: true, defaultUserData: true };

describe("createLoginItem", () => {
  test("passes the fixed value name and no args, and reads the state back", () => {
    const api = createFakeLoginItemApi();
    const item = createLoginItem(api);
    expect(item.view()).toEqual({ available: true, enabled: false });
    expect(item.set(true)).toBe(true);
    expect(api.calls).toEqual([{ openAtLogin: true, name: LOGIN_ITEM_NAME }]);
    expect(item.view()).toEqual({ available: true, enabled: true });
  });

  test("without an api nothing is available and nothing is written", () => {
    const item = createLoginItem(undefined);
    expect(item.view()).toEqual({ available: false, enabled: false });
    expect(item.set(true)).toBe(false);
  });

  test("an api that throws is a refusal, not a crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const item = createLoginItem({ getLoginItemSettings: () => { throw new Error("x"); }, setLoginItemSettings: () => { throw new Error("x"); } });
    expect(item.set(true)).toBe(false);
    expect(item.view()).toEqual({ available: true, enabled: false });
  });
});

describe("first run default", () => {
  test("turns on only for an installed build, default userData and no stored key", () => {
    expect(shouldEnableOnFirstRun({ ...installed, stored: undefined })).toBe(true);
    expect(shouldEnableOnFirstRun({ packaged: false, defaultUserData: true, stored: undefined })).toBe(false);
    expect(shouldEnableOnFirstRun({ packaged: true, defaultUserData: false, stored: undefined })).toBe(false);
  });

  test("turns the item on once and records it", () => {
    const api = createFakeLoginItemApi();
    const save = vi.fn();
    const result = applyFirstRunDefault({ ...installed, settings: base, item: createLoginItem(api), save });
    expect(result.enabled).toBe(true);
    expect(result.settings.launchAtLogin).toBe(true);
    expect(save).toHaveBeenCalledWith({ ...base, launchAtLogin: true });
    expect(api.calls).toHaveLength(1);
  });

  test("does not turn it on again after the user turned it off", () => {
    const api = createFakeLoginItemApi();
    const save = vi.fn();
    const result = applyFirstRunDefault({ ...installed, settings: { ...base, launchAtLogin: false }, item: createLoginItem(api), save });
    expect(result).toEqual({ settings: { ...base, launchAtLogin: false }, enabled: false });
    expect(api.calls).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  test("a second start after the first run does nothing", () => {
    const api = createFakeLoginItemApi();
    const first = applyFirstRunDefault({ ...installed, settings: base, item: createLoginItem(api), save: () => {} });
    const second = applyFirstRunDefault({ ...installed, settings: first.settings, item: createLoginItem(api), save: () => {} });
    expect(second.enabled).toBe(false);
    expect(api.calls).toHaveLength(1);
  });

  test("a development run never writes the item", () => {
    const api = createFakeLoginItemApi();
    const result = applyFirstRunDefault({ packaged: false, defaultUserData: true, settings: base, item: createLoginItem(api), save: () => {} });
    expect(result.enabled).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  test("when the record cannot be saved the item is put back so the next start retries", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = createFakeLoginItemApi();
    const result = applyFirstRunDefault({ ...installed, settings: base, item: createLoginItem(api),
      save: () => { throw new Error("disk"); } });
    expect(result).toEqual({ settings: base, enabled: false });
    expect(api.calls.map((call) => call.openAtLogin)).toEqual([true, false]);
  });
});

describe("saveLaunchAtLogin", () => {
  test("applies the item then records the choice", () => {
    const api = createFakeLoginItemApi();
    const save = vi.fn();
    const next = saveLaunchAtLogin({ enabled: true, settings: base, item: createLoginItem(api), save });
    expect(next).toEqual({ ...base, launchAtLogin: true });
    expect(api.calls).toEqual([{ openAtLogin: true, name: "DeskPet" }]);
    expect(save).toHaveBeenCalledWith({ ...base, launchAtLogin: true });
  });

  test("turning it off is recorded so a later start does not turn it on again", () => {
    const api = createFakeLoginItemApi();
    const item = createLoginItem(api);
    const on = saveLaunchAtLogin({ enabled: true, settings: base, item, save: () => {} });
    const off = saveLaunchAtLogin({ enabled: false, settings: on ?? base, item, save: () => {} });
    expect(off?.launchAtLogin).toBe(false);
    expect(shouldEnableOnFirstRun({ ...installed, stored: off?.launchAtLogin })).toBe(false);
  });

  test("refuses when unavailable and restores the item when the record fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(saveLaunchAtLogin({ enabled: true, settings: base, item: createLoginItem(undefined), save: () => {} })).toBeUndefined();
    const api = createFakeLoginItemApi();
    const result = saveLaunchAtLogin({ enabled: true, settings: base, item: createLoginItem(api), save: () => { throw new Error("disk"); } });
    expect(result).toBeUndefined();
    expect(api.calls.map((call) => call.openAtLogin)).toEqual([true, false]);
  });
});
