# ADR 0005: 플러그인 호스트

## 상태

승인 (2026-10-07, 사용자 승인. 사용자 결정 5건 반영)

## 배경

기획안 5-4는 플러그인을 `utilityProcess` 에서 실행하고 `PluginContext` 를 메시지 프록시로 만들라고 한다. ADR-0003 은 권한 검사 규칙을 정했지만 실제 차단은 M4 호스트에 맡겼고, 미결 사항 5개(cron·시간대, `secret` 저장, 로그 마스킹, `dispose` 중복 호출, `entry` 경로 경계)를 남겼다. M3 은 `reminders` 를 격리 없이 앱 안(`plugin-lite.ts`)에서 돌린다. 이 ADR 은 그 자리를 대신할 호스트의 구조, 메시지 규약, 검사 지점, 수명주기를 정한다. 구현은 `packages/plugin-host/`(기획안 11장)와 `apps/desktop/src/main` 연결부에 둔다.

한계를 먼저 밝힌다. `utilityProcess` 는 OS 샌드박스가 아니다. 플러그인 코드는 `node:fs`, `node:net` 을 직접 쓸 수 있고, 이 ADR 의 검사는 `PluginContext` 를 통하는 경로만 막는다. 1차는 내 플러그인만 쓰므로(기획안 15장) 이 수준을 받아들인다. 외부 플러그인을 허용하려면 OS 수준 격리를 다루는 별도 ADR 이 먼저 필요하다.

## 결정

### 1. 프로세스 구조: 플러그인마다 `utilityProcess` 하나

| 안 | 장점 | 단점 |
|---|---|---|
| **플러그인마다 하나(채택)** | 한 플러그인의 무한 루프·메모리 폭주·크래시가 다른 플러그인에 번지지 않는다. 메시지 채널이 곧 플러그인 신원이라 main 이 "누가 보냈는지"를 속일 수 없다. 프로세스 단위로 죽이고 되살릴 수 있다 | 프로세스 수만큼 메모리를 쓴다 |
| 모두 하나에 공유 | 메모리가 적다 | 한 플러그인이 막히면 전부 막힌다. 발신자를 메시지 안의 id 로 구분해야 해서 위조할 수 있다. 오류 3회·종료를 플러그인별로 처리할 수 없다 |
| 필요할 때만 띄움 | 대기 메모리가 적다 | 스케줄 시각에 맞춘 기동·실패 처리가 복잡하다. M4 에는 과하다 |

기본 플러그인은 많아야 6개(기획안 7장)라 프로세스당 Node 기본 메모리(수십 MB 추정, 측정 전)를 감수한다. 실측은 M4 기준 11이 한다. 대기 CPU 1% 목표는 구조로 지킨다. **타이머를 플러그인 프로세스가 아니라 main 의 스케줄러가 가진다.** 플러그인 프로세스는 메시지가 올 때만 깨어 있고 대기 중에는 이벤트 루프가 비어 있다. main 은 가장 가까운 시각 하나에 타이머 하나만 건다(plugin-lite 와 같은 방식). 기준 11 에서 1%를 넘으면 "필요할 때만 띄움"으로 바꾸는 것을 검토한다.

플러그인 프로세스는 호스트가 제공하는 `plugin-runner.js` 를 실행한다. 러너는 `entry` 를 `import()` 해서 `PluginDefinition` 을 받고, 아래 프록시 `PluginContext` 를 만들어 `activate` 를 호출한다. 환경 변수는 `PATH` 등 최소한만 넘기고 앱의 토큰·설정 경로는 넘기지 않는다. **플러그인 코드는 권한 허용 전에는 실행하지 않는다.** `configSchema` 를 읽기 위한 import 도 마찬가지다.

채널은 `PluginChannel` 인터페이스(`post`, `onMessage`, `onExit`, `kill`)로 감싼다. 실제 구현은 `utilityProcess`, 테스트용은 메모리 내 구현이어서 권한 검사를 Electron 없이 단위 테스트한다.

### 2. 메시지 규약과 검사 분담

전송은 `utilityProcess` 의 `postMessage`(구조화 복제)이고 모든 메시지는 아래 봉투다.

```ts
type Envelope =
  | { v: 1; kind: "req"; id: number; method: string; params: unknown; inv?: string }  // 양방향 요청
  | { v: 1; kind: "res"; id: number; ok: true; value: unknown }
  | { v: 1; kind: "res"; id: number; ok: false; error: { code: string; message: string } };
```

`id` 는 보낸 쪽이 정하는 증가 정수이고 응답은 같은 `id` 로 온다. `inv` 는 사용자 액션 맥락 표식이며 3장에서 설명한다. 오류 코드는 `E_PERMISSION`, `E_INVALID_ARGUMENT`, `E_NOT_SERIALIZABLE`, `E_TIMEOUT`, `E_RATE_LIMIT`, `E_UNAVAILABLE`, `E_DISPOSED` 다.

| 방향 | method | 비고 |
|---|---|---|
| 플러그인→main | `emit`, `registerAction`, `addTrayItem`, `setBadge`, `addReactionRule`, `schedule.every`, `schedule.at`, `schedule.onResume`, `secrets.get`, `secrets.set`, `openExternal`, `fetch`, `exec`, `windows.create`, `window.show`, `window.hide`, `window.getJson`, `log`, `dispose` | `hello`(설정 스키마 보고)도 이 방향 |
| main→플러그인 | `activate`, `deactivate`, `invoke`, `config.changed`, `shutdown` | `invoke` 가 콜백 실행 |

**콜백 등록.** 함수는 복제할 수 없으므로 러너가 함수를 자기 `Map<handle, fn>` 에 두고, 등록 요청에는 정수 `handle` 만 싣는다. main 은 `(pluginId, handle)` 로 등록을 기억하고, 실행할 때 `invoke {handle, args}` 를 보낸다. `handle` 은 플러그인이 정하는 값이므로 main 은 신뢰하지 않는다. 양의 정수만 받고 플러그인당 등록 256개를 넘으면 `E_RATE_LIMIT` 이다. `dispose` 는 `handle` 로 등록을 지운다. `Disposable` 이 아닌 `config`, `onConfigChange` 콜백도 같은 방식이다.

**타임아웃.** main 이 정한다. 요청 처리 상한은 `fetch`·`exec`·`window.getJson` 30초, 나머지 5초다. `invoke` 의 상한은 액션 핸들러·스케줄 콜백·`onResume`·`onConfigChange` 30초, `activate` 30초, `deactivate` 5초다. 러너의 프록시도 응답이 오지 않으면 35초에 `E_TIMEOUT` 으로 거부해 멈춘 Promise 가 남지 않게 한다. 콜백이 시간 초과면 3장의 오류 1회로 센다. 취소는 협조에 의존하므로 실행 중인 핸들러를 강제로 멈추지는 못한다. `activate` 가 시간을 넘기면 프로세스를 죽인다.

**직렬화 불가 값.** 러너 프록시가 보내기 전에 `structuredClone` 가능한지 확인하고, 실패하면 보내지 않고 `E_NOT_SERIALIZABLE` 로 거부한다(편의용이며 보안 경계가 아니다). 함수·심볼·클래스 인스턴스가 대표 사례다. `fetch` 는 별도 규칙이 있다. 프록시가 입력(문자열, `URL`, `Request`)을 `{url, method, headers: [이름, 값][], body}` 로 평평하게 만든다. `body` 는 문자열 또는 `Uint8Array` 만 허용하고, `ReadableStream`·`FormData`·`Blob` 은 `E_NOT_SERIALIZABLE` 이다. `AbortSignal` 은 프록시가 취소 요청(`fetch.abort`)으로 바꿔 보낸다. 응답은 main 이 본문을 모두 읽어 `{status, statusText, headers, body: ArrayBuffer}` 로 돌려주고(본문 10 MiB 초과는 `E_INVALID_ARGUMENT`), 프록시가 `new Response` 로 만든다. 스트리밍 응답은 v1 에서 지원하지 않는다. 일반 요청 메시지는 1 MiB 를 넘으면 버리고 오류 응답을 준다. 봉투 모양이 틀린 메시지는 무시하고 기록한다. 연속 3번 틀리면 프로토콜 위반으로 보고 프로세스를 종료한다. 플러그인당 요청은 초당 100건을 넘으면 `E_RATE_LIMIT` 이다.

**누가 무엇을 검사하나.** 보안 검사는 모두 main 에서 한다. 러너 쪽은 사용 편의(빠른 실패)일 뿐 우회될 수 있다고 가정한다.

| 검사 | 플러그인 쪽 프록시 | main 쪽 `PluginSession` |
|---|---|---|
| 인자 모양 | 직렬화 가능 여부, `fetch` 평탄화 | 모든 메서드의 인자 스키마, 길이·개수 상한 |
| 권한·선언 | `exec` 는 `shell` 이 없으면 프로퍼티 자체를 만들지 않는다 | 3장의 모든 검사. 러너가 만든 프록시는 믿지 않는다 |
| 이벤트 | — | `emit` 은 `validatePetEvent`, `source` 가 플러그인 id 와 다르면 거부(덮어쓰지 않음), `actions[].action` 은 해당 플러그인 id 접두(`<id>.`)만 허용 |
| 반응 규칙 | — | `validateReactionRule` |
| 사용자 맥락 | 비동기 흐름에 `inv` 를 자동으로 붙임 | `inv` 가 main 이 발급한 열린 값인지 확인 |
| 등록 정리 | `dispose` 시 자기 `Map` 에서 제거 | 플러그인이 보고한 `dispose` 와 무관하게 플러그인 id 로 모든 등록을 추적, 종료·비활성화 때 전부 제거 |

`emit` 의 액션 접두 규칙은 다른 플러그인의 액션(예: 승인 버튼)을 자기 말풍선 문구로 포장해 누르게 만드는 혼동을 막는다. 외부 `/event` 로 온 이벤트에는 적용하지 않는다(기존 동작 유지).

### 3. 권한 검사 (모두 main)

| 대상 | 규칙 |
|---|---|
| `fetch` 호스트 | URL 은 main 이 WHATWG `URL` 로 해석한다. 스킴은 `https` 만, 사용자 정보 금지, 포트는 기본값(`url.port === ""`)만, `hostname` 이 `permissions.network` 항목과 **완전히 같아야** 한다. 서브도메인은 항목마다 따로 선언해야 하고(와일드카드 없음) 끝 점(`example.com.`)과 IP 리터럴은 거부한다. IP 리터럴이 선언된 매니페스트는 로드 단계에서 거부한다. DNS 가 사설 주소로 풀리는 경우는 막지 않는다(한계) |
| 리다이렉트 | main 이 `redirect: "manual"` 로 직접 따라간다(최대 5회). 매 홉의 `Location` 에 위 규칙을 다시 적용하고, 어긋나면 응답 없이 `E_PERMISSION` 이다. 호스트가 바뀌면 `Authorization`·`Cookie` 헤더를 지운다. GET·HEAD 가 아닌 요청은 리다이렉트를 따르지 않고 3xx 응답을 그대로 준다 |
| `fetch` 메서드·헤더 | GET·HEAD 는 어디서나 허용한다. 그 밖의 메서드는 사용자 액션 맥락이 열려 있을 때만 허용한다. `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` 헤더는 제거한다. 쿠키 저장소는 쓰지 않는다(`credentials: "omit"`) |
| `openExternal` | `https` 만, 사용자 정보와 포트 금지, `hostname` 이 선언된 패턴의 호스트와 같을 것. 경로는 `url.pathname`(WHATWG 가 `..`와 `%2e%2e` 를 정규화한 뒤의 값, 퍼센트 디코딩은 더 하지 않음)으로 비교한다. 패턴이 `/*` 로 끝나면 그 앞부분(`/a/` 등)으로 시작해야 하고(`/a/*` 는 `/a` 와 `/ab` 를 허용하지 않음), 아니면 완전히 같아야 한다. 쿼리와 해시는 자유다. 통과하면 플러그인이 준 문자열이 아니라 정규화된 `url.href` 를 `shell.openExternal` 에 넘긴다. **사용자 액션 맥락이 열려 있을 때만 허용한다**(사용자 결정 1) |
| 미선언 contributes | `registerAction`(`contributes.actions`), `addTrayItem`(`trayItems`, 그리고 `item.action` 은 `actions`), `setBadge`(`badges`)는 선언되지 않은 id 면 `E_PERMISSION`. 같은 id 를 살아 있는 등록과 중복해 등록해도 오류다. `label`·배지 `text` 는 40자 이하, `tone` 은 열거값만 |
| `secrets` | `permissions.secrets !== true` 면 `E_PERMISSION`. 키는 `^[A-Za-z0-9_.-]{1,64}$`, 값은 8 KiB 이하, 플러그인당 64개. 저장소 이름 공간은 main 이 플러그인 id 로 나눈다 |
| `exec` | `permissions.shell !== true` 면 `E_PERMISSION` 이고 사용자 액션 맥락이 필요하다. main 이 `execFile`(셸 없음, `windowsHide`, 30초, 출력 1 MiB, 정리된 환경 변수)로 실행한다. `.cmd`·`.bat` 은 Node 가 셸 없이 실행하지 못하므로 `E_UNAVAILABLE` 이다. 로그에는 명령 이름만 남기고 인자는 남기지 않는다 |
| `windows.create` | 창 id 는 `permissions.windows`, 최초 URL·이동은 위 `fetch` 호스트 규칙, 세션은 플러그인 id 별 파티션(ADR-0003). **M4 는 검사 함수와 테스트까지만 만들고 실제 창 생성은 M5(`jungle`)에서 연결한다.** 그때까지 호출은 `E_UNAVAILABLE` |

**사용자 액션 맥락(비동기 경계 넘기).** main 이 사용자 호출을 시작할 때 `invocation = {id, pluginId, actionId, openedAt}` 을 발급하고 `invoke {handle, args, inv: id}` 로 보낸다. 사용자 호출은 말풍선 버튼, 트레이 메뉴, 그리고 허용 목록(아래)에 있는 `/action/:id` 뿐이다. 스케줄 콜백, `onResume`, `onConfigChange`, `activate` 에는 맥락을 발급하지 않는다. 러너는 `AsyncLocalStorage` 에 `inv` 를 넣어 핸들러가 `await`, 타이머, 중첩 호출을 넘어가도 이어지게 하고, 그 안에서 나가는 모든 요청 봉투에 `inv` 를 자동으로 붙인다. main 은 맥락이 필요한 요청(비-GET `fetch`, `exec`, `openExternal`)에서 다음을 모두 만족할 때만 허용한다. (a) `inv` 가 main 이 발급한 값이고, (b) 같은 플러그인 것이며, (c) 해당 핸들러 Promise 가 아직 끝나지 않았고(러너가 `invoke` 응답을 보내면 닫힘), (d) 발급 후 60초 이내다. 따라서 핸들러가 끝난 뒤 `void fetch(...)` 로 이어 가는 일은 거부되고, 핸들러는 쓰기 호출을 `await` 해야 한다. **한계:** 악의적인 플러그인이 맥락이 열려 있는 동안 `inv` 를 다른 작업에 쓰는 것은 막지 못한다. 이 방어는 스케줄·설정 변경 같은 자동 경로에서 쓰기가 실행되는 실수와 사용자 클릭 없는 쓰기를 막는 것이 목적이며, 열린 시간은 핸들러 수명(최대 60초)으로 한정된다.

**`/action/:id` 허용 목록.** ADR-0004 의 현재 구현은 `ActionRegistry` 에 등록된 모든 id 를 HTTP 로 실행하게 한다. 플러그인 액션을 같은 레지스트리에 등록하면 사용자 버튼 없이 쓰기 맥락이 열리는 경로가 생기므로(리뷰 기준), 플러그인이 등록한 액션은 `settings.json` 의 `httpActionAllowlist: string[]` 에 id 가 있을 때만 `/action/:id` 로 실행하고, 없으면 `404`(ADR-0004 의 "허용 목록에 없음")로 응답한다. 허용 목록에 있는 id 의 HTTP 실행만 사용자 맥락으로 본다(ADR-0003). 기본값은 빈 목록이고 코어 소유 액션(`deskpet.ping`)은 기존대로 항상 허용한다. 이 분기는 `index.ts` 의 `onAction` 연결부에서 하고 이벤트 서버 코드(`event-server`)는 바꾸지 않는다.

### 4. 수명주기

**발견.** 시작할 때 한 번 스캔한다(핫 리로드 없음, 변경은 재시작으로 반영). 스캔 루트는 `--plugins-dir=<경로>` 가 있으면 그것(e2e·개발용), 없으면 개발 실행(`!app.isPackaged`)은 저장소의 `plugins/`(앱 경로 기준 `../..`), 배포 실행은 `process.resourcesPath/plugins` 다. 루트의 바로 아래 폴더만 보며 `.`·`_` 로 시작하는 이름과 `node_modules` 는 건너뛴다. 폴더 안의 `manifest.json` 이 매니페스트다(기획안 5-2 의 표기도 `manifest.json` 으로 정정함). 사용자 폴더(`userData/plugins`)는 외부 플러그인 ADR 전까지 스캔하지 않는다.

**매니페스트 검증.** `validatePluginManifest`(M4 구현, ADR-0003)에 더해 호스트가 확인한다: 폴더 이름 = `id`, `apiVersion` 이 지원 목록(`["1"]`)에 있음, `permissions.network` 에 IP 리터럴이 없음, `entry` 경계(5장 결정 5), `manifest.json` 크기 64 KiB 이하. 실패하면 로드하지 않고 상태 `invalid` 와 이유를 `/status` 와 로그에 남긴다. 한 플러그인의 실패가 다른 플러그인 로드를 막지 않는다.

**최초 1회 허용.** 기록은 `userData/plugin-grants.json`(`settings.json` 은 사용자가 손으로 고치는 파일이라 분리)이다.

```json
{ "version": 1, "grants": { "<id>": { "decision": "granted", "at": "ISO8601", "permissionsHash": "sha256:...", "permissions": { } } } }
```

`permissionsHash` 는 `permissions` 객체를 키와 배열을 정렬해 정규화한 JSON 의 SHA-256 이다. 현재 매니페스트의 `permissions` 가 허용 기록과 **다르면 다시 묻는다.** 권한이 늘거나 바뀐 경우가 대상이고, 이전 허용의 부분집합으로 줄었을 때는 묻지 않고 기록만 갱신한다. `contributes`, `version`, 코드 변경은 다시 묻지 않는다. 허용 창은 `dialog.showMessageBox` 이고 권한을 한국어 문장으로 나열한다(`shell` 은 "임의 명령 실행"으로 강조). 버튼은 허용, 허용 안 함이며 한 번에 하나씩 순서대로 띄운다. 거부는 같은 해시로 기록해 다음 실행에서 묻지 않고 상태를 `denied` 로 둔다. 허용 대기 중인 플러그인은 `needs-permission` 이고 다른 플러그인 실행을 막지 않는다. 권한이 비어 있는 플러그인은 창 없이 기록만 남긴다(사용자 결정 2). 기록 파일이 깨지면 모두 미허용으로 보고 다시 묻는다. 이 파일은 같은 사용자 권한으로 고칠 수 있다(ADR-0004 토큰 파일과 같은 한계).

**활성화.** 허용된 플러그인만 `utilityProcess` 를 띄우고 `hello`(설정 스키마) → `activate` 순서로 진행한다. 스키마의 `secret` 필드가 있는데 `permissions.secrets` 가 아니면 경고를 남긴다.

**오류 3회 연속.** 오류로 세는 것: (a) `activate`·액션 핸들러·스케줄 콜백·`onResume`·`onConfigChange` 콜백이 던지거나 거부하거나 시간 초과, (b) 요청하지 않은 프로세스 종료, (c) 위 프로토콜 위반으로 인한 강제 종료. 세지 않는 것: 플러그인이 `try/catch` 로 처리한 호출 실패(`E_PERMISSION`, 네트워크 오류 포함)와 `log.error`. 콜백이 정상 종료하면 카운터를 0으로 되돌린다(어떤 종류의 콜백이든). 사용자가 다시 켜도 0이 된다. 오프라인 같은 외부 요인으로 폴링이 계속 던지면 3회로 꺼지므로, 플러그인은 외부 실패를 직접 처리하고 백오프해야 한다(기획안 10장). 3회가 되면 프로세스를 정리하고 상태 `disabled` 로 두며 펫이 알린다. 비정상 종료로 한 번 센 뒤 3회 미만이면 1초, 이어서 5초 뒤에 다시 띄운다. 오류로 인한 `disabled` 는 이번 실행 동안만 유지하고(앱을 다시 켜면 한 번 더 시도), 다시 켜기는 트레이의 "플러그인" 하위 메뉴(상태 표시와 다시 켜기)에서 한다(사용자 결정 3).

**비활성화 알림.** 호스트가 `source: "deskpet"`, `type: "notify"`, `priority: "high"`, `mood: "worried"`, `key: "plugin-disabled:<id>"`, 문구 `"<name>" 플러그인을 껐어요. 오류가 3번 이어졌어요`(120자 이하)를 코어에 직접 넣는다. 이벤트는 플러그인을 거치지 않으며 오류 메시지 원문은 싣지 않는다.

**정리와 종료.** 순서: `deactivate`(5초) → main 이 그 플러그인 id 의 모든 등록(액션·트레이·배지·반응 규칙·타이머·`onResume`)을 제거 → 진행 중 요청 거부, 열린 사용자 맥락 닫기 → `shutdown` 후 2초 안에 안 끝나면 `kill`. 정리는 플러그인의 협조와 무관하게 main 이 한다. 비정상 종료는 `exit` 이벤트에서 같은 정리를 즉시 하고 위 오류 규칙으로 간다. 플러그인의 stdout·stderr 는 로그 규칙(결정 3)을 거쳐 `[plugin:<id>]` 로 남긴다. 앱 종료 때는 모든 플러그인을 병렬로 정리하며 전체 3초를 넘기지 않는다(앱의 강제 종료 안전망 6초 안).

### 5. ADR-0003 미결 사항

**(1) cron·시간대.** M4 는 전체 문법이 아니라 다음 형태만 받는다(사용자 결정 2026-10-07).

```
M H * * D     M: 0–59, H: 0–23 (한 자리·두 자리 숫자)
              D: *  또는 0–6 의 쉼표 목록·범위 (예: 1,3,5  1-5), 0 = 일요일
```

일, 월 필드는 `*` 만 받는다. 이 밖의 형태(`*/5`, 이름, 7)는 등록 시점에 `E_INVALID_ARGUMENT` 이고 실행 시점까지 미루지 않는다. 범위(`1-5`)는 평일을 쓰는 가장 흔한 방법이라 "필요 최소"에 넣었다. 기본 시간대는 앱이 도는 시스템의 현지 시간대이고(M3 과 같음), `opts.tz` 는 IANA 이름이면 `Intl.DateTimeFormat` 으로 검증해 받는다(모르는 이름은 `E_INVALID_ARGUMENT`). 서머타임 때 없는 시각은 그날을 건너뛰고 겹치는 시각은 먼저 오는 쪽에서 한 번만 실행한다. 타이머가 늦게 깨면(잠자기 복귀 등) 놓친 발생을 한 번만 실행하고 다음 시각을 기다린다(M3 과 같음). `every(ms)` 는 `ms` 가 1000 이상의 정수여야 하고(권장 60초 이상), 복귀 후에는 복귀 시점부터 다시 센다. 같은 스케줄의 이전 실행이 아직 끝나지 않았으면 이번 발생은 건너뛰고 기록한다. 순수 계산은 `packages/plugin-host` 의 `cron.ts` 에 두고 시계를 주입해 테스트한다.
대안: 외부 cron 라이브러리는 의존성 추가 대비 이득이 작아 쓰지 않는다. 전체 문법은 backlog 다.

**(2) `secret` 저장.** main 의 Electron `safeStorage`(Windows 는 DPAPI)로 값마다 암호화해 `userData/plugin-secrets.json` 에 `{ version: 1, entries: { "<플러그인 id>": { "<키>": "<base64 암호문>" } } }` 로 저장한다(임시 파일 후 이름 변경). `safeStorage.isEncryptionAvailable()` 가 거짓이면 `secrets.set` 은 `E_UNAVAILABLE` 이고 평문으로 대체하지 않는다. 복호화에 실패한 값은 `null` 을 돌려주고 한 번 경고한다. `configSchema` 의 `secret: true` 필드는 `settings.json` 이 아니라 같은 저장소에 키 = 필드 이름으로 저장하고 `ctx.config` 에는 넣지 않는다. 플러그인은 `ctx.secrets.get(<필드 이름>)` 으로 읽으며 `permissions.secrets` 가 필요하다. 설정 화면에는 값을 다시 보여주지 않는다. 대안(`settings.json` 에 평문, 자체 암호화)은 기획안 10장과 어긋나 제외했다.

**(3) 로그 마스킹.** 1차 책임은 플러그인이다(비밀·메시지 본문·쿠키를 `log` 에 넣지 않는다). 호스트는 2차로 모든 `log` 와 플러그인 stdout·stderr 를 거른다: 한 줄 2 KiB 로 자르고 줄바꿈을 이스케이프, 그 플러그인이 이번 실행에서 `secrets.get/set` 으로 다룬 값(6자 이상)과 `Bearer <토큰>`, `Authorization:`·`Cookie:`·`Set-Cookie:` 줄, `token|key|secret|password|code` 쿼리 값을 `***` 로 바꾼다. 호스트 자신의 로그에는 URL 의 쿼리, 헤더, 본문, `exec` 인자, 이벤트 `text`·`detail` 을 넣지 않는다. 마스킹은 최선의 노력이며 완전하지 않다.

**(4) `Disposable.dispose` 중복 호출.** 멱등이다. 첫 호출만 효과가 있고 이후는 오류·로그 없이 무시한다. 플러그인이 비활성화된 뒤의 호출도 무시한다. 같은 id 를 `dispose` 한 뒤 다시 등록하는 것은 허용하며, 이전 등록의 늦은 `dispose` 가 새 등록을 지우지 않는다(main 이 등록 단위로 추적). `CheckerWindowHandle` 은 `dispose` 후 `show`, `hide`, `getJson` 이 `E_DISPOSED` 로 거부된다.

**(5) 파일 경로 경계.** `entry` 는 비어 있지 않은 상대 경로여야 한다. 거부: 절대 경로(`/`, `\`, `C:`, UNC `\\`), `\`·NUL 포함, `..` 구간, 260자 초과, `.js`·`.mjs`·`.cjs` 가 아닌 확장자. 통과해도 `realpath` 로 해석한 실제 경로가 `realpath(플러그인 폴더) + 정규화한 entry`(Windows 는 대소문자 무시)와 같아야 한다. 즉 폴더 밖뿐 아니라 경로 중간의 심볼릭 링크·정션은 모두 거부한다. 일반 파일이어야 하고 플러그인 폴더와 `manifest.json` 자체도 링크면 거부한다. 확인은 실행 직전에 한 번 더 한다(그 사이의 교체는 막지 못함). 플러그인이 import 하는 의존성(`node_modules`)은 이 검사의 대상이 아니다(ADR-0004 `--file` 규칙과 같은 방식).

### 6. 설정 저장과 `onConfigChange`

플러그인 설정은 `settings.json` 의 `plugins.<id>` 객체다. M3 의 `plugins.reminders` 가 이미 `{ rules }` 라서 **저장 형식 이전은 필요 없다.** 바뀌는 것은 `settings.ts` 뿐이다. (a) `reminders` 전용 검증과 import 를 없애고 `plugins` 를 `Record<id, 객체>` 로 일반화해 모르는 플러그인 설정을 그대로 보존한다(현재 `writeSettings` 는 `reminders` 외 설정을 버린다). (b) 규칙 검증은 플러그인이 자기 안에서 한다(`reminders` 가 이미 함). (c) `httpActionAllowlist` 를 추가한다. 비밀(`secret`)은 여기에 두지 않는다.

호스트는 활성화 때 `configSchema` 로 설정을 정리해 `init` 에 담아 보낸다: 선언된 속성의 타입이 맞지 않으면 그 속성을 버리고 `default` 로 채워 경고한다. 열거값 위반도 같다. `required` 에 없는데 값이 없으면 플러그인이 알아서 처리한다. `items` 가 선언되지 않은 `array` 는 원소를 검사하지 않는다. `items.type` 이 `"object"` 인 배열(D-022)은 배열이 아니면 배열 전체를 `default` 로 대체하고, 배열이면 원소마다 속성 타입·`required`·`enum` 을 검사해 **틀린 원소만 버리고** 경고한다(나머지는 유지, 선언하지 않은 속성은 그대로 통과). 한 원소 때문에 사용자의 다른 규칙이 사라지지 않게 하려는 선택이다. `ctx.config` 는 동결한 복사본이다. 설정이 바뀌면(M4 2단계의 설정 창이 `setPluginConfig(id, next)` 를 호출) main 이 검증 후 `settings.json` 을 원자적으로 쓰고 `config.changed {config}` 를 보낸다. 러너는 `ctx.config` 를 새 객체로 바꾼 뒤 등록된 `onConfigChange` 콜백을 차례로 부르며, 그 호출은 사용자 맥락이 없는 콜백이고 오류 규칙의 대상이다. 짧은 시간에 여러 번 바뀌면 마지막 값만 보낸다. `settings.json` 을 손으로 고친 경우는 재시작 때 반영한다(감시 없음).

### 7. `/status` 의 `plugins`

발견된 플러그인을 `id` 순으로 모두 담는다(`invalid` 포함, 기준 2의 "이유를 `/status` 에 남긴다").

```json
{ "plugins": [
  { "id": "reminders", "name": "Reminders", "version": "0.0.0", "state": "running", "consecutiveErrors": 0 },
  { "id": "broken", "state": "invalid", "reason": "apiVersion: must be \"1\"", "consecutiveErrors": 0 } ] }
```

`state` 는 `invalid`, `needs-permission`, `denied`, `starting`, `running`, `restarting`, `disabled`(오류 3회 또는 사용자) 중 하나다. `name`·`version` 은 매니페스트가 읽힌 경우에만 있고, 읽히지 않으면 `id` 는 폴더 이름이다. `reason` 은 `invalid`·`disabled` 에만 있고 200자 이하이며 경로와 플러그인이 만든 오류 원문을 담지 않는다(고정 문구와 검증 오류만). ADR-0004 는 `plugins: []` 의 원소 형식을 정하지 않았으므로 호환되는 필드 추가다. 따라서 CLI(`deskpet status`)와 `event.e2e` 의 `plugins: []` 기대값은 구현 때 함께 고친다.

### 8. plugin-lite 대체 계획

| 순서 | 내용 | 기준 |
|---|---|---|
| 1 | `packages/plugin-host`: 채널 인터페이스, 봉투, `PluginSession`(검사), 스케줄러·`cron.ts`, 매니페스트 검증기, 허용 기록. 메모리 채널로 단위 테스트 | 4 |
| 2 | `plugin-runner.js` 와 `utilityProcess` 채널, 발견·활성화·오류 3회·재시작 | 2, 3 |
| 3 | 허용 창, `/status`, 트레이 "플러그인" 메뉴, `httpActionAllowlist` 연결 | 5, 6 |
| 4 | `index.ts` 에서 `RemindersPluginLite` 를 호스트로 교체하고 `plugin-lite.ts`·테스트 삭제, `settings.ts` 일반화. 스케줄러에 `advanceForTest`·`setTimeForTest` 를 옮겨 dev control 이 그대로 쓰게 한다 | 6 |
| 5 | 중간 플레이 테스트 | 7 |

`reminders` 는 코드 수정 없이 옮긴다. M3 `reminders.e2e`(시계 이동 → 말풍선)가 그대로 통과하는 것을 교체의 회귀 기준으로 삼는다(`plugins: []` 기대값만 갱신). 권한이 비어 있어 허용 창이 뜨지 않으므로 기존 e2e 의 흐름이 유지된다. 앱을 띄우기 전에 `plugins/*` 의 `dist/` 가 빌드되어 있어야 하므로 `test:e2e` 와 `start-deskpet.cmd` 의 빌드 순서에 플러그인 빌드를 넣는다. 배포용 번들(플러그인 의존성 포함)은 M8 에서 정한다.

## 사용자 결정 (2026-10-07)

| # | 질문 | 결정 |
|---|---|---|
| 1 | `openExternal` 도 사용자 액션 맥락을 요구하나 | **요구한다.** 링크는 말풍선 버튼·트레이 액션 안에서만 연다 |
| 2 | 권한이 빈 플러그인에 허용 창을 띄우나 | **띄우지 않고 기록만 한다** |
| 3 | 오류 3회로 꺼진 플러그인을 재시작 후에도 꺼 두나 | **이번 실행 동안만 끈다.** 다음 실행에 다시 시도하고, 트레이에서 다시 켤 수 있다 |
| 4 | `/action/:id` 로 실행할 플러그인 액션의 기본값 | **빈 허용 목록.** `settings.json` 의 `httpActionAllowlist` 에 적은 id 만 실행하고, 코어 액션(`deskpet.ping`)은 기존대로 허용 |
| 5 | `windows.create` 연결 시점 | **M5.** M4 는 검사 함수와 테스트까지 |

## 규약 변경 필요 (ADR·사용자 확인)

`packages/plugin-sdk/src/v1/` 은 이 ADR 이 바꾸지 않는다. 다음은 필요성만 기록한다.

- `permissions.shell` 이 불리언이라 허용 시 모든 명령이 열린다. 명령 허용 목록(예: 문자열 배열 필드)을 추가하려면 `permissions` 를 바꿔야 하며, 기존 필드의 타입을 바꾸면 `apiVersion` 상승 대상이다. M4 의 `reminders`·`claude-code` 는 `shell` 이 필요 없어 급하지 않고, `orca`(M6)가 쓰기 전에 결정한다.
- ~~`ConfigFieldSchema.items` 가 `{ type: "string" }` 뿐이라 객체 배열을 표현하지 못한다.~~ **해결(D-022, 2026-10-07):** `items` 에 객체 항목을 추가했다(ADR-0003 'D-022 설정 스키마 확장'). `reminders` 의 `rules` 가 이를 선언한다.

## 미결 사항

- ~~설정 화면(M4 2단계)이 허용 전·비활성 플러그인의 `configSchema` 를 보여 줄 방법~~ **결정(M4-8, 2026-10-07):** 허용돼 실행 중(`running`)인 플러그인만 폼을 만든다. 허용 전·거부·`invalid`·`disabled`·시작 중인 플러그인은 폼 대신 상태 안내만 보여 준다(스키마를 캐시하지 않는다). 설정 창은 `PluginManager.configSchemas()` 로 실행 중 플러그인의 스키마를 읽고, 저장은 main 이 스키마로 다시 검증한 뒤 `setPluginConfig` 로 한다. `secret: true` 필드는 `permissions.secrets` 가 있을 때만 저장하며(없으면 입력칸을 막고 저장도 거부), 값은 렌더러로 되돌려 보내지 않고 '저장됨/없음'만 알린다.
- 배포 실행에서 플러그인의 위치와 번들링(의존성 포함), `userData/plugins` 스캔은 M8 과 외부 플러그인 ADR 에서 정한다.
- 프로세스 수·메모리 실측과 "필요할 때만 띄움" 전환 여부는 M4 기준 11 의 측정 결과로 정한다.
- 서머타임 경계(없는 시각·겹치는 시각)의 `opts.tz` 동작은 구현 때 시간대별 테스트로 확인한다.
- 사용자 액션 맥락의 열린 시간 상한(60초)과 요청 빈도 상한(초당 100건)은 첫 실제 플러그인(`claude-code`)을 붙이며 조정한다.
