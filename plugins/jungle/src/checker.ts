import type { CheckerWindowHandle, PluginContext } from "@deskpet/plugin-sdk";
import { parseToday } from "./today.js";
import type { Observation } from "./reaction.js";

export const CHECKER_WINDOW_ID = "lms-checker";
export const CHECKER_URL = "https://jungle-lms.krafton.com/check-in";
const COHORTS_PATH = "/api/v2/me/cohorts";
const MAX_SHAPE_DEPTH = 6;
const MAX_SHAPE_KEYS = 50;

/** Structure only: key names and value types, never values. */
export type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "unknown"
  | { array: { length: number; first?: Shape } }
  | { object: Record<string, Shape> };

export type CheckResult =
  | { kind: "needsLogin" }
  | { kind: "noCohort" }
  | { kind: "unexpectedShape" }
  | { kind: "ok"; cohortCount: number; activeCount: number; todayShape: Shape }
  | { kind: "apiError"; status: number; step: "cohorts" | "today" };

export type CohortSelection =
  | { kind: "selected"; id: string; activeCount: number }
  | { kind: "noCohort" }
  | { kind: "unexpectedShape" };

const COHORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface Candidate {
  id: unknown;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Picks the active cohort: earliest endDate not yet past, else latest endDate; unparsable dates rank last. */
export function selectCohort(cohorts: unknown, now: Date): CohortSelection {
  const candidates: Candidate[] = [];
  if (Array.isArray(cohorts)) {
    for (const item of cohorts) {
      if (!isRecord(item) || item.isActive !== true) continue;
      const end = typeof item.endDate === "string" ? Date.parse(item.endDate) : Number.NaN;
      candidates.push({ id: item.id, end });
    }
  }
  if (candidates.length === 0) return { kind: "noCohort" };
  const nowMs = now.getTime();
  const upcoming = candidates.filter((c) => !Number.isNaN(c.end) && c.end >= nowMs)
    .sort((a, b) => a.end - b.end);
  const past = candidates.filter((c) => !Number.isNaN(c.end) && c.end < nowMs)
    .sort((a, b) => b.end - a.end);
  const unparsable = candidates.filter((c) => Number.isNaN(c.end));
  const id = (upcoming[0] ?? past[0] ?? unparsable[0])?.id;
  if (typeof id !== "string" || !COHORT_ID_PATTERN.test(id)) return { kind: "unexpectedShape" };
  return { kind: "selected", id, activeCount: candidates.length };
}

export function describeShape(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (depth >= MAX_SHAPE_DEPTH) return "unknown";
  if (Array.isArray(value)) {
    const array: { length: number; first?: Shape } = { length: value.length };
    if (value.length > 0) array.first = describeShape(value[0], depth + 1);
    return { array };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, MAX_SHAPE_KEYS)
      .map(([key, child]): [string, Shape] => [key, describeShape(child, depth + 1)]);
    return { object: Object.fromEntries(entries) };
  }
  return "unknown";
}

/** Creates the hidden checker window. Showing it requires a user action. */
export function openChecker(ctx: Pick<PluginContext, "windows">): Promise<CheckerWindowHandle> {
  return ctx.windows.create(CHECKER_WINDOW_ID, {
    url: CHECKER_URL,
    show: false,
    width: 1000,
    height: 760,
    title: "정글 LMS",
  });
}

function isNeedsLogin(status: number): boolean {
  return status === 401 || (status >= 300 && status < 400);
}

/** Reads only attendance booleans; response values never leave this function. */
export async function fetchAttendance(
  handle: CheckerWindowHandle,
  now: Date,
  onWindowFailure?: () => void,
): Promise<Observation> {
  try {
    const cohorts = await handle.getJson(COHORTS_PATH);
    if (isNeedsLogin(cohorts.status)) return { kind: "needsLogin" };
    if (cohorts.status !== 200) return { kind: "error" };

    const selection = selectCohort(cohorts.body, now);
    if (selection.kind === "noCohort") return { kind: "noCohort" };
    if (selection.kind === "unexpectedShape") return { kind: "error" };

    const today = await handle.getJson(`${COHORTS_PATH}/${encodeURIComponent(selection.id)}/attendance/today`);
    if (isNeedsLogin(today.status)) return { kind: "needsLogin" };
    if (today.status !== 200) return { kind: "error" };
    const parsed = parseToday(today.body);
    return parsed.kind === "ok"
      ? { kind: "ok", started: parsed.started, ended: parsed.ended }
      : { kind: "error" };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && (error.code === "E_UNAVAILABLE" || error.code === "E_DISPOSED")) onWindowFailure?.();
    return { kind: "error" };
  }
}

/** Two GETs: the cohort list, then today's attendance of the selected cohort. Returns codes and counts only. */
export async function checkOnce(handle: CheckerWindowHandle, now: Date): Promise<CheckResult> {
  const cohortsResponse = await handle.getJson(COHORTS_PATH);
  if (isNeedsLogin(cohortsResponse.status)) return { kind: "needsLogin" };
  if (cohortsResponse.status !== 200) return { kind: "apiError", status: cohortsResponse.status, step: "cohorts" };

  const selection = selectCohort(cohortsResponse.body, now);
  if (selection.kind !== "selected") return { kind: selection.kind };

  const today = await handle.getJson(`${COHORTS_PATH}/${encodeURIComponent(selection.id)}/attendance/today`);
  if (isNeedsLogin(today.status)) return { kind: "needsLogin" };
  if (today.status !== 200) return { kind: "apiError", status: today.status, step: "today" };
  return {
    kind: "ok",
    cohortCount: Array.isArray(cohortsResponse.body) ? cohortsResponse.body.length : 0,
    activeCount: selection.activeCount,
    todayShape: describeShape(today.body),
  };
}
