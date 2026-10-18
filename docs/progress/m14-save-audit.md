# M14 기준 10 — 사용자 편집 JSON 저장 경로 점검표

점검일 2026-10-17. 범위: `apps/desktop/src/main`, `packages/*/src`, `plugins/*/src` 에서 파일을 쓰는 모든 곳(`writeFile`/`writeFileSync`/`rename`/`appendFile`).
규칙(AGENTS.md "코드 규칙"): 사용자가 고치는 JSON 은 읽고 고쳐 쓰기로 바꾼 키만 교체하고 모르는 키를 보존하며, 보존 단위 테스트를 둔다.

## 사용자 편집 JSON

| 파일·함수 | 무엇을 쓰는지 | 읽고 고쳐 쓰나 | 모르는 키 보존 단위 테스트 | 판정 |
|---|---|---|---|---|
| `settings.ts` `writeSettings` (index.ts 의 모든 저장 호출이 이것을 거침) | `settings.json` 전체 | 예 (수정 후). 수정 전: 아니오 — `parseSettings` 가 아는 키만 남겨 모르는 최상위 키와 `display`·`terrain`·`migrations` 안의 모르는 키가 저장 때 사라졌다 | 있음 (`settings.test.ts` "a save keeps top-level and nested keys…", "unreadable file") | 위반 → 수정 |
| `pack-service.ts` `saveVoice` → `voice.json` | 어투 `templates` | 예 (기존 파일을 읽어 `templates`·`version` 만 교체) | 있음 (`pack-service.test.ts` "keeps lines and other voice fields…", M13 fix3) | 통과 |
| `pack-service.ts` `saveInteractions` → `interactions.json` | 상호작용 `items`·`hidden` | 예 (수정 후). 수정 전: 아니오 — 편집기가 보낸 문서로 파일을 통째로 교체해 모르는 최상위 키·항목 키가 사라졌다 | 있음 ("keeps keys the editors do not know…") | 위반 → 수정 |
| `pack-service.ts` `saveSequences` → `sequences.json` | 동작 순서 `sequences` | 예 (수정 후, 같은 사유) | 있음 (같은 테스트) | 위반 → 수정 |
| `pack-service.ts` `saveReactions` → `reactions.json` | `kinds`·`lines` | 예 (수정 후, 같은 사유) | 있음 (같은 테스트) | 위반 → 수정 |
| `pack-service.ts` `saveMotions` → `motions.json` | `motions`·`landing`·`afterLand` | 예 (수정 후, 같은 사유) | 있음 (같은 테스트) | 위반 → 수정 |
| `pack-service.ts` `updateManifest` / `saveMeta` → `manifest.json` | 매니페스트의 바꾼 키(`voice`·`interactions`·…, `name`·`meta`) | 예 (`{ ...기존, ...patch }`) | 있음 (`pack-service.test.ts` "keeps manifest keys the editors do not know…", 이번에 추가) | 통과 |
| `pack-service.ts` 상태 시트 추가(builtin 쓰기, `writeBuiltinPackFile(…"manifest.json")`) | `manifest.json` 의 `states` | 예 (`{ ...manifest, states: {…} }`) | 있음 (`pack-service.test.ts` "keeps manifest keys the editors do not know when adding a state") | 통과 |
| `pack-service.ts` 팩 파생(`stagePack`) | 새 사용자 팩의 `manifest.json` (새 파일, `extends` 만 가짐) | 해당 없음 — 기존 사용자 데이터를 덮어쓰지 않는 새 파일 | — | 통과 |

수정 전 항목별 요약: 위반 5건(settings, interactions, sequences, reactions, motions) → 수정 후 위반 0.
시퀀스 `steps` 의 모르는 키는 위치로 짝지어 보존한다. `voice.json` 읽기 경로(`readPackJson`)는 기존 `saveVoice` 의 읽기 코드를 일반화한 것이며 `extends` 로 기반 팩의 파일을 따라간다.

## 대상 아님 (앱이 스스로만 쓰고 사용자가 고치지 않는 상태 파일)

| 파일·함수 | 대상 아님 이유 |
|---|---|
| `index.ts` 위치 기억 (`pet-position.json`, 2곳) | 앱이 드래그 결과만 기록하는 캐시. 사용자 편집 대상이 아님 |
| `log-file.ts` (`appendFileSync`, 순환 `renameSync`) | 로그. 추가 전용 |
| `event-server.ts` 토큰·포트 파일 | 실행마다 앱이 새로 쓰는 접속 정보(0o600) |
| `orca-service.ts` 원장(ledger) | 플러그인이 처리한 키·게이트 기록. 앱이 읽고 쓰는 내부 상태이며, 쓸 때 다른 플러그인 항목은 읽어서 보존함 |
| `plugin-host/src/grants.ts` 권한 승인 파일 | 사용자 승인 UI 만 쓰는 보안 상태. 손으로 고치는 파일이 아니며 형식이 틀리면 비워 처리 |
| `plugin-host/src/secrets-store.ts` 비밀 저장소 | 암호화된 값. 앱만 읽고 씀 |
| `index.ts` 화면 캡처 PNG | 이미지 출력물 |
| `pack-store.ts` `writePackFile`·`writeBuiltinPackFile`·`stagePack` | 저장 호출자가 넘긴 내용을 원자적으로 쓰는 저수준 도구. 읽고 고쳐 쓰기는 위의 호출자 표에서 점검 |

## 옛 데이터 해석 확인

- 모르는 키 보존은 현재 파일이 없거나 읽을 수 없으면(없음·깨진 JSON·객체 아님) 아무것도 가져오지 않고 주어진 내용만 쓴다 (`settings.test.ts` "unreadable file"; 팩 쪽은 `keepUnknown` 이 읽기 실패를 `next` 그대로로 처리).
- 저장 형식(키 이름·순서 의미)은 바꾸지 않았다. 보존한 모르는 키는 아는 키 뒤에 붙는다. 빠진 필드(`hidden`·`lines`·`afterLand` 없음)는 그대로 빠진 채 저장된다.

## 남은 것

- 없음. 항목 단위(id)와 시퀀스 단계(위치) 모르는 키까지 보존한다. 배열 항목을 편집기가 지우고 같은 id 로 다시 만들면 모르는 키가 따라붙는 점은 의도다(id 가 같으면 같은 항목).
