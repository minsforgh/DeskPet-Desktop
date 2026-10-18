import type { DoNotDisturbConfig } from "@deskpet/core";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_BADGE_PLACEMENT, DEFAULT_BUBBLE_DISPLAY, loadSettings, msUntilNextQuietChange, parseSettings, writeSettings } from "./settings.js";

let tempDir: string;

beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-settings-")); });
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseSettings", () => {
  test("bubble display defaults silently and parses valid boundaries independently of badge", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings({}).display?.bubble ?? DEFAULT_BUBBLE_DISPLAY).toEqual({ maxWidthDip: 280, maxLines: 4 });
    expect(parseSettings({ display: { bubble: {} } }).display?.bubble).toEqual(DEFAULT_BUBBLE_DISPLAY);
    expect(parseSettings({ display: { bubble: { maxWidthDip: 180, maxLines: 3 }, badge: { side: "left", gap: 4 } } }).display)
      .toEqual({ bubble: { maxWidthDip: 180, maxLines: 3 }, badge: { side: "left", gap: 4 } });
    expect(parseSettings({ display: { bubble: { maxWidthDip: 600, maxLines: 12 } } }).display?.bubble)
      .toEqual({ maxWidthDip: 600, maxLines: 12 });
    expect(warn).not.toHaveBeenCalled();
  });

  test("invalid bubble fields warn and each falls back alone; saving rejects invalid values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of [179, 601, 280.5, "280", null]) {
      expect(parseSettings({ display: { bubble: { maxWidthDip: value, maxLines: 6 } } }).display?.bubble)
        .toEqual({ maxWidthDip: 280, maxLines: 6 });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
    }
    for (const value of [2, 13, 4.5, "4", null]) {
      expect(parseSettings({ display: { bubble: { maxWidthDip: 400, maxLines: value } } }).display?.bubble)
        .toEqual({ maxWidthDip: 400, maxLines: 4 });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
    }
    expect(() => writeSettings(join(tempDir, "settings.json"), { doNotDisturb: { enabled: false },
      display: { bubble: { maxWidthDip: 400, maxLines: 13 } } })).toThrow("Invalid bubble display");
  });
  test("badge placement defaults silently and keeps valid side and gap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings({}).display?.badge ?? DEFAULT_BADGE_PLACEMENT).toEqual({ side: "above", gap: 3 });
    expect(parseSettings({ display: {} }).display?.badge ?? DEFAULT_BADGE_PLACEMENT).toEqual(DEFAULT_BADGE_PLACEMENT);
    expect(parseSettings({ display: { badge: { side: "left", gap: 0 } } }).display?.badge).toEqual({ side: "left", gap: 0 });
    expect(parseSettings({ display: { badge: { side: "right", gap: 40 } } }).display?.badge).toEqual({ side: "right", gap: 40 });
    expect(warn).not.toHaveBeenCalled();
  });

  test("invalid badge placement warns once and is never written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const badge of [{ side: "below", gap: 3 }, { side: "left", gap: -1 }, { side: "right", gap: 41 },
      { side: "above", gap: 1.5 }, { side: "above", gap: "3" }, { side: "above" }, null]) {
      expect(parseSettings({ display: { badge } }).display?.badge ?? DEFAULT_BADGE_PLACEMENT).toEqual(DEFAULT_BADGE_PLACEMENT);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
    }
    expect(() => writeSettings(join(tempDir, "settings.json"), { doNotDisturb: { enabled: false },
      display: { badge: { side: "left", gap: -1 } } })).toThrow("Invalid badge placement");
  });
  test("old settings keep empty line maps and stored unknown line ids survive parsing", () => {
    expect(parseSettings({}).lineOverrides ?? {}).toEqual({});
    expect(parseSettings({}).lineReactions ?? {}).toEqual({});
    const parsed = parseSettings({ lineOverrides: { "wolf-maid": { "fixture.unknown": ["Hello"] } },
      lineReactions: { "wolf-maid": { "fixture.unknown": { play: "happy" } } } });
    expect(parsed.lineOverrides?.["wolf-maid"]?.["fixture.unknown"]).toEqual(["Hello"]);
    expect(parsed.lineReactions?.["wolf-maid"]?.["fixture.unknown"]).toEqual({ play: "happy" });
  });
  test("keeps valid character behavior fields and drops invalid values and ids", () => {
    const stored = JSON.parse('{"wolf-maid":{"sleepAfterMs":5000,"walkSpeedPxPerSecond":45,"walkIntervalMs":[999,6000],"blinkIntervalMs":[2000,4000]},"__proto__":{"sleepAfterMs":5000},"../bad":{"sleepAfterMs":5000},"mochi":{"walkDurationMs":null}}');
    const behavior = parseSettings({ characterBehavior: stored }).characterBehavior;
    expect(behavior).toEqual({ "wolf-maid": { sleepAfterMs: 5000, walkSpeedPxPerSecond: 45,
      blinkIntervalMs: [2000, 4000] } });
    expect(Object.prototype).not.toHaveProperty("sleepAfterMs");
    expect(parseSettings({}).characterBehavior).toBeUndefined();
  });

  test("limits character behavior to 64 valid packs", () => {
    const stored = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`pack-${index}`, { sleepAfterMs: 6000 }]));
    expect(Object.keys(parseSettings({ characterBehavior: stored }).characterBehavior ?? {})).toHaveLength(64);
  });

  test("keeps a safe character id and warns when the stored id is invalid", () => {
    expect(parseSettings({ characterId: "wolf-maid" }).characterId).toBe("wolf-maid");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const characterId of ["../wolf-maid", "__proto__", "x".repeat(49), 1]) {
      expect(parseSettings({ characterId }).characterId).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });
  test("accepts a valid doNotDisturb config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] };
    expect(parseSettings({ doNotDisturb: config })).toEqual({ doNotDisturb: config });
    expect(parseSettings({ doNotDisturb: { enabled: true } })).toEqual({ doNotDisturb: { enabled: true } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("treats an absent doNotDisturb as a silent first-run default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings({})).toEqual({ doNotDisturb: { enabled: false } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("falls back to the default and warns exactly once for each invalid value", () => {
    for (const value of [
      null,
      "nope",
      { doNotDisturb: "on" },
      { doNotDisturb: { enabled: 1 } },
      { doNotDisturb: { enabled: false, schedule: [{ start: "24:00", end: "07:00" }] } },
      { doNotDisturb: { enabled: false, schedule: [{ start: "09:00" }] } },
    ]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(parseSettings(value)).toEqual({ doNotDisturb: { enabled: false } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("settings.json"));
      warn.mockRestore();
    }
  });
});

describe("loadSettings and writeSettings", () => {
  test("loading invalid bubble fields preserves the file while applying per-key defaults", async () => {
    const path = join(tempDir, "settings.json");
    const raw = JSON.stringify({ display: { badge: { side: "right", gap: 7 }, bubble: { maxWidthDip: 700, maxLines: 6 } } });
    await writeFile(path, raw, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadSettings(path)).display).toEqual({ badge: { side: "right", gap: 7 }, bubble: { maxWidthDip: 280, maxLines: 6 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await readFile(path, "utf8")).toBe(raw);
  });
  test("a missing file is a silent default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadSettings(join(tempDir, "settings.json"))).toEqual({ doNotDisturb: { enabled: false } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("writes atomically and reads the same config back without leftover temporary files", async () => {
    const path = join(tempDir, "settings.json");
    const settings = { doNotDisturb: { enabled: true, schedule: [{ start: "22:00", end: "07:00" }] } };
    writeSettings(path, settings);
    expect(await loadSettings(path)).toEqual(settings);
    expect(await readdir(tempDir)).toEqual(["settings.json"]);

    // A toggle overwrites the previous value the same way.
    writeSettings(path, { doNotDisturb: { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] } });
    expect(await loadSettings(path)).toEqual({ doNotDisturb: { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] } });
    expect(await readdir(tempDir)).toEqual(["settings.json"]);
  });

  test("corrupt or invalid file contents warn once and fall back to the default", async () => {
    const path = join(tempDir, "settings.json");
    await writeFile(path, "not json {", "utf8");
    const corruptWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadSettings(path)).toEqual({ doNotDisturb: { enabled: false } });
    expect(corruptWarn).toHaveBeenCalledTimes(1);
    corruptWarn.mockRestore();

    await writeFile(path, JSON.stringify({ doNotDisturb: { enabled: "yes" } }), "utf8");
    const invalidWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadSettings(path)).toEqual({ doNotDisturb: { enabled: false } });
    expect(invalidWarn).toHaveBeenCalledTimes(1);
  });
});

describe("msUntilNextQuietChange", () => {
  const day: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "09:00", end: "17:00" }] };
  const night: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] };
  const at = (hour: number, minute = 0, second = 0, ms = 0): Date => new Date(2026, 0, 1, hour, minute, second, ms);

  test("has nothing to wait for without a working schedule", () => {
    expect(msUntilNextQuietChange({ enabled: true, schedule: [{ start: "09:00", end: "17:00" }] }, at(12))).toBeUndefined();
    expect(msUntilNextQuietChange({ enabled: false }, at(12))).toBeUndefined();
    expect(msUntilNextQuietChange({ enabled: false, schedule: [] }, at(12))).toBeUndefined();
    expect(msUntilNextQuietChange({ enabled: false, schedule: [{ start: "09:00", end: "09:00" }] }, at(12))).toBeUndefined();
  });

  test("accepts 24-hour HH:MM edges and ignores malformed values", () => {
    expect(msUntilNextQuietChange({ enabled: false, schedule: [{ start: "23:59", end: "00:00" }] }, at(23, 58)))
      .toBe(60_000);
    for (const invalid of ["24:00", "23:60", "9:00", "00:0", "08:00Z"]) {
      expect(msUntilNextQuietChange({ enabled: false, schedule: [{ start: invalid, end: "09:00" }] }, at(8)))
        .toBeUndefined();
    }
  });

  test("counts down to the next window start or end inside one day", () => {
    expect(msUntilNextQuietChange(day, at(8, 59, 0, 500))).toBe(59_500);
    expect(msUntilNextQuietChange(day, at(9, 0))).toBe(8 * 3_600_000);
    expect(msUntilNextQuietChange(day, at(12, 30))).toBe(4.5 * 3_600_000);
    expect(msUntilNextQuietChange(day, at(16, 59, 0, 500))).toBe(59_500);
    expect(msUntilNextQuietChange(day, at(17, 0))).toBe(16 * 3_600_000);
    expect(msUntilNextQuietChange(day, at(23, 0))).toBe(10 * 3_600_000);
  });

  test("counts down across midnight for a wrapping window", () => {
    expect(msUntilNextQuietChange(night, at(21, 59))).toBe(60_000);
    expect(msUntilNextQuietChange(night, at(23, 0))).toBe(8 * 3_600_000);
    expect(msUntilNextQuietChange(night, at(3, 0))).toBe(4 * 3_600_000);
    expect(msUntilNextQuietChange(night, at(7, 0))).toBe(15 * 3_600_000);
    expect(msUntilNextQuietChange(night, at(12, 0))).toBe(10 * 3_600_000);
  });

  test("uses the soonest edge across several windows", () => {
    const both: DoNotDisturbConfig = {
      enabled: false,
      schedule: [{ start: "09:00", end: "17:00" }, { start: "20:00", end: "21:00" }],
    };
    expect(msUntilNextQuietChange(both, at(18, 0))).toBe(2 * 3_600_000);
    expect(msUntilNextQuietChange(both, at(6, 0))).toBe(3 * 3_600_000);
  });
});

describe("plugin settings and the HTTP action allowlist", () => {
  test("keeps the settings of plugins it does not know, through a write and a read", async () => {
    const path = join(tempDir, "settings.json");
    const settings = parseSettings({
      doNotDisturb: { enabled: false },
      plugins: { reminders: { rules: [{ id: "a", time: "09:00", text: "t" }] }, weather: { city: "Seoul", nested: { n: [1, 2] } } },
      httpActionAllowlist: ["weather.refresh"],
    });
    expect(settings.plugins).toEqual({
      reminders: { rules: [{ id: "a", time: "09:00", text: "t" }] }, weather: { city: "Seoul", nested: { n: [1, 2] } } });
    writeSettings(path, settings);
    expect(await loadSettings(path)).toEqual(settings);
  });

  test("does not validate plugin contents, because each plugin validates its own", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings({ plugins: { reminders: { rules: "not-an-array" } } }).plugins)
      .toEqual({ reminders: { rules: "not-an-array" } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("drops a plugin entry that is not an object and warns once for it", () => {
    for (const value of [{ plugins: { a: [] } }, { plugins: { a: null } }, { plugins: { a: "x" } }, { plugins: [] }, { plugins: "x" }]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(parseSettings(value).plugins ?? {}).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });

  test("a plugin id of __proto__ stays an own entry and does not change the prototype", () => {
    const settings = parseSettings(JSON.parse(`{"plugins":{"__proto__":{"polluted":true},"ok":{}}}`) as unknown);
    expect(Object.keys(settings.plugins ?? {})).toEqual(["__proto__", "ok"]);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
    expect(Object.getPrototypeOf(settings.plugins)).toBe(Object.prototype);
  });

  test("accepts a string list for httpActionAllowlist and rejects everything else with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings({ httpActionAllowlist: [] }).httpActionAllowlist).toEqual([]);
    expect(parseSettings({ httpActionAllowlist: ["a.b"] }).httpActionAllowlist).toEqual(["a.b"]);
    expect(warn).not.toHaveBeenCalled();
    for (const bad of ["a.b", [1], [null], { a: 1 }]) {
      warn.mockClear();
      expect(parseSettings({ httpActionAllowlist: bad }).httpActionAllowlist).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});

describe("interactions", () => {
  const mine = { id: "pat", label: "쓰다듬기", mood: "happy" as const, speak: true, lines: ["내가 쓴 대사"], builtin: true };

  test("an existing settings.json without the field reads as before", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings = parseSettings({ doNotDisturb: { enabled: true }, plugins: {} });
    expect("interactions" in settings).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps valid entries, drops invalid ones and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings = parseSettings({ interactions: [mine, { id: "BAD" }, { ...mine, id: "x", lines: ["가".repeat(121)] }] });
    expect(settings.interactions).toEqual([{ ...mine, builtin: false }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(parseSettings({ interactions: "no" }).interactions).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("survives a write and a load, and leaves the other fields alone", async () => {
    const path = join(tempDir, "settings.json");
    writeSettings(path, { doNotDisturb: { enabled: true }, plugins: { a: { x: 1 } }, interactions: [{ ...mine, builtin: false }] });
    expect(await loadSettings(path)).toEqual({ doNotDisturb: { enabled: true }, plugins: { a: { x: 1 } }, interactions: [{ ...mine, builtin: false }] });
  });

  test("a save keeps top-level and nested keys the app does not know, and still removes known keys it dropped", async () => {
    const path = join(tempDir, "settings.json");
    await writeFile(path, JSON.stringify({ doNotDisturb: { enabled: false }, futureFeature: { on: true }, display: { badge: { side: "left", gap: 5 }, theme: "x" },
      terrain: { enabled: false, excludedApps: [], note: 1 }, characterId: "wolf-maid" }), "utf8");
    const loaded = await loadSettings(path);
    const rest = { ...loaded };
    delete rest.characterId;
    writeSettings(path, { ...rest, doNotDisturb: { enabled: true } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ doNotDisturb: { enabled: true }, futureFeature: { on: true },
      display: { badge: { side: "left", gap: 5 }, theme: "x" }, terrain: { enabled: false, excludedApps: [], note: 1 } });
  });

  test("a save over an unreadable file writes only the given settings", async () => {
    const path = join(tempDir, "settings.json");
    await writeFile(path, "not json {", "utf8");
    writeSettings(path, { doNotDisturb: { enabled: true } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ doNotDisturb: { enabled: true } });
  });

  test("preserves only the completed interactions migration marker", async () => {
    const path = join(tempDir, "settings.json");
    const settings = parseSettings({ migrations: { interactionsToPack: true, ignored: true } });
    expect(settings.migrations).toEqual({ interactionsToPack: true });
    writeSettings(path, settings);
    expect((await loadSettings(path)).migrations).toEqual({ interactionsToPack: true });
    expect(parseSettings({ migrations: { interactionsToPack: false } }).migrations).toBeUndefined();
  });
});

describe("developerMode setting", () => {
  test("defaults to unset and keeps only a boolean", () => {
    expect(parseSettings({}).developerMode).toBeUndefined();
    expect(parseSettings({ developerMode: true }).developerMode).toBe(true);
    expect(parseSettings({ developerMode: false }).developerMode).toBe(false);
    for (const bad of ["yes", 1, null, {}]) expect(parseSettings({ developerMode: bad }).developerMode).toBeUndefined();
  });
});

describe("launchAtLogin setting", () => {
  test("defaults to unset (first run not yet applied) and keeps only a boolean", () => {
    expect(parseSettings({}).launchAtLogin).toBeUndefined();
    expect(parseSettings({ launchAtLogin: true }).launchAtLogin).toBe(true);
    expect(parseSettings({ launchAtLogin: false }).launchAtLogin).toBe(false);
    for (const bad of ["yes", 1, null, {}]) expect(parseSettings({ launchAtLogin: bad }).launchAtLogin).toBeUndefined();
  });
});

describe("terrain setting", () => {
  test("is unset in an old settings.json so the feature stays on", () => {
    expect(parseSettings({ doNotDisturb: { enabled: false } }).terrain).toBeUndefined();
  });

  test("keeps a boolean enabled flag, defaulting to on, and valid names without case-insensitive duplicates", () => {
    expect(parseSettings({ terrain: {} }).terrain).toEqual({ enabled: true, excludedApps: [] });
    expect(parseSettings({ terrain: { enabled: false, excludedApps: ["chrome.exe", "Code.exe", "CHROME.EXE"] } }).terrain)
      .toEqual({ enabled: false, excludedApps: ["chrome.exe", "Code.exe"] });
    for (const bad of ["no", 0, null]) expect(parseSettings({ terrain: { enabled: bad } }).terrain?.enabled).toBe(true);
  });

  test("drops invalid names one by one and ignores a list that is not an array", () => {
    const names = ["ok.exe", "a/b.exe", "", "x".repeat(65), "x".repeat(64), "한글.exe", 5, null, "with space.exe", "a\nb.exe"];
    expect(parseSettings({ terrain: { excludedApps: names } }).terrain?.excludedApps)
      .toEqual(["ok.exe", "x".repeat(64), "with space.exe"]);
    expect(parseSettings({ terrain: { excludedApps: "chrome.exe" } }).terrain?.excludedApps).toEqual([]);
  });

  test("keeps at most 64 names", () => {
    const names = Array.from({ length: 70 }, (_, index) => `app${index}.exe`);
    expect(parseSettings({ terrain: { excludedApps: names } }).terrain?.excludedApps).toEqual(names.slice(0, 64));
  });

  test("ignores a terrain value that is not an object", () => {
    for (const bad of ["x", 1, [], null]) expect(parseSettings({ terrain: bad }).terrain).toBeUndefined();
  });

  test("keeps the chances in characterBehavior and drops out-of-range ones", () => {
    expect(parseSettings({ characterBehavior: { mochi: { climbChance: 0, descendChance: 1 } } }).characterBehavior)
      .toEqual({ mochi: { climbChance: 0, descendChance: 1 } });
    expect(parseSettings({ characterBehavior: { mochi: { climbChance: 1.1, descendChance: -0.1 } } }).characterBehavior)
      .toEqual({});
  });
});
