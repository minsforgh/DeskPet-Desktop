# e2e 동시 실행 간섭 조사 (M6 기준 5)

조사일 2026-10-09. 서로 다른 두 디렉터리(작업 worktree 와 임시 checkout `C:/dpx`)에서 `pnpm test:e2e`(전체 30개 파일)를 동시에 돌렸다. PC 는 논리 CPU 20개, vitest 는 e2e 에서 워커 1개(`vitest.config.ts`).

## 재현 방법
1. 짧은 경로에 두 번째 checkout 을 만든다: `git worktree add --detach C:/dpx HEAD`, `cd C:/dpx && pnpm install` (긴 경로는 pnpm 이 실패한다). 끝나면 `git worktree remove --force C:/dpx`.
2. 두 곳에서 동시에 `pnpm test:e2e` 를 실행하고 출력을 파일로 남긴다.

## 결과
같은 커밋을 두 곳에서 동시에 돌린 결과, 두 곳 모두 7건 실패(각 103건 통과). 한 곳에서 단독으로 돌리면 모두 통과한다.

| 파일 | 메시지 | 판정 |
|---|---|---|
| event (4~5건) | `Test timed out in 5000ms` (포트 점유·정상 종료·BOM CLI·stale pid), `read ECONNRESET` (느린 헤더 5초 마감 테스트) | CPU 부하. 앞 테스트가 5초를 넘기면 뒤 테스트가 연쇄로 실패 |
| lifecycle | `Test timed out in 60000ms` | CPU 부하. 단독 25초, 두 곳 동시 47초, 전체 스위트 동시일 때 60초 초과 |
| character-review (1~3건) | `Test timed out in 8000ms`, 앱이 죽은 뒤 `connect ENOENT \.\pipe\deskpet-dev-…` | CPU 부하(타임아웃 뒤 앱 정리와 겹친 연쇄) |
| plugin-host | `sched-get:E_UNAVAILABLE` 가 추가로 먼저 기록됨 | 부하 때문에 기동 직후 1초 스케줄 콜백이 `setFetchTargetForTest` 보다 먼저 돌아 실제 네트워크로 나감(테스트 내부 경합, 부하에서만 드러남) |

bubble-actions 는 이번에는 실패하지 않았다(M5 기록은 같은 종류의 부하 실패로 본다).

## 공유 자원 점검
| 자원 | 동시 실행에서 충돌? | 근거 |
|---|---|---|
| 개발 제어 파이프 이름 | 아니오 | `DesktopApp` 이 실행마다 UUID 이름을 만든다 |
| userData·임시 폴더 | 아니오 | 테스트마다 `mkdtemp`, 단일 인스턴스 잠금도 userData 범위 |
| 이벤트 서버 포트 | **예 (고침)** | `--event-port` 없이 띄우는 파일(lifecycle·content-bounds·dpi·drag·pet·character-review)은 앱 기본값 7777 을 쓴다. 두 실행이 겹치면 뒤에 뜬 앱이 EADDRINUSE 로 서버를 못 연다(실제 DeskPet 이 켜져 있어도 같다). 이번 실패 7건의 직접 원인은 아니다(lifecycle 을 두 곳에서 동시에 돌려도 통과) |
| CPU | **예 (못 고침)** | 위 타임아웃 전부. Electron 창을 실제로 띄우므로 동시 실행 수에 비례해 느려진다 |

## 조치
- 고침: `DesktopApp.launch` 가 `--event-port` 가 없으면 `--event-port=0`(임의 포트)을 붙인다. 명시한 테스트(포트 점유·소유권 테스트)는 그대로다.
- 규칙: 전체 e2e 는 한 번에 한 곳에서만 돌린다(AGENTS.md). CPU 부하는 타임아웃을 늘려 가리지 않는다(단언을 약화하지 않는다).
- 남은 위험: 부하가 큰 PC 에서는 event 의 "느린 헤더 5초 마감"(4.8~6.5초 창)과 plugin-host 의 기동 직후 스케줄 경합이 단독 실행에서도 드물게 흔들릴 수 있다. 단독 실행 3회에서는 통과했다.

## 같이 고친 것: jungle-log e2e
- 시각 의존: jungle 이 실제 시계를 써서 23:00–04:00 에는 "종료 가능" 문구가 먼저 나왔다. 개발 제어 이름이 유효한 비패키지 실행에서만 `--plugin-clock=<ISO>` 를 플러그인 프로세스에 넘기고(`apps/desktop/src/main/plugin-clock-args.ts`), jungle 의 기본 `now()` 는 그 시각에서 실제 경과 시간만큼 흐른다(`plugins/jungle/src/clock.ts`). `launchJungle` 은 평일 15:00 KST 로 고정한다. 23:30 으로 주면 예전 실패가 그대로 재현되고(고정이 실제로 먹는다는 확인), 15:00 에서는 시각과 무관하게 통과한다.
- 체커 창 url 빈 문자열: 시각과 무관한 경합이었다. 서버가 `/check-in` 요청을 받는 시점이 창의 탐색 확정보다 빨라 `webContents.getURL()` 이 아직 `""` 이다(약 1/3). 단언은 그대로 두고 첫 테스트처럼 `vi.waitFor` 로 기다리게 했다.
