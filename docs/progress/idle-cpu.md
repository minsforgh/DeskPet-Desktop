# 대기 상태 CPU 측정 (M3-11)

목표: 대기 상태 CPU 사용률 1% 미만 (코어 정규화 기준, `docs/plan.md` "가볍다").

## 측정 방법

`apps/desktop/scripts/measure-idle-cpu.mjs` 가 빌드된 앱(`apps/desktop/out`)을 임시 `--user-data-dir` 와 고유 `--dev-control` 이름으로 띄운다(e2e `DesktopApp` 와 같은 기동 방식). 펫이 준비되고 프로세스 트리의 PID 집합이 안정된 뒤, Electron 트리(main/renderer/gpu/utility)의 CPU 시간(`Win32_Process` UserModeTime+KernelModeTime, `powershell -NoProfile` 조회)을 1초 간격으로 샘플링해 논리 코어 수로 나눈 % 의 평균·최대를 구한다. 측정 중 실행 중이던 다른 `electron.exe` 5개(다른 DeskPet 세션)는 트리 밖으로 제외했고, 종료는 트레이 종료 명령으로 했으며 남은 프로세스 0 을 확인했다.

## 결과 (2026-10-07)

- 환경: Windows 10.0.26200, Intel i7-12700 (논리 20코어), RAM 32GB, Electron 44.5.1, 캐릭터 `placeholder`
- 상태: 펫 표시됨(visible=true, ready=true), 캐릭터 idle, 말풍선 없음(숨김, visible=false). 이 측정 인스턴스의 이벤트 서버는 다른 세션이 포트 7777 을 쓰고 있어 열리지 않았다.
- 샘플: 30초 × 1초 간격, 유효 30/30, 트리 프로세스 5개(main 1, renderer 2, gpu 1, utility 1)

| 지표 | 1회차 (12:26) | 2회차 (12:28) |
|---|---|---|
| 평균 CPU (코어 정규화) | **0.181%** | **0.191%** |
| 최대 CPU (코어 정규화, 1초 샘플) | 1.159% (16/30 샘플) | 1.081% (2/30 샘플) |
| 1코어 환산 평균 | 3.611% (초당 36.1ms CPU) | 3.815% (초당 38.1ms CPU) |
| 역할별 평균 | main 0.062%, gpu 0.080%, renderer 0.036%, utility 0.003% | main 0.039%, gpu 0.098%, renderer 0.054%, utility 0.000% |
| 종료 | 트레이 종료 명령, 남은 프로세스 0, 임시 폴더 삭제 | 같음 |

사전 시행 4회(5–8초)도 평균 0.031–0.370%, 최대 0.924% 이하로 비슷했다.

## 판정

**충족.** 두 번의 30초 측정 모두 평균 0.181–0.191% 로 1% 미만 목표를 크게 밑돈다.

순간 최대치는 1회차 2개(1.159%, 1.085%), 2회차 1개(1.081%) 샘플이 1% 를 넘었다. 원인 후보:

- 대기 애니메이션 틱(깜빡임 프레임)과 렌더러→GPU 합성이 한 샘플 구간에 몰린 버스트. 실제로 깜빡임이 없던 구간은 1회차에서 0.000% 샘플이 12개였다.
- 측정 머신의 백그라운드 스케줄링 영향(1초 간격 집계라 짧은 웨이크업이 한 샘플에 합산된다).

평균 기준으로는 문제 없는 수준이므로 별도 대응은 하지 않고, 목표를 "순간 최대" 로 바꿔야 한다는 요구가 생기면 애니메이션 틱 주기(초당 약 8회 그리기)부터 다시 본다.

## 재현

```powershell
pnpm build
node apps/desktop/scripts/measure-idle-cpu.mjs            # 30초 기본
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 60
```


## 2026-10-07 최종 재측정 (M3 2단계 기능 모두 포함: 전체 화면 감시, 방해 금지 타이머, reminders)

coordinator 직접 실행, 30초: 평균 0.427%, 최대 1.853%(샘플 1개), 판정 충족. 이전보다 평균이 올랐지만(0.18~0.31%) 같은 환경의 측정 편차 범위로 보이며, 감시 PowerShell 프로세스는 앱 트리 밖이라 이 수치에 들어가지 않는다(별도 CPU 는 12.4초당 0.016초로 worker 가 측정).


## 2026-10-07 M4 재측정 (플러그인 프로세스 포함, M4-11)

`apps/desktop/scripts/measure-idle-cpu.mjs` 가 앱이 알려 준 플러그인 pid(`state.pluginHost.pids`)를 `plugin` 역할로 따로 집계하고 마지막 샘플의 메모리(`WorkingSetSize` 작업 집합 / `PrivatePageCount` 전용)를 함께 출력하도록 고쳤다. 펫과 플러그인 호스트가 모두 준비된 뒤 측정을 시작한다.

- 환경: 위와 같음(i7-12700 논리 20코어, RAM 32GB, Windows 10.0.26200, Electron 44.5.1), 캐릭터 `placeholder`, 다른 `electron.exe` 5개(다른 세션)는 트리 밖으로 제외
- 상태: 기본 실행(저장소 `plugins/` 스캔). 실행 중인 플러그인은 `reminders` 하나(규칙 없음), 나머지 5개 폴더는 매니페스트가 없어 `invalid`(프로세스 없음). 말풍선 없음. 30초 × 1초 간격, 유효 30/30, 프로세스 6개(main 1, renderer 2, gpu 1, utility 1, plugin 1)

| 지표 | 1회차 (18:07) | 2회차 (18:08) |
|---|---|---|
| 평균 CPU (코어 정규화) | **0.257%** | **0.299%** |
| 최대 CPU (1초 샘플) | 0.923% | 1.086% (1/30 샘플) |
| 역할별 평균 | main 0.064%, gpu 0.111%, renderer 0.082%, utility 0.000%, **plugin 0.000%** | main 0.041%, gpu 0.144%, renderer 0.111%, utility 0.003%, **plugin 0.000%** |
| 메모리 합계 (작업 집합 / 전용) | 510 / 236 MB | 509 / 234 MB |
| 플러그인 프로세스 1개 (작업 집합 / 전용) | 80 / 22 MB | 79 / 21 MB |
| 종료 | 트레이 종료 명령, 남은 프로세스 0 | 같음 |

### 판정

**충족.** 평균 0.257–0.299% 로 1% 미만이고, 같은 환경의 M3 최종 측정(0.427%)보다 낮다. 플러그인 프로세스의 CPU 는 두 번 모두 0.000–0.003% 미만이라 평균에 거의 영향이 없다. 타이머를 플러그인이 아니라 main 의 스케줄러가 하나만 거는 구조(ADR-0005 1장)가 대기 CPU 를 지킨다는 가정이 이 구성에서 확인됐다.

앱 평균이 1% 를 넘지 않았으므로 ADR-0005 1장의 "필요할 때만 띄움" 전환은 지금 필요하지 않다. 비용은 메모리다: 플러그인 프로세스 하나가 작업 집합 약 80MB, 전용 약 22MB 였다. 기본 플러그인이 6개까지 늘면(기획안 7장) 단순 합산으로 작업 집합 약 480MB, 전용 약 130MB 가 더해진다. 이 수치는 `reminders`(코드가 가장 작은 플러그인) 기준이라 네트워크 폴링을 하는 플러그인은 더 클 수 있다. 플러그인이 3개 이상 실행 중일 때 다시 측정해 전환 여부를 정한다.

참고: 순간 최대 1.086% 한 샘플은 M3 측정과 같은 원인(애니메이션 틱과 GPU 합성이 한 샘플에 몰림)으로 보이며 평균에는 영향이 없다.

## 2026-10-07 M4 2단계 후 (설정 창·claude-code 플러그인 포함, 플러그인 프로세스 2개)

coordinator 직접 실행, 30초: 평균 0.274%, 최대 1.090%(샘플 1개), 역할별 평균 main 0.090 / gpu 0.121 / renderer 0.062 / utility 0.000 / plugin 0.000%. 메모리 합계 작업 집합 742MB / 전용 252MB (플러그인 2개: 189 / 44MB). 판정: 1% 미만 충족. 비용은 CPU 가 아니라 메모리이므로 플러그인 3개 이상이 되면 다시 측정한다(ADR-0005 1장의 "필요할 때만 띄움" 전환 검토 기준).


## M5 재측정 (jungle 포함, M5 기준 12)

목표: jungle 플러그인과 숨김 체커 창을 켠 상태에서도 대기 CPU 평균 1% 미만.

### 측정 방법

`measure-idle-cpu.mjs` 의 `--with-jungle` 은 로컬 가짜 HTTPS LMS(127.0.0.1 임의 포트, e2e `fake-lms.ts` 와 같은 응답)를 띄우고, `plugins/jungle` 의 manifest 와 빌드 산출물을 임시 plugins 폴더로 복사해 `--plugins-dir` 로 지정한다. 앱은 권한 승인 테스트 훅(`--permission-answer=allow`)과 호스트 매핑(`--host-resolver-rules`)으로 가짜 LMS 에 붙고, 첫 자동 조회로 숨김 체커 창이 만들어지고 로그인 쿠키가 세션에 들어가 `jungle.check-now` 가 ok 를 한 번 낸 뒤(서버 요청 기록·로그 파일을 조건 대기) 샘플링을 시작한다. 샘플링 구간의 jungle 은 자동 조회 타이머만 가진 평상 대기 상태다. 실제 LMS 에는 접속하지 않는다. `pnpm build` 가 먼저 필요하다.

```powershell
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30                           # 기준선 (jungle 끔)
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30 --with-jungle             # jungle + 숨김 체커 창
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30 --with-jungle --poll-burst  # 선택: 시작 시점 check-now 직후 처음 10초(--burst-seconds 로 변경)를 따로 보고
```

측정은 다른 작업이 CPU 를 쓰지 않는 조용한 시점에 하고, 기준선과 `--with-jungle` 을 연달아 같은 조건으로 돌린다. 출력 마지막 `JSON:` 줄에 측정 조건(`withJungle`, `pollBurst`, 샘플 수, 플러그인 수, 시각)과 수치가 들어 있다. 역할별 CPU 에서 `checker-renderer`(숨김 체커 창 렌더러: 펫 준비 뒤에 생긴 렌더러)와 `plugin`(플러그인 utility 프로세스)이 따로 나온다. 구분이 안 되면(JSON 의 `checkerRendererSeparated` 가 false) 켠 트리와 끈 트리의 차이로 본다.

### 결과

| 구성 | 평균 | 최대 | 역할별 | 프로세스 수 | 메모리 (작업 집합 / 전용) |
|---|---|---|---|---|---|
| 기준선 (jungle 끔) | **0.222%** | 1.083% (19/30) | main 0.070, renderer 0.078, gpu 0.072, utility 0.003, plugin 0.000 | 7 (플러그인 2개 포함) | 595 / 256 MB |
| `--with-jungle` | **0.274%** | 1.094% (22/30) | main 0.047, renderer 0.080, checker-renderer 0.000, gpu 0.147, utility 0.000, plugin 0.000 | 7 (플러그인 1개 = jungle) | 612 / 268 MB (checker-renderer 94 / 26, plugin 81 / 23) |
| 조회 버스트 (`--poll-burst`, 처음 10초) | 전체 0.154%, 버스트 구간 **0.101%** | 전체 1.156% (24/30), 버스트 구간 0.308% (8/10) | main 0.039, renderer 0.041, checker-renderer 0.000, gpu 0.072 | 7 | 609 / 267 MB |

### 판정

판정 기준: `--with-jungle` 평균(코어 정규화) 1% 미만이면 충족. 넘으면 기준선과의 역할별 차이로 원인(체커 창 렌더러, 플러그인 프로세스, 조회 버스트)을 기록한다.

**충족 (2026-10-08, 17:09–17:11 KST).** `--with-jungle` 평균 0.274% 로 1% 미만이고 기준선(0.222%)과의 차이는 0.05%p 안팎이다. 숨김 체커 창 렌더러는 샘플 구간에 0.000% 였고(조회가 없는 대기), 자동 조회 한 번(`jungle.check-now`)의 직후 10초는 평균 0.101%, 최대 0.308% 로 대기 평균 이하였다. 순간 최대(1.08–1.16%)는 기준선·jungle 모두 1회씩 나타나는 렌더러→GPU 합성 버스트이며 M3 에서 기록한 원인과 같다.

측정 조건과 한계:
- 환경은 M3·M4 와 같다(Windows 10.0.26200, i7-12700 논리 20코어, Electron 44.5.1, 30초×1초 샘플 유효 30/30, 캐릭터 idle, 말풍선 숨김).
- 기준선은 저장소 기본 plugins 폴더(플러그인 2개 기동)를, `--with-jungle` 은 jungle 만 든 임시 plugins 폴더를 쓴다. 그래서 플러그인 구성이 완전히 같지는 않다. 합계는 jungle 쪽 프로세스 수가 1개 적고 메모리는 체커 창 렌더러(약 94 MB) 때문에 약 17 MB 많다.
- 샘플 구간에는 자동 조회가 거의 돌지 않는다(평상시 간격 10–15분, 마감 30분 전 150초). 조회가 몰리는 마감 직전 구간의 CPU 는 따로 측정하지 않았고, 버스트 측정이 그 대리 값이다.
- 측정 중 다른 worker 가 작업 중이었다(앱 프로세스 트리만 집계).

## M8 재측정 (창 감시 포함, M8 기준 14)

목표: 창 감시(terrain-watcher, PowerShell 상주)를 켠 상태에서 앱과 그 자손 프로세스 전체의 대기 CPU 평균 1% 미만.

### 측정 방법

`measure-idle-cpu.mjs` 가 M8-14(aa1665a)부터 앱 루트 프로세스의 자손 전체(ParentProcessId)를 집계한다. `powershell.exe` 는 역할 `powershell` 로 따로 나온다. 그 전 측정(M3–M5)은 `electron.exe` 만 셌기 때문에 전체 화면 감시 PowerShell 의 몫이 빠져 있었다. `--terrain-off` 는 임시 userData 의 settings.json 에 `terrain.enabled=false` 를 써서 창 감시 없이 잰다(전체 화면 감시는 남음). 기본은 앱 기본값대로 창 감시 켬(실제 PowerShell 감시기, 대기 조회 500ms).

```powershell
pnpm build
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30                  # 창 감시 켬
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30 --terrain-off    # 창 감시 끔
```

### 결과 (2026-10-10, 켬·끔을 번갈아 2번씩, 30초×1초 샘플 30/30)

| 구성 | 평균 | 최대 | powershell 역할 | 그 밖의 역할(main / renderer / gpu) | 메모리 합계 (작업 집합 / 전용) |
|---|---|---|---|---|---|
| 켬 1회차 | **0.377%** | 1.618% | 0.052% (2개, 160 / 129 MB) | 0.085 / 0.098 / 0.137 | 2344 / 411 MB |
| 끔 1회차 | 0.188% | 1.695% | 0.008% (1개, 75 / 60 MB) | 0.051 / 0.039 / 0.090 | 2248 / 342 MB |
| 켬 2회차 | **0.157%** | 0.928% | 0.015% (2개) | 0.041 / 0.039 / 0.059 | 2345 / 411 MB |
| 끔 2회차 | 0.338% | 1.327% | 0.008% (1개) | 0.106 / 0.082 / 0.142 | 2252 / 345 MB |

### 판정

**충족.** 창 감시를 켠 평균 0.157–0.377% 로 1% 미만이다. 창 감시 PowerShell 자체의 몫은 0.007–0.044%p(켬의 powershell 역할 − 끔의 전체 화면 감시 0.008%)로, ADR-0009 실험값(500ms 조회 약 0.27% 코어 = 20코어 정규화 약 0.014%)과 같은 크기다. 켬·끔 사이 평균의 차이는 회차마다 순서가 뒤집혀 감시기보다 main·renderer·gpu 의 변동(펫이 걷는지에 따른 그리기 빈도)이 크다. 비용은 CPU 보다 메모리다: 창 감시 PowerShell 한 개가 작업 집합 약 85 MB / 전용 약 68 MB 를 더한다.

측정 조건과 한계:
- 환경은 M5 와 같다(Windows 10.0.26200, i7-12700 논리 20코어). 저장소 기본 plugins 폴더(플러그인 3개). 캐릭터는 기본 팩, 펫은 바닥에서 대기·걷기.
- 측정 중 사용자의 DeskPet 세션(electron.exe 10개)이 떠 있었다(앱 트리만 집계).
- 펫이 공중·오르내리기 중일 때의 16ms 이동 타이머와 창을 끄는 동안의 100ms 조회는 대기 측정에 포함되지 않는다(움직이는 동안만 쓰는 비용).


## M9 설치본 (2026-10-10, 기준 10)

설치본(NSIS 설치 파일을 임시 폴더에 조용히 설치한 `DeskPetCheck.exe`, check-installer 와 같은 점검용 appId)을 `DESKPET_USER_DATA_DIR` 로 격리한 임시 userData 에서 실행해 쟀다. 사용자의 `%APPDATA%\deskpet` 와 HKCU Run 값은 전후가 같음을 확인했고, 측정 뒤 제거·임시 폴더 정리까지 했다. 설치본은 개발 제어 통로가 없어 `event-server.json` + `/status` 로 준비를 확인한다.

```powershell
pnpm package; pnpm package:check          # release/check 에 점검용 설치 파일이 생긴다
# 임시 폴더에 /S /D= 로 설치한 뒤
node apps/desktop/scripts/measure-idle-cpu.mjs --seconds 30 --installed-exe <설치 폴더>\DeskPetCheck.exe
```

- 환경: Windows 10.0.26200, i7-12700 (논리 20코어), RAM 32GB, Electron 44.5.1. 처음 실행 기본 팩 `wolf-maid`, 창 감시(terrain) 켬(앱 기본값), 플러그인 4종(설치본 기본), 말풍선 없음. 30초 × 1초 간격, 유효 30/30, 프로세스 12개(main 1, renderer 2, gpu 1, utility 4, powershell 2, conhost 2).
- 설치본에서는 플러그인 pid 를 알 수 없어 플러그인 프로세스가 `utility` 로 묶여 나온다.

| 지표 | 1회차 | 2회차 |
|---|---|---|
| 평균 CPU (코어 정규화) | **0.165%** | **0.188%** |
| 최대 CPU (1초 샘플) | 0.771% | 1.168% (샘플 1/30) |
| 역할별 평균 | main 0.031, renderer 0.041, gpu 0.072, utility 0.000, powershell 0.021 | main 0.039, renderer 0.054, gpu 0.057, utility 0.005, powershell 0.034 |
| 메모리 합계 (작업 집합 / 전용) | 854 / 407 MB | 850 / 403 MB |

### 판정

**충족.** 두 번 모두 평균 0.165–0.188% 로 1% 미만이다. 평균이 1% 를 넘은 회차는 없다. 순간 최대가 1% 를 넘은 것은 2회차 첫 샘플 1개(1.168%)뿐인데, 앞선 측정과 같이 1초 샘플에 짧은 작업이 몰린 버스트로 보이며 평균에는 영향이 없다(첫 샘플이라 기동 직후 마무리 작업일 가능성도 있으나 이 측정에서 따로 확인하지는 않았다). 메모리는 창 감시 PowerShell 2개가 작업 집합 158 MB 를 차지해 가장 크다.

## M11 orca 켬 (2026-10-13, M11 기준 11)

- 조건: 개발 실행, 임시 플러그인 폴더에 orca 만, `--permission-answer=allow`, 실제 이 PC 의 `orca.exe`(읽기 전용 명령, 30초 주기), 창 감시 켬, 논리 코어 20. `node apps/desktop/scripts/measure-idle-cpu.mjs --with-orca --seconds 30` (PowerShell) 2회.
- 결과: 평균 **0.227% / 0.256%**(최대 0.93% / 1.08%), 메모리 작업 집합 648 / 660 MB(전용 367 MB). 역할별 평균 main 0.05–0.08%, renderer 0.04–0.08%, gpu 0.08–0.13%, plugin 0.000%, powershell 0.01–0.02%.
- 한계: 30초마다 짧게 뜨는 `orca.exe`(명령당 약 0.25초, ADR-0012 6절)는 1초 샘플의 자손 집계에서 빠질 수 있어 역할별 수치에 나오지 않는다. 실제 비용은 위 평균보다 약간 높을 수 있다. 1% 목표에는 여유가 있다.

## M12 orca 켬 + 빠른 감지 (2026-10-15, M12 기준 10)

- 조건: 개발 실행(main b7897a7), 임시 플러그인 폴더에 orca 만, 실제 이 PC 의 `orca.exe`(읽기 전용), 실제 `%APPDATA%\orca\orchestration.db-wal` 이 있어 호스트 1초 stat 빠른 감지 동작, 창 감시 켬, 논리 코어 20. `node apps/desktop/scripts/measure-idle-cpu.mjs --with-orca --seconds 60` 2회. Orca 에 진행 중 worker 없음(대기 상태).
- 결과: 평균 **0.123% / 0.295%**(최대 1.93% / 1.33%, 1회차 최대는 첫 샘플), 전용 메모리 **385 / 383 MB**(M11 367 MB), 작업 집합 934 / 697 MB. 1회차 작업 집합에는 샘플 순간 떠 있던 `orca.exe` 2개(247 MB, 전용 12 MB)가 들어가 있다. 역할별 평균 main 0.07–0.16%, renderer 0.02–0.05%, gpu 0.02–0.06%, plugin 0.000–0.003%.
- M11 비교: 평균 0.227%·0.256% → 0.123%·0.295% 로 같은 범위, 1% 목표 충족. 전용 메모리 +16–18 MB(대사 목록·게이트 원장 등). 1초 snapshot 요청(플러그인→호스트 IPC)과 WAL stat 은 plugin 0.003% 이하로 보인다.
- 측정 도구 수정: B3·B5 뒤 플러그인에 `lines.json` 이 생겨 측정 스크립트의 임시 복사가 이를 빠뜨려 orca 가 무효 처리됐다(첫 시도 실패). `idle-cpu-orca.mjs`·`idle-cpu-jungle.mjs` 복사 목록에 추가(b7897a7).
- 미측정: Orca 작업 중(WAL 이 자주 바뀌어 스냅샷이 최소 3초 간격으로 도는 상태)의 부하. 다음 실제 orchestration 중 같은 명령으로 잰다(기준 11 실사용과 함께).

## M12 Orca 작업 중 (2026-10-15, M12 기준 10)

- 조건: 위 대기 측정과 같은 명령·환경(main d13548e, A4 스냅샷 병렬·A5/A6 배지 포함). 측정하는 동안 별도 스크립트가 coordinator 의 테스트 task 에 게이트를 만들고 2초 뒤 처리하기를 5초 간격으로 20회 반복해 `orchestration.db-wal` 이 약 2.5초마다 바뀌게 했다(빠른 감지 → 최소 3초 간격 빠른 읽기가 계속 도는 상태).
- 결과: 평균 **0.692%**(최대 2.04%), 역할별 main 0.416%·gpu 0.136%·renderer 0.062%·plugin 0.010%. 메모리 전용 511 MB(작업 집합 1773 MB, 그중 동시에 떠 있던 `orca.exe` 8개 1027 / 105 MB). 1% 목표 충족.
- 해석: 대기(0.12–0.30%) 대비 증가는 3초마다 도는 빠른 읽기(활성 run 병렬 4)와 말풍선 표시 때문이다. 연속 쓰기가 이보다 잦은 실제 orchestration 은 드물어 상한에 가까운 조건으로 본다.
