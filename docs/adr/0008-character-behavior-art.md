# ADR 0008: 캐릭터 행동·아트

## 상태

**승인 (2026-10-09, 사용자, D-047). 10장 잠정 채택도 함께 확정.** M7 완료 기준 1(`docs/progress/milestones.md`)의 본이다. D-045·D-046(`docs/progress/decisions.md`)의 방향을 구체화했고, 9장 질문 8개에 대한 사용자 답(D-047)을 반영했다. 9장 "결정" 열과 "확정"으로 적은 문구는 사용자가 정한 것이다. 10장 "잠정 채택"과 11장 아래 "남은 질문"은 아직 결정이 아니며 사용자가 승인할 때 함께 확인한다. "후보"라고 적은 수치는 근거 없이 제안하는 값이다(코드에 이미 있는 값은 "후보"라고 쓰지 않고 출처를 적는다).

각 설계 항목의 `[기준 n]` 표시는 그 항목이 쓰이는 M7 완료 기준 번호다(6 행동 수치, 7 상호작용→상태, 8 순서 있는 동작, 9 시트 교체·새 상태, 10 이미지 쓰기 경로 리뷰).

## 1. 맥락

D-045의 새 요청 3건(백로그 2026-10-09 사람 항목)은 ① 팩에 아트 리소스(그림 시트·애니메이션)를 포함해 편집·교체 ② 행동 수치(잠들기까지 시간, 걷기 주기, 이동 속도 등)를 설정에서 변경하고 기본값은 팩에서 가져오기 ③ 행동·상호작용에 애니메이션을 매핑하고 순서 있는 동작(예: 메이드식 인사 → 안내)을 팩에 추가하기다. ①은 ADR-0007 Q4(복제는 그림 공유 파생)·Q6(그림 편집 없음)의 재결정을 포함한다(D-045).

### 1-1. 지금 코드가 하는 일

- **행동 수치는 코드 기본값뿐이다.** `CharacterAnimationMachine`(`packages/core/src/character-animation.ts`)은 옵션 5개 `blinkIntervalMs`(기본 `[3_000, 7_000]`)·`walkIntervalMs`(`[18_000, 30_000]`)·`walkDurationMs`(3_000)·`sleepAfterMs`(60_000)·`walkSpeedPxPerSecond`(30)를 받는다. 그러나 `apps/desktop/src/main/index.ts` 는 `new CharacterAnimationMachine(characterPack.manifest, { clock: () => clockMs })` 로 시계만 넘기므로(567행 근처) 항상 기본값이다. 옵션은 생성자에서만 읽고 `readonly` 라 실행 중에는 바꿀 수 없다.
- **상호작용은 표정(mood)만 안다.** `packages/core/src/interactions.ts` 의 `InteractionItem` 은 `id`·`label`·`mood`·`bubble`·`lines` 다. 누르면 `interactionEvent`(`apps/desktop/src/main/pet-menu.ts`)가 `mood` 가 담긴 `PetEvent` 를 보내고, `selectReaction`(`packages/core/src/reaction-rules.ts`)이 `mood` 이름을 곧 재생할 상태 이름으로 쓴다(`sleepy`→`sleep`, `neutral`은 재생 없음). 어떤 상태를 재생할지 상호작용이 고를 수 없다.
- **상태 해석.** `CharacterAnimationMachine.request(name)` 은 `fallbacks` 체인을 따라가고(순환 방지), 없으면 `idle` 로 간다. 드래그 중에는 `request` 가 무시된다. 비반복 상태는 `next ?? "idle"` 로 넘어가고, `walk` 는 `walkDurationMs` 가 지나면 `idle` 로 돌아간다. 걷기 이동은 `enter("walk")` 가 방향·속도(`movement`)를 정하고 `index.ts` 의 `tickAnimation` 이 창을 옮긴다.
- **반응 재생.** `index.ts` 의 `playReaction`/`settleReaction` 이 `durationMs`·`repeat` 만큼 상태를 되풀이하다 끝나면 `idle` 로 보낸다. 말풍선이 뜨면 반응이 없을 때 `talk` 상태로 간다(`bubbleChanged`).
- **방해 금지 예외.** 메뉴로 누른 상호작용은 `USER_DIRECT`(main 내부 심볼 키, `pet-menu.ts`)로 표시돼 방해 금지·전체 화면 보류를 받지 않는다(M6). 같은 id 연타는 `INTERACTION_MIN_INTERVAL_MS`(500)로 막는다.
- **팩 형식.** `CharacterManifest`(`packages/core/src/contracts.ts`)는 `id`·`name`·`apiVersion:"1"`·`cellSize`·`anchor`·`scale`·`states`·`fallbacks` 에 선택 필드 `voice`·`meta`·`preview`·`extends`·`interactions` 가 있다. `states` 는 최대 32개이고 `frames` 1–64, `fps` 0 초과 60 이하다(`validateCharacterManifest`, `packages/core/src/validate.ts`). 이 검증기는 상태 이름 형식을 제한하지 않는다. `mergeCharacterManifest`(`packages/core/src/pack.ts`)는 파생 팩에서 `cellSize`·`anchor` 덮어쓰기와 상태 추가를 오류로 거부하고, 기존 상태에서는 `fps`·`loop`·`next` 만 덮어쓰게 한다. 병합 결과에는 `scale`·`preview`·`voice`·`interactions`·`fallbacks`·`meta`·`name` 만 얹는다. 모르는 필드는 허용하고 무시한다(`packages/core/src/schemas.ts` `additionalProperties: true`).
- **시트 로드.** `loadCharacter`(`apps/desktop/src/main/character.ts`)는 `extends` 팩에서 시트를 **원본 팩 폴더**(`sheetRoot = baseRoot`)에서만 읽는다. 시트 8 MiB(`CHARACTER_SHEET_MAX_BYTES`)·16,777,216 픽셀(`CHARACTER_SHEET_MAX_PIXELS`)·팩 합계 64 MiB(`CHARACTER_PACK_MAX_SHEET_BYTES`)(`packages/core/src/schemas.ts`)를 IHDR 로 먼저 확인하고, 시트 크기가 `cellSize × frames` 와 같은지 본 뒤 `nativeImage` 로 디코드한다. 결과 `sheets` 는 시트 경로 문자열을 키로 하는 data URL 맵이다.
- **쓰기 경로.** `createPackStore`(`apps/desktop/src/main/pack-store.ts`)가 팩 쓰기의 단일 지점이다. `writePackFile`(사용자 팩, `data: string | Uint8Array` 라 이진 파일을 이미 받는다), `writeBuiltinPackFile`(개발자 모드 D-044 에서만), `removePack`, `stagePack`, `cleanupStaging`. 모든 쓰기는 `validateRelativePath` 와 링크·이탈 검사(`checkPath`/`checkBuiltinPath`)를 거친 임시 파일 + `rename` 이다. `createPackService`(`apps/desktop/src/main/pack-service.ts`)의 `ensureEditable` 은 내장 팩을 처음 저장할 때 `<id>-mine` 파생 팩을 만들고(개발자 모드면 제자리), `updateManifest`/`saveInteractions`/`saveVoice`/`saveMeta` 가 그 위에서 저장한다.
- **발 위치 검사.** `pnpm sprites:check`(루트 `package.json`)는 `tools/sprite-pipeline/src/check.ts` 의 `checkPack(pack)` 을 돈다. 상태·프레임마다 발 y 가 `anchor[1]` 에서 `FOOT_TOLERANCE_PX`(2) 이내인지, 발 x 중심이 `anchor[0]` 에서 2 이내인지(바닥 `FOOT_BAND_HEIGHT_PX`(8)줄 기준), 발 아래 반투명 잔여, 발 근처 잡점, 빈 프레임, 시트 치수 불일치를 `CheckIssue { state, frame, reason, measured?, expected? }` 로 낸다. `apps/desktop/package.json` 은 `tools/sprite-pipeline` 에 의존하지 않는다(`@deskpet/core`·`plugin-host`·`plugin-sdk` 뿐).
- **설정 저장.** `DeskpetSettings`(`apps/desktop/src/main/settings.ts`)는 `doNotDisturb`·`characterId`·`plugins`·`httpActionAllowlist`·`developerMode` 등을 가지며 `parseSettings` 가 읽고 임시 파일 + `renameSync` 로 쓴다. 설정 창은 허용 채널 목록(`apps/desktop/src/main/settings-window.ts` 의 `settings:*`)으로만 main 과 통신한다. 설정 창 CSP(`apps/desktop/src/renderer/settings.html`)는 `default-src 'none'; script-src 'self'; style-src 'self'` 라 이미지 표시(`img-src`)가 없다.

### 1-2. 문제

1. 팩이나 사용자가 걷기·잠들기·깜빡임의 빈도와 속도를 바꿀 수 없다.
2. 상호작용이 재생할 애니메이션을 고를 수 없고, 여러 동작을 이어 보여 줄 수 없다.
3. 그림은 `tools/sprite-pipeline` 으로 만들고 팩 폴더에 직접 넣어야 한다. 앱 안에서 시트를 교체하거나 상태를 더할 방법이 없고, 파생 팩은 원본의 시트만 쓸 수 있다.

## 2. 목표와 비목표

### 목표

- 행동 수치 5개의 기본값을 팩이 선언하고, 사용자가 재시작 없이 바꿀 수 있다. 범위 밖 값은 main 이 거부한다.
- 상호작용 항목마다 재생할 상태를 고를 수 있고, 팩에 없는 상태는 `fallbacks` 를 따른다.
- 단계마다 상태·시간·선택 말풍선을 가진 순서 있는 동작(시퀀스)을 팩의 별도 파일 `sequences.json` 에 id 로 정의하고, 상호작용이 id 로 참조해 실행한다. 정해진 중단 규칙대로 끊기고 끝나면 `idle` 로 돌아온다.
- 개발자 모드(개발 실행, D-044)에서만 상태의 시트 PNG 를 고른 파일로 교체하거나 새 상태를 더한다. 파일은 `pack-store` 단일 함수를 거쳐 내장 팩 폴더에 쓰이고, 설치본(`app.isPackaged`)에는 이 기능이 없다. 파생 팩("(내 버전)")은 지금처럼 그림을 원본과 공유한다.
- 캐릭터 매니페스트는 선택 필드 추가만 하고 `apiVersion` 은 `"1"` 을 유지한다. `packages/plugin-sdk/src/v1/` 은 건드리지 않는다.

### 비목표

- 앱 안 그림 그리기(픽셀 편집), 프레임 자르기·보정 도구(그림 제작은 `tools/sprite-pipeline` 의 일).
- `.deskpack` 내보내기·가져오기, 보조 펫, 사운드, 외부에서 받은 팩의 설치(milestones.md M7 "범위 밖"). 이 ADR 의 시트 쓰기 경로는 개발자 모드에서 개발자가 이 기기에서 고른 파일 하나를 쓰는 데 한정한다.
- `cellSize`·`anchor` 변경(그림 크기 자체를 바꾸는 일). ADR-0007 Q4 결정(전체 복사 팩을 만들지 않음)을 유지한다.
- 파생 팩·사용자 팩에서의 시트 교체·새 상태 추가(D-047: ADR-0007 Q4·Q6 유지). 일반 사용자에게 주는 그림 편집 기능은 없다.
- 플러그인 반응 규칙(`ReactionRule`)이 시퀀스를 id 로 부르는 기능. 6-5 의 형식은 이를 막지 않지만 이번 범위에서 만들지 않는다.
- 플러그인 SDK 계약(`packages/plugin-sdk/src/v1/`), `PetEvent` 의 공개 모양 변경.
- 걷기 외의 창 이동, 여러 펫 창.

## 3. 설계 요약 (적용 기준)

| 절 | 내용 | 기준 |
|---|---|---|
| 4 | 행동 수치: 팩 `behavior` 필드, 사용자 덮어쓰기, 즉시 반영 | 6 |
| 5 | 상호작용 → 상태 매핑 (`play`) | 7 |
| 6 | 순서 있는 동작: 별도 `sequences.json`(id 로 정의), 상호작용이 `sequence` 로 참조, 상한, 중단 규칙 | 8 |
| 7 | 아트 리소스: 개발자 모드 한정 시트 교체·새 상태·한도·발 위치 검사 표시. 파생 팩 덮어쓰기는 하지 않음 | 9 |
| 8 | 쓰기 경로와 보안 (사용자 파일 경로는 개발자 모드 전용) | 10 (그리고 9) |
| 9 | 질문 8개와 결정(D-047) | 1 |

## 4. 행동 수치 [기준 6]

### 4-1. 팩 필드 `behavior` (선택)

최상위 선택 필드 하나를 더한다. 이름은 `CharacterAnimationOptions` 와 같게 해 대응을 분명히 한다. 파일에는 코드와 같은 단위(밀리초)로 쓰고 설정 창은 초로 보여 준다(변환은 화면에서만).

```json
"behavior": {
  "sleepAfterMs": 60000,
  "blinkIntervalMs": [3000, 7000],
  "walkIntervalMs": [18000, 30000],
  "walkDurationMs": 3000,
  "walkSpeedPxPerSecond": 30
}
```

| 키 | 형식 | 코드 기본값(출처) | 허용 범위(후보) |
|---|---|---|---|
| `sleepAfterMs` | 정수 | 60_000 | 5_000 – 3_600_000 |
| `blinkIntervalMs` | `[최소, 최대]` 정수 | `[3_000, 7_000]` | 각 1_000 – 60_000, 최소 ≤ 최대 |
| `walkIntervalMs` | `[최소, 최대]` 정수 | `[18_000, 30_000]` | 각 1_000 – 600_000, 최소 ≤ 최대 (2026-10-10 사용자 요청으로 하한 5_000 → 1_000) |
| `walkDurationMs` | 정수 | 3_000 | 500 – 30_000 |
| `walkSpeedPxPerSecond` | 숫자 | 30 | 0 – 300 (0 이면 제자리 걷기 그림만) |

모든 키가 선택이다. 없는 키는 코드 기본값을 쓴다(그래서 기존 팩 4개는 수정 없이 지금과 똑같이 동작한다). 수치 범위는 근거 없는 후보이며, 구현 전에 사용자가 화면에서 느껴 보고 조정한다(H 기준). `walk`/`sleep`/`blink` 상태가 팩에 없으면 해당 키는 의미가 없고(머신이 `hasState` 로 건너뜀) 편집기는 그 칸을 비활성으로 보인다.

검증은 `validateCharacterManifest` 에 더하고 범위 밖이면 팩 거부다(알 수 없는 키는 `meta` 와 달리 무시한다). 파생 팩(`extends`)은 `mergeCharacterManifest` 에서 `behavior` 를 키 단위로 덮어쓴다(병합 목록에 `behavior` 추가가 필요하다).

### 4-2. 사용자 덮어쓰기 저장 위치 (Q1, 결정 D-047)

값은 세 층으로 해석한다: **코드 기본값 < 팩 `behavior` < 사용자 덮어쓰기**. **확정: 사용자 덮어쓰기는 `settings.json` 의 캐릭터별 항목에 둔다.**

- **채택 (b): `settings.json` 의 캐릭터별 항목.** `DeskpetSettings` 에 선택 필드 `characterBehavior?: Record<packId, Partial<Behavior>>`(후보 이름)를 둔다. `parseSettings` 의 기존 패턴(`Object.fromEntries`로 프로토타입 오염 방지, 잘못된 값은 버림)으로 읽는다. 키는 유효한 팩 id 만, 항목 수 상한은 64(후보, ADR-0007 T14 와 같은 값). 장점: 숫자 하나 바꾸려고 "(내 버전)" 파생 팩을 만들지 않는다. 내장 팩이 앱 업데이트로 바뀌어도 사용자의 취향 값이 남는다. "초기화"는 키 삭제다. 단점: 팩과 설정 두 곳에 값이 있다.
- 채택하지 않음 (a) 팩 안: 사용자 팩의 `manifest.behavior`. D-042 흐름(첫 저장 때 파생 팩)과 같아 일관되지만, 내장 팩 사용자는 숫자 하나에도 파생 팩이 생긴다.
- 채택하지 않음 (c) 모든 캐릭터 공통 설정(`settings.json` 단일 값). 단순하지만 캐릭터마다 기본값이 다른 팩의 의도를 덮는다.

### 4-3. 즉시 반영 [기준 6]

`CharacterAnimationMachine` 에 메서드 `configure(options, nowMs)`(후보 이름)를 더한다. 현재 상태·`quietSinceMs` 는 유지하고 5개 값만 바꾼 뒤 `resetAutomaticTimers(nowMs)` 로 깜빡임·걷기 다음 시각을 새 범위로 다시 잡는다. `sleepAfterMs`·`walkDurationMs` 는 매 `tick` 에서 읽으므로 즉시 적용되고, `walkSpeedPxPerSecond` 는 다음 걷기부터 적용된다(진행 중인 걷기의 `movement` 는 `enter("walk")` 가 정한 값을 유지). 팩 선택·저장으로 머신을 새로 만들 때(`index.ts` 567행 근처)는 해석한 값(`resolveBehavior(팩, 사용자)`)을 생성자 옵션으로 넘긴다. 설정 창 저장 → main 이 범위 검증 → `settings.json` 쓰기 → `configure` 호출 순서이며, 새 IPC 채널(후보 `settings:behavior-load`·`settings:behavior-save`)은 허용 채널 목록 갱신 대상이다(게이트: 설정 창 IPC 채널 추가, milestones.md M7).

범위 검증은 main 에서 한다(렌더러 검증은 사용성용, ADR-0007 6-2). 해석 함수는 `packages/core` 의 순수 함수로 두고(시계·파일 없음) 단위 테스트한다.

## 5. 상호작용 → 상태 매핑 [기준 7]

`interactions.json` 의 항목(`items[]`)에 선택 필드 `play`(문자열, 재생할 상태 이름)를 더한다. 파일 `version` 은 1 그대로다(필드 추가; 이전 앱의 `parseInteractions` 는 모르는 필드를 버리므로 `play` 만 무시된다).

```json
{ "id": "pat", "label": "쓰다듬기", "mood": "happy", "bubble": true,
  "lines": ["헤헤, 기분 좋아요!"], "play": "happy" }
```

- **없으면 지금 동작.** `play` 가 없으면 `mood` 가 곧 재생 상태 이름이라는 현재 규칙(`selectReaction`)을 그대로 쓴다.
- **있으면 그 상태를 재생한다.** 이름 형식은 `^[a-z][a-z0-9-]{0,31}$`(후보, 상호작용 `id` 패턴과 비슷하게). 이름이 팩 `states` 에 없어도 저장은 막지 않는다. 실행 때 머신의 `request` 가 `fallbacks` 체인을 따르고 그래도 없으면 `idle` 로 간다. 편집기는 선택 목록에 현재 팩의 상태와 `fallbacks` 키를 보여 주고, 해석 결과가 `idle` 로 떨어지는 이름이면 경고한다.
- **`mood` 는 남는다.** 말풍선 이벤트의 표정이고 `play` 와 별개다. `play` 가 `mood` 이름과 다를 수 있다(예: `mood: "happy"`, `play: "bow"`).
- **재생 길이.** 지금 반응과 같다. 비반복 상태는 한 번, 반복 상태는 한 주기(`frames / fps`)만 재생하고 `idle` 로 돌아간다(`playReaction` 의 `forceIdle`). 더 길게 또는 여러 번은 6장의 시퀀스로 한다.
- **계약.** `PetEvent`(`packages/core/src/contracts.ts`)는 바꾸지 않는다. `USER_DIRECT` 와 같은 main 내부 심볼 키(후보 `INTERACTION_PLAY`)로 상태 이름을 이벤트에 실어 `playReaction` 이 `selectReaction` 대신 그것을 쓴다. JSON 으로 오는 이벤트(HTTP `/event`, CLI)는 심볼을 가질 수 없어 외부에서 재생 상태를 지정할 수 없다.
- **수정 대상(구현 task 용).** `InteractionItem`·`parseInteractions`(`packages/core/src/interactions.ts`), `PetInteraction`·`checkInteraction`(`apps/desktop/src/main/pet-menu.ts`), `fromPackInteractions`/`toPackInteractions`(`apps/desktop/src/main/interaction-store.ts`), 상호작용 편집기(`apps/desktop/src/renderer/interactions-panel.ts`). 이 중 하나라도 `play` 를 떨어뜨리면 저장 후 사라지므로 왕복 테스트가 필요하다.


## 6. 순서 있는 동작 (시퀀스) [기준 8]

사용자 결정(D-047 Q5): 시퀀스는 상호작용 항목 안에 넣지 않고 **별도 `sequences`** 로 id 를 붙여 정의하며, 상호작용이 그 id 로 참조한다.

### 6-1. 파일과 형식: `sequences.json`

팩 폴더의 별도 파일 `sequences.json` 에 둔다. 매니페스트에는 `interactions`·`voice` 처럼 경로 문자열 선택 필드 `sequences`(값 `"sequences.json"`)만 더한다. 형식은 `interactions.json` 과 같은 모양(`version: 1`)이다.

```json
{ "version": 1,
  "sequences": [
    { "id": "greet", "label": "인사",
      "steps": [
        { "play": "bow", "ms": 1500 },
        { "play": "talk", "ms": 3000, "say": "어서 오세요, 주인님." },
        { "play": "happy", "say": "오늘도 잘 부탁드려요!" }
      ] } ] }
```

상호작용 항목(`interactions.json`)은 선택 필드 `sequence`(시퀀스 id)로 참조한다.

```json
{ "id": "greet", "label": "인사", "mood": "happy", "bubble": true, "lines": [], "sequence": "greet" }
```

**파일을 고른 근거(매니페스트 선택 필드 대신 별도 파일).** 팩은 이미 어투(`voice.json`)와 상호작용(`interactions.json`)을 별도 파일로 두고 매니페스트는 그 경로만 가리킨다(`CharacterManifest.voice`·`interactions`). 시퀀스도 대사를 담아 길어지고 편집기가 통째로 읽고 쓰는 데이터라 같은 모양이 맞다. 그러면 `validateCharacterManifest` 에는 경로 문자열 검사 하나만 더해지고, 저장 흐름(`saveInteractions` 의 안전 JSON 직렬화 → `parse` → `writeFile` → `updateManifest`)과 크기·깊이 한도(`validatePackJsonLimits`, JSON 256 KiB)를 그대로 쓴다. 매니페스트 안에 넣으면 시퀀스를 한 줄 고칠 때마다 그림·머신 정보가 든 매니페스트 전체를 다시 쓰게 된다.

| 필드 | 형식 | 필수 | 의미·제약 |
|---|---|---|---|
| `id` | 문자열 | 예 | 패턴 `^[a-z0-9][a-z0-9-]{0,47}$`(ADR-0007 4-7 의 id 패턴과 같음) + 금지어(`__proto__`·`constructor`·`prototype`). 파일 안에서 유일. 중복이면 뒤의 것을 버리고 `problems` 에 남긴다(후보) |
| `label` | 문자열 | 아니요 | 편집기 표시용 이름. 120 코드 포인트 이하, 제어·방향 제어 문자 거부(`validText`). 없으면 `id` 를 보인다 |
| `steps` | 배열 | 예 | 1 – 8개 |

참고: 현재 상호작용 항목 id 패턴(`packages/core/src/interactions.ts` 의 `idPattern`)은 `{0,31}` 로 더 짧다. 시퀀스 id 는 요청대로 4-7 패턴을 쓰고 상호작용 id 패턴은 바꾸지 않는다.

| 단계 필드 | 형식 | 필수 | 의미·제약 |
|---|---|---|---|
| `play` | 상태 이름 | 예 | 5장과 같은 이름 형식·`fallbacks` 해석. `walk`·`drag` 는 저장 검증에서 거부(6-6, Q2) |
| `ms` | 정수 | 아니요 | 이 단계 길이(밀리초). 범위 300 – 10_000. 없으면 해석된 상태의 한 주기(`frames / fps`, 최소 300). 주기보다 길면 `playReaction` 처럼 되풀이한다 |
| `say` | 문자열 | 아니요 | 이 단계가 시작될 때 띄울 말풍선. 대사와 같은 규칙: 120 코드 포인트 이하, 제어·방향 제어 문자 거부(`validText`). 어투 템플릿을 거치지 않고 쓴 그대로 나온다(D-035) |

- 항목의 `mood` 는 단계 말풍선의 표정으로 쓴다. 항목의 `bubble: false` 면 모든 `say` 를 무시한다(말풍선 끄기와 같은 뜻, D-035).
- 이 변화는 `interactions.json` `version` 1 에 선택 필드 `sequence` 를 더하는 것과 새 파일 `sequences.json`(`version: 1`)이다. 이전 앱의 `parseInteractions` 는 모르는 필드를 버리므로 `sequence` 만 무시된다.

### 6-2. 내장·파생·사용자 팩에서의 병합 (`interactions.json` 과 같은 방식)

- **파생 팩**(`extends`): 파생 팩 매니페스트가 자기 `sequences` 필드를 가지면 그 파일이 원본 것을 **통째로 대체한다**(항목 단위 병합 없음). 필드가 없으면 원본 팩 폴더의 `sequences.json` 을 읽는다. 지금 `interactions` 가 `mergeCharacterManifest` 의 파생 입력 필드 목록(`packages/core/src/pack.ts`)과 `loadCharacter` 의 `interactionRoot = baseRoot`(`apps/desktop/src/main/character.ts`)로 처리되는 방식 그대로다. 구현은 병합 목록에 `sequences` 를 더하고 `assetRoots` 에 시퀀스 루트를 하나 더한다.
- **내장 팩**: 폴더의 `sequences.json` 을 그대로 읽는다. 사용자가 저장하면 6-5 의 흐름으로 `<id>-mine` 파생 팩이 생기고(개발자 모드면 제자리 저장) 첫 저장 때 원본 시퀀스 전체가 파생 팩 파일로 복사된다.
- **사용자 팩**(파생 아님): 자기 폴더의 `sequences.json` 만 읽는다.
- `interactions` 와 `sequences` 는 서로 다른 팩에서 올 수 있다(파생 팩이 상호작용만 고치면 시퀀스는 원본 것). 그래서 참조 검사는 두 파일을 합쳐서 로드 때 한다(6-3).

### 6-3. 참조와 없는 id

- 상호작용 항목의 `sequence` 가 해석되면(합친 시퀀스 목록에 있으면) 그 시퀀스를 실행하고 항목의 `play`·`lines` 는 쓰지 않는다.
- **없는 id 를 참조하면** 그 `sequence` 만 무시하고 항목은 `sequence` 가 없는 항목처럼 동작한다(`play` 가 있으면 그것, 없으면 `mood` 규칙, `lines` 가 있으면 대사). 로드 때 `problems` 에 남기고 편집기는 해당 항목에 경고를 보인다. 거부하거나 항목을 숨기지 않는 이유: 시퀀스 파일과 상호작용 파일이 따로 바뀔 수 있어 저장 시점에는 판단할 수 없고, 우클릭 메뉴가 비는 쪽이 더 나쁘다(결정, 9장 "남은 질문" 2).
- 저장 검증(main)은 `sequence` 가 id 패턴에 맞는 문자열인지만 본다. 존재 여부는 막지 않는다.
- 시퀀스를 지우거나 id 를 바꿀 때 편집기가 그 시퀀스를 참조하는 상호작용 항목 목록을 보여 준다.

### 6-4. 상한

Q4 확정(후보, 써 보고 조정): 단계 수 ≤ 8, 단계 `ms` 300 – 10_000, 총 시간 ≤ 30_000 ms. 시퀀스 개수는 한 파일 32개까지(후보, 상호작용 항목 상한 `CHARACTER_INTERACTIONS_MAX_ITEMS` 와 같은 값). JSON 크기 256 KiB·깊이 8(`validatePackJsonLimits`)은 그대로 적용된다. 저장 검증(main)은 단계 수와 `ms` 범위만 보고, 총 시간은 해석된 상태 길이가 필요하므로 편집기가 계산해 경고한다. 실행기는 총 시간을 넘는 뒷부분을 자른다.

### 6-5. 실행 모델과 편집·저장 경로

**실행.** main 의 시계(`clockMs`) 기준 순수 스케줄러(후보 이름 `SequencePlayer`, `packages/core`)가 단계 경계를 계산한다. `tickAnimation` 에서 `settleReaction` 과 같은 자리에 구동한다. 상호작용이 눌리면 main 이 `sequence` id 로 단계 목록을 찾아 `SequencePlayer` 에 넘긴다(실행기는 id 와 해석된 단계만 안다). 단계가 시작될 때 머신에 `request(play)`, `say` 가 있으면 말풍선 이벤트(`notify`, `ttlMs` = 단계 길이 이상, 최소 2_000 후보)를 `USER_DIRECT` 표시로 보낸다. 마지막 단계가 끝나면 `machine.request("idle", endMs)` 로 돌아온다. 시퀀스는 활동이므로 시작 때 `quietSinceMs` 가 갱신돼 잠들기 시간이 다시 센다(`request` 의 기존 동작). 시퀀스가 진행 중일 때 `bubbleChanged` 가 `talk` 로 덮지 않도록 `reaction` 과 같은 "점유" 상태를 둔다.

**편집·저장.** 설정 창 [캐릭터] 탭에 시퀀스 편집 하위 탭(후보 이름 [동작])을 더하고, 상호작용 편집기에는 `sequence` 선택 칸을 더한다. 저장은 `createPackService` 에 `saveSequences`(후보)를 `saveInteractions` 옆에 더해 같은 흐름으로 한다: `ensureEditable` 로 저장 대상 팩 결정(D-042: 내장 팩은 첫 저장 때 `<id>-mine` 파생 팩을 만들고 편집하던 팩이 현재 팩이면 전환, 개발자 모드 D-044 면 제자리) → 안전 JSON 직렬화(256 KiB) → `parseSequences`(후보, `packages/core`) 검증 → `writeFile(packId, "sequences.json", json)` → `updateManifest(packId, { sequences: "sequences.json" })`. 쓰기는 `pack-store` 의 `writePackFile`/`writeBuiltinPackFile` 만 거치고 다른 곳에서 `fs` 로 팩에 쓰지 않는다. 파생 팩 첫 저장에서는 편집기가 합쳐진(원본) 시퀀스를 불러와 전체를 저장하므로 원본 것이 복사된다. 상호작용 이전 실패 때 팩이 남지 않게 하는 M7 기준 5 의 처리와 같은 방식을 쓴다. 새 IPC 채널(후보 `settings:sequences-load`·`settings:sequences-save`)은 허용 채널 목록 갱신 대상이다(게이트).

**수정 대상(구현 task 용).** `packages/core`: 새 `sequences.ts`(파서), `interactions.ts` 의 `InteractionItem`·`parseInteractions`(`sequence` 필드), `contracts.ts`·`schemas.ts`·`validate.ts`(매니페스트 `sequences` 경로), `pack.ts`(병합 목록). `apps/desktop/src/main`: `character.ts`(`sequences` 로드·루트), `pack-service.ts`(`saveSequences`), `pet-menu.ts` 의 `PetInteraction`·`checkInteraction`, `interaction-store.ts` 의 `fromPackInteractions`/`toPackInteractions`, 상호작용 편집기(`apps/desktop/src/renderer/interactions-panel.ts`). `sequence` 필드를 하나라도 떨어뜨리면 저장 후 사라지므로 5장의 `play` 와 함께 왕복 테스트가 필요하다.

**반응 규칙(플러그인)에서의 참조 — 비목표.** 이번에 만들지 않는다. 형식은 이를 막지 않는다: 시퀀스는 팩 수준 id 공간에 있고 실행기는 id 만 받으므로, 나중에 `ReactionRule` 이 선택 필드로 시퀀스 id 를 갖거나 main 내부 키(5장 `INTERACTION_PLAY` 와 같은 방식)로 연결해도 `sequences.json` 형식을 바꿀 필요가 없다. 플러그인 SDK(`packages/plugin-sdk/src/v1/`)와 `PetEvent` 는 이번에도 바꾸지 않으며, 그 변경은 별도 ADR 과 사용자 확인이 필요하다. HTTP `/event`·CLI 같은 외부 이벤트는 시퀀스를 지정할 수 없다(5장과 같은 이유).

### 6-6. 중단 규칙 (Q2·Q3 확정, 나머지 잠정 채택)

| 사건 | 규칙 |
|---|---|
| 드래그 시작 | 즉시 중단. 남은 단계 폐기, 시퀀스가 띄운 말풍선은 닫는다. 머신은 `startDrag` 가 이미 상태를 `drag` 로 바꾸고 `request` 를 무시한다 |
| 드래그 중 시작 요청 | 시작하지 않는다(머신이 `dragging` 중 `request` 를 무시하는 것과 일치) |
| 알림(`USER_DIRECT` 가 아닌 이벤트로 실제 재생·표시되는 것) | **확정(Q3): 즉시 끊고 알림을 보인다.** 방해 금지·전체 화면 보류로 **표시되지 않는** 이벤트는 시퀀스를 끊지 않는다 |
| 다른 상호작용 | 새 것이 이긴다: 진행 중인 시퀀스를 끊고 새 상호작용을 시작한다. 같은 id 는 `INTERACTION_MIN_INTERVAL_MS` 규칙이 먼저 막는다 |
| 방해 금지 | 사용자가 직접 누른 것이므로 시작은 막히지 않고(M6 규칙), 실행 중 방해 금지를 켜도 계속한다. 시퀀스가 보내는 말풍선도 `USER_DIRECT` 라 보류되지 않는다 |
| 펫 숨김·캐릭터 전환·팩 저장으로 머신을 새로 만듦 | 중단. 숨겨진 동안은 `clockMs` 가 멈추므로 두면 낡은 말풍선이 나중에 뜬다 |
| 걷기 | **확정(Q2): 시퀀스는 창을 옮기지 않는다.** 단계 `play` 가 `walk`·`drag` 이면 저장 검증이 거부한다. `fallbacks` 해석 결과가 그것이면 그 단계는 `idle` 로 대신 재생한다(머신에 "이동 없이 요청" 옵션이 필요) |
| 끝 | 마지막 단계 후 `idle`. 잠들기 시간은 그때부터 다시 센다 |

주의: 단계 말풍선은 말풍선 사이 간격(약 5초) 대기에 걸려 조용히 버려질 수 있다. 백로그 2026-10-09 "간격 대기 중 상호작용 버려짐"(M7 기준 4)의 수정이 이 설계의 전제다. 기준 4 가 끝나기 전에 기준 8 의 말풍선 단계를 만들지 않는다.

## 7. 아트 리소스 [기준 9]

사용자 결정(D-047 Q6): 파생 팩에서 시트 교체·새 상태 추가는 **허용하지 않는다**(ADR-0007 Q4·Q6 유지). 대신 M7 기준 9 는 **개발자 모드**(개발 실행의 내장 팩 직접 편집, D-044)에서만 시트 교체·새 상태 추가를 한다. `app.isPackaged` 이면 기능이 없다.

### 7-1. ADR-0007 Q4·Q6 은 유지

| 항목 | ADR-0007 결정(D-037) | 이 ADR 의 결과 (D-047) |
|---|---|---|
| Q6 편집 범위 | 그림 시트 편집 없음 | **유지.** 사용자 기능으로는 시트 교체·새 상태가 없다. 개발자 모드의 시트 교체·새 상태는 내장 팩 소스 파일을 고치는 개발 도구(D-044 의 어투·상호작용·메타 직접 편집과 같은 종류)이고 설치본에는 없다 |
| Q4 복제 방식 | 항상 파생(그림 공유), 전체 복사 없음 | **유지.** 파생 팩은 `fps`·`loop`·`next` 덮어쓰기만 하고 그림은 원본 것을 쓴다. 전체 복사 팩도 만들지 않는다 |

### 7-2. 하지 않는 일: 파생 팩 덮어쓰기

파생 팩에서 `states.<이름>` 에 `sheet`·`frames` 를 두어 원본 시트를 대체하거나 상태를 추가하는 안은 **하지 않는다.** 그래서 `mergeCharacterManifest`(상태 추가·`cellSize`·`anchor` 덮어쓰기 거부, `fps`·`loop`·`next` 만 허용)와 `loadCharacter`(`sheetRoot = baseRoot`)는 이 ADR 에서 바뀌지 않는다. 이전 앱과의 파생 팩 비호환도 생기지 않는다. 앱 사용자가 자기 그림을 쓰려면 지금처럼 `tools/sprite-pipeline` 으로 팩을 만든다(그림 제작은 그 도구의 일이다). 가져오기·내보내기는 `.deskpack` 단계(D-045 백로그)의 일이다.

### 7-3. 개발자 모드 흐름

- **켜짐 조건.** `!app.isPackaged && settings.developerMode === true`(`apps/desktop/src/main/index.ts` 의 `developerMode`, `pack-service.ts` 의 `developerMode()`). 대상 팩은 내장 팩(`directEdit`)뿐이다. 설치본은 설정 창이 스위치와 이 화면을 보이지 않고, main 도 `isPackaged` 이면 시트 쓰기·파일 선택 요청을 거부한다(`createPackStore` 의 `allowBuiltinWrites` 도 거짓이어서 `writeBuiltinPackFile` 이 `Built-in pack writes are not enabled` 를 던진다).
- **시트 교체.** 기존 상태 하나의 PNG 를 파일 선택으로 고른 PNG 로 바꾼다. 같은 화면에서 그 상태의 `frames`(1–64)와 `fps`(0 초과 60 이하)를 다시 정할 수 있다. 시트 높이는 `cellSize[1]`, 너비는 `cellSize[0] × frames` 와 같아야 한다(`loadCharacter` 규칙).
- **새 상태 추가.** 이름, 시트, `frames`, `fps`, `loop`, (선택) `next`·`facing` 을 정해 내장 팩 매니페스트의 `states` 에 더한다. 전체 `states` 는 최대 32개(현행 검증기)이므로 기본 9개 외 최대 23개다. 내장 팩에 직접 추가하는 것이라 `mergeCharacterManifest` 의 파생 규칙과 무관하다.
- **새 상태 이름 규칙.** 앱이 만드는 이름은 `^[a-z][a-z0-9-]{0,31}$`(후보)와 금지어(`__proto__`·`constructor`·`prototype`)를 따르고 팩 안에서 유일해야 한다. 기본 9개 이름(`idle`·`blink`·`walk`·`sleep`·`happy`·`surprised`·`worried`·`talk`·`drag`)은 앱이 뜻을 아는 이름이고, 그 밖의 이름(`bow` 등)은 상호작용 `play`, 시퀀스 단계 `play`, 플러그인의 반응 규칙(`ReactionRule.play`), `fallbacks` 의 대상으로만 쓰인다. 자동 재생되지 않는다. 이 규칙은 앱이 새로 만드는 이름에만 적용한다. 기존 팩의 상태 이름은 검증기가 제한하지 않으므로(1-1) 소급해 팩을 거부하지 않는다.
- **삭제는 없다.** `idle` 은 지울 수 없고(`states.idle` 필수), 상태 삭제는 이번 범위에 넣지 않는다. 그래서 `extends` 한 파생 팩이 가리키는 원본 상태가 사라지는 일이 없다.
- **파생 팩에 미치는 영향.** 내장 팩의 시트 교체·새 상태는 그 팩을 `extends` 한 파생 팩에도 보인다(파생 팩은 원본의 상태와 시트를 쓴다). 파생 팩이 덮어쓴 `fps`·`loop`·`next` 는 그대로 남는다. 의도된 동작이고 저장소 파일 변경이라 git 으로 되돌린다.
- **계약.** 캐릭터 매니페스트의 선택 필드 추가는 `behavior`(4장)와 `sequences`(6장)뿐이다. 기존 필드의 의미는 바꾸지 않고, 기존 유효한 매니페스트는 모두 그대로 유효하며 같은 결과를 낸다. `apiVersion` 은 `"1"` 이다(ADR-0002 버전 정책: 필드 추가는 유지, ADR-0007 4-8). 파생 팩 규칙이 그대로라서 "거부하던 것을 허용"하는 변화가 없다. `packages/plugin-sdk/src/v1/` 에는 캐릭터 매니페스트 타입이 없고(`CharacterManifest` 를 찾을 수 없음) 이 설계는 그곳을 건드리지 않는다. `PetEvent` 모양도 바꾸지 않는다(5장). 스키마·타입 변경은 `pnpm test:contract` 영향 범위이므로 계약 테스트를 함께 갱신한다.

### 7-4. 이미지 한도 (Q8, 결정 D-047)

**확정: 현행 한도 그대로.** 시트 하나 8 MiB(`CHARACTER_SHEET_MAX_BYTES`), 16,777,216 픽셀(`CHARACTER_SHEET_MAX_PIXELS`), 팩 시트 합계 64 MiB(`CHARACTER_PACK_MAX_SHEET_BYTES`), `frames` 1–64, `cellSize` 한 변 1024 이하, 상태 32개. PNG 만 받는다(GIF·APNG·WebP·SVG 거부). 실제 시트는 장당 약 3.5–6 KB 라 한도는 사용량보다 훨씬 넉넉하다(ADR-0007 1-1). 개발자가 고르는 파일에 더 낮은 한도를 두지 않는다(저장은 되는데 로드가 안 되는 불일치를 피한다).

### 7-5. 파일 이름과 쓰기 순서 [기준 9·10]

- 디스크에 쓰는 이름은 고른 파일 이름이 아니라 **앱이 계산한다**: `sheets/<상태 이름>-<8자리 16진 난수>.png`(후보 형식). 상태 이름이 7-3 규칙을 통과해야 하므로 경로는 항상 `pack-store` 의 `validateRelativePath` 를 통과한다.
- 쓰기는 모두 `createPackStore` 의 함수만 거친다. 내장 팩에는 `writeBuiltinPackFile`(개발자 모드에서만, `checkBuiltinPath` 와 임시 파일 + `rename`)을 쓰고, 사용자 팩용 `writePackFile` 은 시트에 쓰지 않는다.
- 교체 순서: ① 새 PNG 를 새 이름으로 `writeBuiltinPackFile` ② 병합 결과를 검증한 뒤 매니페스트를 원자적으로 다시 씀(커밋 지점, 개발자 모드의 제자리 저장 경로 `updateManifest`) ③ 더 이상 참조되지 않는 이전 시트를 지움. ②가 실패하면 ①의 새 파일을 지우고 팩은 그대로다. ③이 실패하면 고아 파일이 남을 뿐 팩은 유효하다. 삭제를 위해 `pack-store` 에 개발자 모드 전용 단일 삭제 함수(후보 `removeBuiltinPackFile`)를 더한다.
- **지우는 범위.** 앱이 만든 이름 형식(`<상태>-<8hex>.png`)이고 매니페스트가 가리키지 않는 시트만 지운다. 파이프라인이 만든 원래 시트(`sheets/<상태>.png`)는 지우지 않고 남겨 개발자가 git 으로 정리한다(결정, 9장 "남은 질문" 1).

### 7-6. 발 위치 검사 결과를 앱에서 보여 주기 (Q7, 결정 D-047)

**확정: 이상이 나와도 결과를 보여 주고 사용자가 "그래도 사용"을 고르면 저장한다.** 치수·한도 위반(시트 크기 불일치, 8 MiB·픽셀 한도)만 거부한다.

`checkPack` 은 CLI 용 코드라 앱이 부를 수 없다(1-1). 같은 규칙을 한 곳에 두려면 프레임 검사 부분(`inspectFrame` 과 상수 `FOOT_TOLERANCE_PX`·`OPAQUE_ALPHA_THRESHOLD`·`FOOT_BAND_HEIGHT_PX`)을 픽셀 배열을 받는 순수 함수로 `packages/core` 에 옮기고, `tools/sprite-pipeline/src/check.ts` 와 앱이 둘 다 그것을 쓰게 한다(잠정 채택). 앱은 `nativeImage.toBitmap()` 의 알파 채널로 같은 함수를 부른다(`loadCharacter` 가 이미 같은 방식으로 알파를 읽는다). `tools/sprite-pipeline` 에 앱이 의존하게 하는 안은 도구 패키지를 앱 빌드에 끌어들여 택하지 않는다.

- 보이는 모양: 시트 교체 대화 안에서 상태별 한 줄 요약("발 위치 이상 N프레임")과 처음 몇 건(후보 20건)의 `reason`·프레임 번호·`measured`/`expected` 를 사용자용 문구로 보인다. 경로·OS 오류 원문은 로그에만 둔다(ADR-0007 구현 확정). 이상이 있으면 [그래도 사용] 단추를 따로 눌러야 저장된다.
- 비용: 검사는 시트 픽셀 수에 비례하는 반복(연결 요소 탐색)이다. 한도 최대(16,777,216 픽셀)에서는 main 을 길게 막는다. 프레임 단위로 양보하며 비동기로 돌리고, 검사하는 시트의 픽셀 상한(후보 4,194,304)을 넘으면 검사를 건너뛰었다고 표시하는 안을 구현 때 고른다.

## 8. 쓰기 경로와 보안 [기준 9·10]

가져오기 설계(ADR-0007 6장)와 달리 여기서 읽는 파일은 **개발자 모드에서 개발자가 이 기기에서 방금 고른 PNG 하나**다. 압축 해제·팩 설치·이름 계산이 없고, 이 경로는 설치본에 없으며 개발 실행에서도 개발자 모드를 켠 때만 열린다. 사용자 파일 경로는 개발자 모드 전용이 되었으므로 공격면이 더 작다. 다만 이진 파일을 저장소 폴더에 쓰는 첫 경로이므로 기준 10 에서 리뷰한다. 시퀀스 저장(`sequences.json`)은 일반 설정 창 기능이지만 텍스트 JSON 이고 기존 `writePackFile` 경로를 쓴다(S8).

| # | 위협 | 대응 |
|---|---|---|
| S1 | 렌더러가 임의 경로를 읽게 한다 | 렌더러는 경로를 보내지 않는다. 설정 창은 "파일 고르기"만 요청하고, main 이 `dialog.showOpenDialog`(단일 선택, `.png` 필터)로 경로를 받아 그 경로를 main 안에만 보관한다. 렌더러에는 미리보기(data URL)와 검사 결과, 이 선택을 가리키는 일회용 토큰만 준다. 적용 요청은 토큰·상태 이름·`frames`·`fps`·`loop` 만 싣는다. 드래그 앤 드롭 경로는 받지 않는다(ADR-0007 6장 방침과 같다). 이 채널은 개발자 모드가 켜져 있을 때만 처리한다 |
| S2 | 고른 파일이 링크·특수 파일이다 | `lstat` 로 일반 파일인지 확인하고 심볼릭 링크·장치·디렉터리는 거부한다. 확인 후 읽는 동안 바뀌는 경쟁을 줄이려고 한 번 읽은 바이트만 검증·미리보기·쓰기에 쓰고 경로를 다시 열지 않는다 |
| S3 | 거대 파일·이미지 폭탄 | 읽기 전에 `stat` 크기를 8 MiB 와 비교하고, 읽을 때 한도+1 바이트까지만 읽는다. **디코드 전에** PNG 시그니처·IHDR 의 폭×높이를 픽셀 한도와 `cellSize × frames` 에 맞춰 보고, 통과한 뒤에만 `nativeImage` 로 디코드한다(`loadCharacter` 와 같은 순서). 디코드 실패는 거부. main 에서 `nativeImage` 로 디코드하는 위험은 ADR-0007 T3 이 인정한 잔여 위험이며 이 ADR 이 없애지 못한다 |
| S4 | 경로 이탈·이름 주입 | 디스크 이름은 앱이 상태 이름 규칙 통과값에서 계산한다(7-5). 사용자가 고른 파일 이름은 쓰지 않는다(표시용 화면 문구에도 `textContent` 로만). `pack-store` 의 `validateRelativePath`·`checkBuiltinPath`·링크 검사가 마지막 방어선이다 |
| S5 | 설치본·일반 실행에서 내장 팩이 바뀐다 | 시트 쓰기 요청은 `app.isPackaged` 이거나 `developerMode` 가 꺼져 있으면 main 이 거부한다(UI 숨김과 별개). `writeBuiltinPackFile` 은 `allowBuiltinWrites` 가 거짓이면 오류다. 사용자 팩 쓰기 함수 `writePackFile` 은 시트에 쓰지 않는다 |
| S6 | 쓰다 만 파일, 고아 파일 | 임시 파일 + `rename` 원자적 쓰기(`atomicWrite`). 매니페스트 갱신이 커밋 지점이고 실패 시 새 시트를 지운다(7-5). 앱이 만든 이름 형식의 미참조 시트만 정리한다 |
| S7 | 용량 폭주 | 쓰기 전에 병합 결과의 시트 합계(교체되는 것은 빼고)를 64 MiB 와 비교하고, 상태 수 32 를 넘으면 거부한다. 같은 상태 반복 교체의 고아는 S6 정리로 쌓이지 않는다 |
| S8 | 설정·팩 JSON 입력 | 새 필드(`behavior`, `play`, `sequence`, `sequences.json` 의 `steps`)는 기존 `validatePackJsonLimits`(깊이 8·키 256·금지 키)와 파서·`settings.ts` 의 `parseSettings` 패턴으로 main 에서 다시 검증한다. 검증을 통과한 값만 새 객체로 복사해 쓴다 |
| S9 | 설정 창 표시 | 미리보기를 표시하려면 설정 창 CSP 에 `img-src data:` 가 필요하다(ADR-0007 T10). `default-src 'none'; script-src 'self'` 는 유지한다. 팩 문자열(상태 이름, 대사, 시퀀스 `label`)은 `textContent` 로만 넣는다 |

기준 10 의 확인 항목은 위 S1–S9 와 "사용자가 고른 파일 외에는 읽지 않는다"(S1·S2)다. 이 경로는 머지 전 coordinator 직접 검증 + 쓰기 경로 리뷰 대상이다(milestones.md M7 게이트).

## 9. 사용자에게 묻는 질문과 결정

사용자가 하나씩 답했다(D-047, `docs/progress/decisions.md`, 2026-10-09). 번호는 묻는 순서다. "결정" 열이 확정이고, 근거 없는 후보 수치는 "써 보고 조정"으로 남는다. Q5·Q6 은 초안이 제시한 방향과 다르게 정해졌다.

| # | 질문 | 선택지 | 결정 (D-047) |
|---|---|---|---|
| Q1 | 행동 수치(잠들기·깜빡임·걷기 주기·걷는 시간·속도)를 사용자가 바꾼 값은 어디에 저장할까 (4-2) | (a) 내 팩 안(`manifest.behavior`): 내장 팩은 첫 저장 때 "(내 버전)" 파생 팩이 생김 (b) `settings.json` 의 캐릭터별 항목(`characterBehavior`, 팩 기본값 위에 덮어씀) (c) `settings.json` 의 모든 캐릭터 공통 값 | **(b)** `settings.json` 캐릭터별. 4-2 |
| Q2 | 순서 있는 동작에 "걷기 이동"을 넣을까 (6-6) | (a) 넣지 않음: 단계는 제자리 동작만, `walk`·`drag` 단계는 거부 (b) 단계에 이동을 넣음 (c) `walk` 상태를 단계로 허용하되 이동 방향은 무작위 | **(a)** 이동 없음. 6-1, 6-6 |
| Q3 | 순서 있는 동작이 진행 중일 때 알림이 오면 | (a) 알림이 즉시 시퀀스를 끊고 알림을 보임(보류되는 알림은 끊지 않음) (b) `urgent`/`high` 알림만 끊고 나머지는 시퀀스 뒤에 보임 (c) 시퀀스가 끝날 때까지 알림을 늦춤 | **(a)** 즉시 끊고 알림. 6-6 |
| Q4 | 순서 있는 동작의 상한은 | (a) 단계 8개, 단계당 300–10_000 ms, 총 30_000 ms (b) 단계 16개, 총 60_000 ms (c) 단계 4개, 총 15_000 ms | **(a)** 8단계·단계당 300–10000 ms·총 30000 ms(후보, 써 보고 조정). 6-4 |
| Q5 | 순서 있는 동작을 어디에 정의할까 | (a) `interactions.json` 의 항목 안(`steps`) (b) 별도 `sequences`(id 로 정의하고 상호작용·반응 규칙이 id 로 참조) | **(b)** 별도 `sequences` (초안이 제시한 방향과 다른 결정). 파일은 `sequences.json`, 참조는 상호작용 항목의 `sequence`. 6장 |
| Q6 | 파생 팩("(내 버전)")에서 시트를 교체하거나 새 상태를 더하게 할까 | (a) 허용: 바꾼 시트와 새 상태만 파생 팩에 저장 (b) 허용하지 않음: ADR-0007 Q4·Q6 유지 (c) 전체 복사 팩 도입(ADR-0007 Q4 번복) | **(b)** 허용하지 않음 (초안이 제시한 방향과 다른 결정). 시트 교체·새 상태 추가는 개발자 모드에서만(M7 기준 9 변경). 7장 |
| Q7 | 발 위치 검사(`sprites:check` 규칙)에서 이상이 나온 시트를 어떻게 다룰까 | (a) 결과를 보여 주고 "그래도 사용"을 고르면 저장(치수·한도 위반만 거부) (b) 이상이면 저장을 막음 (c) 저장하고 배지로만 표시 | **(a)** 보여 주고 "그래도 사용". 7-6 |
| Q8 | 개발자가 고르는 PNG 의 크기 한도는 | (a) 현행 그대로: 시트당 8 MiB·16,777,216 픽셀, 팩 합계 64 MiB (b) 고르는 파일은 더 낮게 (c) (a)에 시트 수 상한 추가 | **(a)** 현행 한도. 7-4 |

### 남은 질문 (결정됨, D-047 보충)

답을 받은 뒤 새로 생긴 결정 사항이다. 두 개 모두 사용자가 (a)를 골랐다(2026-10-09).

1. **개발자 모드에서 시트를 교체한 뒤 이전 시트 파일을 어떻게 할까(7-5)?** (a) 앱이 만든 이름(`<상태>-<8hex>.png`)만 정리하고 원래 시트(`sheets/<상태>.png`)는 남겨 git 으로 정리 (b) 항상 같은 경로(`sheets/<상태>.png`)를 덮어써 고아를 만들지 않음. **결정: (a).** 이유: 매니페스트와 PNG 두 파일의 원자적 순서(새 이름 → 매니페스트 → 정리)를 지킬 수 있다. (b)는 git diff 가 깔끔하지만 PNG 와 `frames` 가 잠깐 어긋날 수 있다.
2. **상호작용이 없는 시퀀스 id 를 참조할 때의 처리(6-3)?** (a) `sequence` 를 무시하고 항목은 `play`/`mood`/`lines` 규칙으로 동작, 경고 표시 (b) 항목을 우클릭 메뉴에서 숨김. **결정: (a).**

## 10. 잠정 채택 (질문하지 않은 설계)

사용자가 승인할 때 함께 확인한다. 바꾸고 싶은 항목이 있으면 그 항목만 질문으로 올린다.

| 항목 | 채택 내용 | 기준 |
|---|---|---|
| `behavior` 필드 이름·단위·범위 | 4-1 표(밀리초, 범위는 후보) | 6 |
| 해석 순서 | 코드 기본값 < 팩 `behavior` < 사용자 덮어쓰기(`settings.json` 캐릭터별, Q1) (파생 팩은 키 단위로 병합) | 6 |
| 즉시 반영 | `CharacterAnimationMachine.configure` 로 타이머 재설정, 새 IPC 채널은 허용 목록에 등록 | 6 |
| 상호작용 `play` | 선택 필드, 없으면 `mood` 규칙, 팩에 없는 상태는 `fallbacks`, 마지막은 `idle`. `PetEvent` 불변(내부 심볼 키) | 7 |
| 시퀀스 파일 | 별도 파일 `sequences.json` + 매니페스트 경로 필드 `sequences`(`interactions` 와 같은 방식), 파생 팩은 파일 통째로 대체 | 8 |
| 시퀀스 id·참조 | id 패턴 `^[a-z0-9][a-z0-9-]{0,47}$`, 상호작용 항목 필드 `sequence`, 없는 id 는 무시하고 경고(남은 질문 2) | 8 |
| 시퀀스 단계 필드 | `play`·`ms`·`say`, `say` 는 어투 비적용, `bubble:false` 면 무시 | 8 |
| 시퀀스 저장 | `saveSequences` 가 `saveInteractions` 와 같은 흐름(D-042), 쓰기는 `pack-store` 단일 함수, 새 IPC 채널은 허용 목록에 등록 | 8 |
| 중단 규칙(알림·걷기 외) | 드래그·다른 상호작용·펫 숨김·팩 전환은 중단, 방해 금지는 시작·실행 모두 영향 없음, 끝나면 `idle` | 8 |
| 전제 | 기준 4(간격 대기 중 상호작용 버려짐)가 먼저 끝난다 | 8 |
| 반응 규칙 참조 | 이번 범위 밖, 형식은 막지 않음 | 8 |
| 상태 이름 규칙 | 앱이 만드는 이름만 `^[a-z][a-z0-9-]{0,31}$`(후보), 기존 팩은 소급 안 함 | 9 |
| 시트 파일 이름 | 앱이 `sheets/<상태>-<난수>.png` 로 계산, 사용자 파일 이름 불사용 | 9·10 |
| 쓰기 순서 | 새 PNG → 매니페스트(커밋) → 옛 시트 정리, `pack-store` 단일 함수군(`writeBuiltinPackFile` + 후보 `removeBuiltinPackFile`) | 9·10 |
| 개발자 모드 한정 | 시트 교체·새 상태 추가·파일 선택은 `!app.isPackaged && developerMode` 일 때만, main 에서도 거부 | 9·10 |
| 파일 선택 | main 의 열기 대화상자만, 렌더러는 경로 불송신, 일회용 토큰 | 10 |
| 발 위치 검사 공유 | 검사 규칙을 `packages/core` 순수 함수로 옮겨 CLI 와 앱이 공유 | 9 |
| `cellSize`·`anchor` | 변경 불가(원본 고정) | 9 |

## 11. 위험

| 위험 | 완화 |
|---|---|
| 새 필드가 왕복 중 사라짐: `parseInteractions`/`fromPackInteractions`/`toPackInteractions`/`checkInteraction`/편집기가 모르는 필드를 버리는 구조(M6 구현) | 필드 왕복 단위 테스트(저장→로드→저장, `play`·`sequence`), `mergeCharacterManifest` 의 병합 목록에 `behavior`·`sequences` 추가 확인 |
| 상호작용과 시퀀스 파일이 서로 다른 팩에서 와서 `sequence` 참조가 끊김(파생 팩이 한쪽만 고침) | 로드 때 합친 목록으로 검사하고 `problems` 에 남김, 끊기면 항목 폴백(6-3), 편집기 경고·시퀀스 삭제 때 참조 항목 안내, 파생 팩 로드 테스트(상호작용만 고친 경우) |
| 시퀀스 첫 저장 때 파생 팩에 원본 시퀀스가 복사되지 않아 사라진 것처럼 보임 | 편집기가 합친 목록을 불러와 전체를 저장(6-5), 이전 실패 시 팩이 남지 않게 하는 M7 기준 5 의 처리 재사용 |
| 시트 교체 중 중단으로 내장 팩이 깨짐(`frames` 와 PNG 폭 불일치) | 새 이름 쓰기 → 매니페스트 원자적 갱신 순서(7-5), 시작 때 정리, 저장소 파일이라 git 으로 복구 |
| 내장 팩 시트 교체가 파생 팩과 저장소 파일에 번짐(7-3) | 개발자 모드 전용, 적용 전 어떤 파일이 바뀌는지 보여 줌, git 으로 되돌림 |
| 개발자 모드 켜짐 상태가 설치본에서 노출됨 | UI 숨김과 별개로 main 에서 `app.isPackaged`·`developerMode` 를 검사(S5), 테스트로 `isPackaged: true` 거부 확인(`pack-service.test.ts` 패턴) |
| 시퀀스가 알림·말풍선 간격과 충돌해 말풍선이 사라지거나 중복 | 기준 4 선행, 시퀀스 점유 상태(6-5), 중단 규칙 표와 e2e(시계 고정 규칙은 `AGENTS.md`) |
| 발 위치 검사가 큰 시트에서 main 을 막음 | 비동기·프레임 단위 양보, 검사 픽셀 상한(7-6) |
| 수치 범위·상한이 근거 없는 후보 | 사용자가 화면에서 직접 느껴 보고 조정(H 기준), 상수는 한 곳에 모음 |
| 개발자가 고른 PNG 의 OS 디코더 취약점 | 입력 크기·IHDR 사전 검사, 디코드 실패 시 거부, 개발자 모드 한정. 별도 프로세스 디코드는 범위 밖(ADR-0007 T3 과 같은 잔여 위험) |

## 12. 보충: 알림 종류 → 행동 매핑 [기준 12·13]

**상태: 승인 (2026-10-09, 사용자, D-049). 잠정 항목도 함께 확정.** D-048 로 M7 에 추가된 기준 12 의 본이다. 6-5 에서 비목표로 둔 "반응에서의 시퀀스 참조"를 **팩 수준 매핑**으로 연다. 플러그인 SDK(`packages/plugin-sdk/src/v1/`), `PetEvent`, `ReactionRule` 은 바꾸지 않는다.

### 12-1. 무엇을 매핑하나

알림 종류는 이미 있는 어투 종류(`PetEvent.voice.kind`, `packages/core/src/contracts.ts`) 7가지다: `done`(완료)·`waiting`(대기)·`failed`(실패)·`info`(정보)·`deadline`(마감)·`reminder`(일정)·`alert`(경고). 종류마다 `play`(상태 이름) 또는 `sequence`(시퀀스 id) 중 하나를 고른다. 둘 다 없으면 그 종류는 지금 동작 그대로다. `voice.kind` 가 없는 알림(일반 `/event`, 우클릭 상호작용)은 이 매핑의 대상이 아니다.

### 12-2. 파일과 형식: `reactions.json` (결정: 팩의 새 파일)

팩 폴더의 별도 파일 `reactions.json`, 매니페스트에는 경로 문자열 선택 필드 `reactions`(값 `"reactions.json"`)만 더한다(`interactions`·`sequences` 와 같은 방식, `apiVersion` "1" 유지).

```json
{ "version": 1,
  "kinds": {
    "done":   { "sequence": "greet" },
    "failed": { "play": "worried" }
  } }
```

- `kinds` 의 키는 위 7가지만 허용하고 모르는 키는 버린다(`problems` 에 남김). 값은 `{ play }` 또는 `{ sequence }` 하나만. 둘 다 있으면 `sequence` 를 쓰고 경고한다.
- `play` 는 5장과 같은 이름 형식·`fallbacks` 해석(없으면 `idle`), `sequence` 는 6-1 의 id 패턴. 없는 시퀀스 id 는 6-3 과 같이 무시하고(그 종류는 매핑 없음으로 동작) `problems` 에 남기며 편집기가 경고한다.
- 파생 팩(`extends`)은 자기 `reactions` 가 있으면 원본 것을 통째로 대체, 없으면 원본 것을 읽는다(6-2 와 같은 규칙, `pack.ts` 병합 목록에 `reactions` 추가).
- 크기·깊이 한도는 `validatePackJsonLimits` 그대로. 파서는 `packages/core` 의 순수 함수(`parseReactions`, 후보 이름).

### 12-3. 실행 규칙

- **우선순위 (결정: 팩 매핑 우선).** 팩 `reactions` 의 해당 종류 > 플러그인 반응 규칙(`selectReaction` 의 `ReactionRule`) > 표정(`mood`) 규칙. 매핑이 없는 종류는 지금과 똑같다.
- **언제.** 알림이 실제로 표시될 때(`playReaction` 이 불릴 때)만 재생한다. 방해 금지·전체 화면으로 보류된 알림, 요약으로 합쳐진 알림은 재생하지 않는다. 말풍선 없이 표정만 바꾸는 이벤트(`react`, `low` 보류분)도 `voice.kind` 가 있으면 `play` 매핑은 적용하고 `sequence` 매핑은 적용하지 않는다(말풍선 없는 긴 연기를 피한다, 잠정).
- **`play` 매핑.** 5장의 상호작용 `play` 와 같다: 그 상태를 한 주기 재생하고 `idle`.
- **`sequence` 매핑 (결정: 알림 문구만).** 말풍선에는 알림 문구만 보이고 시퀀스는 그림만 재생한다. 단계의 `say` 는 모두 무시한다. 단계 길이·상한(8단계·30초)·`walk`/`drag` 처리는 6장 그대로다.
- **중단.** 6-6 표를 그대로 쓴다. 알림이 시작한 시퀀스도 다음에 표시되는 알림, 사용자의 상호작용, 드래그, 펫 숨김·팩 전환에 끊긴다. 새 알림에 매핑이 있으면 그것이 바로 시작한다. 알림 말풍선은 시퀀스가 끊겨도 닫지 않는다(알림이 우선).
- **외부 지정 불가.** 재생할 동작은 main 이 현재 팩의 `reactions` 에서 찾는다. HTTP `/event`·CLI·플러그인은 `voice.kind` 만 보낼 수 있고 동작을 직접 지정할 수 없다(5장과 같은 이유).

### 12-4. 편집·저장

[캐릭터] 탭에 하위 탭 [알림 반응](후보 이름): 종류 7가지를 한 줄씩(한글 이름·쓰이는 상황은 어투 편집기와 같은 문구), 각 줄에 "재생 동작"(없음 / 상태) 과 "동작(시퀀스)"(없음 / 시퀀스) 선택, 없는 id·`idle` 로 떨어지는 이름 경고, [▶ 펫에게 보내기](그 종류의 샘플 알림을 보내 실제 반응을 본다, 어투 편집기의 보내기와 같은 통로). 저장은 `createPackService` 에 `saveReactions`(후보)를 `saveSequences` 와 같은 흐름으로 더한다(`ensureEditable` → 안전 JSON → `parseReactions` → `writeFile` → `updateManifest`, 쓰기는 `pack-store` 만, D-042·D-044). 새 IPC 채널(후보 `settings:reactions-load`·`settings:reactions-save`)은 허용 목록 갱신 대상이다.

**수정 대상(구현 task 용).** `packages/core`: 새 `reactions.ts`, `contracts.ts`·`schemas.ts`·`validate.ts`(매니페스트 `reactions` 경로), `pack.ts`. `apps/desktop/src/main`: `character.ts`(로드·루트), `pack-service.ts`(`saveReactions`), `index.ts` 의 `playReaction`(우선순위·`say` 없는 시퀀스 실행), 설정 IPC. 렌더러: 새 패널, `character-panel.ts`.

## 13. M7 구현에서 확정·변경된 점 (2026-10-09 종료 점검)

구현은 M7 에서 끝났다(완료 기준 14/14, `docs/progress/milestones.md`). 이 문서와 달라졌거나 "후보"가 확정된 점만 적는다.

- **확정된 이름.** `behavior` 범위 상수 `BEHAVIOR_RANGES`·`resolveBehavior`(`packages/core/src/behavior.ts`), `CharacterAnimationMachine.configure`, 설정 필드 `characterBehavior`, `SequencePlayer`(`sequence-player.ts`), `parseSequences`·`parseReactions`, 내부 심볼 `INTERACTION_PLAY`(`pet-menu.ts`), `saveSequences`·`saveReactions`(`pack-service.ts`), `selectPackReaction`(`character.ts`), `removeBuiltinPackFile`(`pack-store.ts`), 발 위치 검사 `inspectSpriteFootFrame`(`packages/core/src/sprite-foot-check.ts`, CLI 와 앱이 공유). IPC 채널: `settings:behavior-load/save`, `settings:sequences-load/save`, `settings:reactions-load/save`, `settings:sheet-pick`·`settings:sheet-apply`.
- **수치 후보는 그대로 구현했다.** `behavior` 범위(4-1), 시퀀스 8단계·단계 300–10000ms·총 30초·32개(6-4), 상태 이름 패턴(7-3), 시트 토큰 60초, 발 위치 검사 픽셀 상한 4,194,304. 사용자가 써 보고 조정을 요청하지 않았다.
- **설계에 없던 읽기 API.** `settings:state-preview`(팩 id + 상태 이름 → 시트 data URL·frames·fps·loop·cellSize)를 더했다(M7 기준 14). 기존 로더(`loadCharacter`)의 경로 검사·크기 한도를 그대로 거치고, 상태 하나씩만 돌려주며 경로는 내보내지 않는다. 내장·사용자·파생 팩 모두 읽을 수 있다(읽기 전용).
- **미리보기.** 7-6 은 새로 고른 시트의 정지 미리보기만 적었으나, 구현은 기존 상태와 새 시트를 애니메이션으로 보여 준다. 6-5 의 "단계별 펫에게 보내기"에 더해 [동작] 탭에서 저장 전 시퀀스 전체를 설정 창 안에서 미리 재생한다(실제 펫은 움직이지 않음).
- **탭 이름.** 개발자 모드 시트 탭은 [그림] → [애니메이션](사용자 결정 2026-10-09). 다른 하위 탭은 [행동]·[동작]·[알림 반응].
- **검증 방식.** 6-6 중단 규칙은 단위 테스트 대신 `sequences.e2e` 가 표의 행을 사용자가 보는 결과로 단언한다.
- **기준 10 리뷰 결과.** 8장 S1–S7 에서 고쳐야 할 것 0. 개선 6건(개발자 모드 재켜기 뒤 토큰 생존, pick~apply 사이 외부 `cellSize` 변경, 동시 apply 직렬화, 고아 시트 정리, lstat 기반 경로 확인, 테스트 답 가드)과 다중 IHDR·APNG 실제 디코드 실험은 백로그다.
- **Codex 플러그인.** 이 ADR 범위 밖이지만 같은 마일스톤에서 `plugins/codex` 가 `claude-code` 에서 나뉘었다(D-048, 출처 `codex`). 알림 종류 매핑(12장)은 출처와 무관하게 `voice.kind` 로만 고른다.
- **다중 IHDR·APNG (M8 기준 4 실측, 2026-10-09).** 다중 IHDR PNG 는 nativeImage 디코드 단계에서 거부되고(크래시·한도 초과 없음), APNG 는 IHDR 크기의 기본 이미지로만 검사·수락하며 이후 프레임은 측정하지 않는다. 추가 사전 검사는 두지 않는다.
- **남은 것.** 알림·상호작용에 붙인 상태는 한 주기만 재생되어 말풍선이 떠 있는 동안 표정이 유지되지 않는다. "말풍선 동안 유지"는 다음 마일스톤 첫 항목이다(사용자 결정 2026-10-09, 백로그).

## 변경 이력

- 2026-10-09 초안 작성 (제안, 미승인). 질문 8개.
- 2026-10-09 사용자 답 반영(D-047): Q1 `settings.json` 캐릭터별, Q2 이동 없음, Q3 즉시 끊고 알림, Q4 8단계·총 30초, Q5 별도 `sequences.json`(6장 다시 씀), Q6 파생 팩 덮어쓰기 안 함·시트 교체/새 상태는 개발자 모드 한정(7·8장 다시 씀, M7 기준 9 변경), Q7 "그래도 사용", Q8 현행 한도. 상태를 "승인 대기"로 바꾸고 남은 질문 2개를 적음.
- 2026-10-09 남은 질문 2개 (a) 결정, 사용자 승인.
- 2026-10-09 12장 보충(알림 종류 → 행동 매핑): 팩의 reactions.json, 알림 문구만, 팩 매핑 우선. 사용자 승인(D-049).
- 2026-10-09 13장 추가(M7 종료 점검: 구현에서 확정·변경된 점). 사용자 승인.
