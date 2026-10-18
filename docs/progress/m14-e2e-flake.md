# M14 e2e 간헐 실패 조사

조사일: 2026-10-17. 범위는 e2e 공용 헬퍼와 기존 실패 기록의 읽기, 전체 e2e 재현 측정이다. 앱과 e2e 코드는 바꾸지 않았다.

## 실패가 나는 경로

`apps/desktop/e2e/desktop-app.ts`의 `DesktopApp.launch`는 실행마다 UUID 제어 파이프, 임의 이벤트 포트, 임시 사용자 데이터 경로로 Electron을 띄운다. `waitReady`는 최대 150회 반복하며 각 회차에서 제어 파이프 `state` 요청(기본 제한 3초), 준비 상태 확인, 100ms 대기를 한다. 준비 조건은 펫·말풍선 렌더러·플러그인 호스트·지형 감시기·설정 창 로드 상태를 포함한다. **150 × 100ms는 전체 벽시계 제한이 아니다.** 응답이 늦은 회차마다 3초가 더해질 수 있다. 연결 오류는 마지막 오류로 보관하고 재시도하며, 예기치 않은 네이티브 대화상자만 즉시 던진다.

`requestRaw`는 `\\.\pipe\deskpet-dev-<UUID>`에 연결한다. Windows의 `connect ENOENT`는 그 이름의 파이프가 없을 때 나온다. 시작 중 아직 열리지 않았거나, 앱 종료·충돌 후 이미 닫혔거나, 정리와 요청이 경합한 경우가 후보이다. 이 오류 하나만으로 앱이 시작에 실패했는지 종료 중이었는지는 판정할 수 없다.

정상 종료 요청(`quit` 또는 `dispose`)은 제어 파이프의 트레이 `quit` 명령에 대한 응답을 기다린 뒤 `waitForExit`로 main Electron의 `exit`를 최대 12초 기다린다. 12초가 지나면 `state` 재요청(최대 3초), `forceStop`(main 자식에 `kill`, `exit` 또는 최대 5초)을 거쳐 `Electron did not quit`을 던진다. 정상 종료 뒤에는 마지막 `state`에서 본 플러그인 PID의 소멸을 최대 50 × 100ms 확인한다. `forceStop` 경로는 Electron 자손 전체를 확인하지 않는다. 테스트의 `afterEach`/개별 테스트 제한(예: `event.e2e` 정리 15초, `character-review.e2e` 개별 8초)과 종료 최악 경로(quit 요청 3초 + exit 12초 + 진단 요청 3초 + 강제 정리 5초)는 서로 맞지 않는다.

앱의 `quitApp`(`apps/desktop/src/main/index.ts`)은 위치 저장에 1.5초 제한을 두고 창·서버·제어 소켓을 닫은 뒤 `app.exit(0)`을 호출한다. 6초 뒤 main PID를 강제 종료하는 안전망도 건다. 그러므로 12초 초과는 단순히 정상 정리가 몇 초 더 걸렸다는 설명만으로는 부족하다. main이 실행 기회를 얻지 못했거나, 종료 이벤트/프로세스 관측이 지연됐거나, 제어 요청과 종료가 경합했을 가능성을 구분해야 한다.

## 측정 방법과 결과

동일 빌드를 한 번 만든 뒤 `pnpm exec vitest run --mode e2e`를 실행했다. 이는 `pnpm test:e2e`의 빌드 뒤 테스트 단계와 같은 명령이다. `vitest.config.ts`의 e2e 설정은 실행기 한 개당 `maxWorkers: 1`, `minWorkers: 1`이다. 따라서 두 실행기를 겹치면 동시 e2e 워커가 두 개가 된다. 측정 PC는 Windows 11 Enterprise 10.0.26200, i7-12700(논리 20코어), RAM 31.8GB다. 샘플러는 3초 간격으로 Windows CPU 부하(`Win32_Processor.LoadPercentage`), 사용 가능한 물리 메모리, Electron/Node 프로세스 수와 작업 트리 경로가 들어간 PID를 기록했다. CIM 조회 시간 때문에 실제 샘플 간격은 3초보다 길 수 있다. 원자료는 저장소 밖 `%TEMP%\deskpet-m14-e2e-<조건>/summary.json`과 `run*.out.txt`에 있다.

| 조건·회차 | 실행 시각 | 결과(실패 파일·메시지) | 소요 | CPU 평균/최대 | 최저 가용 메모리 | Electron/Node 최대 | 종료 뒤 남은 테스트 프로세스 |
|---|---|---|---:|---:|---:|---:|---|
| ③ 사용자 DeskPet 꺼짐, Orca 켜짐 #1 | 21:28:18–21:35:19 | 53/53 파일, 196 통과·1 건너뜀 | 422초 | 34% / 82% | 8,825 MB | 16 / 8 | Electron 0, 작업 트리 Node 0 |
| ③ 사용자 DeskPet 꺼짐, Orca 켜짐 #2 | 21:35:27–21:41:57 | 53/53 파일, 196 통과·1 건너뜀 | 390초 | 34% / 59% | 8,752 MB | 14 / 7 | Electron 0, 작업 트리 Node 0 |
| ① 사용자 DeskPet·Orca 켜짐 #1 | 21:42:41–21:49:57 | 53/53 파일, 196 통과·1 건너뜀 | 436초 | 41% / 72% | 7,784 MB | 27 / 6 | 테스트 Electron 0, 사용자 앱 Electron 11 |
| ① 사용자 DeskPet·Orca 켜짐 #2 | 21:51:29–21:59:28 | 53/53 파일, 196 통과·1 건너뜀 | 479초 | 44% / 82% | 7,759 MB | 27 / 6 | 테스트 Electron 0, 사용자 앱 Electron 11 |
| ② 사용자 앱 켠 채 전체 실행기 2개 중첩 #1 | 21:59:39–22:12:49 | 실행기 1: 53/53 통과. 실행기 2: 52/53 통과, `event.e2e.test.ts` 한 테스트 `Test timed out in 5000ms`(실제 7,735ms) | 791초 | 54% / 84% | 6,052 MB | 43 / 9 | 테스트 Electron 0, 사용자 앱 Electron 11 |
| ② 사용자 앱 켠 채 전체 실행기 2개 중첩 #2 | 22:13:46–22:25:51 | 실행기 1: 53/53 통과. 실행기 2: 52/53 통과, `checker-window.e2e.test.ts` `Dev control timed out`(제어 요청 3초 제한) | 726초 | 50% / 91% | 6,226 MB | 39 / 9 | 테스트 Electron 0, 사용자 앱 Electron 11 |

CPU 값은 논리 코어 전체의 Windows 부하율이다. Electron/Node 최대는 해당 실행기의 앱만이 아니라 사용자 앱·측정 과정의 프로세스도 포함한다. 사용자 DeskPet은 21:42:06에 `C:\Users\Example\Desktop\deskpet\start-deskpet.cmd`로 켰다. 이 스크립트는 원래 저장소를 빌드하고 기본 사용자 데이터(`%APPDATA%\deskpet`)에서 실행한다. 측정 뒤에도 켜 둔다.

실패 파일은 같은 빌드에서 단독 `pnpm exec vitest run --mode e2e <파일>`로 다시 실행해 결과를 아래에 적는다.

| 원래 조건·파일 | 원래 실패 | 단독 재실행 결과·소요 |
|---|---|---|
| 중첩 #1 실행기 2 `event.e2e.test.ts` | 새 Electron 기동 → CLI 이벤트 전송 → 종료까지 하는 테스트가 기본 5초를 초과(7,735ms) | 사용자 앱을 켠 채 15/15 통과, 31.9초(파일 전체) |
| 중첩 #2 실행기 2 `checker-window.e2e.test.ts` | 제어 요청이 3초 안에 응답하지 않아 `Dev control timed out`; 앱 main은 그때까지 살아 있었고 테스트가 `forceStop`한 뒤 `SIGTERM` | 사용자 앱을 켠 채 1/1 통과, 5.4초(파일 전체) |

실패 출력 직후의 별도 프로세스 스냅샷: 중첩 #1의 `event` 실패를 22:02:23에 확인했을 때 CPU 52%, 가용 메모리 7,892MB, 테스트 Electron 6개·사용자 Electron 11개·작업 트리 Node 4개였다. 중첩 #2의 `checker-window` 실패를 22:21:17에 감지했을 때 CPU 44%, 가용 메모리 6,732MB, 테스트 Electron 18개·사용자 Electron 11개·작업 트리 Node 4개였다. 스냅샷은 실패 출력 감지 시점이며 오류 발생 순간의 CPU 최고치라고 주장하지 않는다. 두 회차 모두 종료 시 테스트 Electron·작업 트리 Node가 0개로 돌아왔다. `checker-window`의 진단 로그는 팝업 거부 처리까지 진행됐음을 보여 주지만, 어떤 제어 명령이 3초를 넘겼는지는 현재 로그로 특정할 수 없다.

재현 명령(스크립트는 저장소 밖 `%TEMP%\deskpet-m14-measure.ps1`, 결과도 `%TEMP%\deskpet-m14-e2e-<label>`):

```powershell
pnpm build:host
pnpm --filter @deskpet/cli build
pnpm --filter @deskpet/desktop build
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label baseline1 -Parallel 1
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label baseline2 -Parallel 1
Start-Process -FilePath 'C:\Users\Example\Desktop\deskpet\start-deskpet.cmd' -WindowStyle Hidden
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label useron1 -Parallel 1
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label useron2 -Parallel 1
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label overlap1 -Parallel 2
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\deskpet-m14-measure.ps1" -Label overlap2 -Parallel 2
```

스크립트는 `Start-Process pnpm.cmd`로 지정한 수의 `pnpm exec vitest run --mode e2e`를 동시에 시작하고 각 stdout/stderr를 따로 저장한다. 살아 있는 동안 3초 대기 뒤 CIM으로 CPU·가용 메모리·Electron/Node 수·작업 트리 PID를 샘플링해 `summary.json`에 기록한다. 따라서 표의 소요는 전체 실행기 시작부터 마지막 종료까지의 벽시계 시간이며 Vitest 내부 `Duration`과 몇 초 다르다. `overlap2`는 실패 출력 감지 시 별도 스크래치 감시기로 프로세스 스냅샷도 남겼다. 사용자 DeskPet은 종료하지 않았다.

## 기존 기록과의 관계

- M6 동시 전체 e2e 조사(`docs/e2e-concurrency.md`): 두 실행기에서 각각 7건 실패, 단독 재실행은 통과. 당시에는 CPU 부하와 고정 7777 포트가 후보였고 현재 헬퍼는 포트를 임의 값으로 고정한다.
- `event.e2e`의 과거 포트·종료 시간 초과, `character-review.e2e`의 제어 파이프 `ENOENT`는 M6 동시 실행 조사에서 CPU 부하 아래 관측됐다. 이번 중첩에서도 `event`의 다른 5초 제한과 `checker-window`의 3초 제어 요청 제한이 실패했으므로 같은 **부하 민감성**은 지지된다. 그러나 `ENOENT`와 종료 지연의 정확한 순서와 자원 상태는 당시 남지 않아 동일한 단일 원인으로 묶을 수 없다.
- `movement.e2e`의 과거 종료 시간 초과는 부하 관련 가능성이 있지만 이번 여섯 회차에서는 재현되지 않았다. 1px 착지 차이로 매번 실패했던 별도 건은 모니터 작업 영역 y=1이라는 테스트 가정 오류로 고쳤으므로 이번 시간 초과 계열과 분리한다(`STATUS.md`).
- M9/M12 `error-log.e2e`: M9 전체 6회 중 1회 실패(그 실행 283초, 메시지 미보존), 단독 5/5 통과. M12 전체 세 번째 실행에서 5초 시간 초과, 단독 3회 통과. 지연과 관련될 수 있으나 파이프/종료 오류와 같은 원인이라는 증거는 없다.
- ART-8 `content-bounds`는 Electron 코드 1 종료, `position`은 테스트 워커 비정상 종료였다. 이후 같은 브랜치·main에서 재실행 통과했다. 이번 세 오류와 직접 같은 경로인지 미확인이다.
- M13 종료 점검에서는 겹친 e2e 실행 중 전체 두 회차에서 8파일·2파일 실패, 세 번째 단독 회차 53/53 통과했다(`STATUS.md`, `backlog.md`). 실제 실패 로그의 파일별 시각·프로세스 상태가 보존되지 않아 아래 측정으로 별도 검증한다.

## 원인 후보와 대책 비교

### 원인 후보

1. **관측: 중첩 실행에서 서로 다른 대기 제한 초과.** 앱을 켠 단독 2회는 모두 통과했지만 중첩 회차는 실행기 둘 중 하나씩 실패했다. 첫 회차의 `event.e2e`는 새 Electron 기동·CLI 호출·`finally` 종료를 합쳐 7,735ms 걸려 기본 5초 제한을 넘었다. 두 번째의 `checker-window.e2e`는 정상 시나리오 중 한 제어 요청이 3초 감시 타이머를 넘겼다. 둘 다 단독 재실행은 통과했다. 중첩 실행 평균 CPU는 50~54%(단독 41~44%), Electron 최대는 39~43개(단독 27개), 벽시계 소요는 726~791초(단독 436~479초)였다. **추론:** 실행기 간 CPU·프로세스 기동 경쟁이 테스트와 제어 요청의 벽시계를 늘렸을 가능성이 크다. 전체 CPU 수치만으로 특정 프로세스의 스케줄링 지연을 직접 증명하지는 못한다.
2. **미확인: 제어 파이프 수명과 요청의 경합.** `ENOENT`는 파이프가 없는 순간의 연결 오류다. `waitReady`에서는 재시도되지만, 준비 이후의 일반 `request`에서는 그대로 실패한다. 앱이 종료 중이거나 강제 종료된 뒤 요청하면 같은 메시지가 가능하다. 이번 4개 중첩 실행기에서는 `ENOENT`나 `Electron did not quit`이 재현되지 않아 M13의 정확한 발생 순서는 알 수 없다. `checker-window`의 3초 요청 시간 초과는 같은 제어 통로의 지연이지만 `ENOENT`와 동일 원인이라고 단정할 수 없다.
3. **이번 측정에서 낮은 가능성: 영구 프로세스 누수·물리 메모리 고갈.** 앱을 끈 2회, 켠 단독 2회, 중첩 2회 종료 뒤 테스트 Electron은 모두 0개였다. 두 중첩 회차에도 최저 가용 메모리 6,052·6,226MB가 남았다. 테스트 도중 일시적으로 자손 프로세스가 늦게 사라지는 경우는 이 종료 시점 조사로 배제할 수 없다.

### 대책안

| 안 | 기대 효과와 측정 근거 | 비용·한계 |
|---|---|---|
| A. 전체 e2e 진입점에 작업 트리 간 실행 잠금 | 중첩 두 회차에서 각각 1/2 실행기 실패, 소요 726~791초로 단독 436~479초보다 길었다. `maxWorkers: 1`만으로 실행기 간 간섭은 막히지 않는다. 같은 PC에서는 하나만 시작하게 강제한다. | 중간. 잠금 소유 PID·시작 시각 기록, 비정상 종료 후 회수, 직접 `vitest` 실행 안내가 필요하다. 대기하는 작업의 완료 시간은 늦어지지만 자원 경쟁은 줄인다. |
| B. 앱 기동과 종료를 함께 하는 테스트의 제한 시간을 실측에 맞춤 | `event.e2e` 해당 테스트는 중첩에서 7,735ms, 단독 파일은 31.9초에 15/15 통과했다. 이 테스트만 예를 들어 12초로 정하고 주석에 조건·관측 최댓값을 남기면 확인된 5초 거짓 실패를 막는다. | 낮음. `checker-window`의 3초 제어 요청 제한이나 `ENOENT`는 고치지 않는다. 제어 요청 제한은 성공 요청의 지연 분포를 먼저 계측한 뒤 조정해야 하므로 이번 자료만으로 수치를 제안하지 않는다. |
| C. 헬퍼에 단계별 시간·PID 진단과 종료 후 자손 확인 추가 | `Electron did not quit`은 현재 마지막 상태와 로그만 남기며, `forceStop`은 main `exit`만 본다. 정상 종료 요청·앱 6초 안전망·헬퍼 12초 대기 중 어느 단계가 지연됐는지, 남은 자손이 있는지 다음 실패에서 가를 수 있다. | 중간~높음. Windows 자손 추적과 종료 확인이 필요하다. 강제 정리는 테스트가 띄운 PID 트리로 한정해야 사용자 DeskPet을 건드리지 않는다. 아직 영구 누수는 관측되지 않아 이 안만 먼저 구현할 근거는 약하다. |

**추천:** A로 중첩 실행을 우선 막고, B는 `event.e2e`의 해당 테스트에 한정한다. `checker-window`처럼 일반 제어 요청이 3초를 넘긴 사례는 C의 명령별 시간 계측으로 성공 지연의 최댓값을 얻은 뒤 제한을 결정한다. `Electron did not quit`·`ENOENT`는 이번에 재현되지 않았으므로 C의 진단을 통해 다음 발생 시 원인을 분리한다. 코드는 이 조사 task에서 변경하지 않는다.

## 3회차 지연 (M14 기준 9, orca.e2e `advanceReminderClockForTest` 10초 초과)

관측: 사용자 DeskPet을 켠 채 main(8a52dbc)에서 전체 e2e 연속 3회가 53/53, 53/53, 51/53이었다. 3회차의 `orca.e2e` 두 테스트가 `Dev control timed out; phases: launch=19ms, waitReady=910ms; last control: advanceReminderClockForTest=10011ms`로 실패했다. 기동은 빨랐으므로 기동 문제가 아니라 그 명령 안의 대기가 멈춘 것이다.

### 계측

`advanceReminderClockForTest`(`apps/desktop/src/main/index.ts`)는 `pluginHost.idle()` → `scheduler.advanceForTest` → `scheduler.idle()` → `bubbleWindow.settled()` 순서로 기다린다. 임시로 단계별 누적 소요를 응답에 넣고 `orca.e2e`의 호출(30초 전진 29회/파일)마다 기록했다(측정용 기록 코드는 되돌렸다). 측정 PC는 앞 절과 같고 사용자 DeskPet은 켜 둔 상태다.

| 조건 | 호출 수 | 중앙값 | 최대 | 합계 | 결과 |
|---|---:|---:|---:|---:|---|
| orca 단독 #1~#5 | 각 ≈30 | 약 300ms | 731ms(#1) | — | 5/5 통과(파일 33~38초) |
| 전체 e2e #1 안의 orca | 29 | 372ms | 1,078ms | 12,968ms | 53/53 |
| 전체 e2e #2 안의 orca | 29 | 321ms | 814ms | 10,277ms | 53/53 |
| 전체 e2e #3 안의 orca | 29 | 409ms | 914ms | 12,053ms | 53/53 |
| 전체 3회 직후 orca 단독 | 29 | 373ms | 1,070ms | 11,299ms | 6/6 통과 |

- 시간은 거의 전부 `scheduler.idle()` 단계(플러그인 프로세스가 가짜 Orca CLI를 호출하는 구간)이다. `pluginHost.idle()`은 0~1ms, `bubbleWindow.settled()`는 0~11ms였다.
- 회차가 갈수록 늘어나는 경향은 없다(합계 12.9→10.3→12.1→11.3초). 임시 폴더도 orca 5회 단독 실행 동안 `deskpet-orca-*`가 늘지 않았다(테스트 정리가 동작). 전체 실행 뒤 테스트 Electron 프로세스는 남지 않았다.
- **결론: 전체 3회 연속 + 직후 orca, orca 단독 5회, 합계 8번 실행에서 10초 지연은 재현되지 않았다.** "연속 실행에서 쌓이는 상태"는 이 측정에서 확인되지 않는다. 정상 최대치는 1.1초로, 관측된 10초 지연은 정상 분포와 한 자릿수 배 이상 떨어진 일시적 정지이다. 어느 단계에서 멈췄는지는 당시 로그에 없어 단정하지 못한다.

### 하드웨어 지표(추가 가설)

전체 3회 + orca 구간을 `%TEMP%\deskpet-hw-sampler.ps1`로 2~3초 간격 샘플링했다(첫 샘플은 전체 #1 시작 약 50초 뒤). Defender(`MsMpEng`) CPU는 권한 문제로 읽지 못했다.

| 구간 | 샘플 | 실효 성능 평균/최저(% Processor Performance) | 최저 주파수 | 최대 코어 사용률 평균/최대 | 디스크 큐 최대 | 디스크 시간 평균 | Electron 누적 CPU초 최대 |
|---|---:|---|---:|---|---:|---:|---:|
| 전체 #1 | 114 | 153% / 97% | 2,100MHz | 86% / 100% | 5.76 | 48% | 201 |
| 전체 #2 | 129 | 154% / 135% | 2,100MHz | 86% / 100% | 3.44 | 45% | 223 |
| 전체 #3 | 132 | 153% / 116% | 2,100MHz | 84% / 100% | 4.48 | 45% | 249 |
| orca 단독 | 12 | 160% / 148% | 2,100MHz | 77% / 95% | 0.41 | 20% | 251 |

- 열 스로틀링 징후는 없다. 실효 성능이 회차가 갈수록 떨어지지 않고(평균 153→154→153) 최저치도 기본 클럭 이상이다.
- **전체 e2e 동안 가장 바쁜 코어가 평균 85% 안팎, 최대 100%이다.** 평균 CPU 40~50%에 가려지는 한 코어 포화가 상시 있다. 디스크 시간도 평균 45%, 큐 길이가 최대 5.8까지 올라 디스크 경합이 있다. 이 상태에서 가짜 CLI를 호출마다 새 `node` 프로세스로 띄우는 구간이 가장 압박을 받는다고 보는 것이 합리적이나, 10초 정지 순간의 값은 얻지 못해 인과는 입증하지 못했다.

### 수정

- 원인이 확정되지 않았으므로 제한 시간(10초)은 올리지 않고 `orca.e2e` 단언도 그대로 둔다.
- 다음 실패에서 원인을 가르도록, `advanceReminderClockForTest`가 5초가 지나도 끝나지 않으면 어느 단계(`pluginHost.idle` / `scheduler.idle` / `bubbleWindow.settled`)를 기다리는지 stderr에 경고를 남기도록 했다(개발 제어 경로 안, 정상 실행에는 타이머만 추가). 성공 응답에는 단계별 누적 소요(`stepsMs`)를 넣었다. 테스트 헬퍼는 앱 stderr를 이미 수집하므로 실패 진단에 함께 나온다.
- 운영 대책 제안(근거: 코어 포화·디스크 경합이 전체 실행 내내 상시, 중첩 실행에서 실패율 증가는 앞 절에서 관측): 전체 e2e는 한 번에 하나만(기존 잠금), 연속 3회 점검 중에는 사용자의 다른 무거운 작업(빌드·다른 worktree의 테스트)을 피한다. 연속 실행 사이 쉬는 시간이 효과가 있다는 측정 근거는 얻지 못해(쌓이는 상태 없음) 제안하지 않는다.
- 재현 명령: 샘플러는 저장소 밖 `%TEMP%\deskpet-hw-sampler.ps1 -Out <csv> -Done <종료표시파일>`, 전체 실행은 `pnpm exec vitest run --mode e2e`, 단독은 `pnpm exec vitest run --mode e2e apps/desktop/e2e/orca.e2e.test.ts`.

### 남은 것

- 다음에 같은 실패가 나면 stderr의 "still waiting for <단계>" 줄로 멈춘 단계를 확인한다. `scheduler.idle`이면 플러그인 쪽 가짜 CLI 호출 지연(프로세스 기동·백신 검사)을 의심하고, 그때 실패 시점의 코어별 사용률을 같이 샘플링한다.
