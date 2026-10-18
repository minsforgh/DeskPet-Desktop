import { spawn } from "node:child_process";

/**
 * Runs inside one long-lived powershell.exe process (-NoProfile): compiles a P/Invoke stub
 * for shell32's SHQueryUserNotificationState, polls it every FULLSCREEN_POLL_SECONDS, and
 * prints one state name per line on stdout only when the state changes. Unknown numeric
 * states (0 or anything past the documented range) are printed as QUNS_<n> so the parser
 * can ignore them.
 */
export const FULLSCREEN_WATCHER_SCRIPT = `
$signature = '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'
Add-Type -MemberDefinition $signature -Name UserNotificationState -Namespace Deskpet
# Numbering matches Microsoft's QUERY_USER_NOTIFICATION_STATE exactly (1-7):
# https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state
# QUNS_NOT_PRESENT (lock screen / screen saver) is NOT a hold state; the old 0-based table
# made it read as QUNS_BUSY, so lock screens were held only by the numbering bug (fixed 2026-10-08).
$names = @{
  1 = 'QUNS_NOT_PRESENT'
  2 = 'QUNS_BUSY'
  3 = 'QUNS_RUNNING_D3D_FULL_SCREEN'
  4 = 'QUNS_PRESENTATION_MODE'
  5 = 'QUNS_ACCEPTS_NOTIFICATIONS'
  6 = 'QUNS_QUIET_TIME'
  7 = 'QUNS_APP'
}
$previous = -1
while ($true) {
  $state = 0
  $hr = [Deskpet.UserNotificationState]::SHQueryUserNotificationState([ref]$state)
  if ($hr -eq 0 -and $state -ne $previous) {
    $previous = $state
    $name = $names[[int]$state]
    if ($null -eq $name) { $name = 'QUNS_' + $state }
    [Console]::Out.WriteLine($name)
    [Console]::Out.Flush()
  }
  Start-Sleep -Seconds 2
}
`;

/** QUERY_USER_NOTIFICATION_STATE values this watcher understands. */
export type FullscreenState =
  | "QUNS_NOT_PRESENT"
  | "QUNS_BUSY"
  | "QUNS_RUNNING_D3D_FULL_SCREEN"
  | "QUNS_PRESENTATION_MODE"
  | "QUNS_ACCEPTS_NOTIFICATIONS"
  | "QUNS_QUIET_TIME"
  | "QUNS_APP";

const KNOWN_STATES: readonly FullscreenState[] = [
  "QUNS_NOT_PRESENT", "QUNS_BUSY", "QUNS_RUNNING_D3D_FULL_SCREEN", "QUNS_PRESENTATION_MODE",
  "QUNS_ACCEPTS_NOTIFICATIONS", "QUNS_QUIET_TIME", "QUNS_APP",
];

// The M3-9 completion criteria call these three "the user is in a full-screen app".
const FULLSCREEN_STATES: readonly FullscreenState[] = [
  "QUNS_BUSY", "QUNS_RUNNING_D3D_FULL_SCREEN", "QUNS_PRESENTATION_MODE",
];

/** Parses one stdout line of the watcher script; unknown lines (future states, noise) yield undefined. */
export function parseStateLine(line: string): FullscreenState | undefined {
  const text = line.trim();
  return KNOWN_STATES.find((state) => state === text);
}

export function stateIsFullscreen(state: FullscreenState): boolean {
  return FULLSCREEN_STATES.includes(state);
}

/** A replacement child is attempted once; a second death leaves the watcher safely at false. */
const MAX_RESTARTS = 1;

// Two direct runs measured kill() to the child's exit event at 18-19 ms, so waiting 2000 ms
// (about 100x the measured maximum) before giving up only ever trips on a wedged process.
export const STOP_TIMEOUT_MS = 2_000;

/** The child process surface the watcher needs; tests replace it with a fake. */
export interface PowerShellChild {
  readonly pid: number | undefined;
  readonly killed: boolean;
  onStdoutData(listener: (chunk: string) => void): void;
  /** Fires exactly once when the process is gone for any reason (exit or spawn error). */
  onTerminated(listener: () => void): void;
  kill(): void;
}

export type SpawnPowerShell = (args: string[]) => PowerShellChild;

/** Lets tests run timers without real-time waits. */
export interface FullscreenWatcherHost {
  /** Runs `run` after `ms` and returns a function that cancels it. */
  after(ms: number, run: () => void): () => void;
}

function spawnWindowsPowerShell(args: string[]): PowerShellChild {
  const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  return {
    pid: child.pid,
    get killed() { return child.killed; },
    onStdoutData(listener) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", listener);
    },
    onTerminated(listener) {
      let done = false;
      const once = () => { if (!done) { done = true; listener(); } };
      // A failed spawn (e.g. missing powershell.exe) emits "error" without any "exit".
      child.once("exit", once);
      child.once("error", once);
    },
    kill() { child.kill(); },
  };
}

const defaultHost: FullscreenWatcherHost = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface FullscreenWatcherOptions {
  /** Called only when the fullscreen boolean actually changes. */
  onChange(fullscreen: boolean): void;
  /** Defaults to process.platform; anything but "win32" leaves the watcher inert at false. */
  platform?: string;
  spawnPowerShell?: SpawnPowerShell;
  host?: FullscreenWatcherHost;
}

/** Watches for the user being in a full-screen app (game, presentation, video) via one PowerShell child. */
export class FullscreenWatcher {
  private readonly onChange: (fullscreen: boolean) => void;
  private readonly platform: string;
  private readonly spawnPowerShell: SpawnPowerShell;
  private readonly host: FullscreenWatcherHost;
  private child: PowerShellChild | undefined;
  private started = false;
  private stopping = false;
  private restartsUsed = 0;
  private state: FullscreenState | undefined;
  private fullscreenNow = false;

  constructor(options: FullscreenWatcherOptions) {
    this.onChange = options.onChange;
    this.platform = options.platform ?? process.platform;
    this.spawnPowerShell = options.spawnPowerShell ?? spawnWindowsPowerShell;
    this.host = options.host ?? defaultHost;
  }

  get fullscreen(): boolean { return this.fullscreenNow; }

  start(): void {
    if (this.started || this.platform !== "win32") return;
    this.started = true;
    this.launch();
  }

  /** Kills the child and resolves once it is gone (STOP_TIMEOUT_MS at the latest). */
  async stop(): Promise<void> {
    const child = this.child;
    this.started = false;
    if (!child) {
      this.reset();
      return;
    }
    this.stopping = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelTimer();
        resolve();
      };
      const cancelTimer = this.host.after(STOP_TIMEOUT_MS, finish);
      child.onTerminated(finish);
      child.kill();
    });
    this.reset();
  }

  private launch(): void {
    const child = this.spawnPowerShell(["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(FULLSCREEN_WATCHER_SCRIPT, "utf16le").toString("base64")]);
    this.child = child;
    let buffer = "";
    child.onStdoutData((chunk) => {
      // Data after stop() or a restart belongs to a child we no longer track.
      if (this.child !== child) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.applyLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.onTerminated(() => {
      if (this.child !== child) return;
      this.handleTermination();
    });
  }

  private applyLine(line: string): void {
    const next = parseStateLine(line);
    if (!next || next === this.state) return;
    this.state = next;
    const fullscreen = stateIsFullscreen(next);
    if (fullscreen !== this.fullscreenNow) {
      this.fullscreenNow = fullscreen;
      this.onChange(fullscreen);
    }
  }

  private handleTermination(): void {
    this.child = undefined;
    if (this.stopping) return;
    if (this.restartsUsed < MAX_RESTARTS) {
      this.restartsUsed += 1;
      this.launch();
      return;
    }
    // Gave up on the child: report the safe answer and stay inert until a stop()/start() cycle.
    this.state = undefined;
    if (this.fullscreenNow) {
      this.fullscreenNow = false;
      this.onChange(false);
    }
  }

  private reset(): void {
    this.child = undefined;
    this.stopping = false;
    this.restartsUsed = 0;
    this.state = undefined;
    this.fullscreenNow = false;
  }
}
