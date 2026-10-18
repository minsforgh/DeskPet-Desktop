# M9 데모: 설치 파일 → 설치 → 재부팅 → 자동 시작

> 데모 정의(milestones.md M9): 설치 파일과, 설치 → 재부팅 → 자동 시작 순서.
>
> 근거: 설치 파일은 `pnpm package` 로 만들고, 조용한 설치부터 제거까지는 `pnpm package:check` 가 자동으로 확인한다(점검 전용 appId·임시 폴더라 실제 설치를 건드리지 않음). 재부팅 뒤 자동 시작과 기본 팩은 사용자가 새 Windows 계정에서 확인했다(H). 종료 점검 실행 결과는 맨 아래 절에 있다.

## 산출물

| 항목 | 값 |
|---|---|
| 설치 파일 | `release/DeskPet-Setup-0.1.0.exe` (106.3 MB, 저장소에 넣지 않음. `pnpm package` 로 다시 만든다) |
| SHA-256 (사용자 확인본, main e6d653b 빌드) | `6a7639634503173259cda0cff38c115c1b65fdd98b3286677358f44bb08c2329` |
| 받는 사람용 안내 | `docs/install.md` (해시 확인, SmartScreen, Smart App Control, Node.js, 제거) |
| 플러그인 작성 가이드 | `docs/plugin-guide.md`, 가이드만으로 만든 예제 `docs/examples/water/`(기준 2) |

## 시나리오와 근거

| # | 데모 단계 | 보이는 결과 | 근거 |
|---|---|---|---|
| 1 | `pnpm package` | 설치 파일 1개와 `SHA256SUMS.txt`, 내용물 확인 통과(팩 placeholder·wolf-maid, 플러그인 4종, hook 3개, CLI) | `scripts/package-verify.mjs` (기준 3) |
| 2 | 설치 파일 실행 | 관리자 권한·폴더 선택 없이 `%LOCALAPPDATA%\Programs\DeskPet` 에 설치되고 바로 실행 | `pnpm package:check` 조용한 설치 단계 (기준 4), 사용자 확인 |
| 3 | 첫 실행 | 펫이 wolf-maid 로 뜨고 "자동 실행을 켰어요" 말풍선, 플러그인 4종 running | `package:check` 의 기본 팩·`/status` 확인 (기준 4·9), 사용자 확인 |
| 4 | 개발용 인자를 붙여 실행 | 개발 제어 통로가 열리지 않고 개발 인자는 무시 | `package:check` (기준 5) |
| 5 | 재부팅 | 로그인하면 펫이 저절로 뜸 | 사용자 확인 2026-10-12, 새 Windows 계정 (기준 8) |
| 6 | 설정 [일반] "Windows 시작 시 실행" 끄기·켜기 | 시스템 로그인 항목에 바로 반영 | `login-item.e2e.test.ts` (기준 6) |
| 7 | 오류가 났을 때 | `%APPDATA%\deskpet\logs\errors.log` 에 가려진 기록, 트레이 "오류 기록 폴더 열기" | `error-log.e2e.test.ts` (기준 7) |
| 8 | 제거 | 프로그램 파일·자동 시작 값은 지워지고 사용자 데이터는 남음 | `package:check` 제거 단계 (기준 4·6) |

대기 CPU(기준 10): `docs/progress/idle-cpu.md` "M9 설치본" — 평균 0.165% / 0.188%, 메모리 약 850 MB.

## 없는 것

- 설치·재부팅 화면 녹화: 재부팅을 거치는 과정이라 자동으로 찍지 못했다. 필요하면 사용자가 녹화해 이 폴더에 둔다.
- 코드 서명: 없음(범위 밖). 받는 사람은 SmartScreen 에서 "추가 정보 → 실행"을 눌러야 하고, Smart App Control 이 켜진 PC 에서는 설치가 막힌다(`docs/install.md`).
- Node.js 가 없는 PC 의 hook 알림: 안내만 한다(ADR-0010 질문 4).

## 종료 점검 실행 결과 (2026-10-12, main 9f4604a, 깨끗한 작업 폴더)

- typecheck 통과, lint 오류 0(경고 1: `event.e2e.test.ts:119` 고정 sleep, 기존)
- 단위 98파일 1197 통과(건너뜀 3)
- 전체 e2e: 첫 3연속은 1·2회 43/43, 3회차 `error-log.e2e` "a renderer crash is recorded…" 1건 실패(메시지 미보존, 단독 5/5 통과). 다시 3연속 43/43 ×3(160 통과·건너뜀 1, 211·212·211초)
- PowerShell 사용자 경로: `pnpm package` → 106.3 MB, 내용물 확인 통과(이번 빌드 SHA-256 `dd7c0fe6…460b`, 빌드마다 달라짐) → `pnpm package:check` 설치본 점검 통과
