/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { readFileSync } from "node:fs";
import { parseLines, renderLine } from "@deskpet/core";
import type { LinePetEvent } from "@deskpet/core";
import { describe, expect, it } from "vitest";
import { decide, initialNotifyState, manualKey } from "./reaction.js";
import type { Decision, NotifyState, Observation } from "./reaction.js";

const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "jungle");
const lineText = (event: LinePetEvent | undefined): string | undefined =>
  event?.line ? renderLine(parsed.catalog, event.line.id, event.line.vars) : undefined;

function kst(h: number, m: number, s = 0, day = 8): Date {
  return new Date(Date.UTC(2026, 9, day, h, m, s) - 9 * 3600 * 1000);
}

const notStarted: Observation = { kind: "ok", started: false, ended: false };
const started: Observation = { kind: "ok", started: true, ended: false };
const ended: Observation = { kind: "ok", started: true, ended: true };

interface Step {
  at: Date;
  d: Decision;
}

/** 분 단위로 폴링하며 상태를 이어 간다. */
function run(
  from: NotifyState,
  start: Date,
  minutes: number,
  obs: Observation,
): { steps: Step[]; state: NotifyState } {
  const steps: Step[] = [];
  let state = from;
  for (let i = 0; i <= minutes; i++) {
    const at = new Date(start.getTime() + i * 60_000);
    const d = decide(state, obs, at);
    steps.push({ at, d });
    state = d.next;
  }
  return { steps, state };
}

function events(steps: Step[]) {
  return steps.filter((s) => s.d.event).map((s) => s.d.event!);
}

describe("decide: 시작 전", () => {
  it("uses a valid line catalog for every automatic event", () => {
    expect(parsed.problems).toEqual([]);
    const cases: Array<[Observation, Date]> = [
      [notStarted, kst(9, 30)], [notStarted, kst(10, 0)], [started, kst(23, 0)],
      [started, kst(3, 30, 0, 9)], [ended, kst(12, 0)],
      [{ kind: "needsLogin" }, kst(12, 0)], [{ kind: "noCohort" }, kst(12, 0)],
    ];
    const decisions = cases.map(([obs, at]) => decide(initialNotifyState, obs, at));
    const firstError = decide(initialNotifyState, { kind: "error" }, kst(12, 0));
    decisions.push(decide(firstError.next, { kind: "error" }, kst(12, 1)));
    decisions.push(decide(decisions[5]!.next, started, kst(12, 1)));
    for (const { event } of decisions) {
      expect(event?.line?.id).toBeDefined();
      expect(parsed.catalog.lines.map(({ id }) => id)).toContain(event?.line?.id);
      expect(lineText(event)).toBeTruthy();
      expect(event).not.toHaveProperty("text");
      expect(event).not.toHaveProperty("voice");
    }
  });
  it("09:00→10:12 미시작: 30·10·5분 단계 각 한 번, 유예 한 번, 이후 조용", () => {
    const { steps } = run(initialNotifyState, kst(9, 0), 132, notStarted);
    const evs = events(steps);
    expect(evs.map((e) => lineText(e))).toEqual([
      "학습 시작 아직이야! 10시까지 30분",
      "학습 시작 아직이야! 10시까지 10분",
      "학습 시작 아직이야! 10시까지 5분",
      "지금 누르면 아직 괜찮아!",
    ]);
    expect(evs.map((e) => e.line)).toEqual([
      { id: "jungle.start-deadline", vars: { minutes: "30" } },
      { id: "jungle.start-deadline", vars: { minutes: "10" } },
      { id: "jungle.start-deadline", vars: { minutes: "5" } },
      { id: "jungle.start-grace" },
    ]);
    const at = steps.filter((s) => s.d.event).map((s) => s.at.getTime());
    expect(at).toEqual([kst(9, 30), kst(9, 50), kst(9, 55), kst(10, 0)].map((d) => d.getTime()));
    expect(evs[0]).toMatchObject({ source: "jungle", type: "notify", mood: "surprised", priority: "high" });
    expect(evs[0]!.actions!.map((a) => a.action)).toEqual(["jungle.open-attendance", "jungle.check-now"]);
    expect(evs[3]!.actions!.map((a) => a.action)).toEqual(["jungle.open-attendance"]);
  });

  it("30분 넘게 남으면 event 없음, badge 없음", () => {
    const d = decide(initialNotifyState, notStarted, kst(9, 29, 59));
    expect(d.event).toBeUndefined();
    expect(d.badge).toBeNull();
  });

  it("경계를 건너뛰어 처음 관측해도 한 번만(작은 단계 하나)", () => {
    const first = decide(initialNotifyState, notStarted, kst(9, 56));
    expect(lineText(first.event)).toBe("학습 시작 아직이야! 10시까지 4분");
    const again = decide(first.next, notStarted, kst(9, 57));
    expect(again.event).toBeUndefined();
  });

  it("남은 시간은 올림 분", () => {
    const d = decide(initialNotifyState, notStarted, kst(9, 55, 30));
    expect(lineText(d.event)).toBe("학습 시작 아직이야! 10시까지 5분");
  });

  it("유예 후엔 조용하고 시작 놓침 배지", () => {
    const d = decide(initialNotifyState, notStarted, kst(10, 10));
    expect(d.event).toBeUndefined();
    expect(d.badge).toEqual({ text: "시작 놓침", tone: "warn" });
    expect(decide(initialNotifyState, notStarted, kst(10, 5)).badge).toBeNull();
  });
});

describe("decide: 시작 후·종료", () => {
  it("Studying 은 조용하고 badge null", () => {
    const { steps } = run(initialNotifyState, kst(10, 0), 60, started);
    expect(events(steps)).toEqual([]);
    expect(steps.every((s) => s.d.badge === null)).toBe(true);
  });

  it("23:00 전이 알림 한 번, 이후 조용", () => {
    const { steps } = run(initialNotifyState, kst(22, 58), 60, started);
    const evs = events(steps);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ line: { id: "jungle.end-open" }, mood: "happy", priority: "normal" });
    expect(lineText(evs[0])).toBe("이제 학습 종료 누를 수 있어");
    expect(steps.find((s) => s.d.event)!.at.getTime()).toBe(kst(23, 0).getTime());
  });

  it("23:00~04:00 마감 단계: 30·10·5분 각 한 번", () => {
    const { steps } = run(initialNotifyState, kst(23, 0), 300, started);
    const withEvent = steps.filter((s) => s.d.event);
    const texts = withEvent.map((s) => lineText(s.d.event));
    expect(texts).toEqual([
      "이제 학습 종료 누를 수 있어",
      "04시 전에 학습 종료! 30분 남았어",
      "04시 전에 학습 종료! 10분 남았어",
      "04시 전에 학습 종료! 5분 남았어",
    ]);
    expect(withEvent.slice(1).map((s) => s.d.event!.line)).toEqual([30, 10, 5].map((minutes) => ({
      id: "jungle.end-deadline", vars: { minutes: String(minutes) },
    })));
    expect(withEvent.slice(1).map((s) => s.at.getTime())).toEqual(
      [kst(3, 30, 0, 9), kst(3, 50, 0, 9), kst(3, 55, 0, 9)].map((d) => d.getTime()),
    );
    expect(withEvent[1]!.d.event).toMatchObject({ mood: "surprised", priority: "high" });
  });
});

describe("decide: 완료와 날 바뀜", () => {
  it("완료 후 한 번, 이후 조용하고 완료 배지", () => {
    const { steps } = run(initialNotifyState, kst(12, 0), 10, ended);
    const evs = events(steps);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ line: { id: "jungle.attendance-complete" }, mood: "happy", priority: "normal" });
    expect(lineText(evs[0])).toBe("오늘도 수고했어");
    expect(steps.every((s) => s.d.badge?.text === "완료" && s.d.badge.tone === "ok")).toBe(true);
  });

  it("날이 바뀌면(04:00) 단계 초기화", () => {
    const day1 = run(initialNotifyState, kst(9, 0), 60, notStarted).state;
    expect(day1.day).toBe("2026-10-08");
    const day2 = run(day1, kst(9, 0, 0, 9), 59, notStarted);
    expect(events(day2.steps).map((e) => e.key)).toEqual([
      "jungle.start.2026-10-09.30",
      "jungle.start.2026-10-09.10",
      "jungle.start.2026-10-09.5",
    ]);
  });

  it("완료 알림도 다음 attendanceDay 에서 다시 한 번", () => {
    const a = decide(initialNotifyState, ended, kst(12, 0));
    expect(decide(a.next, ended, kst(12, 5)).event).toBeUndefined();
    expect(lineText(decide(a.next, ended, kst(12, 0, 0, 9)).event)).toBe("오늘도 수고했어");
  });

  it("00:00~03:59 는 전날 attendanceDay 로 이어져 초기화되지 않는다", () => {
    const evening = decide(initialNotifyState, started, kst(23, 30));
    expect(evening.event).toBeDefined();
    const night = decide(evening.next, started, kst(1, 0, 0, 9));
    expect(night.next.day).toBe("2026-10-08");
    expect(night.event).toBeUndefined();
  });
});

describe("decide: 로그인·기수·오류", () => {
  it("로그인 풀림은 연속이면 반복 안 함, 복구 후 다시 알림", () => {
    const login: Observation = { kind: "needsLogin" };
    const a = decide(initialNotifyState, login, kst(12, 0));
    expect(a.event).toMatchObject({ line: { id: "jungle.login-lost" }, mood: "sleepy", priority: "high" });
    expect(lineText(a.event)).toBe("LMS 로그인이 풀렸어");
    expect(a.event!.actions).toEqual([{ label: "로그인", action: "jungle.show-login" }]);
    expect(a.badge).toEqual({ text: "로그인 필요", tone: "warn" });
    const b = decide(a.next, login, kst(12, 10));
    expect(b.event).toBeUndefined();
    expect(b.badge).toEqual({ text: "로그인 필요", tone: "warn" });
    const ok = decide(b.next, started, kst(12, 20));
    expect(ok.event).toMatchObject({ key: "jungle.recovered.2026-10-08.1",
      line: { id: "jungle.login-recovered" }, mood: "happy", priority: "normal" });
    expect(lineText(ok.event)).toBe("로그인 확인했어요. 이제 출석을 지켜볼게요");
    expect(ok.badge).toBeNull();
    expect(decide(ok.next, started, kst(12, 21)).event).toBeUndefined();
    const c = decide(ok.next, login, kst(12, 30));
    expect(lineText(c.event)).toBe("LMS 로그인이 풀렸어");
    const recoveredAgain = decide(c.next, started, kst(12, 31));
    expect(recoveredAgain.event?.key).toBe("jungle.recovered.2026-10-08.2");
  });

  it("noCohort 는 한 번만", () => {
    const nc: Observation = { kind: "noCohort" };
    const a = decide(initialNotifyState, nc, kst(12, 0));
    expect(a.event).toMatchObject({ line: { id: "jungle.no-cohort" }, priority: "normal" });
    expect(lineText(a.event)).toBe("활성 기수가 없어");
    expect(a.badge).toEqual({ text: "기수 없음", tone: "neutral" });
    expect(decide(a.next, nc, kst(12, 5)).event).toBeUndefined();
  });

  it("오류: 배지는 항상, 말풍선은 2번째 연속 실패에 한 번", () => {
    const err: Observation = { kind: "error" };
    let s = initialNotifyState;
    const results: Decision[] = [];
    for (let i = 0; i < 5; i++) {
      const d = decide(s, err, kst(12, i));
      results.push(d);
      s = d.next;
    }
    expect(results.map((r) => r.event !== undefined)).toEqual([false, true, false, false, false]);
    expect(results.every((r) => r.badge?.text === "확인 불가" && r.badge.tone === "warn")).toBe(true);
    expect(results[1]!.event).toMatchObject({ line: { id: "jungle.check-error" }, mood: "worried", priority: "normal" });
    expect(lineText(results[1]!.event)).toBe("출석 상태를 확인할 수 없어");
    expect(results[1]!.event!.actions).toEqual([{ label: "다시 확인", action: "jungle.check-now" }]);
    expect(s.consecutiveErrors).toBe(5);
  });

  it("ok 가 오면 연속 수 초기화, 다시 2번 실패하면 또 한 번", () => {
    const err: Observation = { kind: "error" };
    let s = decide(decide(initialNotifyState, err, kst(12, 0)).next, err, kst(12, 1)).next;
    s = decide(s, started, kst(12, 2)).next;
    expect(s.consecutiveErrors).toBe(0);
    const f1 = decide(s, err, kst(12, 3));
    expect(f1.event).toBeUndefined();
    expect(lineText(decide(f1.next, err, kst(12, 4)).event)).toBe("출석 상태를 확인할 수 없어");
  });
});

describe("manualKey: 수동 확인 합치기", () => {
  it("같은 상태의 반복 확인은 같은 key(시간이 지나도)", () => {
    expect(manualKey(started, kst(12, 0))).toBe("jungle.manual.ok.Studying");
    expect(manualKey(started, kst(13, 7))).toBe("jungle.manual.ok.Studying");
    expect(manualKey(notStarted, kst(9, 20))).toBe(manualKey(notStarted, kst(9, 40)));
  });

  it("상태가 바뀌면 key 가 바뀐다", () => {
    const keys = new Set([
      manualKey(notStarted, kst(9, 20)),
      manualKey(started, kst(12, 0)),
      manualKey(ended, kst(12, 0)),
      manualKey({ kind: "needsLogin" }, kst(12, 0)),
      manualKey({ kind: "noCohort" }, kst(12, 0)),
      manualKey({ kind: "error" }, kst(12, 0)),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("decide: 불변·형식·비노출", () => {
  it("prev 를 바꾸지 않는다", () => {
    const prev: NotifyState = { day: "2026-10-08", marks: ["start30"], consecutiveErrors: 1, lastKind: "error" };
    const snapshot = JSON.parse(JSON.stringify(prev));
    decide(prev, notStarted, kst(9, 55));
    decide(prev, { kind: "error" }, kst(9, 55));
    decide(prev, notStarted, kst(9, 55, 0, 9));
    expect(prev).toEqual(snapshot);
  });

  it("상태는 JSON 직렬화 가능", () => {
    const d = decide(initialNotifyState, notStarted, kst(9, 55));
    expect(JSON.parse(JSON.stringify(d.next))).toEqual(d.next);
  });

  it("모든 text 120자 이하, actions 3개 이하, source/type 고정, key 고유 형식", () => {
    const obsList: Observation[] = [notStarted, started, ended, { kind: "needsLogin" }, { kind: "noCohort" }, { kind: "error" }];
    for (const obs of obsList) {
      let s = initialNotifyState;
      for (let m = 0; m < 24 * 60; m += 5) {
        const d = decide(s, obs, new Date(kst(4, 0).getTime() + m * 60_000));
        s = d.next;
        if (d.event) {
          expect(d.event.source).toBe("jungle");
          expect(d.event.type).toBe("notify");
          expect(lineText(d.event)?.length).toBeLessThanOrEqual(120);
          expect((d.event.actions ?? []).length).toBeLessThanOrEqual(3);
          expect(d.event.key).toMatch(/^jungle\.[A-Za-z]+\.\d{4}-\d{2}-\d{2}\.\d+$/);
        }
      }
    }
  });

  it("출력 어디에도 응답 값이 없다", () => {
    // Observation 은 불리언뿐이라 응답 값이 들어올 길이 없다. 그래도 출력에 날짜 외 숫자 값이 새지 않는지 본다.
    const out = JSON.stringify([
      decide(initialNotifyState, notStarted, kst(9, 55)),
      decide(initialNotifyState, { kind: "needsLogin" }, kst(9, 55)),
    ]);
    expect(out).not.toMatch(/cohort|기수 \d|checkedAt|checkedOutAt/i);
    const withDetail = decide(initialNotifyState, notStarted, kst(9, 55));
    expect(withDetail.event?.detail).toBeUndefined();
  });
});
