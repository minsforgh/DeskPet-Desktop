import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePetEvent } from "@deskpet/core";
import { validatePluginManifest } from "@deskpet/plugin-sdk";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import plugin from "./index.js";
import manifest from "../manifest.json" with { type: "json" };

function setup(config: Record<string, unknown> = {}) {
  const test = createTestContext({ manifest: { permissions: manifest.permissions, contributes: manifest.contributes }, config });
  plugin.activate(test.ctx);
  return test;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("water plugin", () => {
  it("has a valid manifest", () => {
    expect(validatePluginManifest(manifest)).toMatchObject({ ok: true });
  });

  it("schedules from the configured interval and falls back to 60 minutes", () => {
    expect(setup({ intervalMinutes: 30 }).schedules.every.map((e) => e.ms)).toEqual([30 * 60_000]);
    expect(setup({}).schedules.every.map((e) => e.ms)).toEqual([60 * 60_000]);
    expect(setup({ intervalMinutes: 0 }).schedules.every.map((e) => e.ms)).toEqual([60 * 60_000]);
  });

  it("emits a valid reminder with a single button when the timer fires", async () => {
    const test = setup();
    await test.runEvery();
    expect(test.events).toHaveLength(1);
    expect(validatePetEvent(test.events[0]).ok).toBe(true);
    expect(test.events[0]).toMatchObject({ source: "water", type: "notify", text: "물 한 잔 어때요?" });
    expect(test.events[0]?.actions).toEqual([{ label: "마셨어", action: "water.drank" }]);
  });

  it("counts a drink and reacts happily", async () => {
    const test = setup({ dailyGoal: 8 });
    await test.runAction("water.drank");
    expect(test.events).toHaveLength(1);
    expect(validatePetEvent(test.events[0]).ok).toBe(true);
    expect(test.events[0]).toMatchObject({ type: "react", mood: "happy" });
    await test.runAction("water.today");
    expect(test.events.at(-1)?.text).toBe("오늘 1잔 마셨어요 (목표 8잔)");
  });

  it("celebrates once when the goal is reached", async () => {
    const test = setup({ dailyGoal: 2 });
    await test.runAction("water.drank");
    expect(test.events.filter((e) => e.type === "notify")).toHaveLength(0);
    await test.runAction("water.drank");
    await test.runAction("water.drank");
    const cheers = test.events.filter((e) => e.type === "notify");
    expect(cheers).toHaveLength(1);
    expect(validatePetEvent(cheers[0]).ok).toBe(true);
    expect(cheers[0]?.text).toContain("목표 2잔 달성");
  });

  it("applies interval and goal changes", async () => {
    const test = setup({ intervalMinutes: 60, dailyGoal: 3 });
    test.changeConfig({ intervalMinutes: 15, dailyGoal: 1 });
    expect(test.schedules.every.map((e) => e.ms)).toEqual([15 * 60_000]);
    await test.runAction("water.drank");
    expect(test.events.at(-1)?.text).toContain("목표 1잔 달성");
  });

  it("keeps the timer when only the goal changes", () => {
    const test = setup();
    test.changeConfig({ intervalMinutes: 60, dailyGoal: 4 });
    expect(test.schedules.every).toHaveLength(1);
  });

  it("shows the count from the tray item and resets on a new day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    const test = setup();
    expect(test.trayItems.get("water.tray-today")).toMatchObject({ label: "오늘 마신 물", action: "water.today" });
    await test.runAction("water.drank");
    vi.setSystemTime(new Date(2026, 9, 11, 9));
    await test.runAction("water.today");
    expect(test.events.at(-1)?.text).toBe("오늘 0잔 마셨어요 (목표 8잔)");
  });
});
