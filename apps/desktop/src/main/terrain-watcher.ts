import { spawn } from "node:child_process";
import type { TerrainWindow } from "@deskpet/core";

// Five Windows runs in ADR-0009 measured 0.225 ms per enumeration of about 200 windows;
// 100 ms polling cost 1.8% of one core and 500 ms polling cost 0.27%.
// D-052 bounds the 100 ms burst to one second after the last change.
export const TERRAIN_WATCHER_SCRIPT = String.raw`
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Deskpet {
  public class TerrainWindow {
    public string id { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int w { get; set; }
    public int h { get; set; }
    public bool platform { get; set; }
  }
  public static class TerrainProbe {
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOOLWINDOW = 0x80;
    private const long WS_EX_TRANSPARENT = 0x20;
    private const long WS_EX_LAYERED = 0x80000;
    private const int LWA_ALPHA = 0x2;
    private delegate bool EnumCallback(IntPtr hwnd, IntPtr unused);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr unused);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint color, out byte alpha, out uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    public static void SetPhysicalPixels() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

    public static List<TerrainWindow> Read(int ownProcessId, string[] excludedNames) {
      var windows = new List<TerrainWindow>();
      var excluded = new HashSet<string>(excludedNames, StringComparer.OrdinalIgnoreCase);
      EnumWindows((hwnd, unused) => {
        if (windows.Count >= 256) return false;
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        if (processId == ownProcessId) return true;
        int cloaked;
        if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
        long style = (uint)GetWindowLong(hwnd, GWL_EXSTYLE);
        if ((style & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)) != 0) return true;
        if ((style & WS_EX_LAYERED) != 0) {
          uint color, flags;
          byte alpha;
          if (GetLayeredWindowAttributes(hwnd, out color, out alpha, out flags) &&
              (flags & LWA_ALPHA) != 0 && alpha == 0) return true;
        }
        RECT rect;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0 &&
            !GetWindowRect(hwnd, out rect)) return true;
        long width = (long)rect.Right - rect.Left;
        long height = (long)rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0 || width > 32768 || height > 32768) return true;
        bool platform = true;
        if (excluded.Count != 0) {
          try {
            // ProcessName is a basename without .exe; no process path is requested or retained.
            using (var process = Process.GetProcessById((int)processId))
              platform = !excluded.Contains(process.ProcessName + ".exe");
          } catch { /* An inaccessible process remains a candidate. */ }
        }
        windows.Add(new TerrainWindow { id = hwnd.ToInt64().ToString(), x = rect.Left, y = rect.Top,
          w = (int)width, h = (int)height, platform = platform });
        return true;
      }, IntPtr.Zero);
      return windows;
    }
  }
}
'@
Add-Type -TypeDefinition $source
[Deskpet.TerrainProbe]::SetPhysicalPixels()
$ownProcessId = [int]$args[0]
$excludedNames = [string[]]::new(0)
if ($args.Count -gt 1 -and $args[1].Length -gt 0) {
  $excludedNames = [string[]]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[1])) -split [char]10)
}
$previous = $null
$fastUntil = [DateTime]::MinValue
$parentCheckAt = [DateTime]::MinValue
while ($true) {
  # The app normally kills this process; if the app died without doing so, stop reading other windows.
  if ([DateTime]::UtcNow -ge $parentCheckAt) {
    $parentCheckAt = [DateTime]::UtcNow.AddSeconds(5)
    if ($null -eq (Get-Process -Id $ownProcessId -ErrorAction SilentlyContinue)) { exit 0 }
  }
  $windows = [Deskpet.TerrainProbe]::Read($ownProcessId, $excludedNames)
  $json = ConvertTo-Json -InputObject @($windows.ToArray()) -Compress -Depth 3
  if ($json -cne $previous) {
    $previous = $json
    $fastUntil = [DateTime]::UtcNow.AddSeconds(1)
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
  if ([DateTime]::UtcNow -lt $fastUntil) { Start-Sleep -Milliseconds 100 }
  else { Start-Sleep -Milliseconds 500 }
}
`;

const MAX_WINDOWS = 256;
const MAX_LINE_LENGTH = 65536;
const MAX_RESTARTS = 1;
// Two direct runs of the existing watcher measured kill-to-exit at 18-19 ms; 2000 ms
// is more than 100 times that maximum and bounds a wedged child during shutdown.
const STOP_TIMEOUT_MS = 2000;
const EXCLUDED_NAME = /^[A-Za-z0-9._ -]{1,64}$/;

export function validExcludedNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 &&
    value.every((name: unknown) => typeof name === "string" && EXCLUDED_NAME.test(name));
}

export function parseTerrainLine(line: string): TerrainWindow[] | undefined {
  if (line.length > MAX_LINE_LENGTH) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length > MAX_WINDOWS) return undefined;
  const windows: TerrainWindow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const value: Record<string, unknown> = entry;
    if (typeof value.id !== "string" || !/^\d+$/.test(value.id) ||
        ![value.x, value.y, value.w, value.h].every((n) => typeof n === "number" && Number.isSafeInteger(n)) ||
        // A RECT holds 32-bit coordinates; anything larger is not a window position.
        typeof value.x !== "number" || Math.abs(value.x) > 2 ** 31 || typeof value.y !== "number" || Math.abs(value.y) > 2 ** 31 ||
        typeof value.w !== "number" || value.w <= 0 || value.w > 32768 ||
        typeof value.h !== "number" || value.h <= 0 || value.h > 32768 ||
        typeof value.platform !== "boolean" || Object.keys(value).some((key) =>
          !["id", "x", "y", "w", "h", "platform"].includes(key))) return undefined;
    windows.push({ id: value.id, x: Number(value.x), y: Number(value.y),
      w: value.w, h: value.h, platform: value.platform });
  }
  return windows;
}

export interface TerrainChild {
  readonly pid: number | undefined;
  onStdoutData(listener: (chunk: string) => void): void;
  onTerminated(listener: () => void): void;
  kill(): void;
}

export type SpawnTerrainPowerShell = (args: string[]) => TerrainChild;

export interface TerrainSource {
  start(): void;
  stop(): Promise<void>;
  onSnapshot(listener: (windows: readonly TerrainWindow[]) => void): void;
  readonly state: { active: boolean; initialized: boolean; pid: number | undefined };
}

function spawnPowerShell(args: string[]): TerrainChild {
  const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  return {
    pid: child.pid,
    onStdoutData(listener) { child.stdout.setEncoding("utf8"); child.stdout.on("data", listener); },
    onTerminated(listener) {
      let done = false;
      const once = () => { if (!done) { done = true; listener(); } };
      child.once("exit", once);
      child.once("error", once);
    },
    kill() { child.kill(); },
  };
}

export class PowerShellTerrainSource implements TerrainSource {
  private child: TerrainChild | undefined;
  private started = false;
  private stopping = false;
  private restarts = 0;
  private initialized = false;
  private disabled = false;
  private generation = 0;
  private readonly pendingStops = new Set<Promise<void>>();
  private readonly listeners: Array<(windows: readonly TerrainWindow[]) => void> = [];
  private readonly spawn: SpawnTerrainPowerShell;
  private readonly platform: string;
  private readonly excludedNames: string[];
  private readonly ownPid: number;
  private readonly log: (event: "started" | "restarted" | "disabled" | "stopped") => void;

  constructor(options: { excludedNames?: string[]; ownPid?: number; platform?: string;
    spawn?: SpawnTerrainPowerShell; log?: (event: "started" | "restarted" | "disabled" | "stopped") => void } = {}) {
    if (!validExcludedNames(options.excludedNames ?? [])) throw new RangeError("Invalid excluded executable names");
    this.excludedNames = options.excludedNames ?? [];
    this.ownPid = options.ownPid ?? process.pid;
    if (!Number.isSafeInteger(this.ownPid) || this.ownPid <= 0) throw new RangeError("Invalid process id");
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? spawnPowerShell;
    this.log = options.log ?? (() => undefined);
  }

  get state(): { active: boolean; initialized: boolean; pid: number | undefined } {
    return { active: this.started && this.child !== undefined, initialized: this.initialized, pid: this.child?.pid };
  }

  onSnapshot(listener: (windows: readonly TerrainWindow[]) => void): void { this.listeners.push(listener); }

  start(): void {
    if (this.started || this.disabled || this.platform !== "win32") return;
    this.started = true;
    this.stopping = false;
    this.launch();
    this.log("started");
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    const generation = ++this.generation;
    if (child) {
      const stopped = new Promise<void>((resolve) => {
        let done = false;
        const timer = setTimeout(finish, STOP_TIMEOUT_MS);
        function finish(): void { if (done) return; done = true; clearTimeout(timer); resolve(); }
        child.onTerminated(finish);
        child.kill();
      });
      this.pendingStops.add(stopped);
      await stopped;
      this.pendingStops.delete(stopped);
      this.log("stopped");
    }
    await Promise.all(this.pendingStops);
    if (generation === this.generation) {
      this.stopping = false;
      this.restarts = 0;
      this.initialized = false;
      this.disabled = false;
    }
  }

  private launch(): void {
    const names = Buffer.from(this.excludedNames.join("\n"), "utf8").toString("base64");
    // -EncodedCommand cannot accept trailing positional arguments in Windows PowerShell 5.1.
    // Supply the script's two arguments in its own $args array; both values are numeric/base64.
    const command = `$args = @(${this.ownPid}, '${names}')\n${TERRAIN_WATCHER_SCRIPT}`;
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64")];
    const child = this.spawn(args);
    this.child = child;
    const generation = ++this.generation;
    let buffer = "";
    child.onStdoutData((chunk) => {
      if (this.child !== child || generation !== this.generation) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE_LENGTH && !buffer.includes("\n")) { buffer = ""; return; }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const windows = parseTerrainLine(buffer.slice(0, newline).trimEnd());
        if (windows) {
          this.initialized = true;
          for (const listener of this.listeners) listener(windows);
        }
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_LENGTH) buffer = "";
    });
    child.onTerminated(() => {
      if (this.child !== child || generation !== this.generation) return;
      this.child = undefined;
      this.initialized = false;
      if (this.stopping || !this.started) return;
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        this.launch();
        this.log("restarted");
      } else {
        this.started = false;
        this.disabled = true;
        for (const listener of this.listeners) listener([]);
        this.log("disabled");
      }
    });
  }
}
