import { describe, expect, test } from "vitest";
import { pluginClockArgs } from "./plugin-clock-args.js";

const TIME = "2026-10-08T15:00:00+09:00";

describe("pluginClockArgs", () => {
  test("passes the parsed time to the plugin process", () => {
    expect(pluginClockArgs(TIME)).toEqual([`--plugin-clock=${TIME}`]);
  });

  test("passes nothing when launch args gave no clock", () => {
    expect(pluginClockArgs(undefined)).toEqual([]);
  });
});
