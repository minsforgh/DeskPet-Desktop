# ADR 0001: PetEvent와 ReactionRule 규약

## 상태

승인 (2026-10-06)

## 배경

`docs/plan.md` 6-1, 6-2는 플러그인과 코어가 주고받는 이벤트 및 반응 규칙의 공통 형식을 정의한다. 구현에 앞서 타입과 JSON Schema를 고정하고, 검증기의 기대 동작을 계약 테스트로 남긴다.

## 결정

`PetEvent`의 필드는 다음과 같다. 필수 여부와 열거 값은 기획안 6-1을 따른다.

| 필드 | 형식 | 필수 | 제약과 의미 |
|---|---|---|---|
| `source` | `string` | 예 | 플러그인 ID 또는 `http` |
| `type` | `notify \| react \| status` | 예 | 알림, 동작, 지속 상태 |
| `key` | `string` | 아니요 | 같은 `source` 안에서 동일 키 병합; 서로 다른 출처의 같은 키는 별개 |
| `text` | `string` | 아니요 | 말풍선 문구, 유니코드 코드 포인트 최대 120개 |
| `detail` | `string` | 아니요 | 펼쳐 보기 내용 |
| `mood` | `happy \| surprised \| sleepy \| worried \| neutral` | 아니요 | 표정 |
| `priority` | `low \| normal \| high \| urgent` | 아니요 | 우선순위 |
| `actions` | `{ label: string; action: string; args?: unknown }[]` | 아니요 | 최대 3개; `label`, `action` 필수 |
| `ttlMs` | 1 이상 `Number.MAX_SAFE_INTEGER` 이하의 정수 | 아니요 | 코어 수신 시각 기준 밀리초 |
| `timestamp` | `Number.MIN_SAFE_INTEGER` 이상 `Number.MAX_SAFE_INTEGER` 이하의 정수 | 아니요 | epoch 밀리초; 생략하면 코어가 수신 시각을 넣음 |

`ReactionRule`의 필드는 다음과 같다. `match` 안의 모든 조건은 선택 사항이다.

| 필드 | 형식 | 필수 | 제약과 의미 |
|---|---|---|---|
| `match` | 객체 | 예 | 일치 조건 |
| `match.source` | `string` | 아니요 | 이벤트 출처 |
| `match.type` | `PetEvent["type"]` | 아니요 | 이벤트 종류 |
| `match.mood` | `PetEvent["mood"]` | 아니요 | 표정 |
| `match.priority` | `PetEvent["priority"]` | 아니요 | 우선순위 |
| `play` | `string` | 예 | 재생할 캐릭터 상태 이름 |
| `durationMs` | 정수 | 아니요 | 재생 시간, 1–60000ms |
| `repeat` | 정수 | 아니요 | 반복 횟수, 1–10회 |
| `sound` | `string` | 아니요 | 캐릭터 팩 기준 상대 경로 |

스키마는 JSON Schema draft 2020-12의 TypeScript 상수로 내보낸다. 검증 함수는 유효한 입력을 그대로 반환하고 잘못된 필드를 오류 문자열로 알린다.
모르는 필드는 허용하며 검증기는 무시한다.
TypeScript 타입은 입력의 모양만 표현하고 길이·개수·정수·형식 제한은 스키마와 검증기가 책임진다.

## 버전 정책

기획안 5-5에 따라 기존 필드를 변경하거나 제거하면 API 버전을 올리고, 필드를 추가할 때는 유지한다. 코어는 현재 버전과 직전 버전을 함께 지원한다. 규약 변경은 `docs/adr/`에 기록한다. 이 규약 자체에는 `apiVersion` 필드가 없다.

## 계약 테스트 위치

`packages/core/src/contracts.contract.test.ts`에서 유효한 입력과 잘못된 입력의 검증 결과를 확인한다. `pnpm test:contract`로 따로 실행하며 검증기 구현 전에는 `not implemented`로 실패한다. 스키마 구조는 `packages/core/src/schemas.test.ts`에서 확인한다.

## 기획안과 다르게 정한 부분

`ttlMs`의 기준 시각과 `timestamp`의 기본값을 확정했다.

## M3에서 확정

- `text`의 120자는 `Array.from(text).length`로 센 유니코드 코드 포인트 수다.
- `ReactionRule.durationMs`는 1 이상 60000 이하의 정수, `repeat`는 1 이상 10 이하의 정수다.
- `sound`는 캐릭터 팩 폴더 기준 상대 경로이며 캐릭터 매니페스트 `sheet`와 같은 경로 규칙을 적용한다. M3에서는 소리를 재생하지 않는다.
- 같은 `key`는 같은 출처 안에서만 병합한다. `source`가 플러그인 ID 또는 HTTP 호출자의 출처이므로 서로 다른 생산자의 동일 키는 독립적인 알림이다. 서로 다른 키 세 개가 30초 안에 온 경우에는 키 유무와 관계없이 같은 출처로 묶는다.
- `ttlMs`와 `timestamp`는 JavaScript의 안전 정수 범위만 허용한다. 스키마와 런타임 검증기가 같은 양끝 경계를 사용한다.

## D-032 선택 필드 voice 추가(2026-10-08)

`PetEvent`에 선택 필드 `voice?: { kind: "done" | "waiting" | "failed" | "info" | "deadline" | "reminder" | "alert"; slots?: { task?: string; result?: string; folder?: string; message?: string } }`를 추가한다. 앱은 현재 캐릭터 팩의 어투 템플릿으로 문구를 만들고, 해당 템플릿이 없으면 기존 `text`를 사용한다. `voice`가 없던 이벤트와 `text`의 기존 필수 여부 및 검증 규칙은 그대로 유지한다.

`voice`는 객체이며 `kind`는 필수다. `slots`는 지정할 경우 객체이고 나열한 네 키만 허용한다. 각 값은 문자열이며 유니코드 코드 포인트 500개 이하이고 제어 문자를 포함할 수 없다. 필드 추가는 하위 호환이므로 `apiVersion`은 유지하며 기존 클라이언트의 요청 형식과 응답에 영향이 없다.

### D-033 어투 종류 확장(2026-10-08)

`voice.kind`에 `deadline`(마감 임박)·`reminder`(일정)·`alert`(로그인·오류 같은 상태 경고)를 추가해 `done|waiting|failed|info|deadline|reminder|alert` 7종으로 한다. 슬롯 이름은 그대로이며 새 종류는 주로 `message`를 쓴다. 허용 값만 늘어나는 하위 호환 변경이므로 `apiVersion`은 유지하고, 기존 4종의 동작과 알 수 없는 종류의 거부는 그대로다.
