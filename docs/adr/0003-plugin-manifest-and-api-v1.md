# ADR 0003: 플러그인 매니페스트와 API v1 규약

## 상태

승인 (2026-10-06)

## 배경

`docs/plan.md` 5-2와 5-3은 `plugin.json`과 플러그인 API v1의 표면을 정의한다. 플러그인과 호스트가 공유할 타입, JSON Schema, 검증 계약을 먼저 고정한다.

## 결정

`PluginManifest`의 `id`, `name`, `version`, `apiVersion`, `entry`, `description`, `permissions`, `contributes`는 모두 필수다. 현재 `apiVersion`은 정수 값을 담은 문자열 `"1"`이다. `permissions`는 `network`, `windows`, `openExternal` 문자열 배열과 `secrets`, `shell` 불리언을 선택적으로 선언한다. `contributes`는 `actions`, `trayItems`, `badges` 문자열 배열을 선택적으로 선언한다. `permissions` 객체 안의 모르는 키는 거부하고, 그 밖의 모든 객체에서 모르는 필드는 허용하며 검증기는 무시한다.

`permissions.network` 항목은 소문자 호스트 이름만 쓴다. scheme, port, 경로, 와일드카드는 허용하지 않는다. `permissions.openExternal` 항목은 `https://` 뒤에 `permissions.network`와 같은 라벨 문법의 소문자 호스트 이름과 `/`로 시작하는 경로를 쓰며, port, 사용자 정보, IP 리터럴, 호스트 와일드카드는 허용하지 않는다. 경로의 와일드카드는 맨 끝의 `/*` 하나만 허용한다. `permissions.windows`의 창 ID는 비어 있지 않은 소문자, 숫자, 하이픈 문자열이다. `actions`, `trayItems`, `badges`의 ID는 `<플러그인 id>.<이름>` 형식이며 플러그인 id 부분에는 소문자, 숫자, 하이픈만 쓴다. 이 형식은 스키마 패턴으로 검사하고, 접두부가 매니페스트의 `id`와 같은지는 검증기가 확인한다.

선언하지 않은 권한은 호스트가 막는다. 최초 활성화 전에는 사용자에게 선언된 권한 목록을 보여 준다. 매니페스트의 선언은 허가 요청이며, 실제 권한 검사는 플러그인 호스트가 수행한다. `contributes`는 플러그인을 실행하기 전 트레이와 설정 화면을 구성할 때 읽는다.

`PluginContext`와 `PluginDefinition`의 필드 이름과 시그니처는 기획안 5-3을 그대로 따른다. `PetEvent`, `ReactionRule`, `ValidationResult`는 `@deskpet/core`에서 가져온다. `definePlugin`은 정의를 그대로 반환한다. `validatePluginManifest`는 `ValidationResult<PluginManifest>`를 반환하도록 선언하되 현재 `not implemented` 오류를 던진다. 매니페스트 JSON Schema는 draft 2020-12 TypeScript 상수로 내보낸다.
TypeScript 타입은 입력의 모양만 표현하고 길이·개수·정수·형식 제한은 스키마와 검증기가 책임진다.

`registerAction`, `addTrayItem`, `setBadge`는 각각 `contributes.actions`, `contributes.trayItems`, `contributes.badges`에 선언된 ID만 받는다. 트레이 항목의 `action`도 선언된 액션 ID를 가리킨다.

`ctx.fetch`는 기본적으로 GET과 HEAD만 허용한다. 다른 메서드와 `ctx.exec`는 사용자가 말풍선 버튼 또는 트레이 메뉴로 호출한 액션 핸들러가 실행되는 동안에만 허용한다. `activate`, 스케줄 콜백, `onResume`, `onConfigChange` 등 그 밖의 호출은 호스트가 거부한다. 로컬 HTTP `/action/:id`로 실행된 액션은 설정의 허용 목록에 있는 액션만 사용자 실행으로 본다(기획안 6-4, 10장). 실제 차단은 M4 플러그인 호스트가 구현한다.

`CheckerWindowOptions`에는 `url`, `show`, `width`, `height`, `title`만 둔다. `windows.create`의 ID는 `permissions.windows`에 선언된 것만 허용한다. 창의 최초 URL과 이후 이동은 `permissions.network`에 선언된 호스트로만 허용하고, 그 밖의 이동과 새 창은 차단하거나 시스템 브라우저로 넘긴다. 호스트가 플러그인 ID별 세션 저장소를 배정하며 플러그인은 저장소를 고를 수 없다. 창은 Node 통합 없이 `contextIsolation`을 켜서 연다.

`CheckerWindowHandle.getJson(path)`는 창의 현재 출처로 로그인 쿠키를 포함한 GET 요청만 보내고 `{ status, body }`를 반환한다. `path`는 `/`로 시작하는 같은 출처 경로만 허용한다. 플러그인은 메서드·헤더·본문을 지정할 수 없다.

기획안 5-1의 향후 확장 지점인 패널, 음성, 대화의 API 이름 `panels`, `voice`, `conversation`을 예약한다. v1에는 이 이름의 필드나 동작을 구현하지 않는다.

## 버전 정책

기획안 5-5에 따라 기존 필드를 변경하거나 제거하면 API 버전을 올리고, 필드 추가만 하면 유지한다. 코어는 현재 버전과 직전 버전을 함께 지원한다. 규약 변경은 `docs/adr/`에 기록한다. 현 v1 스키마는 `"1"`만 받으며, 다음 버전이 생길 때 이전 버전 지원을 추가한다. **M10(2026-10-12):** `apiVersion "2"` 를 추가했다(`packages/plugin-sdk/src/v2/`, v1 폴더 불변). v2 는 `permissions.socketMode` 와 호스트 중개 `ctx.slack` 을 더하고 `secrets` 읽기를 뺀다. 호스트는 `"1"`·`"2"` 를 함께 지원한다. 상세는 ADR-0011 "v2 규약 상세". **M11·M12:** v2 에 필드만 더했다(버전 유지) — `ctx.orca`(ADR-0012) 와 `muteGate`, `contributes.lines`·`emit` 의 `line`(ADR-0013), `setBadge` 배지의 선택 `action`(선언된 액션만, 칩·목록 클릭이 트레이 항목과 같은 경로로 실행, ADR-0012 보강). v1 은 바꾸지 않았고 v1 플러그인이 이 필드를 쓰면 호스트가 거부한다.

## 계약 테스트 위치

`packages/plugin-sdk/src/manifest.contract.test.ts`에서 기획안 5-2의 jungle 매니페스트와 잘못된 버전, 필수 필드 누락, 권한 및 기여 형식 오류를 확인한다. `pnpm test:contract`에서 검증기가 구현되기 전에는 `not implemented`로 실패한다. `packages/plugin-sdk/src/plugin-sdk.test.ts`에서 기획안 5-3의 hello 플러그인 타입 검사와 스키마 구조를 확인한다.

## 기획안과 다르게 정하거나 확정한 부분

- `Disposable`: 등록한 액션·트레이·스케줄·반응 규칙을 정리할 `dispose(): void` 하나로 정의했다. 5-4의 비활성화 단계에 정리가 필요하다.
- `Logger`: `debug`, `info`, `warn`, `error`에 문자열 메시지만 받도록 정했다. 플러그인의 진단용 최소 표면이며, `jungle` 설계의 쿠키·응답 본문 로그 금지 원칙을 따른다.
- `ConfigSchema`: 설정 화면 자동 생성에 필요한 객체형 `properties`와 선택적 `required`를 정했다. 필드에는 기본 스칼라, 문자열 배열, 제목·설명·기본값·열거값·시크릿 표시만 둔다. 더 복잡한 폼 표현은 필요할 때 ADR로 추가한다.
- `CheckerWindowOptions`는 로그인 세션을 유지하는 창의 URL과 선택적 표시·크기·제목만 받도록 확정했다. 이동 허용 목록과 세션 저장소는 호스트가 관리한다.
- `CheckerWindowHandle`은 `show`, `hide`, 조회 전용 `getJson`, `dispose`를 제공하도록 확정했다.
- `permissions`와 `contributes` 객체는 필수지만 내부 필드는 선택적으로 정했다. 빈 객체는 권한·기여가 없다는 뜻이며, 선언하지 않은 권한은 허용되지 않는다.
- `apiVersion`은 정수 값을 담은 문자열 `"1"`로 확정했다.

## D-022 설정 스키마 확장 (2026-10-07)

설정 창이 객체 배열(`reminders` 의 `rules`)을 폼으로 편집하도록 `ConfigFieldSchema.items` 를 `{ type: "string" }` 에서 다음으로 넓혔다(사용자 승인, 필드 추가만이라 `apiVersion` 은 `"1"` 유지).

- `{ type: "string" }` 또는 `{ type: "object"; properties: Record<string, ObjectItemField>; required?: string[] }`.
- `ObjectItemField` 는 `type`(`string`·`number`·`boolean`)과 `title`·`description`·`default`·`enum` 만 가진다. 중첩 배열·객체는 허용하지 않는다(그래서 `reminders` 의 `days` 정수 배열은 선언하지 못하고 플러그인이 직접 검증한다).
- **후속 확장(M4-8, 2026-10-07, 같은 승인 범위):** `ObjectItemField` 의 `type` 에 `"array"` 를 더했다. `type: "array"` 이면 `items: { type: "string" } | { type: "number" }` 가 필수이고 평평한 배열만 허용한다(중첩 배열·객체 금지). 이때 `enum` 은 배열이 아니라 **원소**의 허용값이다. 필드 추가만이라 `apiVersion` 은 `"1"` 유지. 호스트는 원소마다 타입·`enum` 을 검사해 틀린 객체 원소를 버리고(ADR-0005 6장), 스키마가 이 형태를 벗어나면(배열인데 `items` 없음, `items` 가 불리언·배열·객체, 배열이 아닌데 `items` 가 있음) `configSchema` 를 무시한다. `reminders` 는 `days`(0~6 숫자 배열, `enum: [0..6]`)를 선언하고, 설정 창은 이를 요일 체크박스로 보여 준다.
- 호스트 검증은 ADR-0005 6장: 틀린 원소만 버리고 경고한다. 스키마 자체가 이 형태를 벗어나면 `configSchema` 를 무시한다.

## M3 임시 실행 (2026-10-07)

M3 에서는 격리된 플러그인 호스트(M4) 없이 번들된 `reminders` 플러그인을 앱 main 프로세스 안에서 직접 활성화한다(`apps/desktop/src/main/plugin-lite.ts`). 제공하는 PluginContext 는 `emit`, `schedule.at`(`"M H * * D"` 형태만), `config`, `onConfigChange`, `log` 이고 나머지 API 는 호출 시 "M4 까지 사용할 수 없음" 오류를 던진다. 권한 검사와 격리는 하지 않으며, M4 에서 이 실행기를 호스트로 대체한다(대체됨: ADR-0005, `plugin-lite.ts` 삭제). 규약(v1 타입)은 바꾸지 않았다.

## 미결 사항

- cron 문법과 기본 시간대는 M4 플러그인 호스트에서 정한다.
- `ConfigSchema` 필드 사이의 세부 관계와 `secret` 필드의 저장 방식은 M4 플러그인 호스트에서 정한다.
- 로그에서 민감 정보 마스킹을 누가 책임지는지는 M4 플러그인 호스트에서 정한다.
- `Disposable.dispose()` 중복 호출의 의미는 M4 플러그인 호스트에서 정한다.
- `entry` 등 플러그인 파일 경로의 허용 경계는 M4 플러그인 호스트에서 정한다.
