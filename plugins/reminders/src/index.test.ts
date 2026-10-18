import { readFileSync } from "node:fs";
import { parseLines, renderLine } from "@deskpet/core";
import { describe, expect, it } from "vitest";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import type { PluginContext } from "@deskpet/plugin-sdk/v2";
import plugin from "./index.js";

const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "reminders");

async function activatedContext(rules: unknown) {
  const test = createTestContext({ config: { rules } });
  await plugin.activate(test.ctx as unknown as PluginContext);
  return test;
}

describe("reminders plugin", () => {
  it("declares rules items as an object with id, time, text and priority", () => {
    const items = plugin.configSchema?.properties.rules?.items;
    expect(items).toMatchObject({ type: "object", required: ["id", "time", "text"] });
    expect(items?.type === "object" ? Object.keys(items.properties) : []).toEqual(["id", "time", "days", "text", "priority"]);
  });

  it("declares days as a number array limited to 0 through 6", () => {
    const items = plugin.configSchema?.properties.rules?.items;
    expect(items?.type === "object" ? items.properties.days : undefined)
      .toEqual({ type: "array", title: "요일", items: { type: "number" }, enum: [0, 1, 2, 3, 4, 5, 6] });
  });

  it("tells the user the time is 24-hour with a worked example", () => {
    const items = plugin.configSchema?.properties.rules?.items;
    const time = items?.type === "object" ? items.properties.time : undefined;
    const shown = `${time?.title ?? ""} ${time?.description ?? ""}`;
    expect(shown).toContain("24시간제");
    // The evening example must render: 11 PM written as 23:00.
    expect(shown).toContain("23:00");
    // A 12-hour-looking value must not be suggested as valid.
    expect(shown).not.toContain("11:28 PM");
  });

  it("registers a daily rule as a cron schedule and emits notify when it fires", async () => {
    const test = await activatedContext([{ id: "lunch", time: "12:20", text: "점심" }]);
    expect(test.schedules.at).toHaveLength(1);
    expect(test.schedules.at[0]?.cron).toBe("20 12 * * *");
    await test.runAt(0);
    expect(test.events).toEqual([{ source: "reminders", type: "notify", key: "lunch",
      line: { id: "reminders.rule", vars: { message: "점심" } } }]);
    expect(parsed.problems).toEqual([]);
    expect(renderLine(parsed.catalog, "reminders.rule", { message: "점심" })).toBe("점심");
  });

  it("maps selected weekdays and priority onto the cron string and the event", async () => {
    const test = await activatedContext([{ id: "plan", time: "09:05", days: [1, 3, 6], text: "계획", priority: "high" }]);
    expect(test.schedules.at[0]?.cron).toBe("05 09 * * 1,3,6");
    await test.runAt(0);
    expect(test.events).toEqual([{ source: "reminders", type: "notify", key: "plan", priority: "high",
      line: { id: "reminders.rule", vars: { message: "계획" } } }]);
  });

  it("keeps fallback text when a rule contains characters forbidden in voice slots", async () => {
    const test = await activatedContext([{ id: "multiline", time: "12:20", text: "첫 줄\n둘째 줄" }]);
    await test.runAt(0);
    expect(test.events).toEqual([{ source: "reminders", type: "notify", key: "multiline",
      line: { id: "reminders.rule", vars: { message: "첫 줄 둘째 줄" } } }]);
  });

  it("skips invalid and duplicate rules with a warning and keeps the valid ones", async () => {
    const test = await activatedContext([
      { id: "bad-time", time: "9:00", text: "no" },
      { id: "good", time: "08:00", text: "yes" },
      { id: "dup", time: "07:00", text: "first" },
      { id: "dup", time: "07:30", text: "second" },
    ]);
    expect(test.schedules.at.map((entry) => entry.cron)).toEqual(["00 08 * * *", "00 07 * * *"]);
    const warnings = test.logs.filter((log) => log.level === "warn").map((log) => log.message);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("rules[0]");
    expect(warnings[0]).toContain("time");
    expect(warnings[1]).toContain("dup");
    await test.runAt(0);
    await test.runAt(1);
    expect(test.events).toEqual([
      { source: "reminders", type: "notify", key: "good",
        line: { id: "reminders.rule", vars: { message: "yes" } } },
      { source: "reminders", type: "notify", key: "dup",
        line: { id: "reminders.rule", vars: { message: "first" } } },
    ]);
  });

  it("warns and registers nothing when rules is not an array", async () => {
    const test = await activatedContext("nope");
    expect(test.schedules.at).toEqual([]);
    expect(test.logs.filter((log) => log.level === "warn")).toHaveLength(1);
  });

  it("disposes previous schedules and re-registers on config change", async () => {
    const test = await activatedContext([{ id: "lunch", time: "12:20", text: "점심" }]);
    test.changeConfig({ rules: [{ id: "dinner", time: "19:00", text: "저녁" }] });
    expect(test.schedules.at.map((entry) => entry.cron)).toEqual(["00 19 * * *"]);
    await test.runAt(0);
    expect(test.events).toEqual([{ source: "reminders", type: "notify", key: "dinner",
      line: { id: "reminders.rule", vars: { message: "저녁" } } }]);
  });

  it("clears schedules and the config listener on deactivate", async () => {
    const test = await activatedContext([{ id: "lunch", time: "12:20", text: "점심" }]);
    await plugin.deactivate?.();
    expect(test.schedules).toEqual({ every: [], at: [], onResume: [] });
    await expect(test.runAt()).rejects.toThrow("not registered");
    test.changeConfig({ rules: [{ id: "dinner", time: "19:00", text: "저녁" }] });
    expect(test.schedules.at).toEqual([]);
  });
});
