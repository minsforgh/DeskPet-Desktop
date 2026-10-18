import type { CheckerWindowHandle } from "@deskpet/plugin-sdk";
import type { PluginContext } from "@deskpet/plugin-sdk/v2";
import type { LinePetEvent } from "@deskpet/core";
import { attendancePhase } from "./attendance-phase.js";
import type { AttendancePhase } from "./attendance-phase.js";
import { CHECKER_URL, CHECKER_WINDOW_ID, fetchAttendance, openChecker } from "./checker.js";
import { createPluginClock } from "./clock.js";
import { decide, initialNotifyState, manualKey } from "./reaction.js";
import type { Badge, NotifyState, Observation } from "./reaction.js";
import { afterOpen, nextDelayMs } from "./schedule.js";
import { describeStatus } from "./status-text.js";

const FIRST_POLL_MS = 5_000;
// Fake-clock measurement: 5-second intervals allow at most 12 polls in a 60-second window; watch expires at 180 seconds.
const LOGIN_WATCH_MS = 3 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Fake-clock boundary cases measured the latest next poll at 04:00:05, 10:00:05, and 23:00:05 KST.
const BOUNDARY_SECONDS = [4 * 3600 + 5, 10 * 3600 + 5, 23 * 3600 + 5];

export interface MonitorDeps {
  now(): Date;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface Monitor {
  checkNow(manual?: boolean): Promise<void>;
  showLogin(): Promise<void>;
  openAttendance(): Promise<void>;
  dispose(): void;
}

type MonitorContext = Pick<PluginContext, "windows" | "schedule" | "log" | "setBadge"> & {
  emit(event: LinePetEvent): void;
};

function untilNextBoundary(now: Date): number {
  const kstMs = now.getTime() + KST_OFFSET_MS;
  const sinceMidnight = ((kstMs % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.min(...BOUNDARY_SECONDS.map((seconds) => {
    const target = seconds * 1000;
    return target > sinceMidnight ? target - sinceMidnight : DAY_MS - sinceMidnight + target;
  }));
}

export function createMonitor(
  ctx: MonitorContext,
  deps: MonitorDeps = {
    now: createPluginClock(process.argv),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
  },
): Monitor {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handle: Promise<CheckerWindowHandle> | undefined;
  let opening: Promise<void> = Promise.resolve();
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let fastPollsLeft = 0;
  let fastEpoch = 0;
  let windowEpoch = 0;
  let watchUntil: number | undefined;
  let manualPending = false;
  let state: NotifyState = initialNotifyState;
  let lastPhase: AttendancePhase = "NeedStart";
  let lastBadge: Badge | null = null;

  const clearScheduled = (): void => {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
  };

  const schedule = (ms: number): void => {
    clearScheduled();
    if (!disposed) timer = deps.setTimer(() => { void checkNow(); }, ms);
  };

  const forgetWindow = (): Promise<void> => {
    const old = handle;
    handle = undefined;
    return old?.then((window) => window.dispose(), () => undefined) ?? Promise.resolve();
  };

  const ensureWindow = (): Promise<CheckerWindowHandle> => {
    if (handle === undefined) {
      const created = openChecker(ctx);
      handle = created;
      created.catch(() => { if (handle === created) handle = undefined; });
    }
    return handle;
  };

  const runPoll = async (): Promise<void> => {
    const pollEpoch = fastEpoch;
    const pollWindowEpoch = windowEpoch;
    let obs: Observation;
    try {
      const current = ensureWindow();
      obs = await fetchAttendance(await current, deps.now(), () => {
        if (handle === current) void forgetWindow();
      });
    } catch {
      obs = { kind: "error" };
    }
    if (disposed || pollWindowEpoch !== windowEpoch) return;

    const now = deps.now();
    const decision = decide(state, obs, now);
    state = decision.next;
    if (decision.event) ctx.emit(decision.event);
    // Rapid manual clicks share the in-flight poll; they get one result bubble. The stable
    // per-status key lets the app queue replace an undelivered duplicate instead of stacking
    // same-content bubbles (plan 8-2 merge rule).
    const manualAsked = manualPending;
    manualPending = false;
    if (!decision.event && manualAsked) {
      const { line, mood, actions } = describeStatus(obs, now);
      ctx.emit({ source: "jungle", type: "notify", key: manualKey(obs, now),
        line, mood, priority: "normal", ttlMs: 5_000, ...(actions.length > 0 ? { actions } : {}) });
    }
    if (decision.badge?.text !== lastBadge?.text || decision.badge?.tone !== lastBadge?.tone) {
      ctx.setBadge("jungle.status", decision.badge);
      lastBadge = decision.badge;
    }

    let phase = lastPhase;
    let remainingSeconds: number | undefined;
    if (obs.kind === "ok") {
      const attendance = attendancePhase(now, obs);
      phase = attendance.phase;
      remainingSeconds = attendance.remainingSeconds;
      lastPhase = phase;
    }
    if (obs.kind === "ok" && watchUntil !== undefined) {
      watchUntil = undefined;
      fastPollsLeft = afterOpen();
      fastEpoch += 1;
    } else if (pollEpoch === fastEpoch && fastPollsLeft > 0) fastPollsLeft -= 1;
    const outcome = obs.kind === "noCohort" ? "needsLogin" : obs.kind;
    let delay = nextDelayMs({
      phase, remainingSeconds, now, outcome,
      consecutiveErrors: state.consecutiveErrors, fastPollsLeft,
      loginWatch: watchUntil !== undefined && now.getTime() < watchUntil,
    });
    if (obs.kind === "ok") delay = Math.min(delay, untilNextBoundary(now));
    ctx.log.info(`jungle: poll kind=${obs.kind} phase=${phase} nextSec=${Math.ceil(delay / 1000)}`);
    schedule(delay);
  };

  const checkNow = (manual = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (manual) manualPending = true;
    clearScheduled();
    if (inFlight) return inFlight;
    const running = runPoll();
    const settled = running.finally(() => { if (inFlight === settled) inFlight = undefined; });
    inFlight = settled;
    return settled;
  };

  const replaceVisibleWindow = async (): Promise<void> => {
    if (disposed) return;
    windowEpoch += 1;
    await forgetWindow();
    if (disposed) return;
    try {
      const created = ctx.windows.create(CHECKER_WINDOW_ID, {
        url: CHECKER_URL,
        show: true,
        width: 1000,
        height: 760,
        title: "정글 LMS",
      });
      handle = created;
      await created;
      if (disposed) {
        await forgetWindow();
        return;
      }
      watchUntil = deps.now().getTime() + LOGIN_WATCH_MS;
      fastPollsLeft = 0;
      schedule(FIRST_POLL_MS);
    } catch (error) {
      await forgetWindow();
      schedule(FIRST_POLL_MS);
      throw error;
    }
  };

  const openVisibleWindow = (): Promise<void> => {
    const opened = opening.then(replaceVisibleWindow);
    opening = opened.catch(() => undefined);
    return opened;
  };

  const resume = ctx.schedule.onResume(() => { void checkNow(); });
  // Fake-clock measurement: no first request by 4,999 ms; request at 5,000 ms (maximum 5,000 ms).
  schedule(FIRST_POLL_MS);

  return {
    checkNow,
    showLogin: openVisibleWindow,
    openAttendance: openVisibleWindow,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      resume.dispose();
      void forgetWindow();
    },
  };
}
