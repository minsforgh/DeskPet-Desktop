// M5 demo: one simulated attendance day driven by the built jungle plugin's own pure functions
// (plugins/jungle/dist). No app, no network: observations are scripted, timing follows nextDelayMs.
// Run from the repository root after `pnpm build`:
//   node docs/progress/demo/m5-day-scenario.mjs > docs/progress/demo/m5-day-scenario.md
import console from "node:console";
import { attendancePhase } from "../../../plugins/jungle/dist/attendance-phase.js";
import { decide, initialNotifyState } from "../../../plugins/jungle/dist/reaction.js";
import { nextDelayMs } from "../../../plugins/jungle/dist/schedule.js";

const KST = 9 * 3600_000;
const at = (day, hh, mm) => new Date(Date.UTC(2026, 9, day, hh, mm) - KST);
const clock = (date) => new Date(date.getTime() + KST).toISOString().slice(5, 16).replace("T", " ");

// What the LMS would answer at each moment (scripted user behaviour).
const startAt = at(12, 9, 57);   // user presses 학습 시작 at 09:57
const loginLostAt = at(12, 14, 0); // session expires at 14:00 …
const loginBackAt = at(12, 14, 40); // … user logs in again at 14:40
const endAt = at(13, 3, 52);     // user presses 학습 종료 at 03:52 next day
const nextDayAt = at(13, 4, 0);  // from 04:00 the LMS "today" record is the new day (assumed: not started)
const observe = (now) => {
  if (now >= loginLostAt && now < loginBackAt) return { kind: "needsLogin" };
  if (now >= nextDayAt) return { kind: "ok", started: false, ended: false };
  return { kind: "ok", started: now >= startAt, ended: now >= endAt };
};

// Same boundary rule as plugins/jungle/src/monitor.ts (untilNextBoundary): an ok poll never sleeps past
// 04:00:05, 10:00:05 or 23:00:05 KST.
const BOUNDARIES = [4 * 3600 + 5, 10 * 3600 + 5, 23 * 3600 + 5];
const untilNextBoundary = (date) => {
  const since = ((date.getTime() + KST) % 86_400_000 + 86_400_000) % 86_400_000;
  return Math.min(...BOUNDARIES.map((b) => (b * 1000 > since ? b * 1000 - since : 86_400_000 - since + b * 1000)));
};

let now = at(12, 9, 0);
const stop = at(13, 4, 20);
let state = initialNotifyState;
let badge = null;
let polls = 0;
let consecutiveErrors = 0;
const rows = [];
while (now < stop) {
  polls += 1;
  const obs = observe(now);
  const decision = decide(state, obs, now);
  state = decision.next;
  const badgeText = decision.badge?.text ?? null;
  const { phase, remainingSeconds } = obs.kind === "ok" ? attendancePhase(now, obs) : { phase: "-", remainingSeconds: undefined };
  const delay = nextDelayMs({ phase: phase === "-" ? "Studying" : phase, remainingSeconds, now,
    outcome: obs.kind === "ok" ? "ok" : obs.kind === "error" ? "error" : "needsLogin",
    consecutiveErrors, fastPollsLeft: 0 });
  const wait = obs.kind === "ok" ? Math.min(delay, untilNextBoundary(now)) : delay;
  if (decision.event || badgeText !== badge) {
    const e = decision.event;
    rows.push(`| ${clock(now)} | ${obs.kind === "ok" ? phase : obs.kind} | ${e ? e.text : "–"} | ${e ? `${e.mood ?? ""} / ${e.priority ?? ""}` : "–"} | ${e?.actions?.map((a) => a.label).join(", ") || "–"} | ${badgeText ?? "없음"} | ${Math.round(wait / 1000)}초 |`);
  }
  badge = badgeText;
  now = new Date(now.getTime() + wait);
}

console.log(`# M5 데모: 하루 출석 시나리오 (경계 시각 흉내)

빌드된 \`plugins/jungle/dist\` 의 판정(\`attendancePhase\`)·알림(\`decide\`)·조회 간격(\`nextDelayMs\`)을 그대로 써서 가상의 하루를 돌린 결과다. 앱·네트워크 없이 LMS 응답만 대본으로 준다. 실제 하루는 사용자가 2026-10-08 실사용으로 확인했다(M5 기준 10·13).

- 대본: 09:00 시작(학습 시작 안 함) → 09:57 학습 시작 → 14:00 로그인 만료 → 14:40 다시 로그인 → 다음 날 03:52 학습 종료 → 04:00 새 날(LMS 의 오늘 기록이 새 날로 바뀐다고 가정).
- 조회 간격은 \`nextDelayMs\` 에 \`monitor.ts\` 의 경계 시각 보정(04:00·10:00·23:00 의 5초 뒤를 넘기지 않음)을 더했다. 사용자가 누른 확인·로그인 대기 모드는 넣지 않았다.
- 표에는 말풍선이 나오거나 배지가 바뀐 조회만 적었다. 전체 조회 횟수: **${polls}회** (09:00 ~ 다음 날 04:20, 사용자가 직접 누른 확인 제외).
- 재현: 저장소 루트에서 \`pnpm build\` 뒤 \`node docs/progress/demo/m5-day-scenario.mjs\`.

| 시각(KST) | 상태 | 말풍선 | 표정 / 우선순위 | 버튼 | 배지 | 다음 조회 |
|---|---|---|---|---|---|---|
${rows.join("\n")}
`);
