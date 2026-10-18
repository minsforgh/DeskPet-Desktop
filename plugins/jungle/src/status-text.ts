import type { LinePetEvent } from "@deskpet/core";
import { attendancePhase } from "./attendance-phase.js";
import type { Observation } from "./reaction.js";
import { LOGIN, OPEN, RECHECK } from "./reaction.js";

type StatusDescription = { mood: NonNullable<LinePetEvent["mood"]>;
  actions: NonNullable<LinePetEvent["actions"]>; line: NonNullable<LinePetEvent["line"]> };

export function remainingText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}분` : `${hours}시간 ${minutes % 60}분`;
}

export function describeStatus(obs: Observation, now: Date): StatusDescription {
  if (obs.kind === "needsLogin")
    return { mood: "sleepy", actions: [LOGIN], line: { id: "jungle.manual-login-lost" } };
  if (obs.kind === "noCohort")
    return { mood: "neutral", actions: [], line: { id: "jungle.manual-no-cohort" } };
  if (obs.kind === "error")
    return { mood: "worried", actions: [RECHECK], line: { id: "jungle.manual-error" } };

  const { phase, remainingSeconds } = attendancePhase(now, obs);
  switch (phase) {
    case "NeedStart":
      return { mood: "neutral", actions: [OPEN], line: { id: "jungle.manual-before-start",
        vars: { remaining: remainingText(remainingSeconds ?? 0) } } };
    case "StartOverdue":
      return { mood: "neutral", actions: [OPEN], line: { id: remainingSeconds === undefined
        ? "jungle.manual-start-overdue" : "jungle.manual-start-grace" } };
    case "Studying":
      return { mood: "neutral", actions: [], line: { id: "jungle.manual-studying",
        vars: { remaining: remainingText(remainingSeconds ?? 0) } } };
    case "NeedEnd":
      return { mood: "neutral", actions: [OPEN], line: { id: "jungle.manual-end-open",
        vars: { remaining: remainingText(remainingSeconds ?? 0) } } };
    case "Complete":
      return { mood: "happy", actions: [], line: { id: "jungle.manual-complete" } };
  }
}
