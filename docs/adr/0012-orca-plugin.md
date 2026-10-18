# ADR 0012: Orca 플러그인

## 상태

승인 (2026-10-13, D-066). 끝의 질문 4개에 답을 받았고, 질문 3 은 추천과 다르게 정했다(Orca 터미널 탭 전환, 동결 범위 변경). coordinator 수정 1건: 게이트 버튼은 선택지가 정확히 두 개일 때 그 원문(예: `yes`/`no`, `예`/`아니오`)을 버튼 이름으로 쓴다. v2 `ctx.orca` 의 정확한 시그니처·원장 형식은 구현 첫 task 에서 이 ADR 에 덧붙이고 coordinator 확인 뒤 사용자 gate 를 받는다.

표기: **코드 확인**은 이 작업 트리의 파일과 줄을 직접 확인한 사실, **관찰**은 이 PC의 설치된 `orca` CLI를 읽기 전용으로 실행한 결과, **추측**은 아직 재현하지 못한 동작이다. JSON의 개인 경로·토큰·메시지 본문·질문·목표 문구는 아래에 싣지 않고 필드명과 자료형만 기록한다.

## 배경과 범위

M11은 **이 PC의 모든 진행 중 Run**에서 worker 완료·실패, 사람 확인 필요(질문·escalation·게이트 생성), coordinator의 사람 대기, 멈춘 worker를 알리고, 게이트만 말풍선의 [예]/[아니오]로 처리한다(코드 확인: `docs/progress/milestones.md:570-604`). 다른 PC, 게이트 이외의 Orca 쓰기, Orca 창 안 화면 제어는 범위 밖이다. 기획안 7-3의 `check --peek --all`과 5–10초 주기는 현 CLI 및 비용 조사에 맞춰 이 ADR로 대체한다(코드 확인: `docs/plan.md:392-406`; 관찰: `check --help`에서 `--peek`와 `--all`은 택일).

현재 `plugins/orca/src/index.ts:1`은 `export {}`뿐이다(코드 확인). v1 `ctx.exec`는 사용자가 누른 액션 안에서만 허용되며, main의 `PluginSession`도 열린 invocation을 검사한다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:85,111-112`, `packages/plugin-host/src/session.ts:649-657`; ADR-0003 `docs/adr/0003-plugin-manifest-and-api-v1.md:24`, ADR-0005 `docs/adr/0005-plugin-host.md:66-79`). v2도 v1의 나머지 API를 상속하고 현재 `ctx.slack`만 추가한다(코드 확인: `packages/plugin-sdk/src/v2/contracts.ts:24-37`). 따라서 `schedule.every`에서 `ctx.exec`를 부르는 구현은 허용되지 않는다. `packages/plugin-sdk/src/v1/`은 수정하지 않는다.

## CLI 조사 (2026-10-13, 이 PC)

`orca orchestration --help`, `orca skills get orchestration --full`, 아래 각 명령의 `--help`와 실제 `--json` 결과를 확인했다(관찰). 아래 필드는 **존재와 자료형**이지 안정된 공개 스키마를 뜻하지 않는다. 모든 결과는 바깥에 `id`, `ok`, `result` 또는 `error`, `_meta.runtimeId`가 있었다. 오류는 `error.code`·`message`·선택적 `data`가 있었다.

| 읽기 명령 | 실제 결과의 주요 필드(민감한 값 생략) | 범위·주의 |
|---|---|---|
| `run-list --json` | `result.runs[]`: `id`, `objective`, `coordinator_handle`, `consumer_generation`, `legacy`, `created_at`, `updated_at`; `result.nextCursor` | 이 PC에서 과거 Run도 포함한 17건을 보았다. `--limit`, `--cursor`가 있다. `objective` 원문은 화면·로그에 그대로 옮기지 않는다. |
| `run-show --id <run> --json` | `result.run`: 위 Run 필드 | 상태(`active`) 필드는 없다. |
| `task-list --run <run> --json` | `result.runId`, `legacyReadOnly`, `tasks[]`, `count`; task의 `id`, `run_id`, `task_title`, `status`, `deps`, `result`, `created_at`, `completed_at`, `assignee_handle`, `dispatch_id` 외에 생성자·`spec` | 이 Run에서 task 1건. `spec`와 제목은 임의 본문으로 취급한다. `--run` 없이 worker 터미널에서 `run_required` 오류를 보았다. |
| `worker-list --run <run> --json` | `result.workers[]`: `dispatchId`, `taskId`, `runId`, `workerState`, `dispatchStatus`, `agentTerminalHandle`, `terminalState`, `projection.stage`, `projection.outcome`, `projection.liveness.{verdict,observedAt,source}`, `projection.evidence.{durable,liveStatus,lastObservedAt}`, `projection.attention.{categories,requiresAction}`, `projection.nextAction`; `counts`, `page.{limit,total,hasMore,nextCursor}`, `scope.{run,source}` | 이 Run에서 `liveness.verdict=live`, `stage.activity=working`을 보았다. 옛 Run에서는 `exited`, `unverifiable`, `failure`, `root_completion`도 보았다. 기본 최대 100건, `--cursor`로 끝까지 읽는다. 원격은 `--include-remote`가 있어야 하나 M11 범위에서는 사용하지 않는다. |
| `worker-show --dispatch <dispatch> --json` | `result.dispatch.{status,lastHeartbeatAt,...}`, `worker`, `projection`, `terminal.{worktreeId,worktreePath,lastOutputAt,agentWait,...}`, `observation.{status,exactWorker,agentWait}` | 이 worker의 `agentWait`는 `null`; 실제 사람 대기 표본은 보지 못했다. 도움말은 `observation.agentWait`의 양성값을 사람만 답할 수 있는 프롬프트의 증거라 설명한다. 필드 부재는 관찰 실패이며 `null`과 다르다. `terminal.preview`는 원문을 표시·저장하지 않는다. |
| `gate-list --run <run> --json` | `result.runId`, `gates[]`, `count`; 옛 Run의 gate에 `id`, `run_id`, `task_id`, `question`, `options`, `status`, `resolution`, `created_at`, `resolved_at` | 현 Run의 gate는 0건, 옛 Run에서는 `status=resolved`와 두 선택지를 보았다. `options`는 JSON **문자열**이었다. 질문 원문은 알림에 싣지 않는다. `--run` 없이 worker 터미널에서 `run_required`. |
| `check --terminal <handle> --peek --json` | `result.{runId,dispatchId,messages,count,acknowledged}` | 자기 worker 수신함은 `messages=[]`, `acknowledged=null`이었다. 다른 coordinator 터미널을 지정한 `--peek`은 `consumer_fenced`였다. **실제 `--peek`의 비어 있지 않은 `messages[]` 모양은 확인하지 못했다.** |

메시지 종류는 **관찰**: 별도 비소비 조회 `inbox --json`의 이 PC 기록에 `worker_done`, `escalation`, `question`, `status`, `heartbeat`가 있었다. 그 행에는 `id`, `run_id`, `from_handle`, `to_handle`, `type`, `priority`, `payload`, `read`, `sequence`, `created_at` 등이 있고 `payload`는 JSON 문자열이었다. 이는 `check --peek` 행의 스키마를 확인한 결과는 아니다. 구현은 실제 peek 표본 또는 가짜 CLI 계약 fixture에서 `messages[]` 형식을 확인해야 한다. `gate-create`는 메시지 타입으로 가정하지 않고 `gate-list`의 pending 상태로 탐지한다.

**모든 Run 나열:** `run-list --json`의 `nextCursor`가 없을 때까지 `--cursor`로 페이지를 읽고 각 Run에 `--run <id>`를 명시한다. `worker-list`도 `page.hasMore`에 따라 `page.nextCursor`를 그대로 사용한다. 다른 저장소에서 실행한 `run-list`를 대조한 실험은 하지 못했지만, 저장소 밖 작업 디렉터리에서도 같은 첫 Run ID를 보았다(관찰). Run 행에는 repo ID나 worktree 필드가 없어 **다른 저장소의 Run까지 포함되는지는 검증되지 않았다**. 구현 전 두 저장소에 각각 진행 중 Run을 만든 읽기 전용 비교로 확인한다. 연결된 다른 PC의 Run은 여기서 조회하지 않는다.

`gate-resolve --help`는 `--id <gate_id> --resolution <text> [--from <handle>] [--retry-request <id>] [--json]`을 요구한다(관찰). `orca skills get orchestration --full`은 pending gate에 `gate-resolve --id ... --resolution ...`을 안내한다. **이미 resolved인 gate에 다시 보냈을 때의 실제 응답·오류 코드는 문서화된 결과를 찾지 못했고, 쓰기 금지 때문에 실행하지 않았다.** 구현의 가짜 CLI에서는 이미 처리된 응답을 별도 fixture로 만들고, 실사용 전 실제 Orca 버전에서 사용자 버튼으로만 확인한다.

## 1. 읽기 방식과 수신함 보존

| 방식 | 얻는 것 | 부족한 점 |
|---|---|---|
| 메시지함 `check --peek` | `worker_done` 결과와 질문·escalation의 메시지 ID를 직접 본다. `--peek` 자체는 읽음 표시를 하지 않는다. | 터미널·Run 소유권이 필요하다. 다른 coordinator 터미널을 이 worker에서 지정하면 `consumer_fenced`; 모든 Run의 수신함을 하나의 호출로 읽는 수단이 아니다. 과거 메시지가 쌓이고 gate·현재 liveness를 설명하지 못한다. |
| `task-list`·`worker-list`·`gate-list` 폴링 | Run마다 상태를 비소비 조회한다. 완료·실패, pending gate, worker liveness에 적합하다. | `question`·`escalation`·coordinator의 프롬프트 내용은 상태만으로 확정하기 어렵다. |
| **혼합(추천)** | 상태 목록을 정본으로 사용하고, **호스트가 접근 권한을 가진 수신함에 한해** peek을 보강한다. `consumer_fenced`는 권한 없는 범위로 기록한다. | 질문·escalation을 모든 Run에서 완전하게 잡는지는 호스트 조회 권한 실험이 필요하다. 불가능하면 Orca의 별도 비소비 조회 API가 먼저 필요하다. |

**호출 허용 목록:** 호스트 중개 코드는 인자 배열을 직접 만든다. 자동 읽기에는 `orchestration run-list --json [--limit n] [--cursor opaque]`, `run-show --id <목록의 runId> --json`, `task-list --run <목록의 runId> --json`, `worker-list --run <목록의 runId> --json [--cursor opaque]`, `gate-list --run <목록의 runId> --json`, `worker-show --dispatch <목록의 dispatchId> --json`, `check --terminal <자기 소유로 확인된 handle> --peek --json`, `terminal show --terminal <목록의 coordinator_handle> --json`만 허용한다. Run·Dispatch·handle은 앞선 신뢰된 결과에서 받은 값과 대조한다. 플러그인이 임의 서브커맨드·플래그·CLI 인자를 넘기지 않는다. `check` 기본형, `--ack`, `--wait`, `--all`, `--unread`, `--types`, `--retry-request`, `inbox`, 모든 send/reply/생성/수정 명령은 자동 읽기 경로에서 거부한다. 특히 `--peek`과 `--all`을 결합하지 않는다. `--peek` 결과를 반복 조회해도 `acknowledged`가 null이고 coordinator가 자기 메시지를 그대로 받는지 가짜 CLI와 실사용에서 확인한다. **권한 없는 수신함을 억지로 읽는 우회는 하지 않는다.**

## 2. 버튼 없는 조회 권한

| 대안 | 규약·보안 | 구현 영향 |
|---|---|---|
| **A. v2 호스트 중개 `ctx.orca`(추천)** | v2 `permissions.orcaRead: true`와 `permissions.orcaGateResolve: true`(이름은 사용자 승인 후 확정)를 분리한다. `ctx.orca.snapshot()`은 main이 위 읽기 목록만 실행·정규화하고 플러그인은 명령·경로를 넘기지 않는다. `ctx.orca.resolveGate(gateId, resolution)`은 별도 승인된 쓰기 호출이고 열린 사용자 액션 invocation을 요구한다. ADR-0011의 `ctx.slack`처럼 서비스별 호스트 API다(코드 확인: `docs/adr/0011-slack-plugin.md:93-129`). | v2 타입·스키마, 권한 안내, runner↔session 봉투, main 실행기, 플러그인과 e2e가 필요하다. v1 폴더는 불변. |
| B. 독립 main 서비스 | 플러그인 API 없이 main이 Orca 조회·알림·게이트를 모두 맡는다. | 권한·재사용 경계가 플러그인 호스트 밖에 생기고, 켜고 끄기·설치본 포함·플러그인 상태와 별도 관리가 필요하다. |
| C. 플러그인 Node `child_process` 직접 실행 | 규약 변경 없이 주기 실행할 수 있어 보인다. | `utilityProcess`는 OS 샌드박스가 아니며, 현재 권한 검사를 우회한다(코드 확인: `docs/adr/0005-plugin-host.md:11-12`). 채택하지 않는다. |

A에서 읽기는 버튼 없이 가능하되 **외부 쓰기 요청이 아니다**. Orca 승인 값은 `permissions.shell`을 넓히지 않는다. 현재 `ctx.config`는 읽기 전용이고, v2에는 일반 지속 상태 API가 없다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:102-104`, `packages/plugin-sdk/src/v2/contracts.ts:24-37`). 따라서 호스트가 `userData` 안에 Orca 전용 알림 원장(버전, 본 키와 경보 에피소드 상태)을 원자적으로 저장한다. 플러그인이 임의 파일 경로를 받지 않는다. `ctx.orca`는 원장의 조회·기록도 좁은 키 API로 중개하거나, main이 알림 후보를 정규화·claim한 결과만 전달한다. 원장 쓰기는 이 PC 내부 상태 기록이며 Orca에 쓰지 않는다. 중복 방지는 표시 직전에 원장을 기록하는 at-most-once 방식으로 정한다. 기록 직후 앱이 종료되면 그 알림이 누락될 수 있다(추측); 구현 e2e에서 재시작 경계를 확인한다.

## 3. 판정·중복 제거

Run의 진행 여부는 `run-list.updated_at`만으로 결정하지 않는다. task에 비종료 상태가 있거나 pending gate 또는 활성 Dispatch가 있을 때 감시 대상으로 둔다. 종료 상태 집합은 실제 `task-list` 표본과 fixture로 확정한다. 최초 기동 때 옛 Run의 종료 worker는 원장에 기준선으로만 기록하고 말풍선을 내지 않는다. 진행 중 Run의 새 변화만 알린다.

| 알림 | 양성 판정과 반례 | 재시작 뒤 중복 제거 키 |
|---|---|---|
| worker 완료·실패 | `worker-list`의 해당 Dispatch가 `workerState=succeeded/failed` 또는 대응하는 `worker_done.payload.outcome`일 때. `heartbeat`·`status`는 완료가 아니다. 서로 충돌하면 확인 불가로 두고 `worker-show`로 재확인한다. | `runId/dispatchId/worker-outcome` (retry Dispatch는 새 ID). |
| 사람 확인 필요 | `check --peek`에서 새 `question`·`escalation`; 또는 `gate-list`의 `status=pending`이 새로 나타남. `status`·`heartbeat`는 독립 알림이 아니다. 수신함 접근이 막힌 Run은 질문·escalation 감지 불가를 명시한다. | 메시지는 `runId/message.id`, 게이트는 `runId/gate.id`. 동일 gate 관련 메시지와 pending 행은 gate 알림 하나로 합친다. |
| coordinator가 사람을 기다림 | `run-show.coordinator_handle`로 `terminal show`를 하고 `agentWait`가 **양성**일 때만. `null`은 현재 관찰상 대기 아님, 필드 부재·터미널 미접속은 확인 불가. pending gate만으로 coordinator가 대기한다고 추정하지 않는다. | `runId/coordinatorHandle/wait`의 상태 전이(비대기→양성 대기)마다 1회. 원장에 마지막 상태 저장. |
| 멈춘 worker | 완료되지 않은 Dispatch에서 `projection.liveness.verdict=exited`처럼 **양성 종료 증거**가 있으나 `worker_done`이 없거나, `live`이고 `lastHeartbeatAt`·`lastOutputAt` 중 사용 가능한 마지막 활동으로부터 12분 이상 지났으며 사람 대기 `agentWait`가 양성은 아닐 때 “멈춘 것 같음”. `unverifiable`·관찰 시각 누락·단순 무출력은 확정 멈춤으로 치지 않고 “확인 불가”로 둔다. | `runId/dispatchId/stall-episode`; 활동 재개 후 다시 멈추면 새 에피소드. 종료 증거는 Dispatch당 1회. |

**추측:** `terminal show`의 `agentWait`가 coordinator의 사람 대기에서도 양성값으로 채워지는지는 실제 표본이 없다. 이 신호가 없거나 불안정하면 `claude-code`/`codex` hook의 입력 대기 알림과 역할을 나누고, Orca 플러그인은 확인된 gate·질문만 알린다. `terminal.lastOutputAt`은 출력 활동만 가리켜 조용히 작업하는 정상 worker도 12분을 넘길 수 있다. 따라서 `live`의 무활동 판정은 최소 두 관측에서 동일하며 heartbeat도 없을 때만 낮은 확신 문구를 쓴다. `observation.agentWait` 양성은 건강한 사람 대기로 분류한다. 12분은 이 Dispatch 계약의 5분 heartbeat 2회보다 여유를 둔 초안이며, 실제 정상 장기 작업의 heartbeat·출력 간격 최댓값을 측정해 구현 주석에 조건과 함께 확정한다. 그 측정 전에는 시간만으로 경고하는 분기를 활성화하지 않는다.

원장은 키만 보존하고 제목·질문·메시지 본문·토큰·개인 경로는 저장하지 않는다. Run 목록과 작업 제목은 표시 직전에만 최소 길이로 줄이고 로그에 넣지 않는다. 원장 손상 시 과거 전체를 다시 알리지 않고 새 기준선을 세운 뒤 “확인 불가” 한 번을 낸다.

## 4. 게이트 승인

게이트 말풍선은 `gate-list`의 pending 행을 근거로 만들고 두 버튼에 **그 gate의 `id`와 현재 options**를 묶는다. `options` JSON 문자열을 배열로 파싱해 선택지가 정확히 두 개의 짧은 문자열인지 검증하고, 그 원문을 버튼 이름으로 쓴다(D-066, 예: `yes`/`no`). 두 개가 아니거나 형식이 다르면 임의 해석하지 않고 [열기]만 보인다. 버튼 클릭 때 다시 `gate-list --run`으로 pending·동일 task·동일 options를 확인하고, main이 `gate-resolve --id <검증된 id> --resolution <그 선택지의 원문> --json`을 한 번 실행한다. 사용자 버튼 invocation이 없으면 호스트가 거부한다. ID, resolution, Run의 관계와 CLI 응답의 `ok`·결과를 확인하고 나서만 “결정했어”라고 표시한다. 자동 폴링·재시작·알림 표시 경로의 `gate-resolve` 호출은 0회다.

이미 resolved이면 버튼을 비활성화하고 “이미 처리된 확인이야”를 보여 준다. 재확인 뒤 다른 주체가 먼저 처리한 경합은 CLI 오류를 무시하지 않고 `gate-list`로 다시 읽어 resolved이면 같은 안내를, 여전히 pending이면 “승인 결과를 확인하지 못했어”를 표시한다. 이미 처리된 gate의 실제 `gate-resolve` 응답은 미확인이라 특정 오류 코드에 의존하지 않는다. 중복 클릭은 한 gate당 실행 중 요청 하나로 묶는다.

이는 사용자가 누른 버튼으로 호출되는 외부 쓰기 예외에만 해당한다. `CLAUDE.md:16-18`의 리뷰 기준상 자동 Orca 쓰기는 결함이며, `packages/plugin-host/` 권한 검사를 바꾸는 task는 머지 전 사용자 gate가 필요하다(코드 확인). Slack의 두 자동 송신 예외를 Orca에 일반화하지 않는다.

## 5. 말풍선과 [열기]

| 우선순위 | 문구 예시(본문 노출 없음) | 버튼·표정 |
|---|---|---|
| `urgent` | “{작업} 확인이 필요해” / “{작업} 질문이 왔어” / “{작업}에서 문제가 생겼어” | 게이트만 [예] [아니오], 그 외 [열기]; surprised 또는 worried |
| `high` | “{작업}이 끝났어” / “{작업}에 실패했어” / “{작업}에서 나를 기다려” / “{작업}이 멈춘 것 같아” | [열기]; happy 또는 worried |
| `low` | “Orca 상태를 확인할 수 없어” | 상태 배지와 처음 한 번만 말풍선; 버튼 없음 |

`docs/plan.md:449-465`의 우선순위·묶음·방해 금지 정책을 따른다. 같은 Run에서 gate와 질문이 함께 오면 gate를 우선하고, 완료·실패는 결과 하나로 합친다. 표시 이름은 CLI의 임의 문자열을 안전하게 자른 task 제목과 worktree의 마지막 폴더 이름만 쓴다. 경로 전체와 질문·escalation 본문은 말풍선에 싣지 않는다.

**[열기] 조사:** `orca terminal switch --terminal <handle>`는 해당 Orca 터미널 탭 전환 명령이고, `terminal show`는 handle·worktreePath를 제공한다(관찰: 두 명령 `--help` 및 `terminal show --json`). 하지만 전환은 Orca 창 안 화면 제어여서 M11 범위 밖이다. 문서화된 worktree별 Orca 딥링크는 이번 CLI 도움말에서 찾지 못했다. **추천:** [열기]는 검증된 `worktreePath`의 폴더를 Explorer로 연다. 기존 앱도 `shell.openPath`를 사용한다(코드 확인: `apps/desktop/src/main/index.ts:1894`). 경로는 호스트가 Orca 결과와 실제 `realpath`를 대조하고 허용된 worktree 루트 내부인지 검사한 뒤만 연다. `..`, 심볼릭 링크 탈출, 임의 절대 경로를 거부한다. 실제 터미널 탭 전환이 필요하면 범위 변경을 별도로 묻는다.

## 6. 주기·부하·실패

같은 PC의 설치된 CLI에서 `run-list` 3회는 233–271ms, 한 Run의 `task-list` 3회 235–265ms, `worker-list` 235–280ms, `gate-list` 232–259ms였다(관찰: 2026-10-13, 명령마다 새 프로세스, Orca 실행 중, Run 17건·대상 Run worker 1건, 최고 **280ms**; CPU는 아직 측정하지 않음). **초안 주기 30초**: 페이지가 하나인 현재 조건에서 네 명령의 최대 벽시계 합계 1.1초로 한 주기의 약 3.7%다. 이는 CPU 사용률이 아니다. 여러 Run·페이지와 설치본 CPU는 M11 기준 11에서 재측정하고 1% 목표를 넘으면 주기·조회 범위를 조정한다. 한 번에 다음 주기를 겹치지 않고, Run당 호출 상한·출력 크기 상한을 둔다. `worker-show`·`terminal show`는 후보가 있을 때만 조회한다. `--peek`은 접근 가능한 소유 수신함에만 쓴다.

CLI 없음, Orca 미실행, nonzero 종료, 시간 초과, JSON 파싱/필수 필드 실패, `consumer_fenced`를 각각 구분한다. 전역 조회 불능·출력 형식 변화는 “확인 불가”를 한 번 표시하고 상태 배지는 유지하며 앱은 계속 실행한다. 플러그인은 시작 실패로 앱을 내리지 않는다. Orca가 없는 PC의 설치본은 처음부터 조용한 “확인 불가” 배지만 둔다. 회복하면 배지를 지우고 새 기준선부터 감시한다. 실패 중 매번 말풍선을 반복하지 않는다. 실패 재시도 지연은 30→60→120초, 상한 5분의 초안이며 CLI 부재·Orca 종료 시 불필요한 빠른 반복을 막는다. 시간 초과·재시도·stalled 임계값은 정상/고부하 실측의 최대 지연을 주석에 남긴 뒤 확정한다. 출력 형식이 달라지면 낙관적으로 추측하지 않는다.

## 7. 검증 방법

가짜 `orca` CLI 실행 파일의 경로를 e2e에서만 주입한다. 경로는 `realpath`로 검사하고 테스트 fixture 루트 밖의 `..`·링크·절대 경로를 거부한다. 프로덕션에서는 신뢰된 Orca 실행 파일의 절대 경로를 한 번 확정해 shell 없이 인자 배열로 실행한다. 가짜 CLI는 **모든 argv와 호출 시각을 기록**하고 run/task/worker/gate/peek JSON, 페이지, CLI 없음·오류·형식 변화, `consumer_fenced`, gate 경합을 재생한다. `check` 호출은 모두 `--peek` 포함, `--ack`·기본 check·`--wait` 0회, 자동 `gate-resolve` 0회인지 파일 기록으로 단언한다.

`pnpm test:e2e <파일>`은 앱의 실제 플러그인 로드·폴링→말풍선 문구/표정/버튼→버튼 클릭→가짜 gate 결과까지 실행한다. [열기]는 열린 폴더의 실제 경로, 재시작은 중복 말풍선 0회, 정상 회복은 배지 해제를 단언한다. pending/resolved, 옵션 없음·형식 오류·값 불일치, 질문과 escalation, 완료·실패, coordinator wait 양성/null/부재, liveness live/exited/unverifiable, 다중 Run/페이지를 각각 재생한다. `DesktopApp.waitReady`는 플러그인 초기 읽기 완료를 기다리게 한다. 기존 bubble·bubble-actions·plugin-host·settings 화면 e2e도 해당 화면 변경 시 단독 실행한다. 가짜 CLI의 단정은 사용자 화면 결과와 함께 확인한다. 설치본 포함과 Orca 없는 PC도 `package:check` 경로에서 확인한다.

## 8. 구현 task 제안 (질문 승인 뒤)

| 순서 | 내용 | 범위 파일 제안 |
|---|---|---|
| 1 | v2 `orcaRead`/`ctx.orca` 계약, 매니페스트·권한 승인 문구, 호스트 호출 허용 목록과 원장 설계. 읽기 전용 fixture 단위 테스트 | `packages/plugin-sdk/src/v2/*`, `packages/plugin-host/src/{session,runner,grants}*`, Orca 중개 새 파일, 관련 `*.test.ts` |
| 2 (1 뒤) | main에서 CLI 절대 경로·실행기 주입·폴링 수명주기, Run 페이지/상태 정규화·중복 원장·실패 배지 | `apps/desktop/src/main/{plugin-host-app,plugin-bridge,index}*`, `packages/plugin-host/src/*`, 관련 테스트 |
| 3 (2 뒤) | `plugins/orca` 알림·설정·버튼, gate 쓰기 invocation 검사, [열기]의 폴더 경계, 실제 사용자 화면 e2e와 가짜 CLI | `plugins/orca/*`, `apps/desktop/e2e/{desktop-app,plugin-host,bubble,bubble-actions,settings}*`, 필요한 main 연결부 |
| 4 (3 뒤) | 설치본 포함·CLI 없음 점검, CPU·메모리 측정과 지연값 확정 | 패키징 설정·검사 스크립트와 관련 테스트, 측정 문서 |

각 task는 범위를 새로 동결한다. 새 의존성 없이 구현한다. `packages/plugin-host/` 권한 검사 변경은 `CLAUDE.md:17`에 따라 머지 전 gate를 받는다. 1–3은 실제 화면·메뉴 진입점의 단독 e2e를 통과시킨다.

## 사용자에게 물을 질문

**답(2026-10-13, D-066):** 1 예 — v2 `orcaRead`(자동 읽기)·`orcaGateResolve`(버튼에서만 승인) 분리, 호스트 중개 `ctx.orca` · 2 예 — 구현 첫 task 에서 `orca inbox --json` 이 정말 비소비인지(read 표시·coordinator 수신 불변) 먼저 확인하고, 되면 질문·escalation 수집에 쓰고 안 되면 게이트만 알리며 질문은 "감지 불가"로 둔다 · 3 **Orca 터미널 탭 전환**(`orca terminal switch --terminal <검증된 handle>`, 사용자 버튼에서만) — M11 동결 범위의 "Orca 창 안 화면 제어 제외"를 이 한 동작만 허용으로 바꾼다 · 4 예 — 처음에는 종료 증거가 있는데 완료 보고가 없는 경우만 알리고, 시간 기준은 정상 장기 작업 간격을 실측한 뒤 켠다.

1. **v2에 `orcaRead`와 호스트 중개 `ctx.orca`를 추가할까요?** 추천: 예. 이유: 버튼 없는 조회를 v1 `exec` 규칙을 바꾸지 않고 좁은 명령 허용 목록에 묶을 수 있다.
2. **다른 coordinator의 `check --peek`이 `consumer_fenced`일 때 질문·escalation의 전체 Run 감지를 위한 Orca 비소비 조회 API 확인을 선행할까요?** 추천: 예. 이유: 현재 관찰만으로는 모든 진행 중 Run의 두 메시지 종류를 보장할 수 없다.
3. **[열기]를 우선 해당 worktree 폴더 열기로 둘까요?** 추천: 예. 이유: 확인된 CLI의 터미널 전환은 M11의 Orca 화면 제어 제외 범위와 충돌한다.
4. **12분 무활동 경고는 정상 장기 작업의 heartbeat·출력 간격을 측정한 뒤 켜도 될까요?** 추천: 예. 이유: `lastOutputAt`만으로 멈춤을 확정하면 조용히 작업 중인 worker를 잘못 알릴 수 있다.

## v2 `ctx.orca` 상세 (D-066 구현 task 1, 2026-10-13)

이 절은 위의 결정 문장을 수정하지 않고 D-066 답을 구체화한다. 승인 문구는 권한별로 한 줄씩 표시한다.

| v2 권한 | 승인 창 문구 | 허용 동작 |
|---|---|---|
| `permissions.orcaRead: true` | `Orca 진행 상태 읽기: 이 컴퓨터의 Run, 작업, 게이트와 비소비 수신함을 조회합니다` | 자동 스냅샷 조회 |
| `permissions.orcaGateResolve: true` | `Orca 게이트 처리: 사용자가 선택한 버튼으로 게이트 답변을 보냅니다` | 사용자 액션에서만 게이트 처리 |
| `permissions.orcaOpenTerminal: true` | `Orca 터미널 열기: 사용자가 누른 버튼으로 해당 터미널 탭으로 전환합니다` | 사용자 액션에서만 탭 전환 |

`orcaOpenTerminal`은 `orcaGateResolve`와 분리한다. [열기]는 게이트 답변 없이도 쓰고, 게이트 처리 승인이 화면 전환 승인까지 뜻하지 않기 때문이다. `false`와 생략은 권한 없음으로 본다. v1은 세 권한을 모두 거부하며 v1 계약은 바꾸지 않는다.

```ts
interface PluginContext {
  orca: {
    snapshot(): Promise<OrcaSnapshot>;
    resolveGate(gateId: string, resolution: string): Promise<"resolved" | "already-resolved" | "unconfirmed">;
    openTerminal(handle: string): Promise<void>;
  };
}
interface OrcaSnapshot {
  availability: "ready" | "unavailable";
  runs: readonly {
    id: string;
    coordinatorHandle: string;
    coordinatorWaiting: boolean | null;
    tasks: readonly { id: string; title: string; status: "pending" | "running" | "succeeded" | "failed" | "unknown" }[];
    workers: readonly { dispatchId: string; taskId: string; terminalHandle: string | null;
      state: "working" | "succeeded" | "failed" | "exited" | "unknown";
      liveness: "live" | "exited" | "unverifiable" | "unknown"; lastActivityAt: string | null }[];
    gates: readonly { id: string; taskId: string; status: "pending" | "resolved"; options: readonly string[] }[];
    messages: readonly { id: string; taskId: string | null; type: "question" | "escalation" }[];
  }[];
  notifications: readonly { kind: "worker-succeeded" | "worker-failed" | "attention" |
    "coordinator-waiting" | "worker-exited" | "unavailable";
    runId: string; taskId: string | null; dispatchId: string | null; gateId: string | null;
    messageId: string | null; messageType: "question" | "escalation" | null;
    terminalHandle: string | null; title: string }[];
}
```

main은 `run-list`, `task-list`, `worker-list`, `gate-list`, `orchestration inbox --full --json`, 후보의 `worker-show`, coordinator의 `terminal show`를 직접 실행하고 위 필드로 정규화한다. 플러그인은 명령·인자·파일 경로를 넘기지 않는다. 질문·escalation은 `inbox`의 종류와 ID만 전달한다. Orca 공식 `orca-cli` skill 문서는 “Read-only inspection does not consume mail”이라고 명시한다. coordinator가 확인한 `orca orchestration inbox --full --json`은 비소비 읽기이므로 질문·escalation 수집에 이를 쓴다. 앞의 `check --peek` 보강 제안은 구현하지 않는다. 원문 본문·질문·escalation·토큰·절대 경로·터미널 출력은 스냅샷과 알림에 넣지 않는다. `title`은 길이를 제한하고 제어 문자를 제거한 작업 제목이다.

알림 원장은 main 소유의 `<userData>/orca-notification-ledger.json`에 `{ "version": 1, "keys": ["..."] }` 형태로 둔다. 키는 Run·Dispatch·message·gate ID와 알림 종류를 합친 식별자뿐이며 본문과 경로를 저장하지 않는다. main이 후보를 원장에 먼저 기록하고 `snapshot().notifications`로 새 후보만 전달한다. 플러그인에 임의 키를 주장하는 API는 주지 않는다. 파일은 실제 userData 경계 안의 일반 파일만 쓰고 원자적으로 교체한다. 기록 후 앱 종료 시 알림 하나가 빠질 수 있는 at-most-once 방식이다.

main 실행기는 시작할 때 신뢰된 `orca` 실행 파일의 절대 `realpath`를 확정하고 `shell` 없이 고정 인자 배열로 호출한다. 읽기 허용 목록은 위 일곱 명령에 한정하며 페이지 커서와 Run·Dispatch·handle은 앞선 Orca 결과에서 얻은 값만 쓴다. 수신함은 `--full --json`으로만 읽고 `check`는 자동 경로에서 호출하지 않는다. 쓰기 허용 목록은 사용자 액션 문맥과 별도 승인 권한이 있을 때의 `gate-resolve --id <검증된 gateId> --resolution <현재 options 원문> --json`, `terminal switch --terminal <검증된 handle> --json`뿐이다. gate 처리 직전에 같은 Run의 pending·task·options를 다시 확인한다. 각 호출에 시간 및 출력 바이트 상한을 적용하고, 정상·고부하 실측 최대값으로 상한을 정해 코드 주석에 조건과 수치를 남긴다. 허용 목록 밖의 명령·인자·경로는 거부한다. task 1에서는 이 실행기를 연결하지 않고 세 `orca.*` 요청을 `E_UNAVAILABLE`로 거부한다.

## 구현 결과 (M11 종료, 2026-10-13)

- 구현: v2 `ctx.orca`(구현 1 b8ae585), 읽기·정규화·원장(2a e7df9b9, 호스트 `orca-reader.ts`), main 실행기(2b 98e5e1b, `orca-service.ts`), 플러그인(3 7c781fe), 설치본 포함(caec4a0), 대기 CPU 측정 옵션(a3f3e5d). 완료 기준 11/11.
- 주기: 30초 그대로. 스냅샷 1회 약 1.1초, orca 켠 대기 CPU 0.23–0.26%, 메모리 약 650 MB(`docs/progress/idle-cpu.md`).
- **실제 Orca 와의 차이:** 오래된 Run 의 `coordinator_handle` 이 null 이었다. 필수로 읽던 탓에 스냅샷 전체가 "확인 불가"였고, null 허용과 Run 단위 건너뛰기로 고쳤다(ce9bf22). 가짜 CLI 출력만으로는 드러나지 않았다.
- **실사용(기준 10)에서 드러난 것:**
  - 게이트 말풍선이 사람 없이 닫히면 원장에 알린 것으로 남아 다시 알리지 않는다 → 놓친 게이트.
  - 알림 지연 평균 15초(실측 약 20초). 버튼을 누른 뒤 반영은 약 1초(재확인 + `gate-resolve`).
  - 확인 불가에서 복구된 첫 스냅샷에서 지난 inbox 질문 2건을 다시 알렸다(원인 미확인, 기준선 처리 추정).
  - 개발 제어 실행은 권한 창을 띄우지 않고 거부해 orca 가 denied 로 저장됐다.
- **빠른 감지 조사(후속 후보):** Orca 에는 게이트·메시지를 구독할 공개 경로가 없다. CLI 에 변경 알림 명령이 없고(`check --wait` 는 소비), Orca 플러그인 API `events.subscribe` 는 experimental 이며 worktree.created·removed·agent.status.changed 3종뿐, 런타임 named pipe·websocket RPC 는 내부용이다. `%APPDATA%orcaorchestration.db-wal` 의 수정 시각은 쓰기 0.1초 안에 바뀌고 읽기로는 바뀌지 않아(대기 60초 배경 쓰기 0건), 이를 신호로만 쓰고 바뀌면 CLI 스냅샷을 읽는 방식을 다음 작업 후보로 둔다. Windows `fs.watch` 는 열린 파일 쓰기를 알리지 않아 쓸 수 없었다.

## 보강 (M12, 설계 초안, 2026-10-15)

범위는 M12 갈래 A의 기준 1·3·4·5·10이다(`docs/progress/milestones.md:624-645,651-655`; D-067 `docs/progress/decisions.md:48`). 새 Orca 쓰기는 사용자가 게이트 버튼을 누를 때의 기존 `gate-resolve`뿐이다. 아래 간격·횟수는 **제안값**이며 사용자 확인 전에는 구현 기준으로 확정하지 않는다.

### 1. 놓친 게이트: 남는 표시와 재알림

| 선택지 | 이점 | 한계 |
|---|---|---|
| A. 한 번 뜨는 말풍선만 유지 | 코드 변경이 작다 | 시간이 지나 말풍선이 사라지고 같은 게이트는 원장에 기록되어 재알림되지 않는다. M11 실사용에서 놓친 원인이다(`plugins/orca/src/index.ts:84-101`, `packages/plugin-host/src/orca-reader.ts:233-240`). |
| B. **배지 + 트레이의 `대기 중인 Orca 확인 다시 보기` + 제한된 재알림(추천)** | 말풍선이 닫혀도 펫의 상태 표시가 남고, 사용자가 원할 때 현재 pending 게이트의 선택지 원문을 다시 볼 수 있다. | 복수 게이트 순서와 재알림 상태를 관리해야 한다. |
| C. 말풍선 무기한 고정 | 눈에 잘 띈다 | 다른 긴급 말풍선의 자리를 차지한다. |

기존 v2 `ctx.setBadge`, `ctx.addTrayItem`, `ctx.registerAction`으로 B의 표시·다시 보기를 만들 수 있다(`packages/plugin-sdk/src/v1/contracts.ts:85-100`, v2 상속 `packages/plugin-sdk/src/v2/contracts.ts:48-53`, 트레이 연결 `apps/desktop/src/main/plugin-bridge.ts:102-108`, `apps/desktop/src/main/plugin-host-app.ts:309-317`). 현재 manifest는 badge와 두 action만 선언하므로 다시 보기용 tray item/action 선언은 추가해야 한다(`plugins/orca/manifest.json:9`). 배지는 pending 건수만 보이고 제목·질문 본문을 담지 않는다. 다시 보기는 최신 **성공** 스냅샷에서 여전히 pending인 게이트를 순서대로 보여 준다. 한 건의 말풍선에는 기존처럼 선택지 원문 버튼 두 개를 사용하고, 선택지가 유효하지 않으면 [열기]만 제공한다(`plugins/orca/src/index.ts:86-96`). 다시 보기는 Orca 쓰기가 아니며 게이트 답은 버튼 클릭 때만 보낸다(`plugins/orca/src/index.ts:114-133`, `packages/plugin-host/src/orca-reader.ts:258-286`).

재알림은 새 게이트의 첫 알림 뒤 **5분 간격, 최대 3회 추가**를 추천한다. 알림 간격은 M11의 30초 확인 주기·약 20초 실사용 지연(`plugins/orca/src/index.ts:8-10`, `docs/adr/0012-orca-plugin.md:174-177`)보다 길어 중복 방해를 줄이려는 사용자 경험 제안이다. 실제 부재 시간 분포는 측정되지 않았으므로 구현 시 간격은 실사용 확인으로 확정한다. 30초 안전망이면 예정 시각 뒤 최대 한 확인 주기와 스냅샷 시간만큼 늦을 수 있다. `resolved` 또는 게이트가 성공 스냅샷에서 사라지면 배지·다시 보기·재알림을 함께 멈춘다. 확인 불가 중에는 마지막 상태를 확정하지 않아 표시를 유지하고 재알림은 보류한다. 말풍선 자동 닫힘이나 사용자의 단순 닫힘은 **처리 완료가 아니므로** 재알림을 멈추지 않는다. 사용자가 명시적으로 `이 게이트 다시 알리지 않기`를 누른 경우에만 그 게이트의 재알림을 멈추고, pending 배지·다시 보기는 유지한다. 현재 v2에는 말풍선 닫힘 콜백이 없으므로 단순 닫힘으로 수신 확인을 추정하지 않는다(`packages/plugin-sdk/src/v1/contracts.ts:82-100`). 횟수를 다 써도 pending 표시는 유지한다.

원장 선택지는 (A) 현재 v1의 문자열 키만으로 반복 시각·횟수를 추정하거나 (B) **v2 구조로 명시적 gate 상태를 저장(추천)**하는 것이다. A는 재시작 뒤 마지막 알림 시각을 복원할 수 없다. B는 `version: 2`, 기존 `keys`, `gates: [{runId, gateId, lastAlertedAt, repeatCount, muted}]`만 두고 질문·선택지·터미널·경로는 저장하지 않는다. 기존 v1 원장의 키는 그대로 보존해 재알림 대상 외 중복 방지를 이어간다. 이미 알린 것으로 표시된 pending 게이트는 v2 전환 시 `repeatCount: 0`, `lastAlertedAt: 전환 시각`으로 시작해 즉시 몰아 알리지 않는다. 전환 후 처음 보인 새 게이트는 즉시 첫 알림을 보내고 시각을 기록한다. 저장 실패·손상은 지금처럼 확인 불가로 알리고 원장을 임의 초기화하지 않는다(`apps/desktop/src/main/orca-service.ts:69-83,93-111`, `packages/plugin-host/src/orca-reader.ts:93-100,243-252`).

v2 `ctx.orca.muteGate(gateId)`는 사용자가 [다시 알리지 않기]를 누를 때 해당 플러그인의 원장 `muted`만 기록하며 Orca CLI 쓰기 요청을 보내지 않는다.

### 2. WAL 수정 시각으로 빠르게 감지

| 선택지 | 이점 | 한계 |
|---|---|---|
| A. 30초 CLI 확인만 유지 | 현재 동작·부하를 유지한다 | 실사용 약 20초 지연, 평균 약 15초·최대 약 31초다(`docs/progress/backlog.md:73`). |
| B. CLI 확인을 10초마다 실행 | 단순하다 | CLI 실행 약 3배; Orca 쓰기와 관계없는 읽기도 늘어난다. |
| C. `fs.watch` 또는 내부 RPC 구독 | 이상적으로는 빠르다 | Windows `fs.watch` 실측 알림 0건, 공개된 gate/message 구독 경로가 없다(`docs/adr/0012-orca-plugin.md:179`). |
| D. **호스트가 WAL을 1초마다 `stat`하고 변경 시 CLI 스냅샷(추천)** | 프로세스를 늘리지 않고 변경 신호를 얻는다. 30초 정기 확인이 안전망이다. | Orca 내부 저장 경로·WAL 존재 여부에 의존하므로 실패 표시와 복귀 경로가 필요하다. |

호스트 `orca-service`가 환경 변수 `%APPDATA%` 아래 `orca\orchestration.db-wal`의 **mtime과 파일 식별 정보만** `stat`한다. 파일 내용과 SQLite DB를 열거나 읽지 않는다. 현재 이 PC에서 `%APPDATA%\orca\orchestration.db-wal`이 존재하고 2026-10-14T17:46:11.8178914Z 수정 시각, 크기 4,169,472바이트임을 읽기 전용 `Get-Item`으로 확인했다(2026-10-15; 이 짧은 관찰만으로 감지 지연을 새로 측정했다고 주장하지 않는다). 2026-10-13 조사에서는 250ms 표본 검사로 쓰기 후 0.1초 안에 mtime이 바뀌었고, 읽기는 변화를 만들지 않았으며 60초 대기 중 배경 쓰기는 0건이었다(`docs/progress/backlog.md:73`). 이를 근거로 **1초 stat**을 제안한다. 첫 stat 결과는 기준값만 잡고, 변경 후에는 최대 1초 안에 확인을 요청한다. 스냅샷 1회 약 1.1초(`docs/adr/0012-orca-plugin.md:172`)였으므로 **성공 스냅샷 시작 사이 최소 3초**를 제안하고, 진행 중 요청은 합친 뒤 마지막 변경을 다시 확인한다. 이 최소 간격의 작업 중 최댓값은 아직 실측하지 않았으므로 기준 10에서 검증하고 조정한다. 앱 기동·재개 때 즉시 한 번, 이후 30초마다 내용 확인을 유지한다.

현재 플러그인은 30초 `schedule.every`에서만 `ctx.orca.snapshot()`을 부른다(`plugins/orca/src/index.ts:38-42,140`). v2 알림 구독 API는 없으므로 구현은 플러그인이 1초마다 **가벼운** `snapshot()`을 요청하고 호스트가 그때 `stat`·캐시 판정을 하는 방식으로 한다. WAL이 그대로면 CLI를 실행하지 않고 알림이 빈 캐시 스냅샷을 돌려주며, 30초 안전망·mtime 변경·복구 재시도 때만 실제 CLI를 읽는다. 기존 중복 요청 합치기와 실패 재시도는 유지한다(`apps/desktop/src/main/orca-service.ts:63-65,137-151`). 이는 v2 표면 확장이 필요 없는 선택이다(`packages/plugin-sdk/src/v2/contracts.ts:48-53`). 1초 IPC 비용과 새 캐시의 알림 재전달 여부는 구현 테스트·기준 10 측정 대상이다.

`APPDATA` 누락, 파일 없음, 권한 오류, 심볼릭 링크·예상 경로 이탈, mtime 조회 실패, Orca 저장 경로 변경·WAL 교체가 의심되면 빠른 감지를 끄고 기존 30초 CLI 확인을 계속한다. 경로는 정해 둔 `%APPDATA%\orca`의 실제 경로 안에 있는 일반 파일인지 `realpath`로 검증하고, 다른 디렉터리를 검색하지 않는다. 30초마다 경로를 다시 검사해 되살아나면 새 mtime을 기준값으로 잡는다. mtime이 안정적이어도 30초 안전망은 생략하지 않는다. `/status`는 현재 HTTP JSON 응답이다(`apps/desktop/src/main/event-server.ts:24,158-161`, `apps/desktop/src/main/index.ts:1920-1926`). 호스트 상태에 `orca.fastDetection`의 `enabled`와, 꺼졌을 때 정확한 표시 문자열 `빠른 감지 꺼짐`을 추가한다. 파일 경로·Orca 내용은 응답에 넣지 않는다. CLI 전체가 확인 불가인 상태와 빠른 감지만 꺼진 상태는 별도로 표시한다.

### 3. 확인 불가에서 복구한 뒤 첫 성공 기준선

| 선택지 | 결과 |
|---|---|
| A. 기존 원장만으로 복구 | 이미 원장에 있던 항목만 막고, 실패 중 관찰하지 못한 오래된 inbox 질문은 복구 순간 새 항목으로 보일 수 있다. |
| B. **복구 첫 성공 스냅샷은 모든 후보의 기준선으로만 저장(추천)** | 과거 항목의 재알림을 막고 다음 성공 스냅샷부터 새 항목만 알린다. 복구 스냅샷 중 실제 새로 생긴 항목도 첫 알림은 생략될 수 있다. pending 게이트의 배지는 즉시 복원한다. |

원인은 코드로 확인했다. `baseline`은 읽을 때 원장의 `baselineKey` 유무로만 계산되고(`packages/plugin-host/src/orca-reader.ts:93-100`), 실패 경로는 `unavailableReported`만 바꾸며 이 키를 무효화하지 않는다(`packages/plugin-host/src/orca-reader.ts:247-252`). 따라서 기존 원장을 가진 앱이 여러 번 실패한 뒤 복구해도 `baseline=false`이고, 복구된 inbox의 미기록 `message.id`가 새 후보로 발송된다(`packages/plugin-host/src/orca-reader.ts:168-170,205-212,233-240`). M11의 지난 질문 2건 재알림은 이 경로와 부합한다. 단, 당시 원장 내용을 보존한 재현이 없으므로 두 ID가 실제로 미기록이었는지는 추정이다(`docs/progress/backlog.md:72`).

앱 최초 기동에서 **원장이 없으면** 현행대로 첫 성공을 기준선으로 삼는다. 정상 재시작에서 **유효한 원장이 있으면** 기존 키를 존중하고 새 항목은 알린다. 실행 중 성공 후 확인 불가로 전이했다가 복구하면, 원장 유무와 관계없이 **첫 성공만** 후보 키를 저장하고 알림은 보내지 않는다. 이어지는 성공 스냅샷부터 알린다. 실패가 계속되는 동안에는 기준선 처리를 반복하지 않는다. 손상된 원장은 조용히 덮지 않고 기존 확인 불가 정책을 따른다. 복구 기준선은 pending 게이트 배지·다시 보기 상태를 갱신하지만 재알림 횟수를 소진하지 않는다. `unavailable` 표시와 전이도 플러그인에서 분리해 다룬다(`plugins/orca/src/index.ts:32,44-52,103-108`).

### 4. 기준 10 자원 재측정

M11 비교값은 실제 Orca 읽기, 30초 주기, 논리 20코어 PC에서 30초씩 2회 측정한 평균 CPU **0.227% / 0.256%**, 작업 집합 **648 / 660MB**(약 650MB)다(`docs/progress/idle-cpu.md`, “M11 orca 켬”). 같은 기기·캐릭터·창 감시·플러그인 수·권한·Orca Run 수에서 빠른 감지 **끔/켬을 번갈아** 각각 2회 이상 측정한다. 각 회차는 준비 후 최소 60초, 1초 CPU 표본과 작업 집합·전용 메모리의 평균/최대, main·plugin·단명 `orca.exe` 자손의 CPU 시간을 기록한다. 기존 측정 스크립트의 1초 프로세스 표본은 약 0.25초인 `orca.exe`를 놓칠 수 있으므로 CLI 호출 횟수·누적 CPU 시간을 별도로 기록한다(`docs/progress/idle-cpu.md`, “M11 orca 켬”; `apps/desktop/scripts/measure-idle-cpu.mjs`). 대기(Orca 쓰기 없음)와 작업 중(별도 통제한 가짜 CLI/WAL fixture로 여러 게이트·worker 변경 신호 발생)을 나눠 측정하고, 실제 Orca 데이터에 쓰지 않는다. 변경→말풍선 시간의 평균·최대, 스냅샷 동시 실행 수, 30초 안전망도 확인한다. 평균 CPU 1% 미만 목표와 M11 두 회차 대비 증가분을 함께 보고하고, 3초 최소 간격이 부하 중에도 중복 실행을 막는지 결과로 확정한다. M11 수치는 짧은 CLI 자손을 누락할 수 있어 엄밀한 비용 차이로 단정하지 않는다.

### 5. 구현 task 제안 (ADR 승인 뒤)

| 기준 | 작업과 검증 | 예상 변경 파일 |
|---|---|---|
| 3 | 게이트 배지·다시 보기·재알림·명시적 중단, 원장 v2 이행. 원문 두 버튼, 자동 닫힘/직접 닫힘, resolved/사라짐/확인 불가, 재시작을 UI e2e로 확인한다. | `plugins/orca/src/index.ts`, `plugins/orca/manifest.json`, `plugins/orca/src/index.test.ts`, `packages/plugin-host/src/orca-reader.ts`, `packages/plugin-host/src/orca-reader.test.ts`, `apps/desktop/src/main/orca-service.ts`, `apps/desktop/src/main/orca-service.test.ts`, `apps/desktop/e2e/orca.e2e.test.ts`, `apps/desktop/e2e/orca-wire.e2e.test.ts` |
| 4 | 호스트 WAL stat·캐시·30초 안전망·`/status` 표시. 파일 없음·권한·링크·경로 변경과 실제 말풍선 지연을 검증한다. | `apps/desktop/src/main/orca-service.ts`, `apps/desktop/src/main/orca-service.test.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/event-server.test.ts`, `plugins/orca/src/index.ts`, `plugins/orca/src/index.test.ts`, `apps/desktop/e2e/orca.e2e.test.ts`, `apps/desktop/e2e/orca-wire.e2e.test.ts` |
| 5 | 복구 첫 성공 기준선과 기동 경우의 수를 검증한다. 오래된 질문·게이트 재알림 부재와 pending 표시를 e2e에서 확인한다. | `packages/plugin-host/src/orca-reader.ts`, `packages/plugin-host/src/orca-reader.test.ts`, `plugins/orca/src/index.ts`, `plugins/orca/src/index.test.ts`, `apps/desktop/e2e/orca.e2e.test.ts`, `apps/desktop/e2e/orca-wire.e2e.test.ts` |

세 task 모두 `plugins/orca/src/index.ts`, `plugins/orca/src/index.test.ts`, 두 Orca e2e 파일을 건드린다. 기준 3·4는 `orca-service.ts`와 테스트가, 기준 3·5는 `orca-reader.ts`와 테스트가 추가로 겹친다. 따라서 한 소유자가 순서대로 통합하거나 소유 파일을 다시 나눈 뒤 구현하고, 갈래 B와 겹치는 `apps/desktop/src/main/index.ts`는 조정한다. v1은 변경하지 않는다. 기준 10 측정은 이 세 작업 통합 뒤 coordinator가 단독 실행한다.

### 사용자 확인 질문

1. 게이트 표시를 **B(배지 + 트레이 다시 보기 + 제한 재알림)**로 하고, 자동·수동 말풍선 닫힘은 재알림을 유지하며 명시적 `다시 알리지 않기`만 중단할까요? 대안은 A(한 번만)와 C(무기한 말풍선)입니다. 추천은 B입니다.
2. 재알림을 **첫 알림 뒤 5분마다 최대 3회 추가**, 횟수를 다 써도 배지 유지로 정할까요? 대안은 10분마다 최대 2회입니다. 부재 시간은 아직 측정하지 못해 실제 사용 선호를 확인해야 합니다.
3. 빠른 감지를 **D(호스트의 1초 WAL stat, 성공 스냅샷 시작 사이 최소 3초, 30초 안전망)**로 정할까요? 대안은 A(30초만), B(10초 CLI), C(감시/내부 구독)입니다. 추천은 D이며 작업 중 자원 측정 뒤 간격을 조정합니다.
4. 복구 첫 성공을 **B(기준선 전용, pending 표시는 복원)**으로 정할까요? 대안 A는 기존 원장 키에만 의존합니다. 추천은 B이며 장애 중 새로 들어온 알림의 첫 통지가 생략될 수 있습니다.

### 사용자 결정 (2026-10-15, D-070)

1. 게이트 표시: **B** — 배지(대기 건수) + 트레이 "대기 중인 Orca 확인 다시 보기" + 제한 재알림. 말풍선 자동·직접 닫힘은 재알림을 멈추지 않고, 말풍선의 [다시 알리지 않기]만 그 게이트의 재알림을 멈춘다(배지·다시 보기는 유지).
2. 재알림: 첫 알림 뒤 **5분마다 최대 3회**, 횟수를 다 써도 배지 유지.
3. 빠른 감지: **D** — 호스트의 1초 WAL `stat`, 성공 스냅샷 시작 사이 최소 3초, 30초 안전망 유지. 간격은 기준 10 측정 뒤 조정할 수 있다.
4. 복구 뒤: **B** — 확인 불가에서 복구한 첫 성공 스냅샷은 기준선으로만 저장, pending 게이트 표시는 즉시 복원.

위 제안값은 이 결정으로 구현 기준이 된다.

### 5. 스냅샷 속도: 끝난 run 건너뛰기와 병렬 읽기 (M12 기준 4 재작업, 2026-10-15)

실사용에서 run 18개일 때 스냅샷 한 번이 20초 이상 걸려 WAL 신호가 소용없었다. 변경 후 구현은 WAL 변경으로 시작한 **빠른 읽기**에서 run-list·inbox(전역 1회, 서로 동시에)와 활성 run·새로 나타난 run만 읽고, 끝난 run은 직전 결과를 재사용한다. 활성 run은 마지막 성공 전체 읽기에서 끝나지 않은 task, 아직 성공·실패를 보고하지 않은 live·unverifiable worker, pending 게이트 중 하나가 있는 run이다(이미 성공·실패한 worker 는 터미널을 확인할 수 없어도 새 알림을 만들 수 없어 제외). 앱 첫 확인·실패에서 복구한 뒤 첫 확인·마지막 전체 읽기 30초 뒤의 안전망 확인은 전체 읽기이며, 끝난 run에 새로 생긴 task·게이트는 이 안전망에서 잡힌다. run 단위 읽기는 동시에 최대 4개(`MAX_PARALLEL_RUNS`)이고 한 run 안의 호출 순서·해석, 원장 키·기준선·게이트 재알림, `gate-resolve`의 버튼 전용 경로는 그대로다. 서비스는 읽기 시작 순서를 기록해 더 늦게 시작한 성공 결과가 이미 반영됐다면 먼저 시작한 결과로 캐시를 덮지 않는다(현재는 플러그인당 한 번에 하나만 읽어 방어용). 실측(2026-10-15, 이 PC, 실제 `orca.exe`, 읽기 전용 명령만, run 18개·명령 1회 약 0.35~0.40초): 변경 전 전체 읽기 22.4초(57회 호출), 변경 후 전체 읽기 7.7~10.8초(57회, 병렬 4), 빠른 읽기 2.9~3.3초(18회; 활성 run 6개). 빠른 읽기는 목표 3초를 안정적으로 넘기지 못했고, 남은 시간은 활성 run 6개를 4개씩 두 번에 나눠 읽는 run 안 직렬 호출 3회씩이다. 이 PC의 오래된 run 여럿에 끝나지 않은 task(pending)가 남아 있어 활성으로 판정된다.

### 보강 (M12): 펫 배지에서 다시 보기

v2 `setBadge`의 배지 객체는 선택적인 `action`을 가질 수 있다. 호스트는 그 ID가 같은 플러그인의 `contributes.actions`에 선언됐는지 확인하고, v1의 `action`은 거부한다. 펫 칩은 현재 보이는 배지의 액션을, 툴팁의 각 줄은 해당 배지의 액션을 사용자 클릭 때만 실행한다. 액션이 없는 배지는 클릭해도 변하지 않으며, 칩에서 시작한 포인터 이동은 펫 드래그나 액션 실행으로 이어지지 않는다. Orca의 확인 대기 배지는 `orca.review`로 기존 트레이 다시 보기 경로를 호출해 말풍선을 표시한다. 확인 불가 배지에는 액션을 붙이지 않고, `gate-resolve` 등 외부 쓰기는 말풍선 버튼을 누를 때만 실행한다.

### 구현 결과 (M12, 2026-10-15)

- **놓친 게이트:** 결정대로 구현했다. 원장 v2(`gates[]`: runId·gateId·lastAlertedAt·repeatCount·muted), [다시 알리지 않기]는 v2 `ctx.orca.muteGate(gateId)`(권한 `orcaRead`, 버튼 맥락에서만, 원장만 바꾸고 Orca 쓰기 0회). 배지는 처음에 화면에 그려지지 않았다(배지 표시 코드가 M5 부터 없었고 e2e 는 내부 값만 확인) — 실사용에서 발견해 펫 칩·툴팁·트레이 표시(A5)와 v2 배지 `action` 으로 칩 클릭 = 다시 보기(A6)를 더했다. orca 배지 글자는 "확인 대기 N건".
- **빠른 감지:** WAL 신호만으로는 부족했다. 실제 Run 18개에서 순차 읽기 1회 22.4초(호출 57회)라 알림이 30초 안전망으로만 떴다(가짜 CLI e2e 는 Run 1개·즉시 응답이라 못 잡음). 5절의 끝난 Run 건너뛰기 + 병렬 4로 전체 7.7–10.8초, 빠른 읽기 2.9–3.3초, 게이트 생성 → 말풍선 3.5초(실사용 2026-10-15). 늦게 끝난 오래된 결과는 버린다.
- **복구 뒤 기준선:** 결정대로. 원인은 실패 경로가 기준선을 무효화하지 않던 것(`orca-reader.ts` 93-100, 247-252).
- **자원:** 대기 0.12–0.30%, 작업 중(WAL 약 2.5초마다 변경) 0.69%, 1% 목표 안(`docs/progress/idle-cpu.md`).
- **남은 한계:** 오래된 Run 에 끝나지 않은 task 가 남으면 진행 중으로 판정돼 빠른 읽기 대상이 된다(이 PC 6개). 다 쓴 Run 을 정리하거나 변화 없는 Run 을 빼는 규칙은 다음에 검토(기획안 14장).
