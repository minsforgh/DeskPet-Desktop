import { readFileSync } from "node:fs";
import { parseLines, renderLine } from "@deskpet/core";
import { describe, expect, it } from "vitest";
import { describeStatus, remainingText } from "./status-text.js";
import type { Observation } from "./reaction.js";

function kst(hour: number, minute: number, second = 0): Date {
  return new Date(Date.UTC(2026, 9, 8, hour, minute, second) - 9 * 60 * 60 * 1000);
}

const beforeStart: Observation = { kind: "ok", started: false, ended: false };
const studying: Observation = { kind: "ok", started: true, ended: false };
const complete: Observation = { kind: "ok", started: true, ended: true };
const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "jungle");

describe("remainingText", () => {
  it.each([
    [0, "0분"], [1, "1분"], [59 * 60, "59분"], [60 * 60, "1시간 0분"],
    [23 * 60 * 60, "23시간 0분"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(remainingText(seconds)).toBe(expected);
  });
});

describe("describeStatus", () => {
  it.each([
    [beforeStart, kst(9, 0), "아직 학습 시작 전이에요. 10시까지 1시간 0분 남았어요", ["jungle.open-attendance"],
      { id: "jungle.manual-before-start", vars: { remaining: "1시간 0분" } }],
    [beforeStart, kst(9, 1), "아직 학습 시작 전이에요. 10시까지 59분 남았어요", ["jungle.open-attendance"],
      { id: "jungle.manual-before-start", vars: { remaining: "59분" } }],
    [beforeStart, kst(10, 0), "학습 시작이 늦었어요! 지금 누르면 아직 괜찮아요", ["jungle.open-attendance"],
      { id: "jungle.manual-start-grace" }],
    [beforeStart, kst(10, 10), "오늘 학습 시작을 놓쳤어요", ["jungle.open-attendance"],
      { id: "jungle.manual-start-overdue" }],
    [studying, kst(22, 0), "학습 중이에요. 종료는 23시부터 누를 수 있어요(1시간 0분 뒤)", [],
      { id: "jungle.manual-studying", vars: { remaining: "1시간 0분" } }],
    [studying, kst(23, 0), "학습 종료를 누를 수 있어요. 04시까지 5시간 0분 남았어요", ["jungle.open-attendance"],
      { id: "jungle.manual-end-open", vars: { remaining: "5시간 0분" } }],
    [complete, kst(12, 0), "오늘 출석을 마쳤어요", [], { id: "jungle.manual-complete" }],
    [{ kind: "needsLogin" }, kst(12, 0), "LMS 로그인이 풀렸어", ["jungle.show-login"],
      { id: "jungle.manual-login-lost" }],
    [{ kind: "noCohort" }, kst(12, 0), "활성 기수가 없어요", [], { id: "jungle.manual-no-cohort" }],
    [{ kind: "error" }, kst(12, 0), "출석 상태를 확인할 수 없어요", ["jungle.check-now"],
      { id: "jungle.manual-error" }],
  ] as const)("describes %j at %j", (obs, now, expected, actions, line) => {
    const status = describeStatus(obs, now);
    expect(status.line).toEqual(line);
    expect(parsed.problems).toEqual([]);
    expect(parsed.catalog.lines.map(({ id }) => id)).toContain(status.line.id);
    const text = renderLine(parsed.catalog, status.line.id, status.line.vars);
    expect(text).toBe(expected);
    expect(status.actions.map((action) => action.action)).toEqual(actions);
    expect(text?.length).toBeLessThanOrEqual(120);
  });

  it("uses happy for completion, sleepy for login loss, worried for errors and neutral otherwise", () => {
    expect(describeStatus(complete, kst(12, 0)).mood).toBe("happy");
    expect(describeStatus({ kind: "needsLogin" }, kst(12, 0)).mood).toBe("sleepy");
    expect(describeStatus({ kind: "error" }, kst(12, 0)).mood).toBe("worried");
    expect(describeStatus(beforeStart, kst(9, 0)).mood).toBe("neutral");
  });

  it("describes manual checks with catalog ids and time variables", () => {
    expect(describeStatus(beforeStart, kst(9, 0)).line).toEqual({ id: "jungle.manual-before-start",
      vars: { remaining: "1시간 0분" } });
    expect(describeStatus(complete, kst(12, 0)).line).toEqual({ id: "jungle.manual-complete" });
    expect(describeStatus({ kind: "error" }, kst(12, 0)).line).toEqual({ id: "jungle.manual-error" });
  });
});
