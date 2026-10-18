import { describe, expect, it, vi } from "vitest";
import { createSettingsInteractionStore, fromPackInteractions, toPackInteractions } from "./interaction-store.js";
import { getDefaultInteractions, mergeInteractions, sanitizeInteractions } from "./pet-menu.js";
import type { PetInteraction } from "./pet-menu.js";
import type { DeskpetSettings } from "./settings.js";

const item: PetInteraction = { id: "wave", label: "손 흔들기", mood: "happy", speak: true, lines: ["안녕!"], builtin: false };

describe("createSettingsInteractionStore", () => {
  it("loads what settings hold (a copy) and saves through the file writer, keeping other fields", async () => {
    let settings: DeskpetSettings = { doNotDisturb: { enabled: true }, interactions: [item] };
    const write = vi.fn();
    const store = createSettingsInteractionStore({ path: "p", get: () => settings, set: (next) => { settings = next; }, write });
    const loaded = await store.load();
    expect(loaded).toEqual([item]);
    (loaded[0] as PetInteraction).lines.push("바뀜");
    expect(settings.interactions?.[0]?.lines).toEqual(["안녕!"]);
    await store.save([{ ...item, label: "인사" }]);
    expect(write).toHaveBeenCalledWith("p", { doNotDisturb: { enabled: true }, interactions: [{ ...item, label: "인사" }] });
    expect(settings.interactions?.[0]?.label).toBe("인사");
    await store.save([]);
    expect("interactions" in settings).toBe(false);
    expect(settings.doNotDisturb).toEqual({ enabled: true });
  });

  it("rejects and keeps the old settings when the write fails", async () => {
    let settings: DeskpetSettings = { doNotDisturb: { enabled: false }, interactions: [item] };
    const store = createSettingsInteractionStore({ path: "p", get: () => settings, set: (next) => { settings = next; },
      write: () => { throw new Error("disk full"); } });
    await expect(store.save([])).rejects.toThrow("disk full");
    expect(settings.interactions).toEqual([item]);
  });
});

describe("pack interaction conversion", () => {
  it("round trips overrides, additions, hidden defaults and bubble choices", () => {
    const base = getDefaultInteractions().find(({ id }) => id === "pat");
    if (!base) throw new Error("pat default missing");
    const stored = [
      { ...base, lines: ["edited"], hidden: true, play: "surprised", sequence: "greeting" },
      { ...item, speak: false, lines: [], hidden: true, play: "bow" },
    ];
    const pack = toPackInteractions(stored);
    expect(pack.items.map(({ id, bubble }) => ({ id, bubble }))).toEqual([
      { id: "pat", bubble: true }, { id: "wave", bubble: false },
    ]);
    expect(pack.hidden).toEqual(["pat", "wave"]);
    expect(pack.items).toMatchObject([{ play: "surprised", sequence: "greeting" }, { play: "bow" }]);
    expect(fromPackInteractions(pack)).toEqual(stored.map((entry) => ({ ...entry, builtin: false })));
    expect(mergeInteractions(getDefaultInteractions(), fromPackInteractions({ items: [], hidden: ["talk"] }))
      .find(({ id }) => id === "talk")?.hidden).toBe(true);
  });

  it("keeps the menu order of a migrated partial settings list", () => {
    const sanitized = sanitizeInteractions([{ ...getDefaultInteractions()[0], hidden: true }, item]);
    const stored = fromPackInteractions(toPackInteractions(sanitized));
    expect(mergeInteractions(getDefaultInteractions(), stored).filter(({ hidden }) => !hidden).map(({ label }) => label))
      .toEqual([getDefaultInteractions()[1]?.label, getDefaultInteractions()[2]?.label, "손 흔들기"]);
  });
});
