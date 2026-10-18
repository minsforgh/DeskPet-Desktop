import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { cleanupDescendants, descendantsOf, DesktopDiagnostics, listProcesses, registerControlSummary } from "./helpers/desktop-diagnostics.js";

export type ControlResponse = { id: number; ok: boolean; result?: unknown; error?: string; unexpectedDialog?: string };
type ReadyState = { ready: boolean; visible?: boolean; bubble?: { renderer: unknown } | null;
  pluginHost?: { ready: boolean; pids?: Record<string, number> };
  terrain?: { source: "test" | "powershell" | "off"; ready: boolean };
  settings?: { loading: boolean } | null };

const desktopRoot = resolve(import.meta.dirname, "..");
const electronPath: unknown = createRequire(import.meta.url)("electron");
const pause = (ms: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, ms));
// Under concurrent mixed-DPI screenshot tests, pipe closure preceded browser process
// exit by more than 7 s. Observe beyond the app's 6 s kill fallback before failing.
const EXIT_TIMEOUT_MS = 12000;
const exitedApps = new Set<DesktopApp>();

/** Check exited apps together so a 20-launch lifecycle test pays for one CIM snapshot, not twenty. */
export async function cleanupExitedDescendants(): Promise<void> {
  if (exitedApps.size === 0) return;
  const apps = [...exitedApps];
  exitedApps.clear();
  try {
    const rows = await listProcesses();
    for (const app of apps) {
      cleanupDescendants(rows, app.child.pid, app.timing.startedAt, app.timing);
      app.descendantsChecked = true;
    }
  } catch (error) {
    console.warn(`[e2e cleanup] Could not inspect exited Electron descendants: ${String(error)}`);
    for (const app of apps) if (!app.descendantsChecked) exitedApps.add(app);
    throw error;
  }
}

export class DesktopApp {
  readonly name = randomUUID().replaceAll("-", "");
  readonly child: ChildProcess;
  readonly timing: DesktopDiagnostics;
  private readonly closed: Promise<void>;
  private output = "";
  private lastState: unknown;
  /** Plugin process ids from the latest state response; they must all be gone once the app has exited. */
  private pluginPids: number[] = [];
  private nextRequestId = 1;
  private waitingReady = false;
  descendantsChecked = false;

  private constructor(userDataDir: string, args: readonly string[]) {
    if (typeof electronPath !== "string") throw new Error("Electron binary unavailable");
    const launchStarted = performance.now();
    const startedAt = Date.now();
    this.child = spawn(electronPath, [desktopRoot, `--dev-control=${this.name}`, `--user-data-dir=${userDataDir}`, ...args],
      { stdio: ["ignore", "pipe", "pipe"] });
    this.closed = new Promise<void>((resolveClose) => this.child.once("close", () => resolveClose()));
    registerControlSummary();
    this.timing = new DesktopDiagnostics(this.child, startedAt);
    this.timing.markLaunch(performance.now() - launchStarted);
    const capture = (chunk: Buffer): void => { this.output = `${this.output}${chunk.toString()}`.slice(-8192); };
    this.child.stdout?.on("data", capture);
    this.child.stderr?.on("data", capture);
  }

  static async launch(userDataDir: string, args: readonly string[] = [], visible = true): Promise<DesktopApp> {
    // Without an explicit port the app takes the fixed default 7777, which concurrent runs (and a real DeskPet) share.
    const withPort = args.some((arg) => arg.startsWith("--event-port=")) ? args : ["--event-port=0", ...args];
    // The repository's default Jungle plugin requests permission during startup. Keep its
    // test answer explicit unless a case supplies allow or hold for its own permission flow.
    const withPermission = withPort.some((arg) => arg.startsWith("--permission-answer="))
      ? withPort : ["--permission-answer=deny", ...withPort];
    const withTerrain = withPermission.some((arg) => arg.startsWith("--terrain-source="))
      ? withPermission : ["--terrain-source=test", ...withPermission];
    const desktop = new DesktopApp(userDataDir, withTerrain);
    try {
      await desktop.waitReady(visible);
      // Pin the fullscreen input right after readiness (before any test can send notices) so e2e
      // does not depend on the PC's real state: a full-screen app running next to the tests held
      // notifications and broke the bubble/dnd e2e on 2026-10-08. Tests may still override it.
      await desktop.request({ cmd: "setFullscreenForTest", fullscreen: false });
      return desktop;
    }
    catch (error) {
      await desktop.sampleDescendants();
      await desktop.forceStop();
      throw desktop.timing.failure(String(error), error);
    }
  }

  get diagnostics(): string { return this.output; }

  /** Plugin process ids seen in the latest state response. */
  get livePluginPids(): readonly number[] { return this.pluginPids; }

  async requestRaw(command: Record<string, unknown>, timeoutMs = 3000): Promise<ControlResponse> {
    const requestId = this.nextRequestId++;
    const commandName = typeof command.cmd === "string" ? command.cmd : "unknown";
    const started = performance.now();
    const pipePath = `\\\\.\\pipe\\deskpet-dev-${this.name}`;
    return new Promise((resolveResponse, rejectResponse) => {
      const socket = connect(pipePath);
      let pending = "";
      let settled = false;
      const timer = setTimeout(() => socket.destroy(new Error("Dev control timed out")), timeoutMs);
      const finish = (error?: Error, response?: ControlResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        this.timing.control(commandName, performance.now() - started, !error && response?.ok === true);
        if (error) {
          if (this.waitingReady) rejectResponse(this.timing.failure(error.message, error));
          else void this.sampleDescendants().then(() => rejectResponse(this.timing.failure(error.message, error)));
        }
        else if (response) resolveResponse(response);
        else rejectResponse(this.timing.failure("Dev control closed before responding"));
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ ...command, id: requestId })}\n`));
      socket.on("data", (chunk: string) => {
        pending += chunk;
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(pending.slice(0, newline)) as ControlResponse;
          if (response.id !== requestId) throw new Error(`Dev control response id mismatch: expected ${requestId}, got ${response.id}`);
          finish(undefined, response);
        }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on("end", () => finish(new Error("Dev control closed before responding")));
      socket.on("error", (error) => finish(error));
    });
  }

  async request(command: Record<string, unknown>): Promise<unknown> {
    const response = await this.requestRaw(command);
    if (response.unexpectedDialog) throw new Error(`Unexpected native dialog: ${response.unexpectedDialog}`);
    if (!response.ok) throw new Error(`Dev control failed: ${response.error ?? JSON.stringify(response)}`);
    if (command.cmd === "state") {
      this.lastState = response.result;
      this.pluginPids = Object.values((response.result as ReadyState).pluginHost?.pids ?? {});
    }
    return response.result;
  }

  async waitReady(visible = true): Promise<ReadyState> {
    this.waitingReady = true;
    try { return await this.timing.measure("waitReady", () => this.waitUntilReady(visible)); }
    finally { this.waitingReady = false; }
  }

  private async waitUntilReady(visible: boolean): Promise<ReadyState> {
    let lastError = "";
    let pinned = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        await this.closed;
        throw new Error(`Electron exited while starting: ${this.child.exitCode}; ${this.output}`);
      }
      try {
        const state = await this.request({ cmd: "state" }) as ReadyState;
        // Pin the fullscreen input as soon as the control pipe answers: the real PowerShell watcher stops
        // while the PC reports full screen, so pinning only after readiness never became ready there.
        if (!pinned) {
          await this.request({ cmd: "setFullscreenForTest", fullscreen: false });
          pinned = true;
          continue;
        }
        // The bubble page loads on its own; tests that read the bubble renderer need it loaded too.
        // The plugin host counts as loaded once discovery is done and every allowed plugin is past starting.
        // A settings window that is open must also have finished loading (it opens only on request, so usually none is).
        if (state.ready && (!visible || state.visible) && state.bubble?.renderer && state.pluginHost?.ready &&
            state.terrain?.ready && !state.settings?.loading) return state;
      } catch (error) {
        if (String(error).includes("Unexpected native dialog:")) throw error;
        lastError = String(error);
      }
      await pause(100);
    }
    throw new Error(`Pet did not become ready; state=${JSON.stringify(this.lastState)}; error=${lastError}; log=${this.output}`);
  }

  /** The raw event-server.json of this app's userData, for tests that check what the app wrote. */
  async readEventServerFile(userDataDir: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(join(userDataDir, "event-server.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("event-server.json is not an object");
    return parsed as Record<string, unknown>;
  }

  /** The app resolves this after bind succeeds or fails. Five serial Windows launches measured 2 ms max
   * after pet readiness; the normal 3 s control watchdog covers scheduling overhead. */
  async eventServerAuth(userDataDir: string): Promise<{ port: number; token: string }> {
    const response = await this.requestRaw({ cmd: "eventServerReady" });
    if (!response.ok) throw new Error(`Event server readiness failed: ${response.error}`);
    const eventServer = response.result as { listening: boolean; error?: string };
    if (!eventServer.listening) throw new Error(`Event server is not listening: ${eventServer.error ?? "unknown error"}`);
    const { port, token } = await this.readEventServerFile(userDataDir);
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`event-server.json has an invalid port: ${JSON.stringify(port)}`);
    if (typeof token !== "string" || token.length === 0) throw new Error("event-server.json has no token");
    return { port, token };
  }

  async quit(command: Record<string, unknown> = { cmd: "tray", action: "quit" }): Promise<void> {
    await this.timing.measure("quit", async () => {
      await this.request(command);
      await this.waitForExit();
    });
  }

  async waitForExit(): Promise<void> {
    if (!await this.waitForClose(EXIT_TIMEOUT_MS)) {
      let state: unknown;
      try { state = await this.request({ cmd: "state" }); }
      catch (error) { state = String(error); }
      const diagnostic = `Electron did not quit; pid=${this.child.pid}; state=${JSON.stringify(state ?? this.lastState)}; log=${this.output}`;
      await this.sampleDescendants();
      await this.forceStop();
      await this.checkDescendants();
      throw this.timing.failure(diagnostic);
    }
    // A clean exit skips the ~0.6 s PowerShell CIM snapshot; plugin processes are checked below, and abnormal exits, force stops and control failures still list descendants.
    const clean = this.child.exitCode === 0 && this.child.signalCode === null;
    if (!clean) {
      this.queueDescendantCheck();
      throw this.timing.failure(`Electron exited ${this.child.exitCode} signal ${this.child.signalCode}; log=${this.output}`);
    }
    await this.expectNoPluginProcesses();
  }

  /** A utilityProcess must not outlive the app; the OS needs a moment to reap it after main exits. */
  private async expectNoPluginProcesses(): Promise<void> {
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    };
    let remaining = this.pluginPids.filter(alive);
    for (let attempt = 0; attempt < 50 && remaining.length > 0; attempt += 1) {
      await pause(100);
      remaining = remaining.filter(alive);
    }
    this.pluginPids = [];
    if (remaining.length > 0) throw new Error(`Plugin processes outlived the app: ${remaining.join(", ")}`);
  }

  async forceStop(): Promise<void> {
    await this.timing.measure("forceStop", async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
      await this.waitForClose(5000);
      this.queueDescendantCheck();
    });
  }

  private async waitForClose(timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<false>((resolveTimeout) => { timeout = setTimeout(() => resolveTimeout(false), timeoutMs); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private queueDescendantCheck(): void {
    if (!this.descendantsChecked) exitedApps.add(this);
  }

  private async sampleDescendants(): Promise<void> {
    if (this.child.pid === undefined) return;
    try {
      const rows = await listProcesses();
      this.timing.setDescendants(descendantsOf(rows, this.child.pid, this.timing.startedAt).map((row) => row.pid));
    } catch (error) { console.warn(`[e2e diagnostics] Could not inspect Electron descendants: ${String(error)}`); }
  }

  private async checkDescendants(): Promise<void> {
    if (this.descendantsChecked) return;
    cleanupDescendants(await listProcesses(), this.child.pid, this.timing.startedAt, this.timing);
    this.descendantsChecked = true;
    exitedApps.delete(this);
  }

  async dispose(options: { expectedAbnormalExit?: boolean } = {}): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { await this.quit(); }
      catch (error) { await this.forceStop(); throw error; }
    } else if (!options.expectedAbnormalExit) {
      await this.waitForExit();
    } else {
      this.queueDescendantCheck();
    }
  }
}
