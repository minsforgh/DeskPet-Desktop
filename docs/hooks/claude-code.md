# Claude Code·Codex hook 알림

`claude-code`와 `codex` 플러그인은 각 출처의 표정 규칙을 따로 등록합니다. 외부 `/event` 요청은 플러그인을 거치지 않으므로, DeskPet 알림을 사용하려면 아래 hook 설정이 `deskpet event`를 직접 호출해야 합니다. 플러그인이 로드되면 `/status`의 `plugins` 목록에서 두 플러그인이 각각 `running`으로 보입니다.

## 이벤트 형식

모든 hook은 `deskpet event --source <출처> --type notify --line <대사 ID> --var <이름>=<값>` 형태로 호출합니다. 문장은 각 플러그인의 `lines.json`에서 고릅니다. "시킨 일"은 마지막 프롬프트의 첫 줄에서 마크다운 기호를 벗긴 값이고, "결과"는 마지막 어시스턴트 응답의 첫 줄입니다. 대사 ID마다 필요한 변수를 정리해 보내며, 문구는 유니코드 코드포인트 기준 최대 80자로 맞춥니다.

| 상황 | 대사 ID의 접미부 | 기본 문장 | `--mood` | `--detail` |
| --- | --- | --- | --- | --- |
| 완료 · 시킨 일과 결과 모두 있음 | `done-task-result` | `<폴더>: <시킨 일(최대 24자)> → <결과>` | `happy` | 전체 경로 첫 줄 + `시킨 일: …`(최대 300자) + `결과: …`(최대 500자) 줄 |
| 완료 · 시킨 일만 있음 | `done-task` | `<폴더>: <시킨 일>` | `happy` | 위와 같음(있는 줄만) |
| 완료 · 결과만 있음 | `done-result` | `<폴더>: <결과>` | `happy` | 위와 같음(있는 줄만) |
| 완료 · 둘 다 없음 | `done-default` | `<폴더> 작업이 끝났어요` | `happy` | 전체 경로 |
| 대기 · payload `message` 문자열 있음 | `waiting-message`, `failed-message`, `info-message` | `<폴더>: <message>` | `worried` | 전체 경로 |
| 대기 · `message` 없음 | `waiting-default`, `failed-default`, `info-default` | `<폴더>이 입력을 기다려요` | `worried` | 전체 경로 |

시킨 일과 결과가 모두 있을 때 시킨 일은 최대 24자로 자르고 남는 길이(전체 80자에서)를 결과에 씁니다. 잘리면 `…`로 표시합니다.

Claude Code hook은 `--source claude-code`, Codex notify 래퍼는 `--source codex`를 보냅니다. 대사 ID의 접두부도 출처와 같습니다. 두 경로의 key·문구·mood·detail·변수 규칙은 같습니다.

### Claude Code `Stop` payload에서 쓰는 필드

| 필드 | 사용 |
| --- | --- |
| `hook_event_name` | `Stop`이면 완료 알림 |
| `cwd` | `--key`·`--detail`의 작업 폴더 |
| `prompt_id` | transcript에서 이 프롬프트의 user 줄을 찾는 열쇠 |
| `transcript_path` | 시킨 일을 읽을 transcript 파일 경로 |
| `last_assistant_message` | 결과 |

Claude Code `Notification` payload의 필드 구성은 아직 실제 덤프로 확인하지 못했습니다(미확인). `message`가 문자열이면 입력 대기 문구에 쓰고, 아니면 기본 문구 `<폴더>이 입력을 기다려요`를 씁니다.

### Codex notify payload에서 쓰는 필드

| 필드 | 사용 |
| --- | --- |
| `type` | `agent-turn-complete`이면 완료 알림 |
| `cwd` | 작업 폴더 |
| `input-messages` | 시킨 일(마지막 비어 있지 않은 문자열) |
| `last-assistant-message` | 결과 |

## 대사 목록과 캐릭터별 문구

기본 문장은 `plugins/claude-code/lines.json`과 `plugins/codex/lines.json`에 있습니다. 캐릭터 팩이나 사용자 설정에서 해당 ID의 대사를 바꿀 수 있습니다. 대사가 있는 이벤트에는 종류별 어투 템플릿을 적용하지 않습니다(D-071).

### 종류 매핑

기존 이벤트 분기(완료 판정과 mood 결정)를 그대로 따라 종류를 정합니다.

| 이벤트 | 대사 `kind`와 ID 중간부 |
| --- | --- |
| Claude Code `Stop`, Codex `agent-turn-complete` 등 완료 판정(종류 이름이 `stop`·`finished`이거나 `complete` 포함) | `done` |
| 종류 이름에 `fail`·`error`가 들어간 실패 계열(예: `StopFailure`) | `failed` |
| Claude Code `Notification`(입력·권한 대기), 종류를 알 수 없는 기본 알림 | `waiting` |
| 그 밖에 알림이 나가는 이벤트(예: `SubagentStop`) | `info` |

### 변수

| 변수 | 값 |
| --- | --- |
| `task` | 시킨 일 — 마지막 프롬프트의 첫 줄 정리본 |
| `result` | 결과 — 마지막 어시스턴트 응답의 첫 줄 정리본 |
| `folder` | 작업 폴더 이름(`--key`와 같은 값, 항상 있음) |
| `message` | `Notification` payload의 `message` 문자열(완료 이벤트에서는 보내지 않음) |

변수 값은 기존 정리 규칙(마크다운 기호 제거, 첫 줄, 공백 정리)을 거친 뒤 제어 문자를 없애고 대사의 문장 길이 예산에 맞춰 자릅니다(잘리면 `…`). 쓰이지 않는 변수는 보내지 않습니다. 각 대사는 필요한 변수를 `lines.json`에 선언합니다.

## transcript 읽기 (안전)

Claude Code의 시킨 일은 `transcript_path`의 JSONL transcript에서 가져옵니다.

- 읽는 파일은 `<홈>/.claude/projects` 아래의 `.jsonl` 파일뿐이고, 실제 경로(realpath) 기준으로 확인합니다. `..`, 심볼릭 링크·junction, 다른 드라이브, 허용 루트 바깥 경로는 거부합니다.
- 파일 끝에서 최대 1 MiB만 읽고, 창의 첫 줄이 잘렸으면 그 줄은 버립니다.
- 찾는 순서는 `prompt_id`와 같은 `promptId`의 user 줄(내용이 문자열인 것, 도구 결과 줄은 배열이라 건너뜀), 없으면 마지막 `last-prompt` 줄입니다.
- 어떤 오류(파일 없음·권한·JSON 오류)도 hook을 실패시키지 않고 시킨 일 없이 계속합니다.
- 프롬프트·응답 내용은 `deskpet event` 인자로만 전달되고 콘솔·파일 로그에는 남지 않습니다.
- 테스트·디버깅에서는 `DESKPET_TRANSCRIPT_ROOT` 환경 변수로 허용 루트를 바꿀 수 있습니다.

## 변환 스크립트

저장소의 [`send-claude-code-event.mjs`](./send-claude-code-event.mjs)는 stdin JSON을 읽어 위 CLI 인자로 변환합니다. Node.js만 필요하며 새 의존성은 없습니다.

Windows에서는 `deskpet.cmd`를 명시하고, PowerShell의 JSON 따옴표 문제를 피하려고 JSON을 명령행에 넣지 않고 stdin으로 전달합니다.

```powershell
Get-Content -Raw .\hook-input.json | node .\docs\hooks\send-claude-code-event.mjs
```

스크립트는 저장소의 `packages/cli/dist/index.js`(`pnpm build` 로 만들어짐)를 실행 중인 Node 로 직접 호출하므로 PATH 설정이 필요 없습니다(Node 가 셸 없이 `.cmd` 를 실행하지 못하기 때문). 다른 CLI 파일을 쓰려면 `DESKPET_CLI` 환경 변수에 경로를 지정하세요.

설치본(`DeskPet-Setup-*.exe`)에서는 같은 스크립트가 설치 폴더의 `resourceshooks` 에 있고, CLI 는 `resourcescliindex.js` 를 먼저 찾습니다(없으면 저장소 경로). 아래 `settings.json` 의 경로만 바꾸면 됩니다.

```json
"command": "node C:\Users\me\AppData\Local\Programs\DeskPet\resources\hooks\send-claude-code-event.mjs"
```

`node` 가 없다는 오류가 나면 [`docs/install.md`](../install.md) 4장을 보세요.

## Claude Code `settings.json`

Claude Code가 제공하는 `Stop`·`Notification` hook의 stdin을 스크립트로 전달합니다. `settings.json`에서 경로는 실제 저장소 위치로 바꾸세요.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node C:\\Users\\me\\deskpet\\docs\\hooks\\send-claude-code-event.mjs"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node C:\\Users\\me\\deskpet\\docs\\hooks\\send-claude-code-event.mjs"
          }
        ]
      }
    ]
  }
}
```

## Codex `notify`

Codex의 `notify` 설정에는 `codex-notify-wrapper.mjs`를 지정합니다. 기존 notify 프로그램이 있다면 아래처럼 래퍼 뒤에 이어 씁니다. Codex는 이벤트 JSON을 **마지막 명령행 인자**로 넘깁니다(예: `type`이 `agent-turn-complete`). 이미 래퍼를 등록했다면 경로나 인자를 바꾸지 않아도 됩니다.

```toml
notify = ["node", "C:\\Users\\me\\deskpet\\docs\\hooks\\codex-notify-wrapper.mjs", "node", "C:\\Users\\me\\previous-notify.mjs"]
```

Codex 설정 형식이나 payload 필드가 설치 버전에서 다르면 해당 버전의 설정 문서를 따르세요. 스크립트는 알 수 없는 필드를 무시하고 현재 작업 폴더와 입력 대기 문구를 기본값으로 씁니다. Codex payload도 같은 변환을 거쳐 `codex.` 대사 ID와 변수를 받습니다. `codex-notify-wrapper.mjs`는 원래 notify 프로그램을 실행한 뒤 같은 `send-claude-code-event.mjs`로 DeskPet 이벤트를 보냅니다.

플러그인 설정의 `enabled`를 `false`로 바꾸면 반응 규칙을 끌 수 있습니다. hook이 직접 보낸 `/event`의 수신 자체를 플러그인이 차단하거나 변경하지는 않습니다.

## 플러그인별 제어

설정 창의 플러그인 목록에도 Claude Code와 Codex가 따로 표시되고 각자 `enabled`를 설정할 수 있습니다. 끄면 해당 출처의 `happy`·`worried` 반응 규칙만 제거됩니다. 기본 mood 반응은 남으므로 같은 표정이 재생될 수 있고, `/event` 수신과 말풍선은 계속 동작합니다. 래퍼는 내부에서 `codex` 출처를 선택하며, Claude Code hook은 계속 `claude-code`를 사용합니다.
