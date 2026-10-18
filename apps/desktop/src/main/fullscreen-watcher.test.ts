import { describe, expect, test } from "vitest";
import {
  FULLSCREEN_WATCHER_SCRIPT, FullscreenWatcher, STOP_TIMEOUT_MS, parseStateLine, stateIsFullscreen,
  type FullscreenWatcherHost, type PowerShellChild,
} from "./fullscreen-watcher.js";

/** Stand-in for the powershell.exe child; tests drive it with emit()/die(). */
class FakeChild implements PowerShellChild {
  readonly pid = 4242;
  killed = false;
  private readonly dataWaiters: Array<(chunk: string) => void> = [];
  private readonly terminationWaiters: Array<() => void> = [];
  private terminated = false;

  constructor(private readonly options: { ignoreKill?: boolean } = {}) {}

  onStdoutData(listener: (chunk: string) => void): void { this.dataWaiters.push(listener); }
  onTerminated(listener: () => void): void {
    if (this.terminated) listener();
    else this.terminationWaiters.push(listener);
  }
  kill(): void {
    this.killed = true;
    if (!this.options.ignoreKill) this.terminate();
  }
  emit(chunk: string): void { for (const listener of [...this.dataWaiters]) listener(chunk); }
  die(): void { this.terminate(); }
  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    for (const listener of [...this.terminationWaiters]) listener();
  }
}

/** Manual clock so the stop timeout runs without real-time waits. */
class FakeClock {
  private now = 0;
  private readonly entries: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  readonly host: FullscreenWatcherHost = {
    after: (ms, run) => {
      const entry = { at: this.now + ms, run, cancelled: false };
      this.entries.push(entry);
      return () => { entry.cancelled = true; };
    },
  };
  advance(ms: number): void {
    this.now += ms;
    for (const entry of [...this.entries]) {
      if (!entry.cancelled && entry.at <= this.now) { entry.cancelled = true; entry.run(); }
    }
  }
}

interface World {
  watcher: FullscreenWatcher;
  spawnArgs: string[][];
  changes: boolean[];
  clock: FakeClock;
}

function setup(options: { platform?: string; children?: FakeChild[] } = {}): World {
  const spawnArgs: string[][] = [];
  const children: FakeChild[] = [];
  const changes: boolean[] = [];
  const clock = new FakeClock();
  const watcher = new FullscreenWatcher({
    onChange: (fullscreen) => { changes.push(fullscreen); },
    platform: options.platform,
    spawnPowerShell: (args) => {
      spawnArgs.push(args);
      const child = options.children?.[spawnArgs.length - 1] ?? new FakeChild();
      children.push(child);
      return child;
    },
    host: clock.host,
  });
  return { watcher, spawnArgs, changes, clock };
}

describe("state line parsing", () => {
  test("parses every known state name, with CRLF tolerated", () => {
    const states = ["QUNS_NOT_PRESENT", "QUNS_BUSY", "QUNS_RUNNING_D3D_FULL_SCREEN", "QUNS_PRESENTATION_MODE",
      "QUNS_ACCEPTS_NOTIFICATIONS", "QUNS_QUIET_TIME", "QUNS_APP"] as const;
    for (const state of states) expect(parseStateLine(state)).toBe(state);
    expect(parseStateLine("QUNS_BUSY\r")).toBe("QUNS_BUSY");
  });

  test("ignores unknown or malformed lines", () => {
    for (const line of ["", "   ", "garbage", "QUNS_0", "QUNS_8", "QUNS_99", "quns_busy", "QUNS_BUSY extra", "1"]) {
      expect(parseStateLine(line)).toBeUndefined();
    }
  });

  test("script maps numbers 1-7 to Microsoft's documented state names", () => {
    // Microsoft QUERY_USER_NOTIFICATION_STATE values:
    // https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state
    const documented: Record<number, string> = {
      1: "QUNS_NOT_PRESENT",
      2: "QUNS_BUSY",
      3: "QUNS_RUNNING_D3D_FULL_SCREEN",
      4: "QUNS_PRESENTATION_MODE",
      5: "QUNS_ACCEPTS_NOTIFICATIONS",
      6: "QUNS_QUIET_TIME",
      7: "QUNS_APP",
    };
    const table = new Map<number, string>();
    for (const match of FULLSCREEN_WATCHER_SCRIPT.matchAll(/\b(\d+)\s*=\s*'(QUNS_[A-Z0-9_]+)'/g)) {
      const numberText = match[1];
      const name = match[2];
      // Both capture groups are mandatory in the pattern, so this only satisfies the compiler.
      if (numberText === undefined || name === undefined) throw new Error("missing capture group");
      table.set(Number(numberText), name);
    }
    expect(Object.fromEntries(table)).toEqual(documented);
    // 0 and 8 are not in the table, so the script prints QUNS_<n> and the parser ignores them.
    expect(table.has(0)).toBe(false);
    expect(table.has(8)).toBe(false);
  });

  test("classifies exactly busy, D3D full screen, and presentation mode as fullscreen", () => {
    for (const state of ["QUNS_BUSY", "QUNS_RUNNING_D3D_FULL_SCREEN", "QUNS_PRESENTATION_MODE"] as const) {
      expect(stateIsFullscreen(state)).toBe(true);
    }
    for (const state of ["QUNS_NOT_PRESENT", "QUNS_ACCEPTS_NOTIFICATIONS", "QUNS_QUIET_TIME", "QUNS_APP"] as const) {
      expect(stateIsFullscreen(state)).toBe(false);
    }
  });
});

describe("FullscreenWatcher", () => {
  test("starts exactly one PowerShell child with -NoProfile and the encoded script", () => {
    const { watcher, spawnArgs } = setup();
    watcher.start();
    watcher.start();
    expect(spawnArgs.length).toBe(1);
    const args = spawnArgs[0] ?? [];
    expect(args[0]).toBe("-NoProfile");
    expect(args).toContain("-EncodedCommand");
    const decoded = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("Add-Type");
    expect(decoded).toContain("SHQueryUserNotificationState");
    expect(decoded).toContain("Start-Sleep -Seconds 2");
  });

  test("does nothing off Windows", () => {
    const { watcher, spawnArgs, changes } = setup({ platform: "linux" });
    watcher.start();
    expect(spawnArgs).toEqual([]);
    expect(changes).toEqual([]);
    expect(watcher.fullscreen).toBe(false);
  });

  test("reports only changes of the fullscreen boolean", () => {
    const first = new FakeChild();
    const { watcher, changes } = setup({ children: [first] });
    watcher.start();
    // The script's first line is the initial state; a non-fullscreen start is not a change.
    first.emit("QUNS_ACCEPTS_NOTIFICATIONS\n");
    expect(changes).toEqual([]);
    first.emit("QUNS_RUNNING_D3D_FULL_SCREEN\n");
    expect(changes).toEqual([true]);
    // Different fullscreen states do not change the boolean.
    first.emit("QUNS_BUSY\n");
    first.emit("QUNS_PRESENTATION_MODE\r\n");
    expect(changes).toEqual([true]);
    first.emit("QUNS_ACCEPTS_NOTIFICATIONS\n");
    expect(changes).toEqual([true, false]);
    expect(watcher.fullscreen).toBe(false);
  });

  test("skips duplicate states and unknown lines", () => {
    const first = new FakeChild();
    const { watcher, changes } = setup({ children: [first] });
    watcher.start();
    first.emit("QUNS_BUSY\nQUNS_BUSY\n");
    expect(changes).toEqual([true]);
    first.emit("garbage\nQUNS_9\n\n");
    expect(changes).toEqual([true]);
    // The unknown lines did not reset the state, so this is still a duplicate.
    first.emit("QUNS_BUSY\n");
    expect(changes).toEqual([true]);
  });

  test("reassembles lines split across chunks", () => {
    const first = new FakeChild();
    const { watcher, changes } = setup({ children: [first] });
    watcher.start();
    first.emit("QUNS_PR");
    first.emit("ESENTATION_MODE\n");
    expect(changes).toEqual([true]);
    first.emit("QUNS_ACCEPTS_NOTIFICATIONS\nQUNS_BUSY\n");
    expect(changes).toEqual([true, false, true]);
  });

  test("restarts once after a crash and reports the safe answer when it dies again", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const { watcher, spawnArgs, changes } = setup({ children: [first, second] });
    watcher.start();
    first.die();
    expect(spawnArgs.length).toBe(2);
    second.emit("QUNS_BUSY\n");
    expect(changes).toEqual([true]);
    second.die();
    // No third spawn; giving up reports fullscreen=false.
    expect(spawnArgs.length).toBe(2);
    expect(changes).toEqual([true, false]);
    expect(watcher.fullscreen).toBe(false);
  });

  test("a given-up watcher stays inert until stop() and start() again", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const { watcher, spawnArgs, changes } = setup({ children: [first, second] });
    watcher.start();
    first.die();
    second.die();
    expect(changes).toEqual([]);
    watcher.start();
    expect(spawnArgs.length).toBe(2);
  });

  test("stop() confirms the child exit and allows a fresh start", async () => {
    const first = new FakeChild();
    const { watcher, spawnArgs, changes } = setup({ children: [first] });
    watcher.start();
    first.emit("QUNS_BUSY\n");
    await watcher.stop();
    // The fake terminates synchronously on kill(), so the promise resolved on the exit path
    // (the FakeClock never advanced, so the timeout cannot have fired).
    expect(first.killed).toBe(true);
    expect(spawnArgs.length).toBe(1);
    expect(changes).toEqual([true]);
    expect(watcher.fullscreen).toBe(false);
    await watcher.stop();
    expect(spawnArgs.length).toBe(1);
    watcher.start();
    expect(spawnArgs.length).toBe(2);
  });

  test("stop() ignores stdout that arrives after the stop", async () => {
    const first = new FakeChild();
    const { watcher, changes } = setup({ children: [first] });
    watcher.start();
    first.emit("QUNS_BUSY\n");
    await watcher.stop();
    first.emit("QUNS_RUNNING_D3D_FULL_SCREEN\n");
    expect(changes).toEqual([true]);
  });

  test("stop() gives up on a wedged child after STOP_TIMEOUT_MS", async () => {
    const wedged = new FakeChild({ ignoreKill: true });
    const { watcher, clock } = setup({ children: [wedged] });
    watcher.start();
    let resolved = false;
    const stopping = watcher.stop().then(() => { resolved = true; });
    clock.advance(STOP_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);
    clock.advance(1);
    await stopping;
    expect(resolved).toBe(true);
    expect(wedged.killed).toBe(true);
  });
});
