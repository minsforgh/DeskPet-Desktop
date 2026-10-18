import { describe, expect, test } from "vitest";
import {
  conditionsOf, descendantsOf, labelCheckerRenderers, labelPlugins, launchSettingsOf, memoryByRoleOf, memoryTotalOf, parseOptions, rendererPidsOf, roleAveragesOf,
  roleOf, roleOfProcess, sortRoles, summarizeBurst, summarizeRoles, summarizeSamples, type IdleProcess,
} from "./idle-cpu-lib.mjs";

const proc = (pid: number, role: string, workingSetMb = 10, privateMb = 5): IdleProcess =>
  ({ pid, ppid: 1, cpuSeconds: 0, workingSetMb, privateMb, commandLine: "", role });

describe("parseOptions", () => {
  test("defaults keep the existing behavior", () => {
    expect(parseOptions([])).toEqual({ seconds: 30, withJungle: false, withOrca: false, terrainOff: false, pollBurst: false, burstSeconds: 10, installedExe: null });
  });
  test("accepts both --seconds forms and the jungle flags", () => {
    expect(parseOptions(["--seconds", "10", "--with-jungle"]).seconds).toBe(10);
    expect(parseOptions(["--seconds=20", "--with-jungle", "--poll-burst", "--burst-seconds=5"]))
      .toEqual({ seconds: 20, withJungle: true, withOrca: false, terrainOff: false, pollBurst: true, burstSeconds: 5, installedExe: null });
  });
  test("--terrain-off turns the window watcher off and writes the settings the app parser reads", () => {
    const options = parseOptions(["--seconds=10", "--terrain-off"]);
    expect(options.terrainOff).toBe(true);
    expect(launchSettingsOf(options)).toEqual({ terrain: { enabled: false } });
    expect(launchSettingsOf(parseOptions([]))).toEqual({});
  });
  test("accepts --with-orca and rejects conflicting launch modes", () => {
    expect(parseOptions(["--with-orca"]).withOrca).toBe(true);
    expect(() => parseOptions(["--with-orca", "--with-jungle"])).toThrow("--with-orca");
    expect(() => parseOptions(["--installed-exe=a.exe", "--with-orca"])).toThrow("--with-orca");
  });
  test("rejects unknown, out-of-range and inconsistent options", () => {
    expect(() => parseOptions(["--bogus"])).toThrow("인식할 수 없는 인자");
    expect(() => parseOptions(["--seconds", "4"])).toThrow("--seconds");
    expect(() => parseOptions(["--seconds"])).toThrow("--seconds");
    expect(() => parseOptions(["--poll-burst"])).toThrow("--with-jungle");
    expect(() => parseOptions(["--seconds=10", "--with-jungle", "--poll-burst", "--burst-seconds=11"])).toThrow("--burst-seconds");
  });
});

describe("roles", () => {
  test("roleOf maps command lines", () => {
    expect(roleOf("electron.exe app")).toBe("main");
    expect(roleOf("electron.exe --type=gpu-process")).toBe("gpu");
    expect(roleOf("electron.exe --type=renderer")).toBe("renderer");
    expect(roleOf("")).toBe("unknown");
  });
  test("plugin pids and renderers created after readiness are labelled apart", () => {
    const ready = [proc(1, "main"), proc(2, "renderer"), proc(3, "utility")];
    const known = rendererPidsOf(ready);
    const tree = [proc(1, "main"), proc(2, "renderer"), proc(3, "utility"), proc(4, "renderer")];
    labelCheckerRenderers(labelPlugins(tree, new Set([3])), known);
    expect(tree.map((item) => item.role)).toEqual(["main", "renderer", "plugin", "checker-renderer"]);
    expect(summarizeRoles(tree)).toBe("main 1, renderer 1, checker-renderer 1, plugin 1");
  });
});

describe("app process tree", () => {
  const row = (pid: number, ppid: number, role = "x"): IdleProcess => ({ ...proc(pid, role), ppid });
  test("descendantsOf follows ParentProcessId through any depth and skips other trees", () => {
    const all = [row(10, 1), row(11, 10), row(12, 11), row(13, 10), row(20, 1), row(21, 20), row(99, 98)];
    expect(descendantsOf(all, 10).map((item) => item.pid)).toEqual([10, 11, 13, 12]);
    expect(descendantsOf(all, 20).map((item) => item.pid)).toEqual([20, 21]);
  });
  test("a query powershell started by the script (child of node, not of the app) stays outside the tree", () => {
    const all = [row(10, 1), row(11, 10, "powershell"), row(50, 40, "powershell")];
    expect(descendantsOf(all, 10).map((item) => item.pid)).toEqual([10, 11]);
  });
  test("descendantsOf survives a parent cycle", () => {
    expect(descendantsOf([row(1, 2), row(2, 1)], 1).map((item) => item.pid)).toEqual([1, 2]);
  });
  test("powershell descendants get their own role and are reported with memory", () => {
    expect(roleOfProcess("powershell.exe", "powershell.exe -NoProfile")).toBe("powershell");
    expect(roleOfProcess("PowerShell.EXE", "")).toBe("powershell");
    expect(roleOfProcess("electron.exe", "electron.exe --type=renderer")).toBe("renderer");
    expect(roleOfProcess("conhost.exe", "")).toBe("conhost");
    const tree = [proc(1, "main"), proc(2, "powershell", 40, 20), proc(3, "powershell", 40, 20)];
    expect(memoryByRoleOf(tree).get("powershell")).toEqual({ count: 2, workingSetMb: 80, privateMb: 40 });
    expect(summarizeRoles(tree)).toBe("main 1, powershell 2");
    expect(sortRoles([["powershell", 1], ["gpu", 1], ["plugin", 1]]).map(([role]) => role)).toEqual(["gpu", "plugin", "powershell"]);
  });
});

describe("summaries", () => {
  test("summarizeSamples and burst window", () => {
    expect(summarizeSamples([])).toEqual({ count: 0, average: 0, max: 0, maxIndex: 0 });
    expect(summarizeSamples([1, 3, 2])).toEqual({ count: 3, average: 2, max: 3, maxIndex: 2 });
    expect(summarizeBurst([4, 2, 0, 0], 2)).toEqual({ count: 2, average: 3, max: 4, maxIndex: 1 });
    expect(summarizeBurst([4], 10).count).toBe(1);
  });
  test("role averages and memory totals", () => {
    expect(roleAveragesOf(new Map([["main", 6]]), 3).get("main")).toBe(2);
    const memory = memoryByRoleOf([proc(1, "main", 100, 50), proc(2, "renderer", 20, 10), proc(3, "renderer", 30, 5)]);
    expect(memory.get("renderer")).toEqual({ count: 2, workingSetMb: 50, privateMb: 15 });
    expect(memoryTotalOf(memory)).toEqual({ count: 3, workingSetMb: 150, privateMb: 65 });
  });
  test("installed exe option", () => {
    expect(parseOptions(["--installed-exe", "C:/x/DeskPet.exe"]).installedExe).toBe("C:/x/DeskPet.exe");
    expect(() => parseOptions(["--installed-exe", ""])).toThrow();
    expect(() => parseOptions(["--installed-exe=a.exe", "--with-jungle"])).toThrow();
  });
  test("conditionsOf records the run conditions", () => {
    const options = parseOptions(["--seconds=10", "--with-jungle", "--poll-burst"]);
    expect(conditionsOf(options, { pluginCount: 1 })).toEqual({ withJungle: true, withOrca: false, terrain: "on", pollBurst: true, burstSeconds: 10, seconds: 10, pluginCount: 1 });
    expect(conditionsOf(parseOptions([]), {}).burstSeconds).toBeNull();
    expect(conditionsOf(parseOptions(["--terrain-off"]), {}).terrain).toBe("off");
  });
});
