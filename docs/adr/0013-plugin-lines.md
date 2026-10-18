# ADR 0013: 플러그인 대사 목록

## 상태와 범위

ADR-0014로 변형 형식이 문자열 | 세 칸 객체(`{ prefix, content, suffix }`)로 확장됨.

**승인 (2026-10-15, D-071).** 끝의 "사용자 결정" 절이 본문의 추천과 다를 때는 그 절이 우선한다. 초안 당시: D-068·D-069와 M12 갈래 B 기준 2의 설계 초안이다. 아래의 “추천”은 아직 결정이 아니다. 기준 6–9의 구현은 승인 뒤 별도 task로 나눈다. `packages/plugin-sdk/src/v1/`은 바꾸지 않는다. 갈래 A가 고치는 ADR-0012와 Orca 구현의 최종 대사 분기는 구현 착수 때 다시 대조한다.

현재 `PetEvent.voice`는 7개 종류와 `task/result/folder/message` 슬롯만 갖고, `text`는 최대 120 코드 포인트다(`packages/core/src/contracts.ts:1-20`, `packages/core/src/schemas.ts:4-36`). 팩 `voice.json`은 종류별 최대 8개 변형을 읽고 400 코드 포인트 문장을 렌더링해 120으로 자른다(`packages/core/src/voice.ts:6-10,27-57,70-88`). main은 렌더링에 성공하면 `text`를 바꾸고, 반응은 팩의 종류별 매핑 다음 플러그인 규칙을 고른다(`apps/desktop/src/main/voice.ts:9-19`, `apps/desktop/src/main/character.ts:214-223`). 따라서 Orca의 현재 `voice` 없는 이벤트는 어투·종류별 반응 대상이 아니다(`plugins/orca/src/index.ts:67-101`). Jungle의 슬롯에는 편집할 문장 조각이 코드에 박혀 있다(`plugins/jungle/src/reaction.ts:166-167`).

## 1. 목록 형식과 선언 위치

| 안 | 내용 | 평가 |
|---|---|---|
| A. v2 `manifest.contributes.lines`에 목록 전체 | 플러그인 실행 전 읽기 쉽다 | 문장이 많은 플러그인의 매니페스트가 비대해지고 64 KiB 상한과 충돌할 수 있다(`packages/plugin-host/src/discover.ts:29-44`). |
| **B. v2 `manifest.contributes.lines: "lines.json"` (추천)** | 매니페스트에는 팩 내부 파일 경로만 쓰고, 별도 JSON에 대사 메타데이터를 둔다 | 팩 배포에 파일 하나가 늘지만 실행 전 설정 화면을 만들 수 있고 코드 등록 누락이 없다. |
| C. `ctx.registerLine` | 활성화 때 코드에서 선언한다 | 꺼짐·미승인 플러그인의 대사 목록을 보여 줄 수 없고 선언과 사용이 같은 코드에 남는다. |

추천 B의 예시는 다음과 같다. `lines.json`은 플러그인 소유 데이터이며 캐릭터 팩 파일이 아니다. 내장 6종의 매니페스트는 모두 v2로 올려 선언한다. 현재 jungle·reminders·claude-code·codex는 v1(`plugins/jungle/manifest.json:5`, `plugins/reminders/manifest.json:5`, `plugins/claude-code/manifest.json:5`, `plugins/codex/manifest.json:5`), orca·slack은 v2다(`plugins/orca/manifest.json:5`, `plugins/slack/manifest.json:5`). 외부 v1은 승격하지 않는다. v2의 공개 타입·스키마만 확장한다(`packages/plugin-sdk/src/v2/contracts.ts:5-16`, `packages/plugin-sdk/src/v2/schemas.ts:1-20`).

```json
{
  "version": 1,
  "lines": [
    { "id": "jungle.attendance-complete", "label": "출석 완료", "kind": "done",
      "variables": [], "variants": ["오늘도 수고했어"] },
    { "id": "orca.worker-succeeded", "label": "작업 완료", "kind": "done",
      "variables": ["task"], "variants": ["{task}이 끝났어"] }
  ]
}
```

- `id`는 `<manifest.id>.<local-id>`이고 local-id는 소문자 ASCII 문자로 시작해 소문자·숫자·하이픈만 쓴다. 한 목록 안에서 중복 불가. 앞부분은 검증된 매니페스트 ID와 정확히 일치해야 한다. `key`(알림 합치기)와 달리 텍스트 의미의 안정적인 ID다. 문장을 바꾸어도 ID를 재사용하며 의미가 달라지면 새 ID를 낸다. 실제 패턴을 만들면 허용(`orca.worker-succeeded`, `claude-code.wait`)·거부(`slack.other.id`, `Orca.Done`, `orca..done`, `../orca.done`, 없는 ID) 예시를 패턴·검증기 테스트로 확인한다. 기존 contribution ID 형식과 접두부 검사는 `docs/adr/0003-plugin-manifest-and-api-v1.md:15-17`을 따른다.
- `label`은 설정 화면 이름, `kind`는 현재 7종, `variables`는 중복 없는 이름 목록이다. 변수 이름은 소문자 ASCII 문자로 시작해 소문자·숫자만 허용하고, 각 변형의 `{name}`은 선언된 변수여야 한다. `{{` 같은 이스케이프 문법은 처음에는 두지 않는다. 잘못된 중괄호·미선언 변수·빈 문장·제어 문자·중복 ID는 목록 검증에서 거부하고 오류를 화면에 표시한다. 변수 값은 문자열, 최대 500 코드 포인트, 제어 문자 없음으로 현재 슬롯과 같은 한도를 적용한다(`packages/core/src/validate.ts:84-96`). 누락·빈 변수 때문에 한 변형을 만들 수 없으면 다음 변형을 시도하고, 모두 실패하면 아래 fallback으로 간다. 값 안의 `{}`는 재치환하지 않는다(`packages/core/src/voice.ts:70-88`).
- 목록은 대사당 1–8개 변형, 각 원문은 1–400 코드 포인트로 제한한다. 렌더링 결과는 공백 정리 후 120 코드 포인트로 자른다. 현 voice 규칙과 맞춘 상한이다(`packages/core/src/voice.ts:8-10,60-85`). 변형 선택은 대사 ID별 카운터로 순환한다. 미리보기의 변형 번호는 테스트에서 고정한다. 목록 파일의 전체 크기·항목 수 상한은 구현 전에 실제 내장 목록 크기를 재고 정해 주석에 측정 조건과 최댓값을 남긴다. `discover`의 64 KiB 매니페스트 제한을 목록 파일에 무심코 복사하지 않는다.
- 호스트가 승인된 플러그인 폴더 안의 상대 경로만 받는다. `realpath`로 폴더와 대상 파일을 확인해 `..`·절대 경로·심볼릭 링크 탈출을 거부한다. 내장·외부 v2 모두 같은 검사다. 매니페스트에서 이 목록을 읽되 권한 값은 승인된 매니페스트 한 곳에서만 읽는다.

## 2. 이벤트 경로와 출처

| 안 | 내용 | 평가 |
|---|---|---|
| **A. `PetEvent.line?: { id; vars? }` (추천)** | 기존 `voice`·`text`를 유지한 선택 필드를 추가한다 | 코어·HTTP·CLI·플러그인 호스트 경계마다 검증해야 하지만 종류별 fallback이 명확하다. |
| B. `voice` 안에 `lineId`와 새 슬롯 | 한 객체에 모인다 | 지금의 슬롯 4종과 새 임의 변수의 뜻이 뒤섞이고, 기존 voice 파서가 모르는 필드를 거부한다(`packages/core/src/validate.ts:88-96`). |
| C. 별도 대사 이벤트 API | 일반 이벤트와 분리한다 | 큐·중복·DND·반응을 다시 연결해야 한다. |

추천 A에서 `line.id`는 전체 ID이고 `line.vars`는 선언된 키만 받는다. 등록된 목록의 `kind`가 알림 종류의 기준이다. v2 플러그인은 `source === manifest.id`, `line.id`의 접두부와 목록 등록 여부를 세션에서 검사한 뒤 호스트가 검증된 대사 정체성을 전달한다. 기존 세션은 이미 `source`와 액션 접두부를 검사한다(`packages/plugin-host/src/session.ts:501-520`). 등록되지 않은 ID·다른 출처 ID·변수 누락/초과는 거부하고 `ctx.emit` 호출자에 오류를 돌려준다. 실패한 요청은 말풍선이나 동작을 만들지 않는다. `text`는 오래된 화면·팩·이벤트와의 fallback으로 둘 수 있으나, 내장 플러그인과 훅의 정적 말풍선은 목록을 기본 문장의 유일한 저장소로 삼는다.

CLI는 `deskpet event --line <id> --var name=value`를 추가하고 기존 `--voice`·`--slot`·`--text`를 유지한다. JSON `/event`도 같은 `line` 객체를 받는다. 훅은 `--source claude-code|codex`와 해당 대사 ID·변수를 보낸다(`docs/hooks/send-claude-code-event.mjs:88-113,153-156`). 다만 지금 CLI의 `--source`는 호출자가 임의 지정하고 모두 같은 로컬 bearer 토큰을 쓰므로 출처 인증이 아니다(`packages/cli/src/index.ts:21,53-59,100-113`, `apps/desktop/src/main/event-server.ts:17-26,33-52`).

HTTP 출처 처리 선택지: (a) source 문자열과 ID 접두부만 비교하면 단순하지만 누구나 `--source orca`를 쓸 수 있다. **(b) 추천: 일반 HTTP/CLI 요청은 내장 플러그인 대사 ID 사용을 거부하고, 배포된 두 훅에는 별도 출처 범위의 로컬 자격 증명/전용 진입점을 발급한다.** 서버는 요청의 인증 범위에서 `claude-code` 또는 `codex`를 정하고 본문의 source와 ID 접두부를 맞춘다. 범위 없는 기존 토큰은 기존 일반 이벤트만 허용한다. 동등한 출처 인증을 구현하기 전까지 훅의 대사 ID 경로는 켜지 않는다. 같은 OS 사용자가 토큰 파일을 읽을 수 있다는 로컬 신뢰 한계는 남지만, 임의 CLI 인자로 다른 출처의 대사를 고르는 회귀를 막는다. 토큰 파일·설치본 훅 위치·CLI 사용법·HTTP 응답(누락/잘못된 범위, ID/변수 오류)을 구현 task에서 확정하고, 표의 각 응답 코드는 실제 HTTP 요청 e2e로 검증한다. 원문의 `source`가 다른 플러그인 ID인 경우도 명시적으로 거부한다.

추천 HTTP 거부 표는 구현 전 확인할 계약이다. 호스트 내부 `ctx.emit`의 거부는 HTTP 상태 코드 대신 호출 오류로 돌려준다. 기존 `line` 없는 요청은 현재 응답 규칙을 그대로 쓴다(`apps/desktop/src/main/event-server.ts:157-167`).

| 실제 `/event` 요청 | 추천 응답 | 표시 결과 |
|---|---|---|
| 인증 헤더 없음·빈 값·틀린 토큰 | 401 | 없음 |
| 일반 토큰으로 내장 ID 또는 다른 범위 ID 사용 | 403 | 없음 |
| 훅 범위 토큰으로 다른 source·다른 접두부 ID 사용, source 누락 | 403 | 없음 |
| 허용 범위이지만 `line.id` 없음·등록되지 않은 ID·변수 이름/값 오류 | 400 | 없음 |
| 허용 범위·유효한 ID·변수 | 202 | 렌더링된 말풍선과 지정된 반응 |

표의 각 행은 실제 인증 헤더·JSON 본문을 보내는 e2e로 확인하고, 헤더 누락과 빈 헤더를 별도 요청으로 확인한다. 유효한 요청도 로그가 아니라 사용자 말풍선·버튼·반응을 단언한다.

## 3. 편집 저장소와 캐릭터 전환

| 안 | 내용 | 평가 |
|---|---|---|
| A. 팩 `voice.json`의 `lines`만 | 현재 어투 저장 흐름과 같다 | 내장 팩의 한 문장 편집마다 파생 팩을 만들고, 캐릭터별 개인 설정이 팩 콘텐츠로 들어간다(`apps/desktop/src/main/pack-service.ts:340-348`). |
| B. 캐릭터 무관 `settings.json`만 | 캐릭터를 바꿔도 문장이 같다 | 캐릭터별 말투와 팩 공유를 표현할 수 없다. |
| **C. 팩 기본값 + 사용자 설정의 캐릭터별 덮어쓰기 (추천)** | 팩은 공유할 말투를 제공하고, 사용자의 편집은 선택 팩 ID별로 유지한다 | 두 계층의 우선순위를 UI에 보여 줘야 한다. |

추천 C: 팩 `voice.json` v1에 선택 `lines: { "orca.worker-succeeded": ["..."] }`를 추가한다. 기존 `templates`의 의미·파서 결과는 유지하고, 등록된 목록의 변수만 쓰는 줄만 읽는다. 팩에 없는 ID는 기본 목록으로 간다. `settings.json`에는 `lineOverrides[packId][lineId] = string[]`을 두고, 사용자가 저장·기본값 되돌리기 할 때 해당 키만 원자적으로 바꾼다. 캐릭터를 바꾸면 다른 팩 ID의 값과 팩 기본값을 사용하고 되돌아오면 이전 개인 값이 다시 적용된다. 파생 팩은 자기 ID의 개인 값만 가진다. 팩에서 파일이 없는 경우 원본의 `voice`를 읽는 현 루트 선택과 맞춘다(`apps/desktop/src/main/character.ts:59-82,301-333`).

현재 `.deskpack` 내보내기·가져오기는 미구현이다(`docs/adr/0007-character-pack-asset.md:7,375-383`). 나중에 팩을 내보낼 때는 팩 `voice.json`의 기본값만 포함하고 개인 `settings.json` 덮어쓰기는 포함하지 않는다. 사용자가 개인 문장을 공유하려면 향후 별도 “팩에 복사”를 명시적으로 구현해야 한다. 가져온 팩에는 그 안의 대사를 기본값으로 적용한다. 목록에 없거나 삭제된 ID의 저장 값은 실행하지 않고 편집 화면에서 정리 안내를 하며, 자동으로 다른 ID에 붙이지 않는다.

## 4. 적용 순서와 동작

| 안 | 내용 | 평가 |
|---|---|---|
| **A. 대사별 → 종류별 → 기본값/기분별 (추천)** | 사용자가 고친 한 대사가 같은 종류의 다른 알림을 건드리지 않는다 | 기존 팩의 종류별 어투·반응도 그대로 쓸 수 있다. |
| B. 종류별 → 대사별 | 현재 로직을 먼저 부른다 | 종류별 설정이 있는 팩에서는 대사별 편집 결과가 가려져 기준 7·8과 맞지 않는다. |

문장 선택의 정확한 순서: **현재 팩 ID의 사용자 대사 변형 → 현재 캐릭터 팩의 대사 변형 → 현재 팩의 알림 종류 어투(`voice.json.templates`) → 플러그인 목록의 기본 변형 → 이벤트 `text` → 말풍선 없음.** 앞 계층의 모든 변형이 변수 누락 등으로 렌더링 불가하면 다음 계층으로 내려간다. `line`이 유효하면 목록의 `kind`로 종류별 어투와 반응을 찾는다. 기존 이벤트의 `voice.kind`가 동시에 있으면 같아야 하며 불일치는 거부한다. `line` 없는 이벤트는 지금의 `voice` → `text` 경로 그대로다(`apps/desktop/src/main/voice.ts:9-19`). 이 순서에서는 현재 캐릭터의 종류별 어투가 목록 기본 문장보다 먼저 적용된다. 원래 명세의 일반 알림 어투를 살리는 추천이며, 사용자에게 확인한다. Slack의 본문 줄바꿈은 현재 화면의 의미 있는 표시이므로(`plugins/slack/src/index.ts:75-81,162-165`), 새 대사 렌더러는 단일 줄바꿈을 보존하고 연속 공백·제어 문자만 안전하게 정리한다. 기존 종류별 `renderVoice`의 공백 정리 규칙은 바꾸지 않는다.

동작 선택의 정확한 순서: **사용자 대사별 지정 → 캐릭터 팩 대사별 지정 → 팩 `reactions.json`의 종류별 지정 → 플러그인 `ReactionRule` → 기분(`mood`) 기반 규칙.** 대사별 지정은 `play` 또는 `sequence` 하나이며, 정의·상태/시퀀스 검증·표시 시점·중단·`say` 무시는 기존 종류별 반응과 같다(`docs/adr/0008-character-behavior-art.md:342-366`, `apps/desktop/src/main/character.ts:214-223`). 사용자 지정은 `settings.json`의 팩 ID·대사 ID 키에, 팩 지정은 `reactions.json` v1의 선택 `lines` 맵에 둔다. 빈 지정은 “이 계층의 지정 없음”이며 명시적 “동작 끄기”는 이번 범위에서 두지 않는다. 목록에 없는 이벤트는 현 종류별 → 플러그인 규칙 → 기분 규칙을 유지한다. 이벤트가 직접 `play`나 시퀀스 경로를 지정할 수는 없다.

## 5. 호환성과 설정 화면

호환 정책의 선택지는 (A) 새 목록이 없으면 지금 경로를 그대로 타게 하는 방식과 (B) 모든 이벤트를 새 목록으로 자동 변환하는 방식이다. **A를 추천**한다. B는 외부 v1 플러그인의 알 수 없는 문장에 안정적인 ID를 붙일 수 없고 기존 `text` 결과가 바뀔 수 있다.

옛 `voice.json` v1의 `templates`와 `reactions.json` v1의 `kinds`는 그대로 유효하고 의미가 바뀌지 않는다(`packages/core/src/voice.ts:27-57`, `docs/adr/0008-character-behavior-art.md:342-361`). 추가 `lines`는 선택 필드다. 기존 개인 데이터는 이관하지 않고 그대로 읽는다. 외부 v1 플러그인은 대사 목록을 선언할 수 없고 `line`을 보낼 수 없지만 기존 `text`·`voice`·반응 규칙은 종전과 같다. v1 파일·export·런타임 계약은 수정하지 않는다. 내장 v1 네 플러그인의 v2 승격은 기존 권한·액션·메뉴·알림 결과의 회귀를 각각 확인한다. 설치본에 매니페스트가 가리키는 `lines.json`과 두 훅의 자격 경로가 포함되어야 한다(`pnpm package:check`).

화면 배치는 (A) 기존 [어투]·[반응] 아래 플러그인별 접이식 섹션과 (B) 플러그인마다 새 설정 탭을 두는 안을 비교했다. **A를 추천**한다. B는 플러그인이 많을 때 탭 수가 늘고 두 기존 편집 화면의 기능을 중복 구현해야 한다.

[어투]와 [반응] 탭에는 지금의 7종 편집을 유지하고 그 아래 플러그인별 접이식 섹션을 둔다. 제목에는 플러그인 이름·대사 수·상태(켜짐/꺼짐/권한 대기/목록 오류)를 표시한다. 실행 전 매니페스트 목록을 읽으므로 꺼짐·권한 미승인 상태에서도 내용을 편집할 수 있지만, 보내 보기는 실행 가능한 경우에만 켠다. 플러그인별 검색과 접힌 기본 상태로 많은 줄을 다룬다. 각 대사 행에는 label·기본 문장·변수 설명·출처 계층을 보이고, [어투]의 여러 변형·미리보기·다음 변형·펫에게 보내기·기본값 되돌리기는 현 편집기의 조작 패턴을 따른다(`apps/desktop/src/renderer/voice-panel.ts:201-220,276-363`). [반응]은 대사별 `없음/상태/시퀀스` 선택과 실제 보내 보기로 확인한다(`apps/desktop/src/renderer/reactions-panel.ts:76-103,140`). 미승인·꺼진 플러그인의 보내 보기는 실행을 가장하지 않고 이유를 한국어로 표시한다. 두 탭에서 저장 후 다음 알림부터 적용하고 재시작 후에도 유지한다. 두 화면의 기존 e2e를 선택자·탭 이름으로 찾아 함께 갱신한다.

## 6. 기준 6 자동 확인과 구현 분해

자동 확인은 (A) 문자열 grep만 쓰는 방식과 (B) **AST 경계 검사 + 모든 분기·실제 화면 테스트(추천)**를 비교했다. A는 간접 헬퍼가 만든 문장을 놓치고, 배지·버튼의 정상 문자열까지 오탐한다. B는 정적 문장의 위치와 실제 결과를 함께 확인한다.

“코드에 직접 쓴 말풍선 문장 0개”는 소스 전체의 한글 문자열을 금지하지 않는다. 배지·버튼·로그·설정 안내와 사용자 입력은 남는다. 빌드 시 내장 6개 `manifest.contributes.lines`와 두 훅의 ID 목록을 검증하고, 플러그인 소스의 `ctx.emit`/PetEvent 생성·훅의 `deskpet event` 호출에서 `notify`용 `text`에 정적 문장이나 문장 합성을 넣는 패턴을 AST 기반 검사로 금지한다. 대사 기본 문장은 `lines.json`만 허용하고, 훅의 `composeText` 같은 fallback 생성도 목록으로 옮긴다. 동적 사용자 본문(Slack 메시지, reminders 규칙 문구)은 선언된 변수로 전달하되 본문이 120자 제한을 넘으면 현재처럼 명시적으로 자른다. AST 검사만으로 간접 헬퍼 호출을 놓칠 수 있으므로, 부록의 모든 분기를 시험하는 단위 테스트에서 나간 `line.id`·변수와 목록의 일치를 확인하고, 설치 앱의 화면 e2e에서 실제 말풍선 문구·버튼·동작을 확인한다. 목록에 없는 ID, 잘못된 변수, 다른 출처 ID는 거부되는 경계 테스트를 둔다. 패턴을 새로 만들면 허용·거부 예시를 실제 패턴으로 검사한다.

구현 분해는 (A) 계약 → 송신자 전환 → [어투] → [반응] → 회귀의 작은 순차 task와 (B) 플러그인·호스트·두 화면을 하나의 task로 동시에 바꾸는 안을 비교했다. **A를 추천**한다. B는 `index.ts`·`settings-service.ts`·Orca 소스의 동시 수정과 부분 완성 상태의 검증을 어렵게 한다. 갈래 A와는 인터페이스를 먼저 고정하고 Orca 소스의 최종 수정 순서를 조율한다.

| 순서·기준 | task 제안과 주요 파일 | 파일 겹침·검증 |
|---|---|---|
| 1 / 6·9 | v2 목록 타입·스키마·파서와 `PetEvent.line` 검증, 플러그인 호스트의 신원/목록 검사. `packages/plugin-sdk/src/v2/*`, `packages/core/src/{contracts,schemas,validate}*`, `packages/plugin-host/src/{discover,session,runner}*` | 갈래 A의 Orca v2·세션 작업과 겹칠 수 있어 인터페이스를 먼저 고정. v1 회귀·허용/거부·경로 탈출 계약 테스트. |
| 2 / 6 | 여섯 `plugins/*/{manifest.json,lines.json,src/*}`와 `docs/hooks/{hook-message,send-claude-code-event,codex-notify-wrapper}.mjs`, `packages/cli/src/*`, `apps/desktop/src/main/event-server.ts`를 대사 ID 경로로 전환 | Orca `src/index.ts`는 갈래 A 변경을 받은 뒤 한 담당자만 수정. 훅 진입점과 CLI/HTTP 실제 요청 e2e, AST 검사. |
| 3 / 7 | 팩·설정 저장/로드와 [어투] 편집. `packages/core/src/voice.ts`, `apps/desktop/src/main/{character,settings,settings-service,pack-service,index,voice}.ts`, `apps/desktop/src/renderer/{voice-panel,settings}*` | `index.ts`·`settings-service.ts`는 4와 겹치므로 순차 작업. voice 단위와 해당 기존 settings/voice e2e 단독 실행. |
| 4 / 8 | 대사별 반응 저장/선택과 [반응] 편집. `packages/core/src/reactions.ts`, `apps/desktop/src/main/{character,index,settings-service,pack-service}.ts`, `apps/desktop/src/renderer/{reactions-panel,settings}*` | 3의 저장 형식 뒤 적용. 실제 선택/미지정 fallback·시퀀스 말풍선·버튼을 e2e로 확인. |
| 5 / 9 | 기존 v1 플러그인, 구 팩/설정, 설치본 회귀 및 `pnpm package:check` | 갈래 A 병합 뒤 coordinator가 전체 e2e를 한 곳에서만 실행. 각 worker는 변경 영역 파일만 단독 실행. |

## 부록: 현재 말풍선 문장 목록

표의 `kind/slots`는 **현재 실제 전송 값**이며 `—`는 `voice`가 없음을 뜻한다. 괄호 속은 동적 값이다. 배지·액션 라벨·`detail`은 말풍선이 아니므로 제외한다. 자동/수동은 문구가 다르면 별도 대사 ID가 필요하다. 이 표의 ID 예시는 구현 때 고정할 후보이며 모든 행이 목록 항목으로 대응되어야 한다.

| 출처·후보 ID | 파일:줄 | 현재 `text` 또는 분기 | 현재 kind / slots |
|---|---|---|---|
| jungle.login-lost | `plugins/jungle/src/reaction.ts:89-92` | LMS 로그인이 풀렸어 | alert / task=LMS 로그인, message=원문 |
| jungle.no-cohort | `plugins/jungle/src/reaction.ts:95-98` | 활성 기수가 없어 | alert / task=활성 기수, message=원문 |
| jungle.check-error | `plugins/jungle/src/reaction.ts:101-105` | 출석 상태를 확인할 수 없어 | alert / task=출석 상태, message=원문 |
| jungle.login-recovered | `plugins/jungle/src/reaction.ts:110-114` | 로그인 확인했어요. 이제 출석을 지켜볼게요 | info / task=로그인, result=확인했어요, message=후반 문장 |
| jungle.start-deadline | `plugins/jungle/src/reaction.ts:115-127` | 학습 시작 아직이야! 10시까지 {minutes}분 | deadline / task=학습 시작, result=10시까지 {minutes}분, message=학습 시작 10시까지 {minutes}분 |
| jungle.start-grace | `plugins/jungle/src/reaction.ts:130-135` | 지금 누르면 아직 괜찮아! | deadline / task=학습 시작, result=아직 괜찮아, message=원문 |
| jungle.end-open | `plugins/jungle/src/reaction.ts:140-145` | 이제 학습 종료 누를 수 있어 | info / task=학습 종료, message=원문 |
| jungle.end-deadline | `plugins/jungle/src/reaction.ts:148-159` | 04시 전에 학습 종료! {minutes}분 남았어 | deadline / task=학습 종료, result={minutes}분 남았어, message=원문 |
| jungle.attendance-complete | `plugins/jungle/src/reaction.ts:163-167` | 오늘도 수고했어 | done / task=오늘, result=수고했어 |
| jungle.manual-login-lost | `plugins/jungle/src/status-text.ts:15-18`, `plugins/jungle/src/monitor.ts:111-114` | LMS 로그인이 풀렸어 | alert / task=LMS 로그인, message=원문 |
| jungle.manual-no-cohort | `plugins/jungle/src/status-text.ts:19-21` | 활성 기수가 없어요 | alert / task=활성 기수, message=원문 |
| jungle.manual-error | `plugins/jungle/src/status-text.ts:22-24` | 출석 상태를 확인할 수 없어요 | alert / task=출석 상태, message=원문 |
| jungle.manual-before-start | `plugins/jungle/src/status-text.ts:28-32` | 아직 학습 시작 전이에요. 10시까지 {remaining} 남았어요 | deadline / task=학습 시작, result/message=10시까지 {remaining} 남았어요 |
| jungle.manual-start-overdue | `plugins/jungle/src/status-text.ts:33-38` | 오늘 학습 시작을 놓쳤어요 / 학습 시작이 늦었어요! 지금 누르면 아직 괜찮아요 | alert / task=학습 시작, message=놓침; 또는 deadline / task=학습 시작, message=지금 누르면 아직 괜찮아요 (두 ID로 분리) |
| jungle.manual-studying | `plugins/jungle/src/status-text.ts:39-42` | 학습 중이에요. 종료는 23시부터 누를 수 있어요({remaining} 뒤) | info / task=학습 종료, result={remaining} 뒤, message=종료 문장 |
| jungle.manual-end-open | `plugins/jungle/src/status-text.ts:43-47` | 학습 종료를 누를 수 있어요. 04시까지 {remaining} 남았어요 | deadline / task=학습 종료, result=04시까지 {remaining} 남았어요, message=학습 종료 문장 |
| jungle.manual-complete | `plugins/jungle/src/status-text.ts:48-50` | 오늘 출석을 마쳤어요 | done / task=오늘 출석, result=마쳤어요 |
| orca.unavailable | `plugins/orca/src/index.ts:44-47,59-62,103-107` | Orca 상태를 확인할 수 없어 | — |
| orca.worker-succeeded | `plugins/orca/src/index.ts:72-74` | {task}이 끝났어 | — |
| orca.worker-failed | `plugins/orca/src/index.ts:75-77` | {task}에 실패했어 | — |
| orca.worker-exited | `plugins/orca/src/index.ts:78-80` | {task}이 멈춘 것 같아 | — |
| orca.coordinator-waiting | `plugins/orca/src/index.ts:81-83` | {task}에서 나를 기다려 | — |
| orca.gate-pending | `plugins/orca/src/index.ts:84-92` | {task} 확인이 필요해 | — |
| orca.escalation / orca.question | `plugins/orca/src/index.ts:93-97` | {task}에서 문제가 생겼어 / {task} 질문이 왔어 | — (두 ID로 분리) |
| orca.gate-resolved / orca.gate-already / orca.gate-unknown | `plugins/orca/src/index.ts:129-132` | 결정했어 / 이미 처리된 확인이야 / 승인 결과를 확인하지 못했어 | — (세 ID로 분리) |
| slack.mention / slack.dm / slack.channel | `plugins/slack/src/index.ts:140-165` | {sender} · {channel} + 줄바꿈 + {body}; 본문 숨기기면 제목만 | — (kind 별 세 ID, 사용자/외부 본문은 변수) |
| slack.token-required / slack.permission-required | `plugins/slack/src/index.ts:173-185` | Slack 토큰 확인 필요 / Slack 권한 부족 | — (두 ID로 분리; 나머지 연결 상태는 배지만 변경) |
| reminders.rule | `plugins/reminders/src/index.ts:38-45,75-77` | {rule.text} (사용자 설정의 문구) | reminder / task=정리한 rule.text, message=정리한 rule.text |
| claude-code.done variants | `docs/hooks/hook-message.mjs:72-76,87-98`, `send-claude-code-event.mjs:88-111` | {folder}: {task} → {result} / {folder}: {task} / {folder}: {result} / {folder} 작업이 끝났어요 | done / task,result,folder 중 있는 값 |
| claude-code.wait variants | `docs/hooks/hook-message.mjs:77-85`, `send-claude-code-event.mjs:88-111` | {folder}: {message} / {folder}이 입력을 기다려요 | waiting·failed·info 분기 / folder,message 등 있는 값 |
| codex.done / codex.wait variants | `docs/hooks/codex-notify-wrapper.mjs:24-28`, `send-claude-code-event.mjs:153-156`, `hook-message.mjs:72-98` | Claude Code와 같은 6가지 조합; 출처만 codex | done 또는 waiting·failed·info / task,result,folder,message 중 있는 값 |

훅은 현재 완료 외의 `text`를 기다림 문장으로 만들면서 `voice.kind`는 이벤트 이름에 따라 `waiting`·`failed`·`info`가 된다(`docs/hooks/send-claude-code-event.mjs:20-37,99-111`). 목록 전환 때 이 분기별 ID와 kind를 명시하고, 없는 task/result/message 조합은 별도 ID로 나누어 원문 의미를 유지한다. Slack 본문과 reminders의 `rule.text`는 사용자·외부 데이터라 문장 자체를 목록 기본값으로 옮길 수 없다. 이 둘은 `{body}`/`{message}` 변수가 표시의 주체이며, 목록 기본 문장은 주변 형식 또는 변수만 둔다.

## 사용자 확인 질문

1. **선언 형식:** v2 매니페스트가 별도 `lines.json`을 가리키는 B안을 승인할까요? 대안 A는 매니페스트 안에 모두 넣고, C는 실행 중 API로 등록합니다. 추천 B는 꺼진 플러그인도 목록을 보여 주고 큰 문장을 매니페스트에서 분리합니다.
2. **경로와 출처:** `PetEvent.line`과 CLI/HTTP 범위 인증 B안을 승인할까요? 대안은 `voice` 안 확장 또는 source 문자열 비교뿐인 간단한 경로입니다. 추천안은 훅의 실제 출처와 다른 플러그인의 ID를 구별합니다.
3. **저장과 적용:** 팩 기본값 + 팩 ID별 사용자 덮어쓰기 C안, 문장·동작의 4장 우선순위를 승인할까요? 대안은 팩에만 저장하거나 캐릭터 무관 설정에만 저장하는 것입니다. 특히 종류별 어투를 목록 기본 문장보다 먼저 적용하는 것이 맞는지 확인이 필요합니다.

## 사용자 결정 (2026-10-15, D-071)

1. **선언 형식: B 승인.** v2 `manifest.contributes.lines` 가 플러그인 폴더의 `lines.json` 을 가리킨다.
2. **경로와 출처: `PetEvent.line` 은 승인, 출처 확인은 본문 추천 (b) 대신 (a).** 훅 전용 토큰·범위 인증은 두지 않는다. HTTP·CLI 는 지금의 토큰 하나를 그대로 쓰고, `line.id` 의 접두부가 `source` 와 정확히 같아야 하며 다르면 400 으로 거부한다(인증 실패 401 은 지금과 같음). 이유: 로컬 토큰을 가진 호출자는 지금도 어느 `source` 로든 임의 `text` 를 보낼 수 있고, `line` 은 액션 없이 문장만 고르므로 새로 열리는 능력이 없다. 플러그인 경로(`ctx.emit`)는 본문대로 호스트가 manifest id 와 접두부·등록 여부를 검사한다. 2장의 HTTP 거부 표 중 403 두 행은 적용하지 않는다.
3. **저장: C 승인.** 팩 `voice.json` 의 선택 `lines` + `settings.json` 의 `lineOverrides[packId][lineId]`. 동작도 같은 두 계층(팩 `reactions.json` 의 `lines`, 설정의 팩·대사별 지정).
4. **문장 적용 순서: 본문 4장 대신 "대사 기본 문장 먼저".** `line` 이 있는 이벤트는 **사용자 대사 변형 → 현재 팩의 대사 변형 → 플러그인 `lines.json` 기본 변형 → 이벤트 `text`** 순서이고, 알림 종류별 어투(`voice.json` 의 `templates`)는 쓰지 않는다. 종류별 어투는 `line` 이 없는 이벤트(외부 v1 플러그인, 직접 보낸 HTTP 이벤트)에만 지금처럼 적용한다. 이유: 설정 화면에 보이는 문장이 실제로 나오는 문장과 같아야 하고, 대사 변수와 종류별 슬롯(task·result·folder·message)을 이중으로 정의하지 않기 위해서다. 대신 내장 팩 `wolf-maid` 의 `voice.json` 에 내장 플러그인 대사 전부를 지금의 "주인님" 말투로 넣어(`lines`) 기본 캐릭터의 느낌을 유지한다(기준 6·9 범위). 동작 순서는 본문 4장 그대로(대사별 → 종류별 → 플러그인 규칙 → 기분). `line` 의 목록 `kind` 는 종류별 동작과 기존 반응 규칙 선택에 계속 쓴다.

## 구현 결과 (M12, 2026-10-15)

- **계약:** core 의 `PetEvent` 는 그대로 두고 `LinePetEvent`(`line?: { id; vars? }`)를 새로 만들어 v2 `ctx.emit`·내부 경로·HTTP 에서 쓴다. v1 공개 타입의 `emit` 은 `line` 을 받지 않고, v1 플러그인이 런타임에 보내면 호스트가 거부한다. 변수는 선언된 이름만 받고 누락은 허용(못 만드는 변형은 다음 변형으로).
- **전환:** 내장 6종(jungle·reminders·slack·claude-code·codex·orca)을 v2 로 올렸다. 권한 허용 기록은 권한 내용으로 키를 잡아 다시 묻지 않는다. 대사 58개, wolf-maid 팩에 같은 id 전부를 "주인님" 말투로 넣었다. `orca.gate-resolved` 는 쓰기 금지 검사 패턴에 걸려 `orca.gate-decided` 로 이름을 바꿨다.
- **동작 순서 보완:** 처음 구현은 종류별 반응을 `voice.kind` 로만 찾아, `line` 만 보내는 내장 알림이 기분 규칙으로 떨어졌다(예: 출석 완료가 bow 대신 talk). 등록된 대사 목록의 `kind` 로 찾게 고쳤다.
- **보내 보기:** 설정 창의 대사 보내 보기는 대사 id 로 보내 실제 알림과 같은 문장·동작이 나온다. 저장 전 편집 문장 미리보기는 설정 창 IPC 내부 인자로만 지정할 수 있고 HTTP·플러그인 `emit` 으로는 지정할 수 없다(`PetEvent` 공개 스키마 불변).
- **하드코딩 금지:** `scripts/line-hardcoding.ts`(TypeScript 컴파일러 API)가 내장 6종 소스·`docs/hooks` 에서 notify 말풍선의 정적 문장·문장 합성을 막고, manifest 선언·사용 id 를 대조한다.
- **알려진 한계:** 훅은 `--line` 만 보내므로 claude-code·codex 플러그인 폴더를 지우면 HTTP 가 "line.id is not registered" 로 거부해 훅 알림이 사라진다(꺼짐·미승인은 괜찮음, 백로그).
