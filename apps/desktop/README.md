# DeskPet desktop 확인

## Character selection

Double-clicking `start-deskpet.cmd` launches `wolf-maid`. Add `--character=<pack-id>` to select a different pack, for example `start-deskpet.cmd --character=placeholder`. The script keeps `%*`, so later command-line arguments override its default selection.

`pnpm desktop:start` still defaults to `placeholder`, which the desktop e2e tests use. To launch the wolf maid through pnpm, run `pnpm desktop:start --character=wolf-maid`. You can also run `pnpm --filter @deskpet/desktop start:dev --character=wolf-maid` after building the desktop app.

## M2 위치·모니터 확인

1. Windows에서 모니터 두 대를 좌우로 배치해 앱을 실행한다. 펫을 드래그해 다른 모니터로 넘기고, 놓았을 때 해당 모니터의 작업 영역 안에 남는지 확인한다. 모니터를 상하로 배치하거나 왼쪽 모니터에 음수 좌표가 있는 경우에도 확인한다.
2. 각 모니터의 화면 배율을 125%, 150%로 바꿔 펫을 이동한다. 그림이 선명한지, 투명한 부분을 클릭하면 뒤 창으로 입력이 통과하는지, 불투명한 부분에서 드래그가 시작되는지 확인한다. 실행 중 배율을 바꾼 뒤에도 다시 확인한다.

   배율이 다른 모니터로 넘기면 펫의 화면상 크기가 OS 배율에 따라 달라지는 것은 의도된 동작이다. 논리 크기(DIP)는 캐릭터의 `cellSize × scale`로 유지된다. 모니터를 왕복할 때 논리 크기가 계속 커지던 버그는 수정했다.
3. 펫을 옮긴 뒤 앱을 종료하고 다시 켠다. 발 위치가 같은 화면 좌표에 복원되는지 확인한다. 펫이 있던 모니터를 제거한 뒤 다시 켜면 남은 모니터의 작업 영역 안에 나타나는지 확인한다.

개발용 제어 통로(`--dev-control=<이름>`)와 함께 `--user-data-dir=<경로>`를 전달하면 위치 JSON을 해당 폴더에 저장한다. `state` 결과의 `displays`, `display`, `bounds`, `contentBounds`, `contentRect`, `rendererMetrics`, `foot`, `savedPosition`으로 모니터와 위치, 실제 창 크기를 확인할 수 있다.

가장 쉬운 방법은 저장소 루트의 `start-deskpet.cmd`를 더블클릭하는 것이다. 빌드한 뒤 펫을 띄우고 콘솔 창은 닫힌다. 캐릭터를 바꾸려면 `start-deskpet.cmd --character=placeholder-alt`처럼 인자를 붙인다.

터미널에서는 저장소 루트에서 `pnpm install` 후 `pnpm desktop:start`로 실행한다. 기본 캐릭터는 `characters/placeholder`이다. 팩을 바꾸려면 `pnpm --filter @deskpet/desktop build` 후 `pnpm --filter @deskpet/desktop exec electron . --character=placeholder-alt`를 실행한다. 팩 폴더가 다른 곳에 있으면 `--characters-dir=<절대경로>`도 전달한다. `--character`에는 폴더 이름 하나만 지정할 수 있다.

개발용 실행에는 named pipe 제어 통로가 열린다. `--dev-control=<이름>`을 생략한 일반 실행에는 열리지 않는다. 제어 이름은 영문 소문자, 숫자, 하이픈 1–32자이다. 한 줄 요청은 최대 64 KiB이고 동시 처리 요청은 연결마다 최대 8개이다.

## 사람 확인 절차

1. 투명한 창에 캐릭터 팩의 그림이 보이는지 확인한다. 바깥 투명 영역을 클릭하면 뒤의 창이 입력을 받고, 불투명한 캐릭터 부분을 클릭하면 DeskPet이 입력을 받는다.
2. 캐릭터의 불투명한 부분을 왼쪽 버튼으로 잡아 끌고 놓는다. 드래그하는 동안 걷기 이동이 멈추고 놓으면 idle로 돌아온다. 보이는 캐릭터가 작업 영역 안에 남는지 확인한다.
   펫을 잡고 화면 아래로 벗어났다가 맨 위까지 올려, 펫이 작업 영역 맨 위에 닿는지 확인한다. 캐릭터를 화면 네 가장자리(위, 아래 작업 표시줄 바로 위, 왼쪽, 오른쪽)에 각각 붙여 본다. 투명한 셀 여백이 아니라 보이는 캐릭터가 가장자리에 닿아야 한다.
3. 몇 초 기다려 깜빡임을 확인한다. 더 오래 기다리면 좌우로 걷고, 오랫동안 조작하지 않으면 잠든다. 발 위치는 상태가 바뀌어도 흔들리지 않아야 한다.
4. 작업 표시줄의 DeskPet 트레이 메뉴에서 숨기기, 표시, 종료를 확인한다. 숨겨진 동안 애니메이션과 걷기 이동은 멈춘다.
5. `--character=placeholder-alt`로 다시 시작해 색이 달라지는지 확인한다. 잘못된 팩을 지정하면 앱이 종료되지 않고 분홍색 대체 그림을 보여야 한다.

자동 검증은 저장소 루트에서 `pnpm test:e2e`를 실행한다.

## 개발 제어 명령

`pnpm desktop:start`의 제어 이름은 `default`이다. `apps/desktop/scripts/control.mjs`의 `sendRequest`로 아래 JSON 명령을 보낼 수 있다.

- `{ "cmd": "character" }`: 팩 id, 로드 여부, 오류, 상태, 프레임, 보유 상태 목록
- `{ "cmd": "setCharacter", "character": "placeholder-alt" }`: 실행 중 팩 교체
- `{ "cmd": "setState", "state": "worried" }`: 요청한 상태와 fallback 적용 결과 확인
- `{ "cmd": "clock", "action": "pause" }`, `{ "cmd": "clock", "action": "resume" }`, `{ "cmd": "clock", "action": "advanceMs", "advanceMs": 1000 }`: 재생 시계 제어
- `{ "cmd": "state" }`: 창 상태와 현재 캐릭터 상태

## 로컬 이벤트 API와 deskpet 명령

저장소 루트에서 `pnpm build`를 한 뒤 앱을 실행하고 `pnpm deskpet event --text "테스트 알림" --mood happy`를 실행한다. `pnpm deskpet status`는 캐릭터와 서버 상태를 출력하며 `--json`을 붙이면 원본 JSON을 출력한다. JSON 파일은 작업 폴더 안의 상대 경로로 `pnpm deskpet event --file .\event.json`처럼 보낸다. UTF-8·UTF-16 BOM을 읽는다. `--json '<PetEvent JSON>'`도 사용할 수 있다.

PowerShell이나 메모장으로 만든 파일(BOM 포함)도 읽는다.

```json
{"source":"manual","type":"notify","text":"테스트 알림","priority":"normal"}
```

기본 서버는 `127.0.0.1:7777`에서 열린다. 인증 파일은 Windows의 `%APPDATA%\deskpet\event-server.json`에 있으며 실제 포트와 토큰을 담는다. 앱은 서버가 열린 뒤에만 `{port, token}`을 한 번에 기록하고, 서버를 열지 못하면(포트 사용 중) `port` 없이 토큰만 남긴다. CLI는 파일이 준비될 때까지 최대 2초 기다린 뒤, 파일이 없거나 `port`(1~65535 정수)·`token`이 잘못되면 요청 없이 이유를 알리고 실패한다. 개발 실행에서 `--user-data-dir=<경로>`를 사용했다면 CLI에도 `--user-data-dir <경로>`를 전달한다. PowerShell에서 직접 HTTP를 보내려면:

```powershell
$auth = Get-Content "$env:APPDATA\deskpet\event-server.json" -Raw | ConvertFrom-Json
curl.exe -X POST "http://127.0.0.1:$($auth.port)/event" -H "Authorization: Bearer $($auth.token)" -H "Content-Type: application/json" --data-binary '{"source":"manual","type":"notify","text":"테스트 알림"}'
```

이벤트는 최근 100개만 기록한다. 개발 제어 통로의 `events` 명령은 테스트용 기록 조회로 남고 이벤트 주입 명령은 제거했다.

## 말풍선과 표정 반응

- `notify`는 알림 큐를 거쳐 펫 옆의 말풍선 창에 `text`를 보여 준다. `detail`과 버튼(`actions`)은 아직 보여 주지 않는다. `text`가 없는 `notify`는 표정만 바꾼다.
- 표시 시간은 `normal` 6초, `high` 10초, `urgent` 15초이고 말풍선을 클릭하면 바로 닫힌다. 다음 말풍선은 앞의 것이 닫히고 5초 뒤에 뜬다. `urgent`는 떠 있는 말풍선을 바로 대체한다(떠 있는 것이 `urgent`이면 닫힌 직후에 뜬다). `low`는 말풍선 없이 표정만 바꾸며, 말풍선이 떠 있으면 닫힌 뒤에 반영된다.
- `notify`와 `react`는 `mood`에 맞는 상태를 재생한다(`happy`, `surprised`, `worried`, `sleepy`→`sleep`. 팩에 없으면 `fallbacks`). 반복 상태는 한 바퀴, `urgent`는 세 번 재생한다. 말풍선이 떠 있는 동안에는 반응이 끝난 뒤 `talk`를 재생하고, 닫히면 `idle`로 돌아간다. `react`는 말풍선이 없고 `status`는 기록만 한다.
- 말풍선은 보이는 캐릭터 위쪽 가운데에 뜨고, 위에 자리가 없으면 아래에 뜬다. 펫이 있는 모니터의 작업 영역을 벗어나지 않으며 펫을 따라 움직인다. 펫을 숨기면 말풍선도 숨고 시계가 멈춘다. 숨긴 동안 받은 알림은 다시 표시할 때 보여 준다.
- 알림 배달은 재생 시계(`clock` 명령)를 따른다. 기다리는 알림이나 떠 있는 말풍선이 있을 때만 타이머 하나를 둔다.

### 사람 확인 절차 (말풍선)

저장소 루트에서 `pnpm build` 후 `pnpm desktop:start`로 앱을 띄우고, 다른 PowerShell 창에서 실행한다.

1. `pnpm deskpet event --text "안녕" --mood happy`: 펫 위에 "안녕" 말풍선이 뜨고 꼬리가 펫을 가리키는지, 펫이 기뻐한 뒤 말하는 동작을 하는지, 6초 뒤 말풍선이 닫히고 펫이 평소 상태로 돌아오는지 확인한다. 한글 글꼴이 깨지거나 글자가 잘리지 않아야 한다. 말풍선이 떠도 쓰던 창의 입력 포커스가 유지되어야 한다.
2. 말풍선을 클릭하면 바로 닫히는지, 말풍선의 둥근 모서리 바깥과 꼬리 옆 빈 곳을 클릭하면 뒤의 창이 입력을 받는지 확인한다.
3. 연달아 여러 개 보낸다. 출처가 같은 알림이 30초 안에 3개 이상 쌓이면 "cli 알림 3개"처럼 묶이므로, 하나씩 보려면 `--source`를 다르게 준다.

   ```powershell
   pnpm deskpet event --text "첫 번째" --source a
   pnpm deskpet event --text "두 번째" --source b
   pnpm deskpet event --text "급한 알림" --priority urgent --mood surprised --source c
   pnpm deskpet event --text "조용한 알림" --priority low --mood happy --source d
   ```

   첫 번째가 뜬 상태에서 급한 알림이 바로 대체하는지, 두 번째는 앞의 말풍선이 닫히고 5초 뒤에 뜨는지, `low`는 말풍선 없이 표정만 바뀌는지 확인한다.
4. 긴 글을 보낸다: `pnpm deskpet event --text ("가나다라마바사아자차" * 12)`. 말풍선 폭 안에서 줄이 바뀌고 마지막 줄까지 보이는지 확인한다.
5. 말풍선이 떠 있는 동안(`--priority urgent`면 15초) 펫을 끌어 본다. 말풍선이 펫을 따라오는지, 화면 맨 위로 올리면 말풍선이 펫 아래로 내려가고 꼬리가 위를 향하는지, 왼쪽·오른쪽 가장자리에서는 말풍선이 화면 안에 남고 꼬리가 펫 쪽에 있는지 확인한다. 모니터가 두 대면 다른 모니터로 넘겨서도 확인한다.
6. 말풍선이 떠 있을 때 트레이 메뉴에서 숨김을 누르면 말풍선도 사라지고, 표시를 누르면 다시 보이는지 확인한다.

개발 제어 명령:

- `{ "cmd": "state" }`의 `bubble`(`visible`, `text`, `priority`, `bounds`, `side`, `renderer`), `queue.pending`, `delivery`(`timer`: 실제 타이머 유무, `nextAtMs`: 다음에 깨어날 시계 값), `clock`
- `{ "cmd": "bubbleDismiss" }`: 말풍선을 클릭한다(실제 클릭과 같은 경로)
- `{ "cmd": "bubbleScreenshot", "path": "bubble.png" }`: 말풍선 창을 PNG로 저장한다. userData 폴더 안에만 저장하며 폴더 밖 경로는 거부한다
- `{ "cmd": "bubbleHitTest", "x": 0, "y": 0 }`: 말풍선 창 안의 좌표가 클릭을 받는지 확인한다

## 대기 CPU 측정

`pnpm build` 뒤 `node apps/desktop/scripts/measure-idle-cpu.mjs` 를 실행하면 빌드된 앱을 임시 `--user-data-dir` 폴더로 띄우고, 기동이 안정된 다음 30초(기본, `--seconds <초>` 로 변경) 동안 앱 프로세스 트리(main/renderer/gpu 등)의 CPU 시간을 1초 간격으로 샘플링해 논리 코어 수로 나눈 평균·최대를 출력한다. 트리는 앱 루트 pid 에서 `ParentProcessId` 로 자손 전체를 따라 모으므로 앱이 띄운 PowerShell 자식(창 감시 terrain-watcher, 전체 화면 감시 fullscreen-watcher)이 역할 `powershell` 로 따로 집계된다(역할별 평균·메모리에 나온다). 실행 중이던 다른 `electron.exe`(다른 DeskPet 세션 포함)와 이 스크립트가 조회용으로 띄우는 PowerShell 은 앱 트리 밖이라 제외되고, 측정이 끝나면 앱을 종료하고 남은 프로세스가 0인지 확인한다. `--terrain-off` 를 주면 임시 user-data 의 `settings.json` 에 `terrain.enabled=false` 를 미리 써서 창 감시 없이(전체 화면 감시 PowerShell 만 남는다) 기준선을 잰다. 옵션이 없으면 앱 기본값대로 창 감시 켬이며, 개발 제어 실행에서 `--terrain-source` 를 주지 않으므로 실제 PowerShell 감시기가 뜬다. 출력 JSON 의 `conditions.terrain`(`on`/`off`)과 `conditions.powershellCount` 에 조건과 powershell 프로세스 수가 들어간다. 결과 기록은 `docs/progress/idle-cpu.md`에 있다.

## Windows quit reliability investigation (FIX-4)

The e2e helper launches `electron.exe` directly; its watched child is the browser process, not a Node or cmd wrapper. A temporary probe launched the app with a unique `--dev-control` pipe and temporary `--user-data-dir`, sent the tray quit command, then sampled pipe closure, the watched process, and its Electron GPU/utility descendants. The probe did not use the real userData directory.

| Probe | Samples | Pipe closure after quit | All observed Electron processes gone | Child `exit` event |
| --- | ---: | ---: | ---: | ---: |
| Sequential baseline | 60 | 11-30 ms | 73-546 ms | Not retained by the first probe version |
| Five concurrent probes before the fix | 160 retained | p99 314 ms; max 338 ms | p99 3,634 ms; max 4,491 ms | 118 captured: p99 3,796 ms; max 4,642 ms |

The concurrent probe retained 160 of 200 records because two temporary result filenames collided. In 42 records, the process was already gone but the probe recorded the row before Node delivered its `exit` event; those rows are excluded from the event percentile. The process-disappearance measurements cover all 160 retained records. In the slowest observed case, the pipe closed in 14 ms, position persistence completed 2 ms after quit began, and `app.exit(0)` returned 11 ms after quit began (8 ms after it was called). At two seconds only the browser `electron.exe` remained; it disappeared at 4,491 ms and its `exit` event arrived at 4,642 ms. This identifies Electron's native browser-process teardown after `app.exit` as the delayed phase. The old 3,000 ms in-process kill timer could race a normal exit, and the old 3,500 ms e2e observation timeout was below the measured normal maximum; one pre-fix stress run also produced exit code 1, consistent with the kill timer firing.

The kill fallback is now 6,000 ms, beyond the measured 4,491 ms process-disappearance maximum. The e2e helper observes for 7,000 ms, long enough to see the fallback outcome, and still force-stops and fails on timeout. The character restart e2e test uses an 8,000 ms timeout because the added 20-launch lifecycle test runs concurrently: four measured completed runs reached 4,469 ms (p99/max), and another run exceeded the former 5,000 ms limit. The lifecycle regression test launches and quits the real app 20 times through the tray command. A complete e2e run took 18.03-22.62 seconds, below the 60-second threshold, so the 20 launches were retained.

Validation after the final changes: `pnpm typecheck`, `pnpm lint`, `pnpm test` (71 passed), and `pnpm build` all exited 0. Twenty consecutive `pnpm test:e2e` invocations each exited 0 with 23 tests passed: 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0, 11:0, 12:0, 13:0, 14:0, 15:0, 16:0, 17:0, 18:0, 19:0, 20:0. No matching Electron process remained afterward. Detailed run logs are in `%TEMP%\deskpet-fix-quit-check-1791252614\` on the validation machine.
