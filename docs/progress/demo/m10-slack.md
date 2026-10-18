# M10 데모: `slack` 알림 (가짜 Slack 서버 기준)

> 데모 정의(milestones.md M10): 실제 워크스페이스에서 멘션·DM → 말풍선 → [Slack 에서 열기].
>
> 실제 워크스페이스 확인(기준 9)은 하지 않았다. 사용자의 실제 목적이 남이 관리하는 기업 워크스페이스의 알림이었고, 개인이 만든 앱은 관리자 승인 없이 설치할 수 없어서 방향을 바꿨다(D-064). 아래 근거는 실제 플러그인을 가짜 Slack 서버(`apps/desktop/e2e/fake-slack-server.ts`)에 붙인 e2e 이다. 종료 점검 실행 결과는 맨 아래 절에 있다.

## 시나리오와 근거

| # | 데모 단계 | 보이는 결과 | 근거 |
|---|---|---|---|
| 1 | Slack 앱 만들기 | 앱 매니페스트를 붙여 넣고 앱 토큰·사용자 토큰·멤버 ID 를 얻는 안내 | `docs/slack-setup.md` (기준 2, 실제 화면은 미확인) |
| 2 | slack 플러그인 첫 실행 | 권한 창에 "Slack 실시간 연결: slack.com에 연결 요청을 보내고 수신 확인을 자동으로 보냅니다" 줄, 거부하면 연결 요청 0회 | `plugin-host-app.test.ts`, `slack-wire.e2e.test.ts` |
| 3 | 설정 창에 토큰·멤버 ID 저장 | 토큰은 암호화 저장, settings.json·로그·errors.log·/status·플러그인 출력에 토큰·본문·연결 주소 없음 | `slack.e2e.test.ts`, `slack-wire.e2e.test.ts` (기준 3) |
| 4 | 다른 사람이 나를 멘션 / DM | 말풍선 "보낸 사람 · #채널" + 본문 120자, 내 메시지·봇 메시지는 안 뜸 | `slack.e2e.test.ts`, `plugins/slack/src/index.test.ts` (기준 5) |
| 5 | [Slack 에서 열기] | `https://app.slack.com/client/<팀>/<채널>` 이 열림 | `slack.e2e.test.ts` (열린 URL 단언) |
| 6 | 30초 안에 3개 / 방해 금지 | "slack 알림 3개"로 묶임, 방해 금지 중 보류 | `slack.e2e.test.ts` (기준 6) |
| 7 | 토큰이 틀림 | "Slack 토큰 확인 필요" 한 번, 재시도 중단, /status 의 slack 항목 badge | `slack.e2e.test.ts`, `slack-connection.test.ts` (기준 7) |
| 8 | 설치 파일 | 플러그인 5종(claude-code·codex·jungle·reminders·slack) 포함, 설치본 점검 통과 | `pnpm package`, `pnpm package:check` (기준 8) |

## Slack 쪽 쓰기

DeskPet 이 Slack 에 버튼 없이 보내는 것은 연결 열기(`apps.connections.open` POST)와 수신 확인(ack) 두 가지뿐이다(D-062, `packages/plugin-host/src/slack-connection.ts`). 플러그인 소스에는 쓰기 메서드·`ctx.fetch`·POST 가 없다(`plugins/slack/src/no-write-requests.test.ts`).

## 없는 것

- 실제 워크스페이스에서의 멘션·DM 확인(기준 9)과 연결 상태 대기 CPU(기준 10): D-064 로 내려 둠.
- 여러 워크스페이스, 메시지 위치까지 열기: 범위 밖.

## 종료 점검 실행 결과 (2026-10-12, main 0e7a9c2, 깨끗한 작업 폴더)

- typecheck 통과, lint 오류 0(경고 1: `event.e2e.test.ts:119` 고정 sleep, 기존)
- 단위 101파일 1272 통과(건너뜀 3)
- 전체 e2e 연속 3회 45/45(163 통과·건너뜀 1, 220·239·233초)
- PowerShell 사용자 경로: `pnpm package` → 내용물 확인 통과(플러그인 5종) → `pnpm package:check` 설치본 점검 통과
