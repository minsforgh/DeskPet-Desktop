import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import type { CheckerWindowHandle } from "@deskpet/plugin-sdk";
import type { PluginContext } from "@deskpet/plugin-sdk/v2";
import { parseLines, renderLine } from "@deskpet/core";
import type { LinePetEvent } from "@deskpet/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "./index.js";
import { createMonitor } from "./monitor.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));
const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "jungle");
const lineText = (event: LinePetEvent | undefined): string | undefined =>
  event?.line ? renderLine(parsed.catalog, event.line.id, event.line.vars) : undefined;
const COHORTS = "/api/v2/me/cohorts";
const ID = "SENSITIVE_COHORT_42";
const NAME = "SENSITIVE_NAME_42";
const DATE = "2031-02-03T04:05:06Z";
const VALUE = "SENSITIVE_VALUE_42";
const TODAY = `${COHORTS}/${ID}/attendance/today`;
const ATTENDANCE_PAGE = "https://jungle-lms.krafton.com/check-in";

function kst(hour: number, minute: number, second = 0, day = 8): Date {
  return new Date(Date.UTC(2026, 9, day, hour, minute, second) - 9 * 3600 * 1000);
}

function fixture(started = false) {
  return createTestContext({
    manifest,
    windowResponses: {
      [COHORTS]: { status: 200, body: [{ id: ID, name: NAME, endDate: DATE, isActive: true }] },
      [TODAY]: { status: 200, body: { date: DATE, status: VALUE, checkedAt: started ? VALUE : null, checkedOutAt: null } },
    },
  });
}

const activate = (ctx: ReturnType<typeof createTestContext>["ctx"]): ReturnType<typeof plugin.activate> =>
  plugin.activate(ctx as unknown as PluginContext);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await plugin.deactivate?.(); vi.useRealTimers(); });

describe("monitor through plugin entry points", () => {
  it("starts 5 seconds after activate and uses the declared hidden window", async () => {
    vi.setSystemTime(kst(9, 0));
    const test = fixture(true);
    await activate(test.ctx);
    expect(test.windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(test.windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.windows).toHaveLength(1);
    expect(test.windows[0]?.id).toBe("lms-checker");
    expect(test.windows[0]?.options).toMatchObject({ url: ATTENDANCE_PAGE, show: false });
    expect(test.windows[0]?.paths).toEqual([COHORTS, TODAY]);
    expect(test.openExternalCalls).toEqual([]);
    expect(test.schedules.every).toEqual([]);
    await test.runAction("jungle.show-login");
    expect(test.windows).toHaveLength(1);
    expect(test.windows[0]?.visible).toBe(true);
    expect(test.windows[0]?.options).toMatchObject({ url: ATTENDANCE_PAGE, show: true });
    expect(test.windows[0]?.paths).toEqual([]);
  });

  it("replaces the checker on every login click and polls through the newest handle", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = vi.spyOn(test.ctx.windows, "create");
    await activate(test.ctx);
    await test.runAction("jungle.check-now");
    const old = test.windows[0];
    await test.runAction("jungle.show-login");
    const first = test.windows[0];
    expect(first).not.toBe(old);
    expect(test.windows).toHaveLength(1);
    expect(first?.options).toMatchObject({ url: ATTENDANCE_PAGE, show: true, width: 1000, height: 760,
      title: "정글 LMS" });
    await test.runAction("jungle.show-login");
    const newest = test.windows[0];
    expect(newest).not.toBe(first);
    expect(test.windows).toHaveLength(1);
    await test.runAction("jungle.check-now");
    expect(newest?.paths).toEqual([COHORTS, TODAY]);
    expect(create.mock.calls.map(([id, options]) => [id, options.show])).toEqual([
      ["lms-checker", false], ["lms-checker", true], ["lms-checker", true],
    ]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000 + 4 * 30_000);
    expect(newest?.paths).toHaveLength(10);
  });

  it("forgets a failed visible checker creation and retries on the next click", async () => {
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let attempts = 0;
    test.ctx.windows.create = (id, options) => {
      if (id === "lms-checker" && options.show && attempts++ === 0)
        return Promise.reject(new Error("creation failed"));
      return create(id, options);
    };
    await activate(test.ctx);
    await test.runAction("jungle.check-now");
    await expect(test.runAction("jungle.show-login")).rejects.toThrow("creation failed");
    expect(test.windows).toHaveLength(0);
    await test.runAction("jungle.show-login");
    expect(test.windows).toMatchObject([{ id: "lms-checker", visible: true }]);
    expect(attempts).toBe(2);
  });

  it("keeps only the last checker when login and attendance actions alternate", async () => {
    const test = fixture(true);
    const create = vi.spyOn(test.ctx.windows, "create");
    await activate(test.ctx);
    for (const id of ["jungle.show-login", "jungle.open-attendance", "jungle.show-login",
      "jungle.open-attendance"]) {
      const old = test.windows[0];
      await test.runAction(id);
      expect(test.windows).toHaveLength(1);
      expect(test.windows[0]).not.toBe(old);
      expect(test.windows[0]).toMatchObject({ id: "lms-checker", visible: true });
    }
    expect(create.mock.calls.every(([id, options]) => id === "lms-checker"
      && options.url === ATTENDANCE_PAGE && options.show === true)).toBe(true);
  });

  it("serializes simultaneous visible actions so only the latest window survives", async () => {
    const test = fixture(true);
    await activate(test.ctx);
    await Promise.all([test.runAction("jungle.show-login"), test.runAction("jungle.open-attendance")]);
    expect(test.windows).toHaveLength(1);
    expect(test.windows[0]).toMatchObject({ id: "lms-checker", visible: true });
  });

  it("watches a missing login for three minutes at no more than twelve polls per minute", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    test.ctx.windows.create = async (id, options) => {
      const window = await create(id, options);
      window.getJson = async () => ({ status: 401, body: null });
      return window;
    };
    await activate(test.ctx);
    await test.runAction("jungle.show-login");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.logs).toHaveLength(12);
    expect(test.logs.every((log) => log.message.endsWith("nextSec=5"))).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.logs).toHaveLength(36);
    expect(test.logs.at(-1)?.message).toContain("nextSec=600");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.logs).toHaveLength(36);
  });

  it("ends login watch on success and keeps exponential error backoff", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let status = 401;
    test.ctx.windows.create = async (id, options) => {
      const window = await create(id, options);
      const read = window.getJson;
      window.getJson = (path) => path === COHORTS && status !== 200
        ? Promise.resolve({ status, body: null }) : read(path);
      return window;
    };
    await activate(test.ctx);
    await test.runAction("jungle.open-attendance");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.logs.at(-1)?.message).toContain("nextSec=5");
    status = 500;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.logs.at(-1)?.message).toContain("nextSec=60");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.logs.at(-1)?.message).toContain("nextSec=120");
    status = 200;
    await test.runAction("jungle.check-now");
    expect(test.logs.at(-1)?.message).toContain("kind=ok");
    expect(test.logs.at(-1)?.message).toContain("nextSec=30");
    await vi.advanceTimersByTimeAsync(4 * 30_000);
    expect(test.logs.at(-1)?.message).toContain("nextSec=900");
  });

  it("crosses start stages and grace once, with 150-second near-deadline polls", async () => {
    vi.setSystemTime(kst(9, 0));
    const test = fixture();
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(72 * 60_000);
    expect(test.events.map((event) => lineText(event))).toEqual([
      "학습 시작 아직이야! 10시까지 30분",
      "학습 시작 아직이야! 10시까지 10분",
      "학습 시작 아직이야! 10시까지 5분",
      "지금 누르면 아직 괜찮아!",
    ]);
    expect(test.logs.some((log) => log.message.endsWith("nextSec=150"))).toBe(true);
    expect(test.openExternalCalls).toEqual([]);
  });

  it("emits login loss once with action and badge, then clears the badge on recovery", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let loginLost = true;
    test.ctx.windows.create = async (id, options) => {
      const handle = await create(id, options);
      const read = handle.getJson;
      handle.getJson = (path) => path === COHORTS && loginLost
        ? Promise.resolve({ status: 401, body: VALUE }) : read(path);
      return handle;
    };
    const badges = vi.spyOn(test.ctx, "setBadge");
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({ line: { id: "jungle.login-lost" }, actions: [{ action: "jungle.show-login", label: "로그인" }] });
    expect(badges).toHaveBeenCalledTimes(1);
    expect(test.badges.get("jungle.status")?.text).toBe("로그인 필요");
    loginLost = false;
    await test.runAction("jungle.check-now");
    expect(test.badges.has("jungle.status")).toBe(false);
    expect(badges).toHaveBeenCalledTimes(2);
    expect(test.events.at(-1)).toMatchObject({ line: { id: "jungle.login-recovered" },
      mood: "happy", priority: "normal" });
    expect(test.events).toHaveLength(2);
    await test.runAction("jungle.check-now");
    expect(lineText(test.events.at(-1))).toBe("학습 중이에요. 종료는 23시부터 누를 수 있어요(10시간 50분 뒤)");
  });

  it("backs off errors 60, 120, 240 seconds and emits only on the second error", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = createTestContext({ manifest });
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000 + 60_000 + 120_000 + 240_000);
    expect(test.logs.slice(0, 4).map((log) => log.message.match(/nextSec=(\d+)/)?.[1]))
      .toEqual(["60", "120", "240", "480"]);
    expect(test.events.map((event) => lineText(event))).toEqual(["출석 상태를 확인할 수 없어"]);
    expect(test.openExternalCalls).toEqual([]);
  });

  it("resumes immediately and replaces the only checker through the attendance action", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    const created: Array<{ id: string; show: boolean | undefined }> = [];
    let shows = 0;
    test.ctx.windows.create = async (id, options) => {
      created.push({ id, show: options.show });
      const window = await create(id, options);
      const show = window.show;
      window.show = () => { shows += 1; show(); };
      return window;
    };
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    const reads = test.windows[0]?.paths.length;
    test.runOnResume();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.windows[0]?.paths.length).toBe((reads ?? 0) + 2);
    expect(test.openExternalCalls).toEqual([]);
    expect(test.windows).toHaveLength(1);
    expect(created).toEqual([{ id: "lms-checker", show: false }]);
    expect(shows).toBe(0);
    await test.runAction("jungle.open-attendance");
    expect(test.windows).toHaveLength(1);
    expect(test.windows[0]).toMatchObject({ id: "lms-checker", visible: true, options: {
      url: ATTENDANCE_PAGE, show: true, width: 1000, height: 760, title: "정글 LMS",
    } });
    const attendance = test.windows[0];
    if (!attendance) throw new Error("Attendance window was not created");
    attendance.visible = false;
    await test.runAction("jungle.open-attendance");
    expect(test.windows).toHaveLength(1);
    expect(test.windows[0]).not.toBe(attendance);
    expect(test.windows[0]?.visible).toBe(true);
    expect(test.openExternalCalls).toEqual([]);
    const before = test.windows[0]?.paths.length ?? 0;
    await vi.advanceTimersByTimeAsync(5_000 + 4 * 30_000);
    expect(test.windows[0]?.paths.length).toBe(before + 10);
    expect(created.every(({ id }) => id === "lms-checker")).toBe(true);
    expect(shows).toBe(0);
    await plugin.deactivate?.();
    expect(test.windows).toHaveLength(0);
  });

  it.each(["E_UNAVAILABLE", "E_DISPOSED"])("retries an attendance creation after %s on the next click", async (code) => {
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let attempts = 0;
    test.ctx.windows.create = (id, options) => {
      if (id === "lms-checker" && attempts++ === 0)
        return Promise.reject(Object.assign(new Error("gone"), { code }));
      return create(id, options);
    };
    await activate(test.ctx);
    await expect(test.runAction("jungle.open-attendance")).rejects.toMatchObject({ code });
    await test.runAction("jungle.open-attendance");
    expect(test.windows).toMatchObject([{ id: "lms-checker", visible: true }]);
    expect(attempts).toBe(2);
  });

  it.each(["E_UNAVAILABLE", "E_DISPOSED"])("retries a failed attendance replacement after %s", async (code) => {
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let attempts = 0;
    test.ctx.windows.create = async (id, options) => {
      if (id === "lms-checker" && attempts++ === 1)
        throw Object.assign(new Error("gone"), { code });
      return create(id, options);
    };
    await activate(test.ctx);
    await test.runAction("jungle.open-attendance");
    await expect(test.runAction("jungle.open-attendance")).rejects.toMatchObject({ code });
    expect(test.windows).toHaveLength(0);
    await test.runAction("jungle.open-attendance");
    expect(test.windows.filter((window) => window.id === "lms-checker")).toHaveLength(1);
    expect(attempts).toBe(3);
    expect(test.openExternalCalls).toEqual([]);
  });

  it("reports each manual check with a status-stable key so duplicates merge in the queue", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.events).toEqual([]);
    await test.runAction("jungle.check-now");
    await test.runAction("jungle.check-now");
    expect(test.events).toHaveLength(2);
    expect(test.events.map((event) => lineText(event))).toEqual([
      "학습 중이에요. 종료는 23시부터 누를 수 있어요(11시간 0분 뒤)",
      "학습 중이에요. 종료는 23시부터 누를 수 있어요(11시간 0분 뒤)",
    ]);
    expect(test.events.map((event) => (event as LinePetEvent).line)).toEqual(Array.from({ length: 2 }, () => ({
      id: "jungle.manual-studying", vars: { remaining: "11시간 0분" },
    })));
    expect(test.events.map((event) => event.key)).toEqual(["jungle.manual.ok.Studying", "jungle.manual.ok.Studying"]);
    expect(test.events.every((event) => event.mood === "neutral" && event.priority === "normal" && event.ttlMs === 5_000))
      .toBe(true);
  });

  it("answers five rapid manual clicks with one query and one result bubble", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let release: (() => void) | undefined;
    test.ctx.windows.create = async (id, options) => {
      const handle = await create(id, options);
      const read = handle.getJson;
      let gated = false;
      handle.getJson = (path) => {
        if (gated) return read(path);
        gated = true;
        return new Promise<void>((resolve) => { release = resolve; }).then(() => read(path));
      };
      return handle;
    };
    await activate(test.ctx);
    const clicks = Promise.all([
      test.runAction("jungle.check-now"),
      test.runAction("jungle.check-now"),
      test.runAction("jungle.check-now"),
      test.runAction("jungle.check-now"),
      test.runAction("jungle.check-now"),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    release?.();
    await clicks;
    expect(test.windows[0]?.paths).toEqual([COHORTS, TODAY]);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({ key: "jungle.manual.ok.Studying",
      line: { id: "jungle.manual-studying", vars: { remaining: "11시간 0분" } },
      priority: "normal", ttlMs: 5_000 });
  });

  it("gives manual results of different states separate keys so each is shown", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let broken = false;
    test.ctx.windows.create = async (id, options) => {
      const handle = await create(id, options);
      const read = handle.getJson;
      handle.getJson = (path) => broken && path === COHORTS
        ? Promise.resolve({ status: 500, body: null }) : read(path);
      return handle;
    };
    await activate(test.ctx);
    broken = true;
    await test.runAction("jungle.check-now");
    broken = false;
    await test.runAction("jungle.check-now");
    expect(test.events.map((event) => event.key)).toEqual(["jungle.manual.error", "jungle.manual.ok.Studying"]);
    expect(test.events.map((event) => lineText(event)))
      .toEqual(["출석 상태를 확인할 수 없어요", "학습 중이에요. 종료는 23시부터 누를 수 있어요(11시간 0분 뒤)"]);
  });

  it("uses an existing decision event once and repeats login loss on a later manual check", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    test.ctx.windows.create = async (id, options) => {
      const window = await create(id, options);
      window.getJson = async () => ({ status: 401, body: null });
      return window;
    };
    await activate(test.ctx);
    await test.runAction("jungle.check-now");
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({ line: { id: "jungle.login-lost" }, mood: "sleepy", priority: "high" });
    await test.runAction("jungle.check-now");
    expect(test.events).toHaveLength(2);
    expect(test.events[1]).toMatchObject({ key: "jungle.manual.needsLogin", line: { id: "jungle.manual-login-lost" },
      mood: "sleepy", priority: "normal", ttlMs: 5_000,
      actions: [{ label: "로그인", action: "jungle.show-login" }] });
  });

  it("polls at the 23:00:05 boundary even from Studying", async () => {
    vi.setSystemTime(kst(22, 59));
    const test = fixture(true);
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.logs[0]?.message).toContain("nextSec=60");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.events.map((event) => lineText(event))).toEqual(["이제 학습 종료 누를 수 있어"]);
  });

  it.each([
    [kst(9, 59), 60],
    [kst(3, 59, 0, 9), 60],
  ])("caps a successful poll before the next KST boundary", async (start, nextSeconds) => {
    vi.setSystemTime(start);
    const test = fixture(true);
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.logs[0]?.message).toContain(`nextSec=${nextSeconds}`);
  });

  it("keeps response values out of logs, events, and badges", async () => {
    vi.setSystemTime(kst(9, 30));
    const test = fixture();
    await activate(test.ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    const output = JSON.stringify([test.logs, test.events, [...test.badges]]);
    for (const value of [ID, NAME, DATE, VALUE]) expect(output).not.toContain(value);
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]?.message).toMatch(/^jungle: poll kind=ok phase=NeedStart nextSec=\d+$/);
  });
});

describe("monitor with injected clock and timer", () => {
  it("coalesces simultaneous requests, recreates a disposed checker, and stops after dispose", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture(true);
    const create = test.ctx.windows.create;
    let creations = 0;
    let release: (() => void) | undefined;
    test.ctx.windows.create = async (id, options): Promise<CheckerWindowHandle> => {
      const handle = await create(id, options);
      creations += 1;
      if (creations === 1) {
        handle.getJson = async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          throw Object.assign(new Error("disposed"), { code: "E_DISPOSED" });
        };
      }
      return handle;
    };
    const monitor = createMonitor(test.ctx, {
      now: () => new Date(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
    });
    const one = monitor.checkNow();
    const two = monitor.checkNow();
    expect(two).toBe(one);
    await Promise.resolve();
    await Promise.resolve();
    expect(creations).toBe(1);
    release?.();
    await one;
    expect(test.logs[0]?.message).toContain("kind=error");
    await monitor.checkNow();
    expect(creations).toBe(2);
    const events = test.events.length;
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(test.events).toHaveLength(events);
    expect(test.windows).toHaveLength(0);
  });

  it("does not emit after disposal while a request is pending", async () => {
    vi.setSystemTime(kst(12, 0));
    const test = fixture();
    const create = test.ctx.windows.create;
    let release: (() => void) | undefined;
    let held = false;
    test.ctx.windows.create = async (id, options) => {
      const handle = await create(id, options);
      const read = handle.getJson;
      handle.getJson = async (path) => {
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return read(path);
      };
      return handle;
    };
    const monitor = createMonitor(test.ctx, {
      now: () => new Date(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
    });
    const pending = monitor.checkNow();
    await Promise.resolve();
    await Promise.resolve();
    monitor.dispose();
    release?.();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(test.events).toEqual([]);
    expect(test.logs).toEqual([]);
  });
});
