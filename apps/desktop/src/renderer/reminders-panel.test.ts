import { describe, expect, it } from "vitest";
import type { PluginSettingsEntry } from "../main/plugin-host-app.js";
import { createReminderLoadGuard, fromClock, newReminderId, priorityFor, saveOne, toClock } from "./reminders-panel.js";

describe("reminder card values", () => {
  it("converts both noon boundaries and rejects minutes outside 0 through 59", () => {
    expect(toClock("am", 12, 0)).toBe("00:00");
    expect(toClock("pm", 12, 59)).toBe("12:59");
    expect(toClock("pm", 11, 9)).toBe("23:09");
    expect(fromClock("00:00")).toEqual({ period: "am", hour: 12, minute: 0 });
    expect(fromClock("12:59")).toEqual({ period: "pm", hour: 12, minute: 59 });
    for (const minute of [-1, 60, 1.5]) expect(toClock("am", 1, minute)).toBeUndefined();
    for (const hour of [0, 13]) expect(toClock("am", hour, 0)).toBeUndefined();
    for (const value of ["24:00", "09:60", "9:05", "09:5", "12:00x"]) expect(fromClock(value)).toBeUndefined();
  });

  it("saves one card from the last saved list without another card's draft", () => {
    const saved = [{ key: 1, value: { id: "one", text: "saved one" } }, { key: 2, value: { id: "two", text: "saved two" } }];
    const otherDraft = { id: "two", text: "unsaved edit" };
    expect(saveOne(saved, 1, { id: "one", text: "new one" })).toEqual([
      { id: "one", text: "new one" }, { id: "two", text: "saved two" },
    ]);
    expect(saveOne(saved, undefined, { id: "three" })).toEqual([...saved.map(({ value }) => value), { id: "three" }]);
    expect(saved[1]?.value).not.toEqual(otherDraft);
  });

  it("keeps legacy priorities until the checkbox changes and avoids new id collisions", () => {
    expect(priorityFor("low", false, false)).toBe("low");
    expect(priorityFor("high", false, false)).toBe("high");
    expect(priorityFor("high", true, false)).toBeUndefined();
    expect(priorityFor("low", true, true)).toBe("urgent");
    expect(newReminderId(36, new Set(["r-10", "r-10-1"]))).toBe("r-10-2");
  });
});

it("ignores an older load response and a response arriving after editing starts", async () => {
  const applied: string[] = [];
  let dirty = false;
  const guard = createReminderLoadGuard((plugins) => applied.push(plugins[0]?.id ?? ""), () => dirty);
  const first = guard.begin();
  const second = guard.begin();
  const plugin = (id: string): PluginSettingsEntry => ({ id, name: id, state: "running", statusLine: id, notice: "" });
  await Promise.resolve().then(() => guard.apply(second, [plugin("newer")]));
  await Promise.resolve().then(() => guard.apply(first, [plugin("older")]));
  expect(applied).toEqual(["newer"]);
  const third = guard.begin();
  dirty = true;
  await Promise.resolve().then(() => guard.apply(third, [plugin("overwriting") ]));
  expect(applied).toEqual(["newer"]);
});
