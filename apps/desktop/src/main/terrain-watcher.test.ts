import { expect, test } from "vitest";
import { PowerShellTerrainSource, TERRAIN_WATCHER_SCRIPT, parseTerrainLine, validExcludedNames,
  type TerrainChild } from "./terrain-watcher.js";

class FakeChild implements TerrainChild {
  readonly pid = 4242;
  private readonly data: Array<(chunk: string) => void> = [];
  private readonly terminated: Array<() => void> = [];
  private dead = false;
  onStdoutData(listener: (chunk: string) => void): void { this.data.push(listener); }
  onTerminated(listener: () => void): void {
    if (this.dead) listener();
    else this.terminated.push(listener);
  }
  kill(): void { this.die(); }
  emit(chunk: string): void { for (const listener of this.data) listener(chunk); }
  die(): void {
    if (this.dead) return;
    this.dead = true;
    for (const listener of this.terminated) listener();
  }
}

const window = { id: "123", x: -20, y: 4, w: 100, h: 50, platform: true };

test("parses one bounded snapshot and rejects malformed lines and invalid dimensions", () => {
  expect(parseTerrainLine(JSON.stringify([window]))).toEqual([window]);
  expect(parseTerrainLine("[]\r")).toEqual([]);
  for (const input of ["{", "{}", JSON.stringify([{ ...window, id: "not-id" }]),
    JSON.stringify([{ ...window, w: -1 }]),
    JSON.stringify([{ ...window, h: 0 }]), JSON.stringify([{ ...window, title: "private" }]),
    JSON.stringify(Array.from({ length: 257 }, () => window)), " ".repeat(65537)]) {
    expect(parseTerrainLine(input)).toBeUndefined();
  }
});

test("excluded executable pattern accepts names and rejects injection and excess", () => {
  expect(validExcludedNames(["App.exe", "my tool-2.EXE", "a_b.exe"])).toBe(true);
  for (const name of ["", "a".repeat(65), "bad;run.exe", "bad\nrun.exe", "bad\\run.exe",
    "C:/tool.exe", "한글.exe", "$(run).exe"]) expect(validExcludedNames([name])).toBe(false);
  expect(validExcludedNames(Array.from({ length: 65 }, () => "app.exe"))).toBe(false);
});

test("script reads geometry without title, class, or path APIs", () => {
  for (const name of ["EnumWindows", "GetWindowRect", "GetWindowThreadProcessId", "DwmGetWindowAttribute",
    "SetThreadDpiAwarenessContext", "GetLayeredWindowAttributes"]) expect(TERRAIN_WATCHER_SCRIPT).toContain(name);
  for (const name of ["GetWindowText", "GetClassName", "QueryFullProcessImageName", "SetWindowPos"])
    expect(TERRAIN_WATCHER_SCRIPT).not.toContain(name);
});

test("one death restarts and the second disables without a third child", async () => {
  const children: FakeChild[] = [];
  const events: string[] = [];
  const snapshots: unknown[] = [];
  const source = new PowerShellTerrainSource({ platform: "win32", ownPid: 22,
    spawn: (args) => {
      expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    log: (event) => events.push(event) });
  source.onSnapshot((windows) => snapshots.push(windows));
  source.start();
  expect(source.state.active).toBe(true);
  children[0]?.emit(`${JSON.stringify([window])}\n`);
  expect(snapshots).toEqual([[window]]);
  expect(source.state.initialized).toBe(true);
  children[0]?.die();
  expect(children).toHaveLength(2);
  expect(source.state.initialized).toBe(false);
  children[0]?.emit("[]\n");
  expect(snapshots).toHaveLength(1);
  children[1]?.die();
  expect(source.state.active).toBe(false);
  expect(snapshots).toEqual([[window], []]);
  source.start();
  expect(children).toHaveLength(2);
  expect(events).toEqual(["started", "restarted", "disabled"]);
  await source.stop();
  source.start();
  expect(children).toHaveLength(3);
  await source.stop();
});

test("stop terminates the child and ignores later output", async () => {
  const child = new FakeChild();
  const snapshots: unknown[] = [];
  const source = new PowerShellTerrainSource({ platform: "win32", spawn: () => child });
  source.onSnapshot((windows) => snapshots.push(windows));
  source.start();
  await source.stop();
  child.emit("[]\n");
  expect(snapshots).toEqual([]);
  expect(source.state.active).toBe(false);
});

test("coordinates outside the 32-bit window range are rejected", () => {
  const line = (x: number, y: number): string => JSON.stringify([{ id: "1", x, y, w: 10, h: 10, platform: true }]);
  expect(parseTerrainLine(line(2 ** 31, -(2 ** 31)))).toHaveLength(1);
  expect(parseTerrainLine(line(2 ** 31 + 1, 0))).toBeUndefined();
  expect(parseTerrainLine(line(0, -(2 ** 31) - 1))).toBeUndefined();
  expect(parseTerrainLine(line(Number.MAX_SAFE_INTEGER, 0))).toBeUndefined();
});
