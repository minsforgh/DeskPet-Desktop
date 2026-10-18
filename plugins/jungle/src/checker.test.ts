import { describe, expect, it } from "vitest";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import { validatePluginManifest } from "@deskpet/plugin-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkOnce, describeShape, fetchAttendance, openChecker, selectCohort } from "./checker.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));
const COHORTS = "/api/v2/me/cohorts";
const SECRET = "someone@example.com";
const NOW = new Date("2026-10-08T00:00:00Z");
const FAKE_ID = "COH_fake-01";
const FAKE_NAME = "FAKE-NAME-ZZZ";
const FAKE_DATE = "2031-02-03T04:05:06Z";

type Responses = Record<string, { status: number; body: unknown }>;

function cohort(over: Record<string, unknown> = {}) {
  return {
    id: FAKE_ID, name: FAKE_NAME, courseName: "FAKE-COURSE", courseId: "c1", cohortClassId: "k1",
    cohortClassName: "FAKE-CLASS", startDate: "2031-01-01T00:00:00Z", endDate: FAKE_DATE,
    isActive: true, enabledFeatures: ["attendance"], enrolledAt: "2031-01-01T00:00:00Z", ...over,
  };
}

function todayPath(id: string): string {
  return `${COHORTS}/${encodeURIComponent(id)}/attendance/today`;
}

describe("manifest", () => {
  it("passes the manifest validator", () => {
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  it("declares only the required hosts, windows, actions and badge", () => {
    expect(manifest.permissions).toEqual({
      network: ["jungle-lms.krafton.com", "accounts.google.com"],
      windows: ["lms-checker"],
      secrets: false,
      shell: false,
    });
    expect(manifest.contributes).toEqual({
      actions: ["jungle.show-login", "jungle.check-now", "jungle.open-attendance"],
      badges: ["jungle.status"],
      lines: "lines.json",
      trayItems: ["jungle.show-login", "jungle.check-now", "jungle.open-attendance"],
    });
    expect(manifest.entry).toBe("dist/index.js");
    expect(manifest.permissions).not.toHaveProperty("openExternal");
  });
});

describe("fetchAttendance", () => {
  async function run(responses: Responses) {
    const test = createTestContext({ manifest, windowResponses: responses });
    const handle = await openChecker(test.ctx);
    return { test, result: await fetchAttendance(handle, NOW) };
  }

  it.each([401, 301, 302, 399])("maps cohorts %i to needsLogin", async (status) => {
    expect((await run({ [COHORTS]: { status, body: SECRET } })).result).toEqual({ kind: "needsLogin" });
  });

  it("maps cohort errors and shape outcomes", async () => {
    expect((await run({ [COHORTS]: { status: 500, body: SECRET } })).result).toEqual({ kind: "error" });
    expect((await run({ [COHORTS]: { status: 200, body: [] } })).result).toEqual({ kind: "noCohort" });
    expect((await run({ [COHORTS]: { status: 200, body: [cohort({ id: "../bad" })] } })).result)
      .toEqual({ kind: "error" });
  });

  it("maps today status and parsed booleans without values", async () => {
    const list = { status: 200, body: [cohort()] };
    const path = todayPath(FAKE_ID);
    for (const status of [401, 302]) {
      expect((await run({ [COHORTS]: list, [path]: { status, body: SECRET } })).result)
        .toEqual({ kind: "needsLogin" });
    }
    expect((await run({ [COHORTS]: list, [path]: { status: 500, body: SECRET } })).result)
      .toEqual({ kind: "error" });
    expect((await run({ [COHORTS]: list, [path]: { status: 200, body: { value: SECRET } } })).result)
      .toEqual({ kind: "error" });
    const { test, result } = await run({
      [COHORTS]: list,
      [path]: { status: 200, body: { date: FAKE_DATE, status: SECRET, checkedAt: SECRET, checkedOutAt: null } },
    });
    expect(result).toEqual({ kind: "ok", started: true, ended: false });
    expect(test.windows[0]?.paths).toEqual([COHORTS, path]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each(["E_DISPOSED", "E_UNAVAILABLE"])("maps thrown requests to error and reports %s", async (code) => {
    const test = createTestContext({ manifest });
    const handle = await openChecker(test.ctx);
    let lost = 0;
    expect(await fetchAttendance(handle, NOW)).toEqual({ kind: "error" });
    handle.getJson = async () => { throw Object.assign(new Error("unavailable"), { code }); };
    expect(await fetchAttendance(handle, NOW, () => { lost += 1; })).toEqual({ kind: "error" });
    expect(lost).toBe(1);
  });
});

describe("selectCohort", () => {
  const sel = (list: unknown) => selectCohort(list, NOW);

  it("selects the single active cohort", () => {
    expect(sel([cohort({ id: "a", isActive: false }), cohort({ id: "b" })]))
      .toEqual({ kind: "selected", id: "b", activeCount: 1 });
  });

  it("prefers the earliest endDate not yet past among several", () => {
    expect(sel([
      cohort({ id: "late", endDate: "2027-01-01T00:00:00Z" }),
      cohort({ id: "soon", endDate: "2026-11-01T00:00:00Z" }),
      cohort({ id: "gone", endDate: "2025-01-01T00:00:00Z" }),
    ])).toEqual({ kind: "selected", id: "soon", activeCount: 3 });
  });

  it("takes the latest endDate when all are past", () => {
    expect(sel([
      cohort({ id: "old", endDate: "2024-01-01T00:00:00Z" }),
      cohort({ id: "newer", endDate: "2025-06-01T00:00:00Z" }),
    ])).toEqual({ kind: "selected", id: "newer", activeCount: 2 });
  });

  it("returns noCohort when none is active or input is unusable", () => {
    expect(sel([cohort({ isActive: false }), cohort({ isActive: "true" })])).toEqual({ kind: "noCohort" });
    expect(sel([])).toEqual({ kind: "noCohort" });
    expect(sel({ cohorts: [cohort()] })).toEqual({ kind: "noCohort" });
    expect(sel(null)).toEqual({ kind: "noCohort" });
  });

  it("skips non-object elements", () => {
    expect(sel([null, "x", 3, [cohort()], cohort({ id: "ok" })]))
      .toEqual({ kind: "selected", id: "ok", activeCount: 1 });
  });

  it("ranks unparsable dates last", () => {
    expect(sel([
      cohort({ id: "bad", endDate: "not-a-date" }),
      cohort({ id: "none", endDate: undefined }),
      cohort({ id: "past", endDate: "2020-01-01T00:00:00Z" }),
    ])).toEqual({ kind: "selected", id: "past", activeCount: 3 });
    expect(sel([cohort({ id: "bad", endDate: "nope" })]))
      .toEqual({ kind: "selected", id: "bad", activeCount: 1 });
  });

  it.each(["../x", "a/b", "", "a".repeat(65), "a b", "a?b=1", 7, null])("rejects id %j", (id) => {
    expect(sel([cohort({ id })])).toEqual({ kind: "unexpectedShape" });
  });
});

describe("checkOnce", () => {
  async function run(responses: Responses) {
    const test = createTestContext({ manifest, windowResponses: responses });
    const handle = await openChecker(test.ctx);
    return { test, result: await checkOnce(handle, NOW) };
  }

  it.each([401, 301, 302, 399])("treats cohorts %i as needsLogin without a second call", async (status) => {
    const { test, result } = await run({ [COHORTS]: { status, body: null } });
    expect(result).toEqual({ kind: "needsLogin" });
    expect(test.windows[0]?.paths).toEqual([COHORTS]);
  });

  it("treats cohorts 500 and 404 as apiError", async () => {
    expect((await run({ [COHORTS]: { status: 500, body: SECRET } })).result)
      .toEqual({ kind: "apiError", status: 500, step: "cohorts" });
    expect((await run({ [COHORTS]: { status: 404, body: null } })).result)
      .toEqual({ kind: "apiError", status: 404, step: "cohorts" });
  });

  it("returns noCohort and unexpectedShape without a second call", async () => {
    const none = await run({ [COHORTS]: { status: 200, body: [cohort({ isActive: false })] } });
    expect(none.result).toEqual({ kind: "noCohort" });
    expect(none.test.windows[0]?.paths).toEqual([COHORTS]);
    const bad = await run({ [COHORTS]: { status: 200, body: [cohort({ id: "../evil" })] } });
    expect(bad.result).toEqual({ kind: "unexpectedShape" });
    expect(bad.test.windows[0]?.paths).toEqual([COHORTS]);
  });

  it("requests the exact today path and reports a value-free shape", async () => {
    const { test, result } = await run({
      [COHORTS]: { status: 200, body: [cohort(), cohort({ id: "other", isActive: false })] },
      [todayPath(FAKE_ID)]: { status: 200, body: { status: SECRET, checkedIn: false, at: null } },
    });
    expect(test.windows[0]?.paths).toEqual([COHORTS, `/api/v2/me/cohorts/${FAKE_ID}/attendance/today`]);
    expect(result).toEqual({
      kind: "ok", cohortCount: 2, activeCount: 1,
      todayShape: { object: { status: "string", checkedIn: "boolean", at: "null" } },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("builds the path with encodeURIComponent", async () => {
    const { test } = await run({
      [COHORTS]: { status: 200, body: [cohort({ id: "A-b_9" })] },
      [todayPath("A-b_9")]: { status: 200, body: {} },
    });
    expect(test.windows[0]?.paths[1]).toBe("/api/v2/me/cohorts/A-b_9/attendance/today");
  });

  it("maps a second-call 401/302 to needsLogin and 500 to apiError", async () => {
    const list = { status: 200, body: [cohort()] };
    const path = todayPath(FAKE_ID);
    expect((await run({ [COHORTS]: list, [path]: { status: 401, body: null } })).result).toEqual({ kind: "needsLogin" });
    expect((await run({ [COHORTS]: list, [path]: { status: 302, body: null } })).result).toEqual({ kind: "needsLogin" });
    expect((await run({ [COHORTS]: list, [path]: { status: 500, body: null } })).result)
      .toEqual({ kind: "apiError", status: 500, step: "today" });
  });

  it("opens the window hidden at the LMS origin", async () => {
    const { test } = await run({ [COHORTS]: { status: 200, body: [] } });
    expect(test.windows[0]?.options).toEqual({
      url: "https://jungle-lms.krafton.com/check-in", show: false, width: 1000, height: 760, title: "정글 LMS",
    });
  });

  it("caps shape depth", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 20; i += 1) deep = { a: deep };
    expect(JSON.stringify(describeShape(deep))).toContain("unknown");
  });
});
