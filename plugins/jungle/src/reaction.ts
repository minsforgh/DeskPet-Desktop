import type { LinePetEvent } from "@deskpet/core";
import { attendanceDay, attendancePhase } from "./attendance-phase.js";

export type Observation =
  | { kind: "ok"; started: boolean; ended: boolean }
  | { kind: "needsLogin" }
  | { kind: "noCohort" }
  | { kind: "error" };

/** 직렬화 가능한 알림 상태. marks 는 그 attendanceDay 에 이미 알린 단계 표지. */
export interface NotifyState {
  day: string | null;
  marks: string[];
  consecutiveErrors: number;
  lastKind: Observation["kind"] | null;
}

export type Badge = { text: string; tone: "neutral" | "warn" | "ok" };

export interface Decision {
  next: NotifyState;
  event?: LinePetEvent;
  badge: Badge | null;
}

export const initialNotifyState: NotifyState = { day: null, marks: [], consecutiveErrors: 0, lastKind: null };

/** 수동 확인 결과의 합치기 키(기획 8-2): 같은 상태의 연타 결과는 같은 key 로 큐에서 최신 하나로 합친다. 상태가 바뀌면 key 가 바뀌어 각각 표시된다. */
export function manualKey(obs: Observation, now: Date): string {
  return obs.kind === "ok" ? `jungle.manual.ok.${attendancePhase(now, obs).phase}` : `jungle.manual.${obs.kind}`;
}

type Action = NonNullable<LinePetEvent["actions"]>[number];

export const OPEN: Action = { label: "출석 페이지 열기", action: "jungle.open-attendance" };
export const RECHECK: Action = { label: "다시 확인", action: "jungle.check-now" };
export const LOGIN: Action = { label: "로그인", action: "jungle.show-login" };
const STAGES = [30, 10, 5];

function minutesCeil(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** 남은 시간이 넘은 경계 중 가장 작은 단계. 이미 알렸으면 undefined. */
function pendingStage(prefix: string, remainingSeconds: number, marks: string[]): number | undefined {
  let crossed: number | undefined;
  for (const stage of STAGES) {
    if (remainingSeconds <= stage * 60) crossed = stage;
  }
  if (crossed === undefined || marks.includes(`${prefix}${crossed}`)) return undefined;
  return crossed;
}

/** 넘은 단계와 그보다 큰 단계를 모두 알린 것으로 표시한다(건너뛴 경계는 다시 알리지 않는다). */
function withStageMarks(marks: string[], prefix: string, stage: number): string[] {
  const added = STAGES.filter((s) => s >= stage).map((s) => `${prefix}${s}`);
  return [...new Set([...marks, ...added])];
}

export function decide(prev: NotifyState, obs: Observation, now: Date): Decision {
  const day = attendanceDay(now);
  let marks = prev.day === day ? [...prev.marks] : [];
  let consecutiveErrors = 0;
  let event: LinePetEvent | undefined;
  let badge: Badge | null = null;

  const make = (
    kind: string,
    stage: string,
    mood: NonNullable<LinePetEvent["mood"]>,
    priority: NonNullable<LinePetEvent["priority"]>,
    line: NonNullable<LinePetEvent["line"]>,
    actions: Action[],
  ): LinePetEvent => {
    const built: LinePetEvent = {
      source: "jungle",
      type: "notify",
      key: `jungle.${kind}.${day}.${stage}`,
      line,
      mood,
      priority,
    };
    if (actions.length > 0) built.actions = actions;
    return built;
  };

  if (obs.kind === "needsLogin") {
    if (prev.lastKind !== "needsLogin") {
      event = make("login", "1", "sleepy", "high", { id: "jungle.login-lost" }, [LOGIN]);
    }
    badge = { text: "로그인 필요", tone: "warn" };
  } else if (obs.kind === "noCohort") {
    if (prev.lastKind !== "noCohort") {
      event = make("noCohort", "1", "neutral", "normal", { id: "jungle.no-cohort" }, []);
    }
    badge = { text: "기수 없음", tone: "neutral" };
  } else if (obs.kind === "error") {
    consecutiveErrors = prev.consecutiveErrors + 1;
    if (consecutiveErrors === 2) {
      event = make("error", "2", "worried", "normal", { id: "jungle.check-error" }, [RECHECK]);
    }
    badge = { text: "확인 불가", tone: "warn" };
  } else {
    const { phase, remainingSeconds } = attendancePhase(now, { started: obs.started, ended: obs.ended });
    if (prev.lastKind === "needsLogin") {
      const recovered = marks.filter((mark) => mark.startsWith("recovered")).length + 1;
      marks.push(`recovered${recovered}`);
      event = make("recovered", String(recovered), "happy", "normal", { id: "jungle.login-recovered" }, []);
    } else if (phase === "NeedStart" && remainingSeconds !== undefined) {
      const stage = pendingStage("start", remainingSeconds, marks);
      if (stage !== undefined) {
        marks = withStageMarks(marks, "start", stage);
        event = make(
          "start",
          String(stage),
          "surprised",
          "high",
          { id: "jungle.start-deadline", vars: { minutes: String(minutesCeil(remainingSeconds)) } },
          [OPEN, RECHECK],
        );
      }
    } else if (phase === "StartOverdue") {
      if (remainingSeconds !== undefined) {
        if (!marks.includes("grace")) {
          marks.push("grace");
          event = make("grace", "1", "surprised", "high", { id: "jungle.start-grace" }, [OPEN]);
        }
      } else {
        badge = { text: "시작 놓침", tone: "warn" };
      }
    } else if (phase === "NeedEnd" && remainingSeconds !== undefined) {
      if (remainingSeconds > 30 * 60) {
        if (!marks.includes("endOpen")) {
          marks.push("endOpen");
          event = make("endOpen", "1", "happy", "normal", { id: "jungle.end-open" }, [OPEN]);
        }
      } else {
        const stage = pendingStage("end", remainingSeconds, marks);
        if (stage !== undefined) {
          marks = withStageMarks(marks, "end", stage);
          event = make(
            "end",
            String(stage),
            "surprised",
            "high",
            { id: "jungle.end-deadline", vars: { minutes: String(minutesCeil(remainingSeconds)) } },
            [OPEN, RECHECK],
          );
        }
      }
    } else if (phase === "Complete") {
      if (!marks.includes("complete")) {
        marks.push("complete");
        event = make("complete", "1", "happy", "normal", { id: "jungle.attendance-complete" }, []);
      }
    }
    if (phase === "Complete") badge = { text: "완료", tone: "ok" };
  }

  const next: NotifyState = { day, marks, consecutiveErrors, lastKind: obs.kind };
  return event ? { next, event, badge } : { next, badge };
}
