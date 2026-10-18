import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, screen, shell, type Tray, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { CharacterAnimationMachine, MOVEMENT_FIELDS, DEFAULT_MOVEMENT_FALLBACKS, MOVEMENT_PHYSICS, PetMovement, SequencePlayer, calculateTerrain, isQuietNow, resolveBehavior, resolveMotionPlay, validUserCharacterId, validateBehavior, type AnimationSnapshot, type CharacterBehavior, type DoNotDisturbConfig, type LinePetEvent, type MovementSnapshot, type Motions, type PetEvent, type Reactions, type SequenceItem, type TerrainPlatform, type TerrainWall, type TerrainWindow, type VoiceTemplates, type VoiceLines } from "@deskpet/core";
import { ActionRegistry } from "./actions.js";
import { BubbleWindow, type BubbleAnchor } from "./bubble-window.js";
import { resolveInside } from "./capture-path.js";
import { loadCharacter, loadInteractions, loadMotions, loadReactions, loadSequences, loadVoiceTemplates, selectPackReaction, validCharacterId, type CharacterPack } from "./character.js";
import { createPackService, type PackSelection } from "./pack-service.js";
import { applyVoice, type VoiceCounters } from "./voice.js";
import { NotificationDelivery, type ShownBubble } from "./delivery.js";
import { createPackInteractionStore, fromPackInteractions, migrateSettingsInteractions, type InteractionStore } from "./interaction-store.js";
import { USER_DIRECT, buildPetMenuTemplate, createInteractionRunner, findPetMenuClick, getDefaultInteractions, interactionPlay, mergeInteractions, petMenuLabels, type PetInteraction } from "./pet-menu.js";
import { recordPetEvent, recentPetEvents } from "./events.js";
import { startEventServer, type EventServerState } from "./event-server.js";
import { FullscreenWatcher } from "./fullscreen-watcher.js";
import { applyFirstRunDefault, createFakeLoginItemApi, createLoginItem, saveLaunchAtLogin, type LoginItemApi } from "./login-item.js";
import { PowerShellTerrainSource, parseTerrainLine, validExcludedNames } from "./terrain-watcher.js";
import { DEFAULT_BADGE_PLACEMENT, DEFAULT_BUBBLE_DISPLAY, dedupeExcludedApps, loadSettings, msUntilNextQuietChange, writeSettings, type DeskpetSettings } from "./settings.js";
import { createPluginHostApp, type PermissionAnswer, type PluginHostApp } from "./plugin-host-app.js";
import { CheckerWindows } from "./checker-windows.js";
import { createPetTray } from "./tray.js";
import { createLogFile } from "./log-file.js";
import { createErrorLog, describeError, type ErrorCategory } from "./error-log.js";
import { createSettingsService } from "./settings-service.js";
import { SettingsWindow } from "./settings-window.js";
import { parseLaunchArgs } from "./launch-args.js";
import { pluginClockArgs } from "./plugin-clock-args.js";
import { probePlugin, UtilityPluginChannel } from "./utility-channel.js";
import { dragWindowPosition } from "./drag-position.js";
import { clampWindowForMovement, contentOnScreen, displayForPoint, footFromWindow, footOffset, hasSize, placeFoot,
  parseSavedPosition, type DisplayArea, type Point, type Rectangle, type SavedPosition } from "./position.js";

const SIZE = 256;
const SKIP_TASKBAR = true;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_IN_FLIGHT = 8;
// runPluginForTest step limit (hello, activate, exit): six Windows runs (2026-10-07) reached hello in 49-59 ms,
// so 10 s is a generous failure bound; real plugin timeouts are ADR-0005 §2 and live in the manager.
const PLUGIN_PROBE_STEP_MS = 10_000;
// Five concurrent Windows runs took up to 4.5 s to finish native Electron shutdown.
// Keep the kill fallback beyond that measured maximum so it cannot race a clean exit.
const QUIT_FORCE_KILL_MS = 6000;
const launch = parseLaunchArgs(process.argv, { isPackaged: app.isPackaged, env: process.env });
app.setName("deskpet");
const eventPort = launch.eventPort ?? 7777;
if (launch.userDataDir) {
  const directory = resolve(launch.userDataDir);
  mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
}
// ADR-0010 §7: logs/errors.log opens before the lock and any window so early failures are kept. Local only; no crashReporter.
const errorLog = createErrorLog({ dir: join(app.getPath("userData"), "logs") });
/** Never throws: reporting an error must not become one. Returns how often this exact record appeared in the last minute. */
function recordError(category: ErrorCategory, message: string): number {
  try { return errorLog.record(category, message); } catch { return 0; }
}
// ADR-0010 question 8: keep running after a main-process error; the same error more than five times in a minute ends the app.
const MAX_REPEATED_MAIN_ERRORS = 5;
function onMainError(category: "main:uncaughtException" | "main:unhandledRejection", error: unknown): void {
  const count = recordError(category, describeError(error));
  if (count > MAX_REPEATED_MAIN_ERRORS) {
    try { errorLog.flush(); quitApp(); } catch { app.exit(1); }
  }
}
process.on("uncaughtException", (error) => { onMainError("main:uncaughtException", error); });
process.on("unhandledRejection", (reason) => { onMainError("main:unhandledRejection", reason); });
// Electron scopes its singleton lock to userData, including the isolated e2e directories above.
if (!app.requestSingleInstanceLock()) {
  // ADR-0010 §2: the running instance shows its pet (second-instance below); a development run says why it left.
  if (!app.isPackaged) console.error("DeskPet is already running with this data folder; showing that pet and exiting.");
  app.exit(0);
}
// Test-only controls (permission answers, fetch target) exist only in an unpackaged run with a valid dev control name.
const devControlActive = launch.devControl !== undefined;
const terrainStartMode = launch.terrainSource;
// ADR-0010 §6: only an installed build writes the real login item. A development run with a dev control gets a recording stand-in
// (so e2e sees the calls and no registry value is written); any other development run has no login item at all.
const fakeLoginItemApi = !app.isPackaged && devControlActive ? createFakeLoginItemApi() : undefined;
const loginItem = createLoginItem(app.isPackaged ? (app as unknown as LoginItemApi) : fakeLoginItemApi);
if (devControlActive && launch.pluginsDir !== undefined) app.commandLine.appendSwitch("ignore-certificate-errors");
// ADR-0005 §4 and ADR-0010 §3: an explicit folder (e2e, development), else the repository plugins/, else the packaged resources.
const pluginsDir = launch.pluginsDir !== undefined ? resolve(launch.pluginsDir)
  : app.isPackaged ? join(process.resourcesPath, "plugins") : resolve(app.getAppPath(), "../../plugins");
const positionPath = join(app.getPath("userData"), "pet-position.json");
const settingsPath = join(app.getPath("userData"), "settings.json");
let savedPosition: SavedPosition | null = null;
let lastPositionWrite = 0;
let positionRetryDelayMs = 2_000;
let positionWriteFailures = 0;
const charactersDir = launch.charactersDir !== undefined ? launch.charactersDir
  : app.isPackaged ? join(process.resourcesPath, "characters") : resolve(app.getAppPath(), "../../characters");
const requestedCharacterId = launch.characterId;
let characterId = "placeholder";
let packService: ReturnType<typeof createPackService> | undefined;
let characterPack: CharacterPack | undefined;
let voiceTemplates: VoiceTemplates = {};
let voiceLines: VoiceLines = {};
let voiceProblems: string[] = [];
const voiceCounters: VoiceCounters = {};
let characterError: string | undefined;
let machine: CharacterAnimationMachine | undefined;
let snapshot: AnimationSnapshot = { state: "idle", frame: 0, movement: null };
let characterVersion = 0;
let selectionQueue: Promise<void> = Promise.resolve();
let clockMs = 0;
let deliveryClockMs = 0;
let deliveryLastRealMs = Date.now();
let deliveryClockPaused = false;
let clockPaused = false;
let lastRealMs = Date.now();
let lastTickMs = 0;
let walkDirection: "left" | "right" = "left";
let walkRemainder = 0;
let petMovement: PetMovement | undefined;
let movementState: MovementSnapshot | undefined;
let deferredReaction: PetEvent | undefined;
let deferredSequence: { interaction: PetInteraction; sequence: SequenceItem } | undefined;
let movementAnimation: string | null = null;
let renderedWaiter: (() => void) | undefined;
let frameSequence = 0;
const frameWaiters = new Map<number, () => void>();
let lastFrameRender: Promise<void> = Promise.resolve();
let animationTimer: ReturnType<typeof setInterval> | undefined;
let animationIntervalMs = 50;
let controlServer: Server | undefined;
let closeEventServer: (() => Promise<void>) | undefined;
let signalEventServerReady: (() => void) | undefined;
const eventServerReady = new Promise<void>((resolveReady) => { signalEventServerReady = resolveReady; });
let eventServerState: EventServerState = {
  ...(Number.isSafeInteger(eventPort) && eventPort >= 0 && eventPort <= 65535 ? { port: eventPort } : {}),
  listening: false,
  ...(launch.eventPort !== undefined && (!Number.isSafeInteger(eventPort) || eventPort < 0 || eventPort > 65535)
    ? { error: "Invalid event port" } : {}),
};
const controlSockets = new Set<Socket>();
let quitting = false;

function windowKind(contents: WebContents): string {
  try {
    if (petWindow && !petWindow.isDestroyed() && petWindow.webContents === contents) return "pet";
    const url = contents.getURL();
    if (url.endsWith("/bubble.html")) return "bubble";
    if (url.endsWith("/settings.html")) return "settings";
  } catch { return "unknown"; }
  return "checker";
}
app.on("render-process-gone", (_event, contents, details) => {
  if (quitting || details.reason === "clean-exit") return;
  recordError("renderer:gone", `window=${windowKind(contents)} reason=${details.reason} exitCode=${details.exitCode}`);
});
app.on("child-process-gone", (_event, details) => {
  if (quitting || details.reason === "clean-exit") return;
  recordError("child:gone", `type=${details.type} name=${details.serviceName ?? details.name ?? "-"} reason=${details.reason} exitCode=${details.exitCode}`);
});
// No renderer-to-main channel (ADR-0010 §7): console errors from our own pages are read here. Pages of other origins are not (an empty source is our own executeJavaScript).
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", (details) => {
    if (details.level !== "error" || !(details.sourceId === "" || details.sourceId.startsWith("file:"))) return;
    recordError("renderer:error", `window=${windowKind(contents)} source=${details.sourceId.split("/").pop() ?? ""}:${details.lineNumber} ${details.message}`);
  });
});

function startAnimationTimer(): void {
  if (!animationTimer && !clockPaused) animationTimer = setInterval(advanceClock, animationIntervalMs);
}

function refreshAnimationTimer(): void {
  // At 1,800 DIP/s the grounded 50 ms interval moves at most 90 DIP per frame;
  // the ADR's airborne 16 ms interval limits that jump to 28.8 DIP.
  const interval = movementState && !["grounded", "landing", "dragging"].includes(movementState.state)
    ? MOVEMENT_PHYSICS.stepMs : 50;
  if (interval === animationIntervalMs) return;
  animationIntervalMs = interval;
  stopAnimationTimer();
  if (ready && petWindow.isVisible()) startAnimationTimer();
}

function stopAnimationTimer(): void {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = undefined;
}
let petWindow: BrowserWindow;
let bubbleWindow: BubbleWindow | undefined;
let dismissWaiter: (() => void) | undefined;
let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
let doNotDisturb: DoNotDisturbConfig = { enabled: false };
let settings: DeskpetSettings = { doNotDisturb };
const userBehavior = (id: string): CharacterBehavior | undefined =>
  settings.characterBehavior && Object.hasOwn(settings.characterBehavior, id) ? settings.characterBehavior[id] : undefined;
let pluginHost: PluginHostApp | undefined;
let checkerWindows: CheckerWindows | undefined;
let externalOpensForTest = 0;
const externalUrlsForTest: string[] = [];
let settingsWindow: SettingsWindow | undefined;
let packDeleteAnswerForTest: boolean | undefined;
let unexpectedDialogForTest: string | undefined;
const unexpectedDialog = (name: string): void => { if (devControlActive) unexpectedDialogForTest ??= name; };
let pluginsStopped: Promise<void> | undefined;
let fullscreen = false;
let fullscreenForTest: boolean | undefined;
let terrainSource: PowerShellTerrainSource | undefined;
let terrainMode: "test" | "powershell" | "off" = terrainStartMode === "test" ? "test" : terrainStartMode === "off" ? "off" : "powershell";
/** Settings > 화면 위 이동 (ADR-0009 §10); the executable names stay in settings.json and are never put in state or logs. */
let terrainEnabled = true;
let terrainExcludedNames: string[] = [];
let terrainGeneration = 0;
let terrainSourceCreations = 0;
let terrainLogger: { info(message: string): void } = { info: () => undefined };
// Dev-control only: windows present from the first frame, so a restart e2e can have a window under the restored foot.
let terrainWindows: TerrainWindow[] = terrainStartMode === "test"
  ? parseTerrainLine(launch.terrainWindows ?? "[]") ?? [] : [];
let terrainPhysicalWindows: TerrainWindow[] = [];
let terrainPlatforms: TerrainPlatform[] = [];
let terrainWalls: TerrainWall[] = [];
let setDoNotDisturbChecked: ((checked: boolean) => void) | undefined;
let setPluginMenu: ((items: ReturnType<PluginHostApp["menu"]>) => void) | undefined;
let trayMenuLabels: (() => string[]) | undefined;
let trayToolTip: (() => string) | undefined;
/** The plugin lines, kept in one place so the tray and the pet's right-click menu show the same items. */
let pluginMenuItems: ReturnType<PluginHostApp["menu"]> = [];
let petMenuActions: Omit<Parameters<typeof buildPetMenuTemplate>[0]["actions"], "interact"> | undefined;
let trayDoNotDisturbChecked: (() => boolean) | undefined;
const fullscreenWatcher = new FullscreenWatcher({ onChange: (next) => {
  fullscreen = next;
  if (terrainMode === "powershell" && terrainEnabled) {
    if (fullscreenForTest ?? next) void terrainSource?.stop();
    else if (requestedVisible) terrainSource?.start();
  }
  calculateCurrentTerrain();
  pumpDelivery();
} });
/** The expression an event asked for, tracked so it ends (and repeats) on the animation clock. */
let reaction: { play: string; cycleMs: number; repeatAtMs: number; endAtMs: number; forceIdle: boolean;
  pendingBubbleText?: string; bubble?: ShownBubble } | undefined;
const sequencePlayer = new SequencePlayer();
let sequenceStep: { play: string; cycleMs: number; repeatAtMs: number; endAtMs: number } | undefined;
let packSequences = new Map<string, SequenceItem>();
let packReactions: Reactions = { kinds: {} };
let packMotions: Motions = { motions: {}, landing: "normal" };
let notificationSequence = false;
let suppressNotificationTalk = false;
const delivery = new NotificationDelivery({
  now: () => deliveryClockMs,
  active: petActive,
  quiet: () => isQuietNow(doNotDisturb, new Date()) || (fullscreenForTest ?? fullscreen),
  react: playReaction,
  bubbleChanged,
  schedule: scheduleDelivery,
});
const actions = new ActionRegistry();
// Harmless demo action: the pet reacts with a happy face. It gives /action/:id a real allowlist entry (M3-7).
actions.register("deskpet.ping", (args) => {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
    throw new Error("deskpet.ping takes no args or an object");
  receivePetEvent({ source: "deskpet", type: "react", mood: "happy" });
});
let tray: Tray | undefined;
let clickTrayMenuItem: ((label: string) => void) | undefined;
let ready = false;
let requestedVisible = true;
let ignoreMouseEvents = true;
let dragging = false;
let dragTimer: ReturnType<typeof setInterval> | undefined;
let grabOffset: Point | undefined;
let injectedDrag = false;
let hitTestGeneration = 0;
// Dev-control mouse input stays authoritative across frame hit tests, independent of the PC cursor.
let testMousePosition: Point | undefined;
let correctingWindowSize = false;

function petActive(): boolean {
  return ready && !petWindow.isDestroyed() && petWindow.isVisible();
}

function bubbleAnchor(): BubbleAnchor | undefined {
  return petActive() ? { content: contentOnScreen(petWindow.getBounds(), currentContentRect()), foot: currentFoot(), displays: displays() }
    : undefined;
}

function hasTalkState(): boolean {
  return characterPack !== undefined && Object.hasOwn(characterPack.manifest.states, "talk");
}

function requestState(state: string, atMs = clockMs): void {
  const wasWalking = snapshot.state === "walk";
  machine?.request(state, atMs);
  snapshot = machine?.tick(clockMs) ?? snapshot;
  if (snapshot.state === "walk" && snapshot.movement) {
    walkDirection = snapshot.movement.direction;
    walkRemainder = 0;
  }
  if (wasWalking && snapshot.state !== "walk" && !movementBusy()) savePosition();
}

function playReaction(event: PetEvent): void {
  if (movementBusy()) { deferredReaction = event; return; }
  if (sequencePlayer.active || sequenceStep) {
    if (event.type === "notify" && event.text && event.priority !== "low") stopSequence();
    else return;
  }
  const play = interactionPlay(event);
  const registeredLines = new Map(pluginHost?.lineCatalogs().flatMap(({ catalog }) => catalog.lines.map(({ id, kind }) => [id, kind] as const)) ?? []);
  const choice = selectPackReaction(event, packReactions, pluginHost?.reactionRules(),
    settings.lineReactions?.[characterId], registeredLines, new Set(packSequences.keys()));
  const showBubble = event.type === "notify" && !!event.text && event.priority !== "low";
  if (showBubble) suppressNotificationTalk = choice.mapped;
  if (play === undefined && choice.sequence !== undefined) {
    const sequence = packSequences.get(choice.sequence);
    if (sequence) { startNotificationSequence(sequence); return; }
  }
  const selected = play !== undefined ? { play } : choice.selected;
  const manifest = characterPack?.manifest;
  if (!selected || !machine || !manifest || dragging) return;
  requestState(selected.play);
  const state = manifest.states[snapshot.state];
  reaction = undefined;
  if (state && snapshot.state !== "idle") {
    const cycleMs = state.frames * 1_000 / state.fps;
    reaction = { play: selected.play, cycleMs, repeatAtMs: state.loop ? Infinity : clockMs + cycleMs,
      endAtMs: clockMs + (selected.durationMs ?? cycleMs * (selected.repeat ?? 1)),
      // Explicit interaction play ends at idle after one cycle, regardless of the state's next transition.
      forceIdle: play !== undefined || (choice.mapped && choice.sequence === undefined) || state.loop || selected.durationMs !== undefined,
      ...(showBubble ? { pendingBubbleText: event.text } : {}) };
  }
  void broadcastFrame();
}

function stopSequence(closeBubble = false): void {
  if (!sequencePlayer.active && !sequenceStep) return;
  sequencePlayer.stop();
  const wasNotification = notificationSequence;
  notificationSequence = false;
  sequenceStep = undefined;
  machine?.request("idle", clockMs);
  snapshot = machine?.tick(clockMs) ?? snapshot;
  if (closeBubble && !wasNotification && delivery.current) delivery.dismiss();
}

function sequenceState(play: string): string {
  const manifest = characterPack?.manifest;
  if (!manifest) return "idle";
  const visited = new Set<string>();
  let current = play;
  while (!visited.has(current)) {
    if (Object.hasOwn(manifest.states, current)) return current === "walk" || current === "drag" ? "idle" : current;
    visited.add(current);
    const next = Object.hasOwn(manifest.fallbacks, current) ? manifest.fallbacks[current] : undefined;
    if (next === undefined) break;
    current = next;
  }
  return "idle";
}

function startSequence(interaction: PetInteraction, sequence: SequenceItem): void {
  if (!machine || dragging) return;
  if (movementBusy()) { deferredSequence = { interaction, sequence }; return; }
  advanceClock();
  stopSequence(true);
  notificationSequence = false;
  reaction = undefined;
  const manifest = characterPack?.manifest;
  if (!manifest) return;
  sequencePlayer.start(sequence.steps.map((step) => {
    const play = sequenceState(step.play);
    const state = manifest.states[play];
    return { play, cycleMs: state ? state.frames * 1_000 / state.fps : 300,
      ...(step.ms !== undefined ? { ms: step.ms } : {}),
      ...(interaction.speak && step.say !== undefined ? { say: step.say } : {}) };
  }), clockMs);
  settleSequence();
  snapshot = machine.tick(clockMs);
  void broadcastFrame();
}

function startNotificationSequence(sequence: SequenceItem): void {
  if (!machine || dragging || !characterPack) return;
  reaction = undefined;
  notificationSequence = true;
  sequencePlayer.start(sequence.steps.map((step) => {
    const play = sequenceState(step.play);
    const state = characterPack?.manifest.states[play];
    return { play, cycleMs: state ? state.frames * 1_000 / state.fps : 300,
      ...(step.ms !== undefined ? { ms: step.ms } : {}) };
  }), clockMs);
  settleSequence();
  snapshot = machine.tick(clockMs);
  void broadcastFrame();
}

function settleSequence(): void {
  if (!machine || !sequencePlayer.active) return;
  for (const event of sequencePlayer.tick(clockMs)) {
    if (event.type === "end") {
      sequenceStep = undefined;
      machine.request("idle", event.atMs);
      if (!notificationSequence && delivery.current) delivery.dismiss();
      notificationSequence = false;
      continue;
    }
    machine.request(event.play, event.atMs);
    const state = characterPack?.manifest.states[event.play];
    const cycleMs = state ? state.frames * 1_000 / state.fps : 300;
    sequenceStep = { play: event.play, cycleMs, repeatAtMs: event.atMs + cycleMs,
      endAtMs: event.atMs + event.durationMs };
    if (event.say !== undefined) {
      const notice: PetEvent & { [USER_DIRECT]: true } = { source: "pet-menu", type: "notify",
        text: event.say, priority: "normal", ttlMs: Math.max(2_000, event.durationMs), [USER_DIRECT]: true };
      delivery.showImmediately(notice);
    }
  }
  if (sequenceStep) {
    while (sequenceStep.repeatAtMs < sequenceStep.endAtMs && sequenceStep.repeatAtMs <= clockMs) {
      machine.request(sequenceStep.play, sequenceStep.repeatAtMs);
      sequenceStep.repeatAtMs += sequenceStep.cycleMs;
    }
  }
}

function settleReaction(): void {
  if (!reaction || !machine) return;
  if (reaction.pendingBubbleText !== undefined || reaction.bubble !== undefined) return;
  while (reaction.repeatAtMs < reaction.endAtMs && reaction.repeatAtMs <= clockMs) {
    machine.request(reaction.play, reaction.repeatAtMs);
    reaction.repeatAtMs += reaction.cycleMs;
  }
  if (clockMs < reaction.endAtMs) return;
  if (reaction.forceIdle) machine.request("idle", reaction.endAtMs);
  reaction = undefined;
}

function bubbleChanged(bubble: ShownBubble | undefined): void {
  bubbleWindow?.set(bubble ? { sequence: bubble.sequence, text: bubble.text, detail: bubble.detail,
    fullText: bubble.fullText, parts: bubble.parts, priority: bubble.priority, actions: bubble.actions } : undefined);
  petWindow?.webContents.send("pet:bubble-visible", bubble !== undefined);
  if (reaction?.bubble && reaction.bubble !== bubble) {
    machine?.release(clockMs);
    snapshot = machine?.tick(clockMs) ?? snapshot;
    reaction = undefined;
    void broadcastFrame();
  }
  if (bubble && reaction?.pendingBubbleText === bubble.text && machine) {
    machine.request(reaction.play, clockMs, { hold: true });
    reaction.bubble = bubble;
    reaction.pendingBubbleText = undefined;
    snapshot = machine.tick(clockMs);
    void broadcastFrame();
  }
  if (!bubble) suppressNotificationTalk = false;
  if (!movementBusy() && !suppressNotificationTalk && !sequencePlayer.active && !sequenceStep &&
      (bubble ? !reaction && hasTalkState() && snapshot.state !== "talk" : snapshot.state === "talk")) {
    requestState(bubble ? "talk" : "idle");
    void broadcastFrame();
  }
}

function scheduleDelivery(atMs: number | undefined): void {
  if (deliveryTimer) clearTimeout(deliveryTimer);
  deliveryTimer = undefined;
  if (atMs === undefined || deliveryClockPaused || quitting || !petActive()) return;
  deliveryTimer = setTimeout(() => { deliveryTimer = undefined; pumpDelivery(); }, Math.max(1, Math.ceil(atMs - deliveryClockMs)));
}

function advanceDeliveryClock(): void {
  const now = Date.now();
  if (!deliveryClockPaused) deliveryClockMs += Math.max(0, now - deliveryLastRealMs);
  deliveryLastRealMs = now;
}

function pumpDelivery(): void {
  advanceClock();
  advanceDeliveryClock();
  delivery.pump();
  bubbleWindow?.refresh();
}

function bubbleExpanded(sequence: number, expanded: boolean): void {
  advanceDeliveryClock();
  delivery.setExpanded(sequence, expanded);
}

function scheduleQuietChange(): void {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = undefined;
  if (quitting) return;
  const wait = msUntilNextQuietChange(doNotDisturb, new Date());
  if (wait === undefined) return;
  quietTimer = setTimeout(() => {
    quietTimer = undefined;
    pumpDelivery();
    scheduleQuietChange();
  }, wait);
}

/** The one path that changes do-not-disturb, for the tray checkbox and the settings window alike. */
function applyDoNotDisturb(next: DoNotDisturbConfig): boolean {
  try { writeSettings(settingsPath, { ...settings, doNotDisturb: next }); }
  catch (error) { console.error("Save do-not-disturb settings:", error); return false; }
  doNotDisturb = next;
  settings.doNotDisturb = next;
  setDoNotDisturbChecked?.(next.enabled);
  pumpDelivery();
  scheduleQuietChange();
  return true;
}

function toggleDoNotDisturb(): void {
  if (applyDoNotDisturb({ ...doNotDisturb, enabled: !doNotDisturb.enabled }))
    settingsWindow?.notifyGeneralChanged({ enabled: doNotDisturb.enabled, schedule: (doNotDisturb.schedule ?? []).map(({ start, end }) => ({ start, end })) });
}

function receivePetEvent(event: PetEvent, immediately = false): void {
  deliverPetEvent(event, immediately);
}

/** Only the settings window's line send calls this with preview values; the public receive path above cannot. */
function deliverPetEvent(event: LinePetEvent, immediately: boolean, previewText?: string, previewVariant?: number): void {
  const counters = previewVariant !== undefined && event.line !== undefined
    ? { lines: { [event.line.id]: previewVariant } } : voiceCounters;
  const voiced = applyVoice(recordPetEvent(event), voiceTemplates, counters, {
    catalogs: pluginHost?.lineCatalogs().map(({ catalog }) => catalog) ?? [],
    packLines: voiceLines, overrides: settings.lineOverrides?.[characterId] ?? {},
  });
  const received = previewText !== undefined && voiced.line !== undefined && previewText !== voiced.text
    ? { ...voiced, text: previewText, fullText: undefined, parts: undefined } : voiced;
  advanceClock();
  advanceDeliveryClock();
  if (received.type === "notify") {
    if (!((immediately || sequencePlayer.active || sequenceStep) && delivery.showImmediately(received))) delivery.enqueue(received);
  }
  else if (received.type === "react") playReaction(received);
}

const runInteraction = createInteractionRunner((event, interaction) => {
  const sequence = interaction.sequence === undefined ? undefined : packSequences.get(interaction.sequence);
  if (sequence) startSequence(interaction, sequence);
  else {
    const interrupted = sequencePlayer.active || sequenceStep !== undefined;
    stopSequence(event.type !== "notify" || !event.text);
    receivePetEvent(event, interrupted);
  }
});
/** The user's interactions as the menu reads them (it is built synchronously); kept in step with the store. */
let userInteractions: PetInteraction[] = [];
async function refreshPackInteractions(pack: CharacterPack): Promise<void> {
  const sequences = await loadSequences(pack);
  packSequences = new Map(sequences.sequences.sequences.map((item) => [item.id, item]));
  packReactions = (await loadReactions(pack, new Set(packSequences.keys()))).reactions;
  packMotions = (await loadMotions(pack)).motions;
  petMovement?.setLanding(packMotions.landing);
  const { interactions, problems } = await loadInteractions(pack, new Set(packSequences.keys()));
  for (const problem of problems) console.warn(`Character ${pack.manifest.id} interactions: ${problem}`);
  userInteractions = fromPackInteractions(interactions);
}

function petMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  if (!petMenuActions) return [];
  const interactions = mergeInteractions(getDefaultInteractions(), userInteractions);
  return buildPetMenuTemplate({ interactions, pluginItems: pluginMenuItems,
    doNotDisturbChecked: trayDoNotDisturbChecked?.() ?? doNotDisturb.enabled,
    actions: { interact: runInteraction, ...petMenuActions } });
}

function dismissBubble(): void {
  advanceClock();
  delivery.dismiss();
  dismissWaiter?.();
  dismissWaiter = undefined;
}

async function invokeBubbleAction(index: number): Promise<void> {
  const bubble = delivery.current;
  const action = bubble?.actions?.[index];
  if (!action) return;
  try { await actions.invoke(action.action, action.args); }
  finally { if (delivery.current === bubble) dismissBubble(); }
}

function displays(): DisplayArea[] {
  return screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) =>
    ({ id, bounds, workArea, scaleFactor }));
}

function currentOffset(): Point {
  const manifest = characterPack?.manifest;
  const size = windowSize();
  return footOffset(size, manifest ? manifest.anchor[1] * manifest.scale + badgeTopMargin() : size.height * 0.875,
    manifest ? manifest.anchor[0] * manifest.scale + badgeSideMargin() : size.width / 2);
}

const BADGE_SIDE_MARGIN = 220;
// Chip height (23) + max gap (40) + slack, so the chip fits above content that touches the window top.
const BADGE_TOP_MARGIN = 70;
function badgeIsAbove(): boolean { return (settings.display?.badge?.side ?? "above") === "above"; }
function badgeSideMargin(): number { return badgeIsAbove() ? 0 : BADGE_SIDE_MARGIN; }
function badgeTopMargin(): number { return badgeIsAbove() ? BADGE_TOP_MARGIN : 0; }

function currentContentRect(): Rectangle {
  // The fallback is a filled circle centered at (128, 137) with radius 90.
  const content = characterPack?.contentRect ?? { x: 38, y: 47, width: 180, height: 180 };
  return { ...content, x: content.x + badgeSideMargin(), y: content.y + badgeTopMargin() };
}

function calculateCurrentTerrain(): void {
  ({ platforms: terrainPlatforms, walls: terrainWalls } = calculateTerrain((fullscreenForTest ?? fullscreen) ? [] : terrainWindows,
    displays(), currentContentRect()));
  if (petMovement) {
    const previousState = movementState?.state;
    movementState = petMovement.setTerrain(terrainPlatforms, displays(), terrainWalls);
    if ((previousState === "grounded" || previousState === "landing") &&
        movementState.state === "falling" && sequencePlayer.active) stopSequence();
    movementState = petMovement.setEnabled(motionEnabled());
    if (!motionEnabled() && movementAnimation) {
      movementAnimation = null;
      machine?.release(clockMs);
      snapshot = machine?.tick(clockMs) ?? snapshot;
    }
    applyMovementFoot();
    refreshAnimationTimer();
  }
}

// ADR-0009 15: a snapshot that cannot be converted is dropped; the previous terrain stays.
function acceptTerrainSnapshot(windows: readonly TerrainWindow[]): void {
  try {
    const converted = windows.map((window) => {
      const rect = screen.screenToDipRect(null, { x: window.x, y: window.y, width: window.w, height: window.h });
      return { id: window.id, x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height), platform: window.platform };
    });
    terrainPhysicalWindows = [...windows];
    terrainWindows = converted;
    calculateCurrentTerrain();
    if (ready) tickAnimation();
  } catch {
    console.warn("Terrain snapshot dropped");
  }
}

function terrainState(): { source: "test" | "powershell" | "off"; windows: number;
  platforms: TerrainPlatform[]; ready: boolean; pid: number | undefined;
  enabled: boolean; excludedCount: number; sourceCreations: number } {
  const active = terrainEnabled && terrainMode === "powershell" && terrainSource?.state.active === true;
  return { source: !terrainEnabled || (terrainMode === "powershell" && !active) ? "off" : terrainMode,
    windows: terrainWindows.length, platforms: terrainPlatforms,
    ready: !terrainEnabled || terrainMode !== "powershell" || terrainSource?.state.initialized === true,
    pid: active ? terrainSource?.state.pid : undefined,
    // Only the count: names would leak through the dev control (ADR-0009 §6 logs and state).
    enabled: terrainEnabled, excludedCount: terrainExcludedNames.length, sourceCreations: terrainSourceCreations };
}

function createTerrainSource(): void {
  terrainSource = new PowerShellTerrainSource({ excludedNames: terrainExcludedNames,
    log: (event) => terrainLogger.info(`Terrain watcher ${event}`) });
  terrainSource.onSnapshot(acceptTerrainSnapshot);
  terrainSourceCreations += 1;
}

/** Applies settings.terrain right away: off stops the watcher and returns the pet to M7 rules; a changed list rebuilds the watcher. */
async function applyTerrainSettings(): Promise<void> {
  const generation = ++terrainGeneration;
  const names = settings.terrain?.excludedApps ?? [];
  const listChanged = names.length !== terrainExcludedNames.length || names.some((name, index) => name !== terrainExcludedNames[index]);
  terrainEnabled = settings.terrain?.enabled ?? true;
  calculateCurrentTerrain();
  if (!terrainEnabled || listChanged) await terrainSource?.stop();
  // A newer apply owns the source now; a late one must not recreate or restart it.
  if (generation !== terrainGeneration) return;
  if (!terrainEnabled) {
    terrainWindows = [];
    terrainPhysicalWindows = [];
  }
  if (listChanged) {
    terrainExcludedNames = [...names];
    createTerrainSource();
  }
  if (terrainEnabled && terrainMode === "powershell" && requestedVisible && !(fullscreenForTest ?? fullscreen)) terrainSource?.start();
  calculateCurrentTerrain();
  tickAnimation();
}

function currentFoot(): Point {
  return footFromWindow(petWindow.getBounds(), currentOffset());
}

function motionEnabled(): boolean {
  const terrain = terrainState();
  return terrainEnabled && terrainMode !== "off" && ((fullscreenForTest ?? fullscreen) ||
    (terrain.source !== "off" && terrain.ready));
}

function movementBusy(): boolean {
  return motionEnabled() && movementState !== undefined &&
    !["grounded", "dragging"].includes(movementState.state);
}

function movementPlay(name: string): string {
  const manifest = characterPack?.manifest;
  if (!manifest) return "idle";
  return resolveMotionPlay(name, packMotions, manifest, DEFAULT_MOVEMENT_FALLBACKS);
}

function applyMovementFoot(): void {
  if (!petMovement || !petWindow || petWindow.isDestroyed() || !movementState) return;
  const offset = currentOffset();
  const foot = movementState.foot;
  moveWindowWithScaleChange({ x: Math.round(foot.x - offset.x), y: Math.round(foot.y - offset.y) });
}

function resetMovement(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const { climbChance, descendChance, climbSpeed, gravity, jumpMaxHeight, jumpClearance, gapJumpDistance, gapJumpChance } =
    resolveBehavior(characterPack?.manifest.behavior, userBehavior(characterId));
  petMovement = new PetMovement({ foot: currentFoot(), nowMs: clockMs, platforms: terrainPlatforms, walls: terrainWalls,
    displays: displays(), visibleSize: currentContentRect(), enabled: motionEnabled(),
    climbChance, descendChance, climbSpeed, gravity, jumpMaxHeight, jumpClearance, gapJumpDistance, gapJumpChance,
    landing: packMotions.landing });
  movementState = petMovement.snapshot();
  movementAnimation = null;
  refreshAnimationTimer();
}

function currentDisplay(): DisplayArea {
  return displayForPoint(currentFoot(), displays());
}

function savePosition(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (positionWriteFailures > 0 && Date.now() - lastPositionWrite < positionRetryDelayMs) return;
  lastPositionWrite = Date.now();
  try {
    const display = currentDisplay();
    const position: SavedPosition = { foot: currentFoot(), display: { id: display.id, bounds: display.bounds } };
    mkdirSync(dirname(positionPath), { recursive: true });
    const temporary = `${positionPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(position), "utf8");
    renameSync(temporary, positionPath);
    savedPosition = position;
    positionWriteFailures = 0;
    positionRetryDelayMs = 2_000;
  } catch (error) {
    console.error("Save pet position:", error);
    positionWriteFailures += 1;
    positionRetryDelayMs = Math.min(30_000, 2_000 * 2 ** (positionWriteFailures - 1));
  }
}

function fitCurrentPosition(): void {
  const placed = placeFoot(currentFoot(), currentOffset(), currentContentRect(), displays());
  moveWindowTo(placed.window);
  if (petMovement) movementState = petMovement.placeFoot(currentFoot());
  void refreshHitTest();
}

function correctWindowSize(): void {
  if (correctingWindowSize || petWindow.isDestroyed()) return;
  const size = windowSize();
  if (hasSize(petWindow.getBounds(), size) && hasSize(petWindow.getContentBounds(), size)) return;
  correctingWindowSize = true;
  try {
    const { x, y } = petWindow.getBounds();
    petWindow.setResizable(true);
    let requested = size;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      petWindow.setBounds({ x, y, ...requested }, false);
      const actual = petWindow.getBounds();
      const content = petWindow.getContentBounds();
      if (hasSize(actual, size) && hasSize(content, size)) break;
      requested = {
        width: Math.max(1, requested.width + size.width - actual.width),
        height: Math.max(1, requested.height + size.height - actual.height),
      };
    }
  } finally {
    petWindow.setResizable(false);
    correctingWindowSize = false;
  }
}

function moveWindowTo(position: Point): Electron.Rectangle {
  const size = windowSize();
  const bounds = petWindow.getBounds();
  if (bounds.x !== position.x || bounds.y !== position.y ||
      !hasSize(bounds, size) || !hasSize(petWindow.getContentBounds(), size)) {
    petWindow.setBounds({ x: position.x, y: position.y, ...size }, false);
    correctWindowSize();
  }
  bubbleWindow?.refresh();
  return petWindow.getBounds();
}

function setMousePassThrough(ignore: boolean): void {
  if (dragging || ignoreMouseEvents === ignore) return;
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
  ignoreMouseEvents = ignore;
}

function moveWindowBy(dx: number, dy: number, targetPoint?: Point): Electron.Rectangle {
  const bounds = petWindow.getBounds();
  const candidate = { x: bounds.x + dx, y: bounds.y + dy };
  const targetFoot = footFromWindow(candidate, currentOffset());
  const target = displayForPoint(targetPoint ?? targetFoot, displays());
  const positioned = clampWindowForMovement(candidate, currentContentRect(), target, displays());
  const moved = moveWindowWithScaleChange(positioned);
  if (petMovement) movementState = petMovement.placeFoot(currentFoot());
  return moved;
}

function moveWindowWithScaleChange(position: Point): Electron.Rectangle {
  const previousDisplay = currentDisplay();
  moveWindowTo(position);
  if (previousDisplay.id !== currentDisplay().id || previousDisplay.scaleFactor !== currentDisplay().scaleFactor) {
    petWindow.webContents.send("pet:scale-changed");
  }
  return petWindow.getBounds();
}

function stopDrag(): void {
  const wasDragging = dragging;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = undefined;
  grabOffset = undefined;
  injectedDrag = false;
  dragging = false;
  if (wasDragging) {
    if (petMovement) movementState = petMovement.endDrag(clockMs, currentFoot());
    machine?.endDrag(clockMs);
    tickAnimation();
    if (!motionEnabled()) { fitCurrentPosition(); savePosition(); }
    else if (movementState?.state === "grounded") savePosition();
  }
}

function moveDragCursor(cursor: Point): Electron.Rectangle {
  if (!dragging || !grabOffset) throw new Error("Drag has not started");
  const bounds = moveWindowWithScaleChange(dragWindowPosition(grabOffset, cursor, currentContentRect(), displays()));
  if (petMovement) movementState = petMovement.sampleDrag(clockMs, currentFoot());
  return bounds;
}

function commandCursor(request: object): Point {
  if (!("cursor" in request) || typeof request.cursor !== "object" || request.cursor === null ||
      !("x" in request.cursor) || !("y" in request.cursor) ||
      typeof request.cursor.x !== "number" || !Number.isFinite(request.cursor.x) ||
      typeof request.cursor.y !== "number" || !Number.isFinite(request.cursor.y)) {
    throw new Error("Drag command requires a finite cursor point");
  }
  return { x: request.cursor.x, y: request.cursor.y };
}

function startDrag(cursor: Point, injected: boolean): void {
  if (dragging) throw new Error("Drag already started");
  stopSequence(true);
  dragging = true;
  injectedDrag = injected;
  reaction = undefined;
  machine?.startDrag(clockMs);
  if (petMovement) movementState = petMovement.startDrag(clockMs, currentFoot());
  snapshot = machine?.tick(clockMs) ?? snapshot;
  void broadcastFrame();
  petWindow.setIgnoreMouseEvents(false);
  ignoreMouseEvents = false;
  const bounds = petWindow.getBounds();
  grabOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  if (!injected) dragTimer = setInterval(() => { moveDragCursor(screen.getCursorScreenPoint()); }, 16);
}

function characterState() {
  return { id: characterId, loaded: characterPack !== undefined, ...(characterError ? { error: characterError } : {}),
    state: snapshot.state, frame: snapshot.frame, states: characterPack ? Object.keys(characterPack.manifest.states) : [] };
}

function windowSize(): { width: number; height: number } {
  const manifest = characterPack?.manifest;
  return manifest ? { width: Math.round(manifest.cellSize[0] * manifest.scale) + 2 * badgeSideMargin(), height: Math.round(manifest.cellSize[1] * manifest.scale) + badgeTopMargin() }
    : { width: SIZE + 2 * badgeSideMargin(), height: SIZE + badgeTopMargin() };
}

function broadcastFrame(): Promise<void> {
  if (!ready || petWindow.isDestroyed()) return Promise.resolve();
  const sequence = ++frameSequence;
  lastFrameRender = new Promise<void>((resolveRendered) => {
    frameWaiters.set(sequence, resolveRendered);
    petWindow.webContents.send("pet:frame", { sequence, snapshot });
  });
  return lastFrameRender;
}

function tickAnimation(): void {
  if (!machine || !ready || !petWindow.isVisible()) { lastTickMs = clockMs; return; }
  const previous = snapshot;
  if (!movementBusy()) { settleReaction(); settleSequence(); }
  snapshot = machine.tick(clockMs);
  if (!movementBusy() && delivery.current && !suppressNotificationTalk && !reaction && !sequencePlayer.active && !sequenceStep && !dragging && snapshot.state === "idle" && hasTalkState()) {
    machine.request("talk", clockMs);
    snapshot = machine.tick(clockMs);
  }
  const elapsed = Math.min(250, Math.max(0, clockMs - lastTickMs));
  lastTickMs = clockMs;
  if (snapshot.state === "walk" && snapshot.movement && previous.walkStartedMs !== snapshot.walkStartedMs) {
    walkDirection = snapshot.movement.direction;
    walkRemainder = 0;
  }
  if (petMovement && motionEnabled() && !dragging) {
    if (snapshot.state === "walk" && snapshot.movement && movementState?.state === "grounded")
      petMovement.requestWalk(walkDirection, snapshot.movement.speedPxPerSecond);
    else petMovement.stopWalk();
    const priorMotion = movementState;
    movementState = petMovement.advance(clockMs);
    if (movementState.reverseWalk) {
      walkDirection = walkDirection === "left" ? "right" : "left";
      if (snapshot.state === "walk" && snapshot.movement)
        petMovement.requestWalk(walkDirection, snapshot.movement.speedPxPerSecond);
    }
    applyMovementFoot();
    const motionRequest = movementState.request;
    if (motionRequest && movementAnimation !== motionRequest) {
      movementAnimation = motionRequest;
      machine.request(movementPlay(motionRequest), clockMs, { hold: true });
      snapshot = machine.tick(clockMs);
    } else if (!motionRequest && movementAnimation) {
      const landed = movementAnimation === "land" && movementState.state === "grounded";
      movementAnimation = null;
      const afterLand = packMotions.afterLand?.play;
      const state = afterLand && Object.hasOwn(characterPack?.manifest.states ?? {}, afterLand)
        ? characterPack?.manifest.states[afterLand] : undefined;
      if (landed && afterLand && !dragging && !sequencePlayer.active && !sequenceStep && !deferredSequence && !deferredReaction &&
          state && !state.loop) machine.request(afterLand, clockMs);
      else machine.release(clockMs);
      snapshot = machine.tick(clockMs);
      if (deferredSequence) {
        const pending = deferredSequence;
        deferredSequence = undefined;
        startSequence(pending.interaction, pending.sequence);
      }
      if (deferredReaction) { const event = deferredReaction; deferredReaction = undefined; playReaction(event); }
    }
    if (priorMotion?.state !== movementState.state && movementState.state === "grounded") savePosition();
    refreshAnimationTimer();
    if (snapshot.state === "walk" && Date.now() - lastPositionWrite >= positionRetryDelayMs) savePosition();
  } else if (petMovement && !motionEnabled() && !dragging) {
    // Keep the movement clock current while it is off so turning it on does not replay the time it was off as one fall.
    petMovement.advance(clockMs);
  }
  if (!motionEnabled() && !dragging && snapshot.state === "walk" && elapsed > 0 && snapshot.movement) {
    const walkingElapsed = previous.walkStartedMs === snapshot.walkStartedMs
      ? elapsed : Math.min(elapsed, Math.max(0, clockMs - (snapshot.walkStartedMs ?? clockMs)));
    const distance = snapshot.movement.speedPxPerSecond * walkingElapsed / 1000 + walkRemainder;
    const pixels = Math.floor(distance);
    walkRemainder = distance - pixels;
    if (pixels > 0) {
      const before = petWindow.getBounds().x;
      moveWindowBy(walkDirection === "left" ? -pixels : pixels, 0);
      const after = petWindow.getBounds().x;
      if (Math.abs(after - before) < pixels) walkDirection = walkDirection === "left" ? "right" : "left";
      if (Date.now() - lastPositionWrite >= positionRetryDelayMs) savePosition();
    }
  }
  if (snapshot.state === "walk" && snapshot.movement && snapshot.movement.direction !== walkDirection) {
    snapshot = { ...snapshot, movement: { ...snapshot.movement, direction: walkDirection } };
  }
  if (previous.state === "walk" && snapshot.state !== "walk" && !movementBusy()) savePosition();
  if (previous.state !== snapshot.state || previous.frame !== snapshot.frame ||
      previous.movement?.direction !== snapshot.movement?.direction) void broadcastFrame();
}

function advanceClock(): void {
  const now = Date.now();
  if (!clockPaused && ready && petWindow.isVisible()) clockMs += Math.max(0, now - lastRealMs);
  lastRealMs = now;
  tickAnimation();
}

async function selectCharacter(id: string, selection?: PackSelection): Promise<void> {
  if (ready) { advanceClock(); stopAnimationTimer(); }
  const foot = petWindow && !petWindow.isDestroyed() ? currentFoot() : undefined;
  characterId = id;
  characterPack = undefined;
  characterError = undefined;
  voiceTemplates = {};
  voiceLines = {};
  voiceProblems = [];
  userInteractions = [];
  packSequences = new Map();
  packReactions = { kinds: {} };
  packMotions = { motions: {}, landing: "normal" };
  suppressNotificationTalk = false;
  stopSequence(true);
  try {
    const source = selection?.source ?? (packService?.list().find((item) => item.id === id)?.source ?? "builtin");
    const directory = source === "user" ? join(app.getPath("userData"), "characters") : charactersDir;
    characterPack = selection?.pack ?? await loadCharacter(directory, id, source === "user" ? charactersDir : undefined);
    ({ templates: voiceTemplates, lines: voiceLines, problems: voiceProblems } = await loadVoiceTemplates(directory, characterPack.manifest, characterPack, charactersDir));
    await refreshPackInteractions(characterPack);
  }
  catch (error) {
    characterError = error instanceof Error ? error.message : String(error);
    console.error(`Character ${id}:`, characterError);
  }
  machine = characterPack ? new CharacterAnimationMachine(characterPack.manifest, {
    clock: () => clockMs, ...resolveBehavior(characterPack.manifest.behavior, userBehavior(id)),
  }) : undefined;
  reaction = undefined;
  deferredReaction = undefined;
  deferredSequence = undefined;
  snapshot = machine?.tick(clockMs) ?? { state: "idle", frame: 0, movement: null };
  calculateCurrentTerrain();
  lastTickMs = clockMs;
  const version = ++characterVersion;
  if (!petWindow || petWindow.isDestroyed()) return;
  const position = placeFoot(foot ?? currentFoot(), currentOffset(), currentContentRect(), displays()).window;
  moveWindowTo(position);
  resetMovement();
  if (!movementBusy()) savePosition();
  if (ready) {
    const rendered = new Promise<void>((resolveRendered) => { renderedWaiter = resolveRendered; });
    petWindow.webContents.send("pet:character", { version, pack: characterPack, snapshot });
    await rendered;
    await refreshHitTest();
    if (petWindow.isVisible()) startAnimationTimer();
  }
}

function queuedCharacterSelection(character: string): Promise<ReturnType<typeof characterState>> {
  const result = selectionQueue.then(async () => {
    await selectCharacter(character);
    return characterState();
  });
  selectionQueue = result.then(() => undefined, () => undefined);
  return result;
}

function showPet(): void {
  requestedVisible = true;
  if (!ready) return;
  moveWindowTo(petWindow.getBounds());
  petWindow.show();
  if (terrainMode === "powershell" && terrainEnabled && !(fullscreenForTest ?? fullscreen)) terrainSource?.start();
  if (petMovement) movementState = petMovement.setTerrain(terrainPlatforms, displays(), terrainWalls);
  lastRealMs = Date.now();
  startAnimationTimer();
  petWindow.setAlwaysOnTop(true, "screen-saver");
  void refreshHitTest();
  pumpDelivery();
}

async function hidePet(): Promise<void> {
  advanceClock();
  stopSequence(true);
  reaction = undefined;
  machine?.request("idle", clockMs);
  snapshot = machine?.tick(clockMs) ?? snapshot;
  movementAnimation = null;
  stopAnimationTimer();
  requestedVisible = false;
  stopDrag();
  savePosition();
  hitTestGeneration += 1;
  setMousePassThrough(true);
  petWindow.hide();
  const stopped = terrainSource?.stop();
  terrainWindows = [];
  terrainPhysicalWindows = [];
  // Keep the last standing platform until the next snapshot after showing the pet.
  await stopped;
  pumpDelivery();
}

async function persistPositionForQuit(): Promise<void> {
  if (!petWindow || petWindow.isDestroyed()) return;
  const display = currentDisplay();
  const position: SavedPosition = { foot: currentFoot(), display: { id: display.id, bounds: display.bounds } };
  const temporary = `${positionPath}.${process.pid}.quit.tmp`;
  await mkdir(dirname(positionPath), { recursive: true });
  await writeFile(temporary, JSON.stringify(position), "utf8");
  await rename(temporary, positionPath);
  savedPosition = position;
}

async function closeAppResources(): Promise<void> {
  stopAnimationTimer();
  await pluginsStopped;
  await checkerWindows?.flushStores();
  pluginHost = undefined;
  settingsWindow?.destroy();
  settingsWindow = undefined;
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = undefined;
  await fullscreenWatcher.stop();
  await terrainSource?.stop();
  if (deliveryTimer) clearTimeout(deliveryTimer);
  deliveryTimer = undefined;
  if (closeEventServer) await closeEventServer();
  closeEventServer = undefined;
  dismissWaiter?.();
  dismissWaiter = undefined;
  bubbleWindow?.destroy();
  bubbleWindow = undefined;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = undefined;
  dragging = false;
  hitTestGeneration += 1;
  renderedWaiter?.();
  renderedWaiter = undefined;
  for (const resolveFrame of frameWaiters.values()) resolveFrame();
  frameWaiters.clear();
  for (const socket of controlSockets) socket.destroy();
  controlSockets.clear();
  if (controlServer?.listening) controlServer.close();
  controlServer = undefined;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = undefined;
}

function quitApp(): void {
  if (quitting) return;
  quitting = true;
  try { checkerWindows?.destroyAll(); }
  catch { console.warn("Checker window cleanup failed"); }
  try { errorLog.flush(); } catch { /* the error file must never block quitting */ }
  setTimeout(() => process.kill(process.pid, "SIGKILL"), QUIT_FORCE_KILL_MS);
  // Plugins stop in parallel with the position save; the manager caps its own cleanup at 3 s (ADR-0005 §4).
  pluginsStopped = pluginHost?.stop().catch((error: unknown) => { console.error("Stop plugins:", error); });
  void (async () => {
    let saveTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        persistPositionForQuit(),
        new Promise<never>((_resolve, reject) => {
          saveTimeout = setTimeout(() => reject(new Error("Position save timed out")), 1500);
        }),
      ]);
    } catch (error) { console.error("Save pet position on quit:", error); }
    finally {
      if (saveTimeout) clearTimeout(saveTimeout);
      try { await closeAppResources(); }
      catch (error) { console.error("Close pet resources:", error); }
      finally { app.exit(0); }
    }
  })();
}

async function hitTestAt(x: number, y: number): Promise<{ interactive: boolean; alpha: number }> {
  const result: unknown = await petWindow.webContents.executeJavaScript(`window.petHitTest(${x}, ${y})`);
  if (typeof result !== "object" || result === null ||
      !("interactive" in result) || typeof result.interactive !== "boolean" ||
      !("alpha" in result) || typeof result.alpha !== "number") {
    throw new Error("Invalid renderer hit test result");
  }
  return { interactive: result.interactive, alpha: result.alpha };
}

async function refreshHitTest(): Promise<void> {
  const generation = ++hitTestGeneration;
  if (!ready || !petWindow.isVisible()) { setMousePassThrough(true); return; }
  try {
    const bounds = petWindow.getBounds();
    const cursor = testMousePosition ?? screen.getCursorScreenPoint();
    const local = testMousePosition ?? { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    const hit = await hitTestAt(local.x, local.y);
    if (generation === hitTestGeneration && ready && petWindow.isVisible()) setMousePassThrough(!hit.interactive);
  } catch (error) {
    console.error("Pet hit test:", error);
    if (generation === hitTestGeneration) setMousePassThrough(true);
  }
}

function createPetWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const size = windowSize();
  const offset = currentOffset();
  const content = currentContentRect();
  const defaultFoot = { x: workArea.x + workArea.width - content.x - content.width + offset.x,
    y: workArea.y + workArea.height - content.y - content.height + offset.y };
  const position = placeFoot(savedPosition?.foot ?? defaultFoot, offset, content, displays()).window;
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: SKIP_TASKBAR,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.setIgnoreMouseEvents(true, { forward: true });

  window.webContents.on("render-process-gone", () => { ready = false; stopAnimationTimer(); stopDrag(); hitTestGeneration += 1; setMousePassThrough(true); pumpDelivery(); });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("Renderer load:", code, description);
    ready = false;
    stopDrag();
    hitTestGeneration += 1;
    setMousePassThrough(true);
  });
  void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

async function runCommand(request: unknown): Promise<unknown> {
  if (typeof request !== "object" || request === null || !("cmd" in request)) {
    throw new Error("Invalid request");
  }
  if (request.cmd === "state") {
    const rendererMetrics: unknown = ready ? await petWindow.webContents.executeJavaScript(
      "({ canvas: { width: document.querySelector('#pet').width, height: document.querySelector('#pet').height, clientWidth: document.querySelector('#pet').clientWidth, clientHeight: document.querySelector('#pet').clientHeight }, devicePixelRatio: window.devicePixelRatio, badge: window.petBadgeState() })",
    ) : null;
    return {
      visible: petWindow.isVisible(),
      bounds: petWindow.getBounds(),
      contentBounds: petWindow.getContentBounds(),
      contentRect: contentOnScreen(petWindow.getBounds(), currentContentRect()),
      expectedSize: windowSize(),
      displays: displays(),
      rendererMetrics,
      alwaysOnTop: petWindow.isAlwaysOnTop(),
      skipTaskbar: SKIP_TASKBAR,
      trayReady: tray !== undefined && !tray.isDestroyed(),
      ready,
      ignoreMouseEvents,
      cursor: screen.getCursorScreenPoint(),
      workArea: currentDisplay().workArea,
      display: (() => { const { id, scaleFactor, workArea } = currentDisplay(); return { id, scaleFactor, workArea }; })(),
      foot: currentFoot(),
      savedPosition,
      character: characterState(),
      eventServer: eventServerState,
      queue: { pending: delivery.pending },
      pluginHost: pluginHost?.state() ?? { ready: false, plugins: [], permissionPrompt: null, pids: {} },
      trayMenu: trayMenuLabels?.() ?? [],
      trayToolTip: trayToolTip?.() ?? null,
      trayDoNotDisturbChecked: trayDoNotDisturbChecked?.() ?? null,
      settings: settingsWindow?.state() ?? null,
      windowCount: BrowserWindow.getAllWindows().length,
      delivery: { timer: deliveryTimer !== undefined, nextAtMs: delivery.nextAtMs ?? null },
      doNotDisturb: { enabled: doNotDisturb.enabled, fullscreen: fullscreenForTest ?? fullscreen,
        scheduleTimer: quietTimer !== undefined },
      clock: { ms: clockMs, paused: clockPaused },
      bubble: await bubbleWindow?.state() ?? null,
      state: snapshot.state,
      movement: movementState ? { state: movementState.state, foot: movementState.foot,
        velocity: movementState.velocity, platformWindowId: movementState.standingPlatformId?.startsWith("floor:")
          ? null : movementState.standingPlatformId } : null,
      animationMovement: snapshot.movement,
      terrain: terrainState(),
    };
  }
  if (request.cmd === "eventServerReady") { await eventServerReady; return eventServerState; }
  if (request.cmd === "character") { advanceClock(); return characterState(); }
  if (request.cmd === "setState") {
    if (!("state" in request) || typeof request.state !== "string") throw new Error("setState requires a state string");
    reaction = undefined;
    requestState(request.state);
    await broadcastFrame();
    return characterState();
  }
  if (request.cmd === "setMovementDirection") {
    if (!("direction" in request) || (request.direction !== "left" && request.direction !== "right"))
      throw new Error("setMovementDirection requires left or right");
    snapshot = { ...snapshot, movement: { direction: request.direction,
      speedPxPerSecond: snapshot.movement?.speedPxPerSecond ?? 0 } };
    if (snapshot.state === "walk") walkDirection = request.direction;
    await broadcastFrame();
    return { state: snapshot.state, frame: snapshot.frame, movement: snapshot.movement };
  }
  if (request.cmd === "setFullscreenForTest") {
    if (!("fullscreen" in request) || typeof request.fullscreen !== "boolean")
      throw new Error("setFullscreenForTest requires a boolean fullscreen value");
    fullscreenForTest = request.fullscreen;
    if (terrainMode === "powershell" && terrainEnabled) {
      if (fullscreenForTest) await terrainSource?.stop();
      else if (requestedVisible) terrainSource?.start();
    }
    calculateCurrentTerrain();
    pumpDelivery();
    await bubbleWindow?.settled();
    return { fullscreen: fullscreenForTest };
  }
  if (request.cmd === "terrainSetForTest") {
    if (terrainMode !== "test") throw new Error("테스트 지형 모드에서만 창을 지정할 수 있어요");
    const windows = "windows" in request && Array.isArray(request.windows)
      ? parseTerrainLine(JSON.stringify(request.windows)) : undefined;
    if (!windows) throw new Error("창 목록 형식이 올바르지 않아요");
    terrainWindows = windows;
    calculateCurrentTerrain();
    tickAnimation();
    return terrainState();
  }
  if (request.cmd === "terrainOffForTest") {
    terrainMode = "off";
    await terrainSource?.stop();
    terrainWindows = [];
    terrainPhysicalWindows = [];
    calculateCurrentTerrain();
    tickAnimation();
    return terrainState();
  }
  if (request.cmd === "movementChancesForTest") {
    if (!("climbChance" in request) || !("descendChance" in request) ||
        typeof request.climbChance !== "number" || typeof request.descendChance !== "number" || !petMovement)
      throw new Error("movementChancesForTest requires climbChance and descendChance");
    petMovement.setChances(request.climbChance, request.descendChance);
    if ("gapJumpChance" in request && typeof request.gapJumpChance === "number") petMovement.configure({ gapJumpChance: request.gapJumpChance });
    return { climbChance: request.climbChance, descendChance: request.descendChance };
  }
  if (request.cmd === "advanceReminderClockForTest") {
    if (!("advanceMs" in request) || typeof request.advanceMs !== "number" ||
        !Number.isSafeInteger(request.advanceMs) || request.advanceMs < 0)
      throw new Error("advanceReminderClockForTest requires a non-negative integer advanceMs");
    // A config change sent just before (from the settings window) must have reached the plugin first.
    const started = Date.now();
    let stage = "pluginHost.idle";
    // A stalled wait would only show up as the e2e helper's "Dev control timed out"; name the stage that is still pending.
    const stallWarning = setTimeout(() => console.warn(`advanceReminderClockForTest still waiting for ${stage} after ${Date.now() - started}ms`), 5_000);
    let hostIdleMs: number;
    let schedulerIdleMs: number;
    try {
      await pluginHost?.idle();
      hostIdleMs = Date.now() - started;
      stage = "scheduler.idle";
      pluginHost?.scheduler.advanceForTest(request.advanceMs);
      // The callbacks run in plugin processes; wait for them so the bubble is already queued when this returns.
      await pluginHost?.scheduler.idle();
      schedulerIdleMs = Date.now() - started;
      stage = "bubbleWindow.settled";
      await bubbleWindow?.settled();
    } finally { clearTimeout(stallWarning); }
    // Per-step elapsed times (cumulative) let e2e runs show which wait is slow.
    return { advancedMs: request.advanceMs, stepsMs: { hostIdle: hostIdleMs, schedulerIdle: schedulerIdleMs, bubbleSettled: Date.now() - started } };
  }
  if (request.cmd === "setReminderClockForTest") {
    if (!("atMs" in request) || typeof request.atMs !== "number" || !Number.isSafeInteger(request.atMs))
      throw new Error("setReminderClockForTest requires an integer atMs");
    pluginHost?.scheduler.setTimeForTest(request.atMs);
    return { atMs: request.atMs };
  }
  if (request.cmd === "setPermissionAnswerForTest") {
    const answer = "answer" in request ? request.answer : undefined;
    if (answer !== null && !parsePermissionAnswer(answer)) throw new Error("setPermissionAnswerForTest requires allow, deny, hold or null");
    const once = "once" in request && request.once === true;
    pluginHost?.setPermissionAnswerForTest(answer === null ? undefined : parsePermissionAnswer(answer), once);
    return { answer, once };
  }
  if (request.cmd === "setSettingsCloseAnswerForTest") {
    const answer = "answer" in request ? request.answer : undefined;
    if (answer !== null && answer !== undefined && answer !== "close" && answer !== "edit")
      throw new Error("setSettingsCloseAnswerForTest requires close, edit or null");
    settingsWindow?.setCloseAnswerForTest(answer === null || answer === undefined ? undefined : answer);
    return { answer: answer ?? null };
  }
  if (request.cmd === "setSettingsConfirmAnswerForTest") {
    if (!("answer" in request) || (request.answer !== true && request.answer !== false && request.answer !== null))
      throw new Error("setSettingsConfirmAnswerForTest requires a boolean or null");
    settingsWindow?.setConfirmAnswerForTest(request.answer === null ? undefined : request.answer);
    return { answer: request.answer };
  }
  if (request.cmd === "setFetchTargetForTest") {
    const port = "port" in request ? request.port : undefined;
    if (port !== null && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error("setFetchTargetForTest requires a port or null");
    pluginHost?.setFetchTargetForTest(port === null ? undefined : port);
    return { port };
  }
  if (request.cmd === "setSlackTransportForTest") {
    const port = "port" in request ? request.port : undefined;
    if (port !== null && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error("setSlackTransportForTest requires a port or null");
    pluginHost?.setSlackTransportForTest(port === null ? undefined : port);
    return { port };
  }
  if (request.cmd === "setOrcaExecutableForTest") {
    if (app.isPackaged || !devControlActive || !pluginHost || !("path" in request) ||
        request.path !== null && typeof request.path !== "string")
      throw new Error("가짜 Orca CLI 경로가 필요합니다");
    await pluginHost.setOrcaExecutableForTest(request.path);
    return null;
  }
  if (request.cmd === "setOrcaTimeForTest") {
    if (app.isPackaged || !devControlActive || !pluginHost || !("atMs" in request) ||
        typeof request.atMs !== "number" || !Number.isSafeInteger(request.atMs))
      throw new Error("Orca 테스트 시각이 올바르지 않습니다");
    pluginHost.setOrcaTimeForTest(request.atMs);
    return { atMs: request.atMs };
  }
  if (request.cmd === "setOrcaWalDirectoryForTest") {
    if (app.isPackaged || !devControlActive || !pluginHost || !("path" in request) || typeof request.path !== "string")
      throw new Error("가짜 Orca 저장 경로가 필요합니다");
    await pluginHost.setOrcaWalDirectoryForTest(request.path);
    return null;
  }
  if (request.cmd === "checkerWindowsForTest") {
    return { windows: checkerWindows?.snapshotForTest() ?? [], externalOpens: externalOpensForTest,
      externalUrls: [...externalUrlsForTest] };
  }
  if (request.cmd === "checkerExecuteForTest" || request.cmd === "checkerCrashForTest" || request.cmd === "checkerCloseForTest") {
    if (!("pluginId" in request) || typeof request.pluginId !== "string" ||
        !("windowId" in request) || typeof request.windowId !== "string")
      throw new Error("checker command requires pluginId and windowId");
    if (request.cmd === "checkerCrashForTest") {
      checkerWindows?.crashForTest(request.pluginId, request.windowId);
      return { crashed: true };
    }
    if (request.cmd === "checkerCloseForTest") {
      checkerWindows?.closeForTest(request.pluginId, request.windowId);
      return { closed: true };
    }
    if (!("code" in request) || typeof request.code !== "string") throw new Error("checkerExecuteForTest requires code");
    return checkerWindows?.executeForTest(request.pluginId, request.windowId, request.code);
  }
  if (request.cmd === "loginItemCallsForTest") {
    // Development only: the calls the stand-in login item received (nothing is written to the registry).
    if (!fakeLoginItemApi) throw new Error("Login item stand-in is not active");
    return { calls: fakeLoginItemApi.calls };
  }
  if (request.cmd === "mainErrorForTest") {
    // Development only (reachable through the dev control): raises a real main-process error to prove it is recorded.
    const kind = "kind" in request ? request.kind : undefined;
    const message = "message" in request && typeof request.message === "string" ? request.message : "mainErrorForTest";
    if (kind === "throw") setImmediate(() => { throw new Error(message); });
    else if (kind === "reject") void Promise.reject(new Error(message));
    else throw new Error("mainErrorForTest requires kind throw or reject");
    return { raised: kind };
  }
  if (request.cmd === "crashRendererForTest") {
    const pid = petWindow.webContents.getOSProcessId();
    petWindow.webContents.forcefullyCrashRenderer();
    return { crashed: "pet", pid };
  }
  if (request.cmd === "rendererConsoleErrorForTest") {
    if (!("message" in request) || typeof request.message !== "string") throw new Error("rendererConsoleErrorForTest requires message");
    await petWindow.webContents.executeJavaScript(`console.error(${JSON.stringify(request.message)})`);
    return { logged: true };
  }
  if (request.cmd === "runPluginForTest") {
    if (!("root" in request) || typeof request.root !== "string" || !("pluginId" in request) || typeof request.pluginId !== "string")
      throw new Error("runPluginForTest requires root and pluginId strings");
    const kill = "kill" in request && request.kill === true;
    const idleMs = "idleMs" in request && typeof request.idleMs === "number" && Number.isSafeInteger(request.idleMs) ? request.idleMs : 0;
    return probePlugin({ runnerPath: join(__dirname, "plugin-runner.js"), scanRoot: request.root, id: request.pluginId,
      kill, idleMs, stepTimeoutMs: PLUGIN_PROBE_STEP_MS });
  }
  if (request.cmd === "setCharacter") {
    if (!("character" in request) || typeof request.character !== "string" || !validCharacterId(request.character)) throw new Error("setCharacter requires a single folder character");
    return queuedCharacterSelection(request.character);
  }
  if (request.cmd === "clock") {
    const provided = ["pause", "resume", "advanceMs"].filter((key) => key in request);
    const actions = new Set([...provided, ...("action" in request ? [request.action] : [])]);
    if (actions.size !== 1 || !["pause", "resume", "advanceMs"].includes([...actions][0] as string) ||
        ("pause" in request && request.pause !== true) || ("resume" in request && request.resume !== true))
      throw new Error("clock requires exactly one of pause, resume, advanceMs");
    const action = "action" in request ? request.action :
      ("pause" in request && request.pause === true ? "pause" :
        "resume" in request && request.resume === true ? "resume" :
          "advanceMs" in request ? "advanceMs" : undefined);
    if (action !== "pause" && action !== "resume" && action !== "advanceMs") throw new Error("clock requires pause, resume, or advanceMs");
    if (action === "pause") { advanceClock(); advanceDeliveryClock(); clockPaused = true; deliveryClockPaused = true; stopAnimationTimer(); pumpDelivery(); await lastFrameRender; }
    if (action === "resume") { clockPaused = false; deliveryClockPaused = false; lastRealMs = Date.now(); deliveryLastRealMs = lastRealMs; if (petWindow.isVisible()) startAnimationTimer(); pumpDelivery(); }
    if (action === "advanceMs") {
      if (!("advanceMs" in request) || typeof request.advanceMs !== "number" || !Number.isSafeInteger(request.advanceMs) || request.advanceMs < 0) throw new Error("clock advanceMs requires a non-negative integer");
      deliveryClockMs += request.advanceMs;
      if (petWindow.isVisible()) { clockMs += request.advanceMs; tickAnimation(); }
      pumpDelivery();
      await lastFrameRender;
    }
    await bubbleWindow?.settled();
    return { clockMs, paused: clockPaused, ...characterState(), bounds: petWindow.getBounds() };
  }
  if (request.cmd === "events") {
    const limit = "limit" in request ? request.limit : undefined;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error("events limit must be a non-negative integer");
    }
    return { events: recentPetEvents(limit) };
  }
  if (request.cmd === "tray") {
    if (!("action" in request)) throw new Error("tray requires an action");
    switch (request.action) {
      case "show": showPet(); return { visible: petWindow.isVisible() };
      case "hide": await hidePet(); return { visible: petWindow.isVisible() };
      case "quit": setImmediate(quitApp); return { quitting: true };
      default: throw new Error("Unknown tray action");
    }
  }
  if (request.cmd === "trayMenuClick") {
    if (!("label" in request) || typeof request.label !== "string") throw new Error("trayMenuClick requires a label");
    clickTrayMenuItem?.(request.label);
    await pluginHost?.idle();
    if (request.label === "방해 금지") await bubbleWindow?.settled();
    if (request.label === "설정…") await settingsWindow?.settled();
    if (request.label === "표시") await refreshHitTest();
    return request.label === "종료" ? { quitting: true } : { visible: petWindow.isVisible() };
  }
  if (request.cmd === "petMenuLabelsForTest") {
    if (!devControlActive || !petMenuActions) throw new Error("Pet menu is not available");
    return { labels: petMenuLabels(petMenuTemplate()) };
  }
  if (request.cmd === "petMenuClickForTest") {
    if (!devControlActive || !petMenuActions) throw new Error("Pet menu is not available");
    if (!("label" in request) || typeof request.label !== "string") throw new Error("petMenuClickForTest requires a label");
    const callback = findPetMenuClick(petMenuTemplate(), request.label);
    if (!callback) throw new Error("Unknown pet menu label");
    callback();
    await pluginHost?.idle();
    if (request.label === "방해 금지") await bubbleWindow?.settled();
    if (request.label === "설정…") await settingsWindow?.settled();
    return request.label === "종료" ? { quitting: true } : { visible: petWindow.isVisible() };
  }
  if (request.cmd === "settingsClose") {
    if (!settingsWindow) throw new Error("Settings window is not open");
    settingsWindow.close();
    return { closed: true };
  }
  if (request.cmd === "settingsPackCall") {
    if (!settingsWindow || !("method" in request) || typeof request.method !== "string" ||
        !["packsList", "packSelect", "packDelete", "packSaveVoice", "packSaveInteractions", "sequencesLoad", "sequencesSave", "reactionsLoad", "reactionsSave", "motionsLoad", "motionsSave", "packSaveMeta", "packVoiceLoad", "behaviorSave", "saveDeveloperMode", "terrainLoad", "terrainSave", "sheetPick", "sheetApply"].includes(request.method))
      throw new Error("settingsPackCall requires a pack method");
    const method = request.method as Parameters<SettingsWindow["invokePack"]>[0];
    const result = await settingsWindow.invokePack(method, "payload" in request ? request.payload : undefined);
    await bubbleWindow?.settled();
    return result;
  }
  if (request.cmd === "setPackDeleteAnswerForTest") {
    if (!("answer" in request) || (request.answer !== true && request.answer !== false && request.answer !== null))
      throw new Error("setPackDeleteAnswerForTest requires a boolean or null");
    packDeleteAnswerForTest = request.answer === null ? undefined : request.answer;
    return { answer: packDeleteAnswerForTest ?? null };
  }
  if (request.cmd === "setSheetFileAnswerForTest") {
    if (!devControlActive || !settingsWindow || !("path" in request) || typeof request.path !== "string")
      throw new Error("setSheetFileAnswerForTest requires a path");
    settingsWindow.setSheetFileAnswerForTest(request.path);
    return { ready: true };
  }
  if (request.cmd === "settingsClick" || request.cmd === "settingsSet" || request.cmd === "settingsQuery" || request.cmd === "settingsDump") {
    if (!settingsWindow) throw new Error("Settings window is not open");
    if (request.cmd === "settingsDump") return settingsWindow.dump();
    if (!("selector" in request) || typeof request.selector !== "string") throw new Error(`${request.cmd} requires a selector`);
    if (request.cmd === "settingsQuery") return settingsWindow.query(request.selector);
    if (request.cmd === "settingsClick") {
      if (!await settingsWindow.click(request.selector)) throw new Error("No element matches the selector");
      return { clicked: true };
    }
    if (!("value" in request) || (typeof request.value !== "string" && typeof request.value !== "boolean"))
      throw new Error("settingsSet requires a string or boolean value");
    if (!await settingsWindow.setValue(request.selector, request.value)) throw new Error("No element matches the selector");
    return { set: true };
  }
  if (request.cmd === "hitTest") {
    if (!("x" in request) || !("y" in request) ||
        typeof request.x !== "number" || !Number.isFinite(request.x) ||
        typeof request.y !== "number" || !Number.isFinite(request.y)) {
      throw new Error("hitTest requires finite x and y");
    }
    if (!ready) throw new Error("Pet is not ready");
    return hitTestAt(request.x, request.y);
  }
  if (request.cmd === "petMouseMoveForTest") {
    if (!devControlActive || !ready || !("x" in request) || !("y" in request) ||
        typeof request.x !== "number" || !Number.isFinite(request.x) ||
        typeof request.y !== "number" || !Number.isFinite(request.y)) throw new Error("petMouseMoveForTest requires finite x and y");
    testMousePosition = { x: request.x, y: request.y };
    hitTestGeneration += 1;
    petWindow.webContents.sendInputEvent({ type: "mouseMove", x: request.x, y: request.y });
    const badgeState: unknown = await petWindow.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => resolve(window.petBadgeState())))");
    setMousePassThrough(!(await hitTestAt(request.x, request.y)).interactive);
    return badgeState;
  }
  if (request.cmd === "petBadgeClickForTest" || request.cmd === "petBadgeDragForTest") {
    if (!devControlActive || !ready || !("x" in request) || !("y" in request) ||
        typeof request.x !== "number" || !Number.isFinite(request.x) ||
        typeof request.y !== "number" || !Number.isFinite(request.y)) throw new Error("petBadgeClickForTest requires finite x and y");
    return petWindow.webContents.executeJavaScript(`window.${request.cmd}(${request.x}, ${request.y})`);
  }
  if (request.cmd === "moveBy") {
    if (!("dx" in request) || !("dy" in request) ||
        typeof request.dx !== "number" || !Number.isFinite(request.dx) ||
        typeof request.dy !== "number" || !Number.isFinite(request.dy)) {
      throw new Error("moveBy requires finite dx and dy");
    }
    const bounds = moveWindowBy(request.dx, request.dy);
    tickAnimation();
    if (!movementBusy()) savePosition();
    return { bounds };
  }
  if (request.cmd === "dragStart") {
    if (!ready || !petWindow.isVisible()) throw new Error("Pet is not ready for dragging");
    startDrag(commandCursor(request), true);
    return { bounds: petWindow.getBounds(), state: snapshot.state };
  }
  if (request.cmd === "dragMove") {
    if (!injectedDrag) throw new Error("Injected drag has not started");
    return { bounds: moveDragCursor(commandCursor(request)), state: snapshot.state };
  }
  if (request.cmd === "dragEnd") {
    if (!injectedDrag) throw new Error("Injected drag has not started");
    stopDrag();
    return { bounds: petWindow.getBounds(), state: snapshot.state, foot: currentFoot() };
  }
  if (request.cmd === "bubbleDismiss") {
    if (!bubbleWindow) throw new Error("Bubble is not showing");
    // Clicks the tail in its renderer, so this takes the same path as a real mouse click.
    const dismissed = new Promise<void>((resolveDismissed) => { dismissWaiter = resolveDismissed; });
    try { await bubbleWindow.click(); }
    catch (error) { dismissWaiter = undefined; throw error; }
    await dismissed;
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleTextClick") {
    if (!bubbleWindow) throw new Error("Bubble is not showing");
    const dismissed = new Promise<void>((resolveDismissed) => { dismissWaiter = resolveDismissed; });
    let toggled: boolean;
    try { toggled = await bubbleWindow.clickText(); }
    catch (error) { dismissWaiter = undefined; throw error; }
    if (toggled) dismissWaiter = undefined;
    else await dismissed;
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleHintClick") {
    if (!bubbleWindow) throw new Error("Bubble is not showing");
    await bubbleWindow.clickHint();
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleWheelForTest") {
    if (!("deltaY" in request) || typeof request.deltaY !== "number" || !Number.isFinite(request.deltaY) || !bubbleWindow) {
      throw new Error("bubbleWheelForTest requires a showing bubble and finite deltaY");
    }
    await bubbleWindow.wheel(request.deltaY);
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleClose") {
    if (!bubbleWindow) throw new Error("Bubble is not showing");
    const dismissed = new Promise<void>((resolveDismissed) => { dismissWaiter = resolveDismissed; });
    try { await bubbleWindow.clickClose(); }
    catch (error) { dismissWaiter = undefined; throw error; }
    await dismissed;
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleContainsText") {
    if (!("text" in request) || typeof request.text !== "string" || !bubbleWindow) {
      throw new Error("bubbleContainsText requires text");
    }
    return { visible: await bubbleWindow.containsRenderedText(request.text) };
  }
  if (request.cmd === "bubbleAction") {
    if (!("index" in request) || typeof request.index !== "number" || !Number.isInteger(request.index) ||
        request.index < 0 || request.index >= (delivery.current?.actions?.length ?? 0) || !bubbleWindow) {
      throw new Error("bubbleAction requires a showing action button index");
    }
    const dismissed = new Promise<void>((resolveDismissed) => { dismissWaiter = resolveDismissed; });
    try { await bubbleWindow.clickAction(request.index); }
    catch (error) { dismissWaiter = undefined; throw error; }
    await dismissed;
    return { bubble: await bubbleWindow.state() };
  }
  if (request.cmd === "bubbleHitTest") {
    if (!("x" in request) || !("y" in request) ||
        typeof request.x !== "number" || !Number.isFinite(request.x) ||
        typeof request.y !== "number" || !Number.isFinite(request.y)) {
      throw new Error("bubbleHitTest requires finite x and y");
    }
    if (!bubbleWindow) throw new Error("Bubble is not ready");
    return { interactive: await bubbleWindow.hitTest(request.x, request.y) };
  }
  if (request.cmd === "bubbleScreenshot") {
    if (!("path" in request) || typeof request.path !== "string" || !request.path) {
      throw new Error("bubbleScreenshot requires a path");
    }
    if (!bubbleWindow) throw new Error("Bubble is not showing");
    // Unlike the older pet screenshot, this only writes inside the userData folder.
    const path = await resolveInside(app.getPath("userData"), request.path);
    const image = await bubbleWindow.capture();
    await writeFile(path, image.toPNG());
    const { width, height } = image.getSize();
    return { path, width, height };
  }
  if (request.cmd === "screenshot") {
    if (!("path" in request) || typeof request.path !== "string" || !request.path) {
      throw new Error("screenshot requires a path");
    }
    if (!ready) throw new Error("Pet is not ready");
    const path = resolve(request.path);
    if (petWindow.isVisible()) {
      await petWindow.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    }
    const image = await petWindow.webContents.capturePage();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, image.toPNG());
    const { width, height } = image.getSize();
    return { path, width, height };
  }
  throw new Error("Unknown command");
}

function parsePermissionAnswer(value: unknown): PermissionAnswer | undefined {
  return value === "allow" || value === "deny" || value === "hold" ? value : undefined;
}

function startControl(name: string): void {
  const pipePath = `\\\\.\\pipe\\deskpet-dev-${name}`;
  const server = createServer((socket) => {
    controlSockets.add(socket);
    let pending = "";
    let active = true;
    let inFlight = 0;
    const respond = (payload: unknown): void => { if (active && !socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`); };
    socket.setEncoding("utf8");
    socket.on("error", (error) => { console.error("Dev control socket:", error); active = false; });
    socket.on("close", () => { active = false; controlSockets.delete(socket); });
    socket.on("data", (chunk: string) => {
      if (!active) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          respond({ id: null, ok: false, error: "Request line exceeds 64 KiB" });
          active = false;
          socket.end();
          return;
        }
        if (inFlight >= MAX_IN_FLIGHT) {
          let id: unknown = null;
          try {
            const request: unknown = JSON.parse(line);
            if (typeof request === "object" && request !== null && "id" in request) id = request.id;
          } catch { /* The request is rejected for the connection limit. */ }
          respond({ id, ok: false, error: "Too many in-flight requests" });
          newline = pending.indexOf("\n");
          continue;
        }
        inFlight += 1;
        void (async () => {
          let id: unknown = null;
          try {
            const request: unknown = JSON.parse(line);
            if (typeof request === "object" && request !== null && "id" in request) id = request.id;
            const result = await runCommand(request);
            respond({ id, ok: true, result, unexpectedDialog: unexpectedDialogForTest });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            respond({ id, ok: false, error: message, unexpectedDialog: unexpectedDialogForTest });
          } finally {
            inFlight -= 1;
          }
        })();
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) {
        respond({ id: null, ok: false, error: "Request line exceeds 64 KiB" });
        active = false;
        socket.end();
      }
    });
  });
  server.on("error", (error) => { console.error("Dev control:", error); quitApp(); });
  server.listen(pipePath);
  controlServer = server;
}

ipcMain.on("pet:first-draw-complete", (event) => {
  if (event.sender !== petWindow.webContents || ready) return;
  ready = true;
  if (requestedVisible) showPet();
  else void refreshHitTest();
});

ipcMain.handle("pet:get-character", (event) => {
  if (event.sender !== petWindow.webContents) throw new Error("Invalid renderer");
  return { version: characterVersion, pack: characterPack, snapshot };
});

ipcMain.handle("pet:get-badge-display", (event) => {
  if (event.sender !== petWindow.webContents) throw new Error("Invalid renderer");
  return { badges: pluginHost?.badges() ?? [], bubbleVisible: delivery.current !== undefined,
    placement: settings.display?.badge ?? DEFAULT_BADGE_PLACEMENT,
    workArea: screen.getDisplayMatching(petWindow.getBounds()).workArea };
});

ipcMain.handle("pet:click-badge", async (event, pluginId: unknown, id: unknown) => {
  if (event.sender !== petWindow.webContents || typeof pluginId !== "string" || typeof id !== "string" ||
      !petActive() || dragging || delivery.current !== undefined) throw new Error("Invalid badge click");
  await pluginHost?.clickBadge(pluginId, id);
});

ipcMain.on("pet:character-rendered", (event, version: unknown) => {
  if (event.sender !== petWindow.webContents || version !== characterVersion) return;
  renderedWaiter?.();
  renderedWaiter = undefined;
});

ipcMain.on("pet:frame-rendered", (event, sequence: unknown) => {
  if (event.sender !== petWindow.webContents || typeof sequence !== "number") return;
  frameWaiters.get(sequence)?.();
  frameWaiters.delete(sequence);
  if (!dragging && petWindow.isVisible()) void refreshHitTest();
});

ipcMain.on("pet:set-mouse-pass-through", (event, ignore: unknown) => {
  if (event.sender === petWindow.webContents && typeof ignore === "boolean") setMousePassThrough(ignore);
});

ipcMain.on("pet:drag-start", (event) => {
  if (event.sender !== petWindow.webContents || dragging) return;
  startDrag(screen.getCursorScreenPoint(), false);
});

ipcMain.on("pet:context-menu", (event) => {
  // Not while dragging or before the pet is shown; the menu is built from the latest state each time.
  if (event.sender !== petWindow.webContents || dragging || !petActive() || !petMenuActions) return;
  Menu.buildFromTemplate(petMenuTemplate()).popup({ window: petWindow });
});

ipcMain.on("pet:drag-end", (event) => {
  if (event.sender === petWindow.webContents) stopDrag();
});

void app.whenReady().then(() => {
  void (async () => {
    try { savedPosition = parseSavedPosition(JSON.parse(await readFile(positionPath, "utf8")) as unknown); }
    catch { savedPosition = null; }
    settings = await loadSettings(settingsPath);
    terrainEnabled = settings.terrain?.enabled ?? true;
    terrainExcludedNames = [...(settings.terrain?.excludedApps ?? [])];
    doNotDisturb = settings.doNotDisturb;
    packService = createPackService({ builtinDir: charactersDir, userDataDir: app.getPath("userData"), settingsPath,
      getSettings: () => settings, setSettings: (next) => { settings = next; },
      apply: (selection) => selectCharacter(selection.id, "pack" in selection ? selection : undefined),
      refresh: async (selection) => {
        const directory = selection.source === "user" ? join(app.getPath("userData"), "characters") : charactersDir;
        characterPack = selection.pack;
        ({ templates: voiceTemplates, lines: voiceLines, problems: voiceProblems } = await loadVoiceTemplates(directory, selection.pack.manifest, selection.pack, charactersDir));
        await refreshPackInteractions(selection.pack);
      },
      notify: (message) => receivePetEvent({ source: "deskpet", type: "notify", key: "character-fallback", text: message,
        voice: { kind: "info", slots: { message } } }),
      isPackaged: app.isPackaged,
      chooseSheetFile: () => settingsWindow?.chooseSheetFile() ?? Promise.resolve(undefined),
      confirmDelete: async (id) => {
        if (packDeleteAnswerForTest !== undefined) return packDeleteAnswerForTest;
        if (devControlActive) { unexpectedDialog(`pack delete: ${id}`); return false; }
        return (await dialog.showMessageBox({ type: "warning", title: "캐릭터 팩 삭제",
          message: `${id} 팩을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`, buttons: ["삭제", "취소"],
          defaultId: 1, cancelId: 1, noLink: true })).response === 0;
      } });
    await packService.start(requestedCharacterId);
    await migrateSettingsInteractions({ packs: packService, path: settingsPath, get: () => settings,
      set: (next) => { settings = next; }, notify: (message) => receivePetEvent({ source: "deskpet", type: "notify",
        key: "interactions-migrated", text: message, voice: { kind: "info", slots: { message } } }) });
    const firstRun = applyFirstRunDefault({ packaged: app.isPackaged, defaultUserData: launch.userDataDir === undefined, settings, item: loginItem,
      save: (next) => { writeSettings(settingsPath, next); } });
    settings = firstRun.settings;
    petWindow = createPetWindow();
    scheduleQuietChange();
    fullscreenWatcher.start();
    calculateCurrentTerrain();
    resetMovement();
    petWindow.on("resize", correctWindowSize);
    petWindow.on("move", correctWindowSize);
    petWindow.on("move", () => bubbleWindow?.refresh());
    bubbleWindow = new BubbleWindow({ preload: join(__dirname, "../preload/bubble.cjs"),
      page: join(__dirname, "../renderer/bubble.html"), anchor: bubbleAnchor,
      display: () => settings.display?.bubble ?? DEFAULT_BUBBLE_DISPLAY,
      onDismiss: dismissBubble, onAction: invokeBubbleAction, onExpanded: bubbleExpanded });
    const logsDir = join(app.getPath("userData"), "logs");
    const logger = createLogFile({ dir: logsDir });
    terrainLogger = logger;
    createTerrainSource();
    if (terrainMode === "powershell" && terrainEnabled) terrainSource?.start();
    checkerWindows = new CheckerWindows(logger);
    pluginHost = createPluginHostApp({
      windows: checkerWindows,
      scanRoot: pluginsDir, userDataDir: app.getPath("userData"), actions,
      receivePetEvent, logger, env: process.env, safeStorage,
      onPluginExit: (pluginId, code, stderrTail) => {
        if (quitting || code === 0) return;
        recordError("plugin:exit", `id=${pluginId} code=${String(code)} stderr=${JSON.stringify(stderrTail.join("\n"))}`);
      },
      createChannel: (pluginId, entryPath) => new UtilityPluginChannel(join(__dirname, "plugin-runner.js"), entryPath, `plugin-${pluginId}`, pluginClockArgs(launch.pluginClock)),
      showPermissionDialog: async (options) => {
        if (devControlActive) { unexpectedDialog(`plugin permission: ${options.message}`); return false; }
        return (await dialog.showMessageBox(options)).response === 0;
      },
      openExternal: (url) => {
        externalOpensForTest++;
        externalUrlsForTest.push(url);
        return shell.openExternal(url);
      },
      fetch: (url, init) => fetch(url, init),
      execFile: (command, args, options, callback) => { execFile(command, args, options, callback); },
      getConfig: (pluginId) => Object.hasOwn(settings.plugins ?? {}, pluginId) ? settings.plugins?.[pluginId] ?? {} : {},
      saveConfig: (pluginId, next) => {
        const updated = { ...settings, plugins: { ...settings.plugins, [pluginId]: next } };
        writeSettings(settingsPath, updated);
        settings = updated;
      },
      httpActionAllowlist: () => settings.httpActionAllowlist ?? [],
    });
    if (devControlActive) {
      const answer = parsePermissionAnswer(launch.permissionAnswer);
      if (answer) pluginHost.setPermissionAnswerForTest(answer);
    }
    powerMonitor.on("resume", () => pluginHost?.resume());
    pluginHost.start();
    const handleDisplayChange = (): void => {
      if (!petWindow || petWindow.isDestroyed()) return;
      fitCurrentPosition();
      if (terrainMode === "powershell" && terrainEnabled) acceptTerrainSnapshot(terrainPhysicalWindows);
      else calculateCurrentTerrain();
      if (!movementBusy()) savePosition();
      petWindow.webContents.send("pet:scale-changed");
    };
    screen.on("display-added", handleDisplayChange);
    screen.on("display-removed", handleDisplayChange);
    screen.on("display-metrics-changed", handleDisplayChange);
    const interactionStore: InteractionStore = createPackInteractionStore(packService);
    const settingsService = createSettingsService({
      doNotDisturb: () => doNotDisturb,
      saveDoNotDisturb: applyDoNotDisturb,
      badgePlacement: () => settings.display?.badge ?? DEFAULT_BADGE_PLACEMENT,
      saveBadgePlacement: (badge) => {
        try {
          const foot = currentFoot();
          const next: DeskpetSettings = { ...settings, display: { ...settings.display, badge } };
          writeSettings(settingsPath, next);
          settings = next;
          moveWindowTo(placeFoot(foot, currentOffset(), currentContentRect(), displays()).window);
          resetMovement();
          petWindow.webContents.send("pet:badge-placement", badge);
          petWindow.webContents.send("pet:scale-changed");
          return true;
        } catch (error) { console.error("Save badge placement:", error); return false; }
      },
      bubbleDisplay: () => settings.display?.bubble ?? DEFAULT_BUBBLE_DISPLAY,
      saveBubbleDisplay: (bubble) => {
        try {
          const next: DeskpetSettings = { ...settings, display: { ...settings.display, bubble } };
          writeSettings(settingsPath, next);
          settings = next;
          return true;
        } catch (error) { console.error("Save bubble display:", error); return false; }
      },
      developerMode: () => ({ available: !app.isPackaged, enabled: !app.isPackaged && settings.developerMode === true }),
      saveDeveloperMode: (enabled) => {
        if (app.isPackaged) return false;
        try {
          const next = { ...settings, developerMode: enabled };
          writeSettings(settingsPath, next);
          settings = next;
          return true;
        } catch (error) { console.error("Save developer mode:", error); return false; }
      },
      launchAtLogin: () => loginItem.view(),
      saveLaunchAtLogin: (enabled) => {
        const next = saveLaunchAtLogin({ enabled, settings, item: loginItem, save: (value) => { writeSettings(settingsPath, value); } });
        if (!next) return false;
        settings = next;
        return true;
      },
      host: () => pluginHost,
      lineSettings: () => ({ settings, packId: characterId, catalogs: pluginHost?.lineCatalogs() ?? [], packLines: voiceLines,
        sequenceIds: new Set(packSequences.keys()) }),
      saveLineSettings: (next) => {
        try { writeSettings(settingsPath, next); settings = next; return true; }
        catch (error) { console.error("Save line settings:", error); return false; }
      },
      voice: () => ({ characterName: characterPack?.manifest.name ?? characterId, templates: voiceTemplates, problems: voiceProblems }),
      sendVoicePreview: (event) => { receivePetEvent(event); },
      sendLinePreview: (event, previewText, variant) => { deliverPetEvent(event, false, previewText, variant); },
      interactionStore,
      runInteraction,
      packs: packService,
    });
    const behaviorPack = async (id: unknown): Promise<CharacterPack> => {
      if (!validUserCharacterId(id)) throw new Error("팩 ID가 올바르지 않아요");
      const item = packService?.list().find((pack) => pack.id === id && pack.valid);
      if (!item) throw new Error("캐릭터 팩을 찾지 못했어요");
      if (characterId === id && characterPack) return characterPack;
      const directory = item.source === "user" ? join(app.getPath("userData"), "characters") : charactersDir;
      return loadCharacter(directory, id, item.source === "user" ? charactersDir : undefined);
    };
    const behaviorLoad = async (id: unknown) => {
      const pack = await behaviorPack(id);
      return { packId: pack.manifest.id, defaults: resolveBehavior(pack.manifest.behavior, undefined),
        behavior: resolveBehavior(pack.manifest.behavior, userBehavior(pack.manifest.id)),
        states: Object.keys(pack.manifest.states) };
    };
    const behaviorSave = async (payload: unknown) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
          !("packId" in payload) || !("behavior" in payload)) return { ok: false, message: "요청이 올바르지 않아요" };
      try {
        const pack = await behaviorPack(payload.packId);
        const value = payload.behavior;
        if (value !== null && (typeof value !== "object" || Array.isArray(value) ||
            validateBehavior(value).length > 0 ||
            Object.keys(value).some((key) => !["sleepAfterMs", "blinkIntervalMs", "walkIntervalMs", "walkDurationMs", "walkSpeedPxPerSecond", ...MOVEMENT_FIELDS].includes(key))))
          return { ok: false, message: "행동 값이 허용 범위를 벗어났어요" };
        const current = settings.characterBehavior ?? {};
        if (value !== null && !Object.hasOwn(current, pack.manifest.id) && Object.keys(current).length >= 64)
          return { ok: false, message: "캐릭터 행동 설정은 최대 64개까지 저장할 수 있어요" };
        const entries = Object.entries(current).filter(([id]) => id !== pack.manifest.id);
        const nextBehavior: Record<string, CharacterBehavior> = Object.fromEntries(value === null ? entries :
          [...entries, [pack.manifest.id, value as CharacterBehavior]]);
        const next: DeskpetSettings = { ...settings, characterBehavior: nextBehavior };
        writeSettings(settingsPath, next);
        settings = next;
        if (pack.manifest.id === characterId && machine) {
          advanceClock();
          const resolved = resolveBehavior(pack.manifest.behavior, value);
          machine.configure(resolved, clockMs);
          petMovement?.configure(resolved);
          tickAnimation();
        }
        return { ok: true, view: await behaviorLoad(pack.manifest.id) };
      } catch (error) {
        console.error("Save character behavior:", error);
        return { ok: false, message: "행동 설정을 저장하지 못했어요" };
      }
    };
    const terrainView = () => ({ enabled: settings.terrain?.enabled ?? true, excludedApps: settings.terrain?.excludedApps ?? [] });
    // The renderer check is only guidance; names and count are validated again here (ADR-0009 §10).
    const terrainSave = async (payload: unknown) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
          !("enabled" in payload) || !("excludedApps" in payload) || typeof payload.enabled !== "boolean")
        return { ok: false, message: "요청이 올바르지 않아요" };
      const names = payload.excludedApps;
      if (!validExcludedNames(names)) return { ok: false, message: "제외 앱 이름이 올바르지 않거나 64개를 넘었어요" };
      try {
        const next: DeskpetSettings = { ...settings, terrain: { enabled: payload.enabled, excludedApps: dedupeExcludedApps(names) } };
        writeSettings(settingsPath, next);
        settings = next;
        await applyTerrainSettings();
        return { ok: true, view: terrainView() };
      } catch (error) {
        console.error("Save terrain settings:", error);
        return { ok: false, message: "화면 위 이동 설정을 저장하지 못했어요" };
      }
    };
    settingsWindow = new SettingsWindow({ preload: join(__dirname, "../preload/settings.cjs"),
      page: join(__dirname, "../renderer/settings.html"), service: settingsService, sheets: packService,
      behaviorLoad, behaviorSave, terrainLoad: terrainView, terrainSave, devControlActive, sheetFileTestMode: devControlActive && launch.userDataDir !== undefined,
      onUnexpectedDialog: unexpectedDialog });
    const petTray = createPetTray({ showPet, hidePet, toggleDoNotDisturb, openSettings: () => settingsWindow?.open(),
      openLogsFolder: () => { void mkdir(logsDir, { recursive: true }).then(() => shell.openPath(logsDir)).then((error) => { if (error) console.error("Open logs folder:", error); }, (error: unknown) => { console.error("Open logs folder:", error); }); },
      quitApp: () => setImmediate(quitApp) });
    tray = petTray.tray;
    clickTrayMenuItem = petTray.clickMenuItem;
    setDoNotDisturbChecked = petTray.setDoNotDisturbChecked;
    setDoNotDisturbChecked(doNotDisturb.enabled);
    petMenuActions = { openSettings: () => settingsWindow?.open(), toggleDoNotDisturb, hidePet,
      openLogsFolder: () => { void mkdir(logsDir, { recursive: true }).then(() => shell.openPath(logsDir)).then((error) => { if (error) console.error("Open logs folder:", error); }, (error: unknown) => { console.error("Open logs folder:", error); }); },
      quitApp: () => setImmediate(quitApp) };
    setPluginMenu = (items) => {
      pluginMenuItems = items;
      petTray.setPluginMenu(items);
      const badges = pluginHost?.badges() ?? [];
      petTray.setBadgeSummary(badges.filter((badge) => badge.tone === "warn")
        .map((badge) => `${badge.pluginName}: ${badge.text}`));
      petWindow.webContents.send("pet:badges", badges);
    };
    trayMenuLabels = petTray.menuLabels;
    trayToolTip = petTray.toolTip;
    trayDoNotDisturbChecked = petTray.doNotDisturbChecked;
    // The menu is rebuilt whenever a plugin's state changes (ADR-0005 §4, user decision 3).
    pluginHost.onMenuChange(() => setPluginMenu?.(pluginHost?.menu() ?? []));
    setPluginMenu(pluginHost.menu());
    if (launch.devControl !== undefined) startControl(launch.devControl);
    else if (launch.invalidDevControl) console.error("Invalid dev control name");
    try {
      if (!eventServerState.error) {
        const started = await startEventServer({
          lineCatalogs: () => pluginHost?.lineCatalogs() ?? [],
          userDataDir: app.getPath("userData"), port: eventServerState.port ?? 7777,
          onEvent: receivePetEvent,
          onAction: (id, args) => pluginHost?.invokeHttpAction(id, args) ?? actions.invoke(id, args),
          status: () => ({ version: app.getVersion(), character: { id: characterId, state: snapshot.state },
            visible: petWindow.isVisible(), eventServer: { port: eventServerState.port },
            queue: { pending: delivery.pending }, plugins: pluginHost?.status() ?? [],
            orca: { fastDetection: pluginHost?.orcaFastDetectionStatus() ?? { enabled: false, message: "빠른 감지 꺼짐" } } }),
        });
        eventServerState = started.state;
        closeEventServer = started.close;
      }
    } finally { signalEventServerReady?.(); }
    if (firstRun.enabled) {
      const message = "Windows 시작 시 자동 실행을 켰어요. 설정 [일반]에서 끌 수 있어요";
      receivePetEvent({ source: "deskpet", type: "notify", key: "launch-at-login-first-run", text: message, voice: { kind: "info", slots: { message } } });
    }
  })();
});

// ADR-0010 §2: a second launch with the same data folder asks this instance to show its pet instead of vanishing.
app.on("second-instance", () => { showPet(); });
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitApp();
});
app.on("window-all-closed", quitApp);
