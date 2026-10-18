# M11 데모: `orca` 알림 (실제 Orca 기준)

> 데모 정의(milestones.md M11): 실제 orchestration 진행 중 완료·게이트 알림 → 펫에서 게이트 [예] → worker 진행 재개.
>
> 2026-10-13 이 저장소의 실제 작업 하나(백로그 정리)를 Orca 로 돌리며 개발판 펫(`start-deskpet.cmd`)으로 확인했다. 그 작업의 worker 는 게이트 전에 일을 끝내 두었으므로, 승인 뒤 "진행 재개"는 worker 가 아니라 coordinator 의 머지였다.

## 실사용 기록 (run_public_001)

| # | 단계 | 보인 것 | 근거 |
|---|---|---|---|
| 1 | task "event e2e 고정 sleep 을 조건 대기로" 를 Luna worker 로 시작 | – | `orca orchestration worker-start`, 결과 커밋 b7591f8 |
| 2 | worker 완료 | 말풍선 "event e2e 고정 sleep 을 조건 대기로이 끝났어" + [열기] | 개발 제어 `state` 의 이벤트 기록 |
| 3 | coordinator 가 머지 여부 게이트 생성(gate_6e83a81089f1) | 말풍선 "…확인이 필요해" + [yes] [no] (높은 우선순위) | 같은 기록. 사용자가 자리를 비워 말풍선이 닫혔고, 같은 게이트는 다시 알리지 않았다(백로그) |
| 4 | 같은 질문으로 게이트 다시 생성(gate_0e1d96a4d69f) | 약 20초 뒤 말풍선, 사용자가 [yes] → "결정했어" | `gate-list` 에서 resolved:yes, 펫 말풍선 마지막 문구 "결정했어" |
| 5 | coordinator 가 그 승인으로 머지 | main dfeceec | 머지 전 확인: lint 경고 0, event.e2e 3회, 전체 e2e 47/47 |

## 자동 테스트가 덮는 나머지 (가짜 orca CLI)

| 기준 | 내용 | 근거 |
|---|---|---|
| 2 | 자동 경로에서 메시지를 가져가는 `check` 0회, 허용 목록 밖 명령 0회 | `orca-wire.e2e.test.ts`, `orca.e2e.test.ts` (호출 인자 기록) |
| 3·4 | 완료·실패·게이트·질문·escalation 문구와 우선순위, [열기] → `terminal switch` 1회 | `orca.e2e.test.ts` |
| 5 | 버튼을 누를 때만 `gate-resolve`, 직전 `gate-list` 재확인, 이미 처리됨 안내 | `orca.e2e.test.ts`, `plugins/orca/src/no-write-requests.test.ts` |
| 6·7 | coordinator 대기(agentWait 양성만), 종료된 worker "멈춘 것 같아" | `orca.e2e.test.ts`, 단위 |
| 8 | 재시작 뒤 같은 알림 없음(원장), CLI 없음 → "Orca 상태를 확인할 수 없어" 한 번 | `orca.e2e.test.ts` |
| 9 | 설치본에 플러그인 6종, orca 없는 PC 에서 조용히 확인 불가 | `pnpm package`, `pnpm package:check` |
| 11 | orca 켠 대기 CPU 0.23–0.26%, 메모리 약 650 MB | `docs/progress/idle-cpu.md` |

## 실사용에서 드러난 것 (백로그)

- **놓친 게이트:** 말풍선이 닫히면 같은 게이트를 다시 알리지 않는다.
- **지연:** 30초 간격 확인이라 평균 15초, 이번에는 약 20초. Orca 저장 파일(WAL) 수정 시각을 신호로 쓰면 1–2초로 줄일 수 있음을 확인했다.
- **오래된 질문 재알림:** 확인 불가에서 복구된 첫 스냅샷에서 지난 질문 2건이 다시 떴다(원인 미확인).
- **실제 Orca 의 null 필드:** 오래된 Run 의 `coordinator_handle` 이 null 이라 전체가 확인 불가로 떨어졌다. ce9bf22 에서 null 허용·Run 단위로 건너뛰게 고쳤다.
- **개발판 권한 창:** 개발 제어 실행은 권한 창 없이 거부해서 orca 가 모르게 denied 로 저장됐다.
- **[열기]의 터미널 탭 전환**은 실사용으로 눌러 보지 못했다(e2e 로만 확인).

## 종료 점검 실행 결과 (2026-10-13, main d5016a5, 깨끗한 작업 폴더)

- typecheck 통과, lint 오류·경고 0 (M10 때 남았던 `event.e2e.test.ts` 고정 sleep 경고는 이번 실사용 task 로 없앰)
- 단위 105파일 1323 통과(건너뜀 3)
- 전체 e2e 연속 3회 47/47(165 통과·건너뜀 1)
- PowerShell 사용자 경로: `pnpm package`(플러그인 6종, 106.3 MB) → `pnpm package:check` 설치본 점검 통과
