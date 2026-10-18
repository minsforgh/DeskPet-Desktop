# ADR 0006: 체커 창 호스트

## 상태

승인 (2026-10-08, 사용자 승인. 사용자 결정 5건 모두 추천안(a) 채택)

## 배경

SDK v1 은 `ctx.windows.create(id, opts)` 와 `CheckerWindowHandle`(`show`, `hide`, `getJson`, `dispose`)을 선언한다. ADR-0003 은 규칙(선언한 `permissions.windows` id 만, 최초 URL·이동은 `permissions.network` 호스트만, 플러그인별 세션 저장소, Node 통합 없이 `contextIsolation`)을 정했고, ADR-0005 는 사용자 결정 5 로 "`windows.create` 연결은 M5"라고 정했다. 현재 `packages/plugin-host/src/session.ts` 의 `windows.create` 는 옵션과 `allowedWindowRequest`(창 id 선언 + 최초 URL 호스트) 검사까지만 하고 `E_UNAVAILABLE` 을 던지며, `window.show`·`window.hide`·`window.getJson` 은 바로 `E_UNAVAILABLE` 이다. `SessionHost` 인터페이스에는 창 관련 메서드가 아직 없다.

M5 의 `jungle` 은 사용자가 직접 로그인한 숨김 LMS 창에서 출석 상태를 GET 으로만 읽는다(`docs/jungle-plugin-design.md` 1-1, 2-1, 2-2, 5장). 이 ADR 은 그 창을 호스트가 어떻게 만들고 가두고 정리하는지, `getJson` 이 무엇을 보장하는지 정한다. 코드는 이 ADR 이 승인된 뒤 M5 기준 2 에서 쓴다.

한계를 먼저 밝힌다.

- ADR-0005 와 같이 `utilityProcess` 는 OS 샌드박스가 아니다. 이 ADR 의 검사는 `PluginContext` 를 통하는 경로만 막는다. 플러그인 코드가 `node:fs`·`node:https` 를 직접 쓰면 아래 검사를 거치지 않는다(7장).
- 창 안의 페이지는 LMS·로그인 사이트가 서비스하는 코드다. 플러그인은 그 페이지에 스크립트를 넣거나 읽을 수 없게 설계한다(preload 없음, 스크립트 실행 API 없음). 그러므로 이 ADR 의 위협 모델은 "플러그인이 창을 통해 선언 밖으로 나가는 것"과 "창 안의 페이지가 선언 밖으로 사용자를 데려가는 것"이다.
- Electron 버전과 일부 API 의 동작은 이 저장소에서 확인하지 못했다. 해당 항목은 "미확인"으로 적고 구현 전 최소 시험(프로토타입)으로 확인하는 일을 9장에 모았다.

## 결정

### 1. 숨김 `BrowserWindow` 의 `webPreferences`

플러그인 창마다 `BrowserWindow` 하나를 main 이 만든다. 플러그인이 정할 수 있는 것은 `CheckerWindowOptions` 의 `url`, `show`, `width`, `height`, `title` 뿐이고 아래 값은 모두 호스트가 고정한다.

| 항목 | 값 | 이유 |
|---|---|---|
| `sandbox` | `true` | 렌더러를 OS 샌드박스 안에 둔다. 원격 페이지의 취약점이 곧 main 권한이 되지 않게 한다 |
| `contextIsolation` | `true` | ADR-0003 규칙 |
| `nodeIntegration` / `nodeIntegrationInSubFrames` / `nodeIntegrationInWorker` | `false` | ADR-0003 규칙 |
| `preload` | **없음** | 창과 호스트 사이의 IPC 통로를 만들지 않는다. `getJson` 은 main 이 직접 하므로(3장) 페이지 안에 넣을 코드가 필요 없다 |
| `webSecurity` / `allowRunningInsecureContent` | `true` / `false` | 기본값을 명시해 고정한다 |
| `webviewTag`, `experimentalFeatures`, `enableBlinkFeatures` | 끔 / 끔 / 비움 | 불필요한 표면을 만들지 않는다 |
| `devTools` | `false` | 사용자가 DevTools 로 세션 토큰을 보거나 페이지를 바꾸는 경로를 두지 않는다 |
| `spellcheck`, `backgroundThrottling` | `false`, 기본(켬) | 숨김 창이 대기 CPU 를 쓰지 않게 한다. 쓰로틀이 폴링 정확도에 영향을 주지는 않는다. 폴링은 main 이 `getJson` 으로 하므로 페이지 타이머에 기대지 않는다 |
| `partition` | 2장 | |
| 창 속성 | `show: false`로 만들고 `skipTaskbar: true`, `webContents.setAudioMuted(true)`, 메뉴 막대 제거 | 사용자가 `show()` 하기 전에는 아무것도 보이지 않는다 |

추가로 main 이 거는 가드는 다음과 같다.

- `session.setPermissionRequestHandler` 는 모든 권한(카메라, 위치, 알림 등)을 거부하고, `setPermissionCheckHandler` 도 `false`, `setDevicePermissionHandler` 도 거부한다.
- `will-download` 는 취소한다. 창으로 파일을 받게 하지 않는다.
- 인증서 오류는 Electron 기본(거부)을 유지한다. 인증서 오류를 무시하는 코드는 테스트 전용 경로(8장)에만 두고 `--plugins-dir` 테스트 실행에서만 켠다.
- 창 제목은 플러그인이 준 `title` 을 그대로 쓰지 않는다. `[<플러그인 이름>] <title> — <현재 호스트>` 형식으로 호스트가 조립하고 `page-title-updated` 는 막는다. 로그인 창이 은행·시스템 창처럼 보이지 못하게 하고, 사용자가 지금 어느 도메인에 있는지 알 수 있게 한다(주소 표시줄이 없기 때문). `title` 은 80자 이하로 자른다.
- 사용자가 창의 X 를 누르면 `close` 를 취소하고 `hide()` 한다(앱 종료·플러그인 정리 때만 실제로 파괴).
- 창 크기는 `width`·`height` 가 200~4096 의 정수일 때만 받는다(`session.ts` 의 검사 보강. SDK 타입은 그대로). 생략하면 480×720.

플러그인 자체는 창 안의 DOM·쿠키·스토리지에 접근할 방법이 없다. 노출하는 것은 `getJson`(3장)과 `show`/`hide` 뿐이다.

### 2. 플러그인별 세션 분리

| 항목 | 결정 |
|---|---|
| partition 이름 | `persist:deskpet-plugin-<플러그인 id>`. 플러그인 id 는 소문자·숫자·하이픈이라(매니페스트 검증기) 이름 규칙이 안전하다. 창 id 는 이름에 넣지 않는다 |
| 같은 플러그인의 여러 창 | 한 파티션을 공유한다(예: 같은 LMS 로그인을 쓰는 두 창). 플러그인 간에는 공유하지 않는다 |
| 플러그인이 고를 수 있나 | 없다. 옵션에 `partition` 이 없고, 호스트가 `webPreferences.partition` 을 정한다 |
| 쿠키 위치·수명 | Electron 이 `userData/Partitions/deskpet-plugin-<id>/` 에 저장한다. 사이트가 준 만료 시각을 따르고 앱을 다시 켜도 유지된다. 플러그인을 비활성화·제거해도 지우지 않는다. 지우기는 사용자 결정 4 |
| 비밀번호 | 호스트는 폼 입력을 읽지 않으며 `secrets` 저장소에도 쓰지 않는다. 사용자가 로그인 창에 입력한 값은 사이트로만 간다. 브라우저의 비밀번호 관리자(자동 저장)는 Electron `BrowserWindow` 에 없는 것으로 알고 있으나 **미확인**이라 프로토타입에서 저장 제안이 뜨지 않는지 확인한다 |
| 쿠키를 읽는 쪽 | main 의 `session.fetch` 만 쓴다(3장). `session.cookies` API 는 정리(삭제)에만 쓰고 값을 읽어 로그나 플러그인에 넘기지 않는다 |
| 기본 세션 | 앱 창(펫, 말풍선, 설정)이 쓰는 기본 세션과 완전히 분리된다 |

### 3. 출처 밖 이동 차단과 시스템 브라우저 위임

**용어.** *홈 출처* = `windows.create` 의 `opts.url` 의 출처(`https://<호스트>`). *허용 호스트* = 매니페스트 `permissions.network`. v1 매니페스트에는 "API 호스트"와 "로그인 호스트"를 구분하는 필드가 없다. 그래서 허용 호스트는 모두 창이 **이동해 갈 수 있는** 곳이고, `getJson` 이 **요청을 보내는** 곳은 홈 출처 하나뿐이다(4장). 이 구분이 "로그인 호스트 허용 방식"의 답이다. 로그인 사이트를 `network` 에 적으면 이동은 되지만 호스트가 그곳으로 요청을 보내 주지는 않는다.

**이동 검사 함수.** `allowedNetworkUrl`(`permissions.ts`)을 재사용한다: `https` 만, 사용자 정보·포트·끝 점·IP 리터럴 거부, `hostname` 이 선언값과 완전히 같을 것. `about:blank`, `data:`, `blob:`, `file:`, `javascript:`, `http:` 이동은 모두 막는다(최초 로드 전 빈 문서는 Electron 내부에서 만들므로 예외 처리 필요 여부는 **미확인**).

**검사 지점(중첩 방어).**

1. `will-navigate` (주 프레임 이동), `will-redirect` (서버 리다이렉트), `will-frame-navigate` (하위 프레임. Electron 25 이상에서 제공하는 것으로 알고 있으나 이 저장소의 Electron 버전은 **미확인**)에서 위 함수를 적용하고, 어긋나면 `event.preventDefault()`.
2. 위 이벤트가 `loadURL`, `reload`, history 이동, 일부 리다이렉트에서 빠지는 경우를 대비해, `session.webRequest.onBeforeRequest` 에서 `resourceType` 이 `mainFrame`·`subFrame` 인 요청에 같은 검사를 하고 어긋나면 `cancel`. 이것이 최종 방어선이다. 하위 리소스(스크립트·이미지·XHR)는 막지 않는다. 로그인 사이트(예: Google)가 여러 보조 도메인에서 리소스를 받아 오기 때문에 이를 막으면 로그인이 깨진다. 이 열린 부분은 7장의 남는 위험이다.
3. 리다이렉트는 매 홉이 같은 검사를 받는다. 중간 홉이 선언 밖이면 그 홉에서 막힌다(응답을 보지 않고 취소).
4. 막힌 이동은 사용자에게 보이지 않게 조용히 취소하고, 로그에는 **호스트 이름만** 남긴다(경로·쿼리에 OAuth `code` 같은 값이 있을 수 있음).

**새 창.** `setWindowOpenHandler` 는 항상 `{ action: "deny" }` 를 반환한다. 앱 안에 두 번째 창을 만들지 않는다. 그 위에서 다음만 한다.

- 창이 현재 **보이는 상태**이고 요청 URL 이 `allowedExternalUrl`(ADR-0005 3장의 `openExternal` 검사: `https`, 선언 패턴의 호스트·경로)을 통과하면 정규화된 `url.href` 를 `shell.openExternal` 에 넘긴다.
- 그 밖(숨김 상태, 선언하지 않은 주소, 다른 스킴)은 버리고 호스트 이름만 로그에 남긴다.

숨김 창은 사용자가 클릭할 수 없으므로 숨김 상태의 팝업은 광고·추적 스크립트가 낸 것으로 보고 버린다. 보이는 창에서 사용자가 누른 링크만 시스템 브라우저로 넘어간다. 이것은 ADR-0005 사용자 결정 1("`openExternal` 은 사용자 액션 맥락에서만")과 같은 정신이며, 근거는 창의 가시성이다. 가시 창에서의 클릭을 `userGesture` 로 판별할 수단은 **미확인**이다(`setWindowOpenHandler` 의 details 에는 제스처 필드가 없는 것으로 알고 있음).

### 4. `getJson`: GET 고정, 크기·시간 제한

**GET 만 가능한 구조적 이유.** `getJson(path)` 의 프로토콜 메시지는 `{id, generation, path}` 뿐이고 `PARAM_KEYS` 에 `method`·`headers`·`body` 가 없다(`session.ts` 의 `window.getJson: ["id","generation","path"]`). main 이 요청을 만들 때 메서드를 코드에 `"GET"` 으로 박는다. 플러그인이 넘길 수 있는 요청 내용은 경로 문자열 하나이므로 메서드·헤더·본문을 바꿀 입력 자체가 없다. SDK 타입 `getJson(path: string)` 도 같다. 즉 "검사로 거부"가 아니라 "표현할 수 없음"이다.

**수행 방식(사용자 결정 1).** 페이지 안에서 스크립트를 실행하지 않고 main 이 파티션 세션의 `session.fetch`(Electron 네트워크 스택, 파티션 쿠키 자동 첨부)로 직접 요청한다. 근거: (a) preload·`executeJavaScript` 가 필요 없어 1장의 "preload 없음"을 지킨다, (b) 페이지가 `window.fetch` 를 바꿔도 영향이 없다, (c) 창이 지금 로그인 페이지에 가 있어도 요청이 `accounts.google.com` 으로 새지 않는다(`docs/jungle-plugin-design.md` 2-2 의 "M5에서 확인할 것" 해소). 대가: 서버가 `Origin`/`Referer`/`Sec-Fetch-*` 헤더를 확인하면 페이지 안 `fetch` 와 다르게 보일 수 있다. 이 LMS 가 그런지는 **미확인**이고 기준 6(실제 로그인) 때 확인한다. 어긋나면 사용자 결정 1 의 대안(페이지 안 실행)으로 바꾼다.

**요청 규칙(main).**

| 규칙 | 내용 |
|---|---|
| 대상 출처 | 항상 홈 출처. 결과 URL 은 `new URL(path, homeOrigin)` 이고 `url.origin === homeOrigin` 이어야 한다 |
| `path` 모양 | `/` 로 시작, `//` 로 시작 금지, `\`·제어 문자·NUL 금지, 2048자 이하. 위반 `E_INVALID_ARGUMENT`. 해석 후 출처가 다르면 `E_PERMISSION` |
| 헤더 | 호스트가 고정: `Accept: application/json`. 플러그인 지정 헤더 없음. `Cookie` 는 세션이 붙인다 |
| 쿠키 | `credentials: "include"` 와 같은 동작을 쓰되 반드시 이 파티션 세션만. **`session.fetch` 가 파티션 쿠키를 보내는지는 미확인**이라 프로토타입으로 확인한다 |
| 리다이렉트 | `redirect: "manual"`. 3xx 를 따라가지 않고 `{status, body: null}` 로 돌려준다. 같은 출처 안의 리다이렉트도 따라가지 않는다(필요하면 플러그인이 경로를 다시 요청). LMS 가 비로그인 상태에서 로그인 페이지로 3xx 를 보내도 앱은 따라가지 않으므로 플러그인은 3xx 를 "로그인 필요 후보"로 본다 |
| 응답 본문 | 최대 **1 MiB**(바이트). 넘으면 읽기를 중단하고 `E_INVALID_ARGUMENT`. `Content-Type` 이 JSON 이고 파싱에 성공하면 `body`, 아니면 `body: null`(상태 코드는 유지). 파싱 오류 원문은 돌려주지 않는다 |
| 시간 | main 의 `AbortController` 가 **20초**에 끊고 `E_TIMEOUT`. 세션의 요청 상한(30초, ADR-0005 2장)은 그대로 안전망이다 |
| 동시 실행 | 창당 2건. 초과는 `E_RATE_LIMIT`. 세션 전체 초당 100건 상한은 그대로 |
| 돌려주는 것 | `{ status, body }` 만. 응답 헤더·`Set-Cookie`·최종 URL 은 플러그인에 주지 않는다 |
| 창 상태 | 창이 파괴되었거나 dispose 되었으면 `E_DISPOSED`/`E_UNAVAILABLE`(5장). 창이 숨김이든 아니든 상관없다 |

**로그 규칙.** 로그에는 `[window] <pluginId>/<windowId> getJson status=<번호>` 형태만 남긴다. 경로·쿼리·본문·헤더·쿠키·`Set-Cookie`·리다이렉트 `Location`은 남기지 않는다(ADR-0005 5장 (3)의 호스트 로그 규칙과 같은 방향). 오류도 코드(`E_TIMEOUT` 등)만 남기고 네트워크 오류 원문은 남기지 않는다. `session.fetch` 가 던진 `Error.message` 에 URL 이 들어갈 수 있으므로 호스트는 메시지를 그대로 로그에 쓰지 않는다. 단위 테스트가 가짜 로거로 이 규칙을 확인한다(8장). 호스트 쪽 마스킹(ADR-0005 5장 (3))은 2차 방어일 뿐이다.

### 5. `show`/`hide`와 창 수명주기

| 상황 | 동작 |
|---|---|
| `windows.create(id, opts)` | 창 객체와 `loadURL` 을 시작한 뒤 응답한다(로드 완료를 기다리지 않는다. 로드 실패는 로그에 호스트·오류 코드만 남기고 창은 유지, `getJson` 은 페이지와 무관하게 동작). `opts.show === true` 이면 `show` 와 같은 맥락 규칙을 받는다(사용자 결정 3) |
| 중복 id | 같은 플러그인이 살아 있는 같은 id 를 다시 `create` 하면 `E_INVALID_ARGUMENT`("이미 열린 창"). ADR-0005 의 "살아 있는 등록과 중복 등록은 오류"와 같다. 파괴·dispose 된 id 는 다시 만들 수 있다. 다른 플러그인의 같은 id 는 별개다(`(pluginId, windowId)` 로 추적) |
| 개수 | 플러그인당 `permissions.windows` 선언 개수까지, 앱 전체 4개까지(초과 `E_RATE_LIMIT`) |
| `window.show` | 창을 보이고 앞으로 가져온다. `E_DISPOSED`(파괴됨). 중복 호출은 무시 |
| `window.hide` | 창을 숨긴다. 창과 세션은 유지. 중복 호출은 무시 |
| `dispose` | 멱등(ADR-0005 5장 (4)). 창을 파괴한다. **파티션 쿠키는 지우지 않는다.** 이후 `show`/`hide`/`getJson` 은 `E_DISPOSED`. 플러그인이 같은 id 로 새로 만든 창을 이전 핸들의 늦은 `dispose` 가 지우지 않도록 main 이 창 단위(`(pluginId, windowId, generation)`)로 추적한다 |
| 플러그인 비활성화·오류 3회·프로세스 종료 | ADR-0005 4장 정리 순서에서 그 플러그인의 모든 창을 main 이 파괴한다(플러그인 협조 불필요). 진행 중인 `getJson` 은 `AbortController` 로 끊고 `E_DISPOSED` |
| 앱 종료 | `before-quit` 에서 모든 체커 창을 파괴한다. 3초 정리 예산(ADR-0005)에 포함하며 창 파괴가 늦어도 앱 강제 종료 안전망(6초)이 우선한다 |
| 창 렌더러 크래시(`render-process-gone`), 응답 없음 | 크래시한 창은 파괴 처리하고 그 id 를 "닫힘"으로 표시한다. 이후 `getJson`/`show`/`hide` 는 `E_UNAVAILABLE`("창이 종료되었습니다"). 같은 id 로 다시 `create` 할 수 있다. 앱, 다른 창, 다른 플러그인은 영향이 없다. 플러그인에 별도 이벤트는 보내지 않는다(SDK 에 통로 없음). 이 오류는 플러그인이 `try/catch` 로 처리하는 호출 실패라서 오류 3회 규칙에 세지 않는다(ADR-0005 4장). 응답 없음(`unresponsive`)은 로그만 남긴다. `getJson` 은 페이지와 무관하므로 영향이 없다 |
| 사용자가 X 로 닫음 | 숨김으로 바꾼다(1장). 플러그인 관점에서 창은 계속 존재한다 |
| 이동 차단 등 창 이벤트 오류 | 3장의 방식으로 조용히 취소하고 로그만 남긴다. 앱 크래시로 번지지 않게 모든 `webContents` 이벤트 핸들러를 `try/catch` 로 감싸고 `uncaughtException` 에 기대지 않는다 |

### 6. 호스트 ↔ 플러그인 메시지와 검사 분담

봉투와 오류 코드는 ADR-0005 2장 그대로다. `CheckerWindowHandle.dispose()` 는 별도 메시지 `window.dispose {id, generation}` 을 쓴다. `windows.create` 가 성공하면 세션은 직렬화 가능한 양의 정수 `generation` 을 응답하고, 러너는 핸들에 이를 보관해 `window.show`·`window.hide`·`window.getJson`·`window.dispose` 에 함께 보낸다. 세션은 현재 창의 세대와 다르면 `dispose` 를 멱등으로 무시하고 나머지 세 메서드에는 `E_DISPOSED` 를 반환한다. 생성 응답을 기다리는 동안 이전 핸들의 늦은 `dispose` 가 도착해도 새 창을 파괴하지 않는다. `PARAM_KEYS` 는 각 창 메서드에 `generation` 을 허용한다. SDK v1 계약은 바꾸지 않는다.

| 메시지 | 플러그인 쪽 프록시(편의, 우회 가정) | main 쪽 `PluginSession` (보안 경계) | main 쪽 창 관리자(앱) |
|---|---|---|---|
| `windows.create {id, opts}` → `generation` | `structuredClone` 가능 여부, `opts` 타입 | 인자 스키마(`onlyKeys`, 크기 범위, `title` 80자), `permissions.windows` 에 id 선언, `opts.url` 이 `allowedNetworkUrl` 통과(`allowedWindowRequest`), 중복 id, 개수 상한, `show:true` 의 사용자 맥락(결정 3), 기존 요청 상한 안에서 생성 시간 제한 | `BrowserWindow`·파티션 생성, 1장 가드와 3장 이동 차단 설치, 홈 출처 기록 |
| `window.show {id, generation}` | — | 현재 세대의 살아 있는 창인지, 사용자 맥락(결정 3) | `show()` + 포커스 |
| `window.hide {id, generation}` | — | 현재 세대의 살아 있는 창인지 | `hide()` |
| `window.getJson {id, generation, path}` | `path` 가 문자열인지 | 현재 세대 소유 확인, `path` 모양(4장), 동시 실행·빈도, 30초 타임아웃 | 홈 출처 결합, `session.fetch` GET, 리다이렉트 비추종, 크기·시간 제한, 로그 규칙 |
| `window.dispose {id, generation}` | 핸들 상태를 `disposed` 로 | 현재 세대만 폐기, 이전 세대는 멱등으로 무시, 비동기 폐기 완료 뒤 창 슬롯 반환 | 창 파괴 |
| 플러그인 종료·비활성화 | — | 그 플러그인의 모든 창 등록을 추적해 제거 요청 | 창 파괴, 진행 중 요청 중단 |

원칙: **세션은 "이 플러그인이 이것을 해도 되는가"(권한·인자·소유·맥락)를, 창 관리자는 "그렇게 해도 안전하게 실행하는 방법"(Electron 설정·이동 가드·요청 수행)을 맡는다.** 창 관리자는 세션이 이미 검사한 값을 받더라도 `getJson` 의 출처 결합과 이동 검사는 스스로 다시 한다(세션 검사와 중복이지만 구현 실수에 대한 이중 방어). `SessionHost` 에 `windows: { create, show, hide, getJson, dispose }` 를 추가해 `plugin-host` 가 Electron 없이 가짜 구현으로 단위 테스트되게 한다(ADR-0005 의 채널 추상화와 같은 방식). `windows.create` 가 반환하는 것은 직렬화 가능한 최소 정보(세대 정수)뿐이고 `BrowserWindow`·`webContents` 객체는 플러그인 쪽으로 가지 않는다.

### 7. 보안 위험과 남는 위험

| 위험 | 대응 | 남는 것 |
|---|---|---|
| 플러그인이 창으로 선언 밖 주소를 연다 | 3장 이동 가드 + `onBeforeRequest` 최종 방어선 | 구현 버그. 8장 테스트로 줄임 |
| 창 안 페이지가 사용자를 선언 밖으로 유도(리다이렉트, 팝업) | 3장. 새 창은 항상 거부, 선언한 주소만 시스템 브라우저 | 선언한 호스트 자체가 침해되었을 때 |
| 쓰기 요청 | `getJson` 은 GET 만 표현 가능(4장). 쓰기 금지 패턴 검사는 M5 기준 4 | **GET 이 안전하다는 보장은 아니다.** 서버가 `GET /logout` 같은 부작용 경로를 가지면 `path` 로 호출할 수 있다. 경로 허용 목록은 v1 에 없다(규약 변경 필요 3) |
| 쿠키·응답 본문 유출 | 쿠키는 main 만 읽음. 플러그인에는 `{status, body}` 만. 로그 규칙(4장) | `body` 에 개인 정보가 있으면 플러그인이 `fetch` 로 선언 호스트에 보낼 수 있다(선언 호스트 안으로 한정) |
| 하위 리소스·스크립트의 외부 통신 | 막지 않음(로그인 사이트가 깨지기 때문) | 창 안의 서드파티 스크립트는 어디로든 요청할 수 있다. 플러그인이 아니라 사이트 책임 범위 |
| 피싱 창 | 호스트가 제목을 조립하고 현재 호스트를 표시(1장). `show` 에 사용자 맥락 요구(결정 3). 주소 표시줄은 없음 | 사용자가 제목을 보지 않을 수 있음 |
| 렌더러 취약점 | `sandbox: true`, 권한 요청 전부 거부, 다운로드 취소. Electron 업데이트에 의존 | 원격 페이지를 상시 로드하는 데서 오는 일반 위험 |
| **`utilityProcess` 가 OS 샌드박스가 아님** | 이 ADR 의 검사는 `PluginContext` 를 통한 경로만 막는다 | 플러그인 코드는 `node:fs` 로 `userData/Partitions/deskpet-plugin-<id>/` 의 쿠키 파일을 읽거나 `node:https` 로 직접 요청할 수 있다. Chromium 의 쿠키 암호화(Windows 에서는 OS 사용자 키 의존으로 알고 있음. **미확인**)는 같은 사용자 권한의 프로세스에게 막이 되지 않을 수 있다. 1차는 내 플러그인만 쓰므로(기획안 15장) 받아들이고, 외부 플러그인은 OS 수준 격리 ADR 이 먼저 필요하다(ADR-0005 와 같음) |
| Google 등 임베디드 브라우저 로그인 차단 | — | Google 이 Electron 같은 내장 브라우저의 로그인을 막을 수 있다. 이 저장소에서 확인한 사실이 아니라 일반적으로 알려진 동작이며 **미확인**이다. 막히면 기준 6 이 실패한다. 우회(사용자 에이전트 변경 등)는 이 ADR 이 정하지 않고 사용자 결정 5 로 올린다 |
| 대기 CPU | 숨김 창은 `backgroundThrottling` 기본, 사이트의 폴링은 통제 불가 | 기준 12 에서 측정 |

### 8. 테스트 계획

단위 테스트는 `packages/plugin-host` 에서 가짜 `SessionHost.windows`(Electron 없음)로 한다. 아래 표의 행마다 "거부 조건"을 하나씩 확인한다. 거부 테스트는 허용 예시와 쌍으로 둔다(AGENTS.md 의 형식 검사 규칙).

| 대상 | 거부해야 하는 조건 | 기대 결과 | 계층 |
|---|---|---|---|
| `windows.create` | 선언하지 않은 창 id | `E_PERMISSION` | 단위 |
| `windows.create` | `opts.url` 이 `permissions.network` 밖, `http:`, 포트, 사용자 정보, 끝 점, IP 리터럴, 서브도메인(와일드카드 아님) | `E_PERMISSION` | 단위 |
| `windows.create` | 알 수 없는 옵션 키, 범위 밖 크기, 80자 초과 `title` | `E_INVALID_ARGUMENT` | 단위 |
| `windows.create` | 같은 id 중복 / 개수 상한 초과 | `E_INVALID_ARGUMENT` / `E_RATE_LIMIT` | 단위 |
| `windows.create` | 파괴 뒤 같은 id 재생성 | 성공(허용 예시) | 단위 |
| `window.show` / `hide` / `getJson` | 없는 창 id, 다른 플러그인의 창 id | `E_INVALID_ARGUMENT` 또는 `E_PERMISSION`(구현 때 하나로 고정. 소유 여부를 알려 주지 않도록 같은 코드 권장) | 단위 |
| `window.show` | 사용자 맥락 없이 호출(결정 3 채택 시), 스케줄·`activate` 에서 호출 | `E_PERMISSION` | 단위 |
| `window.getJson` | `path` 가 `/` 로 시작하지 않음, `//evil.com/x`, `\`, 제어 문자, 2048자 초과 | `E_INVALID_ARGUMENT` | 단위 |
| `window.getJson` | 비-GET: 프로토콜에 `method`·`headers`·`body` 키를 실어 보냄 | 알 수 없는 키로 `E_INVALID_ARGUMENT`, 실제 요청은 항상 `GET` | 단위 |
| `window.getJson` | 응답 1 MiB 초과 / 20초 초과 / 동시 3건 | `E_INVALID_ARGUMENT` / `E_TIMEOUT` / `E_RATE_LIMIT` | 단위(가짜 fetch·시계) |
| `window.getJson` | 3xx 응답 | 따라가지 않고 `{status: 3xx, body: null}` | 단위 |
| `window.getJson` | dispose 뒤 호출 | `E_DISPOSED` | 단위 |
| 로그 | `getJson` 이 성공·실패해도 가짜 로거에 경로 쿼리·본문·`Set-Cookie` 문자열이 없다 | 로그 문자열에 금지 토큰이 없음 | 단위 |
| 이동 가드 함수 | 선언 밖 호스트, `http:`, `data:`, `javascript:`, 포트, 사용자 정보 | 거부 | 단위 |
| 정리 | 플러그인 종료·비활성화 시 그 플러그인의 모든 창이 정리 요청됨, 이전 핸들의 늦은 `dispose` 가 새 창을 지우지 않음 | 정리됨 | 단위 |

앱 e2e(`apps/desktop`)는 실제 `BrowserWindow` 로 확인한다. 테스트용 `https` 서버가 필요하고 `permissions.network` 는 `https` 호스트만 허용하므로, Chromium 의 `--host-resolver-rules` 로 가짜 호스트 이름을 로컬 서버로 매핑하고 인증서는 테스트 실행(`--plugins-dir` 지정)에서만 허용하는 방식을 제안한다. **이 방식이 Electron 에서 동작하는지는 미확인**이다. ADR-0005 의 `fetch` 시험 장치(`fetchPort`)처럼 승인된 검사 뒤에서 연결 대상만 바꾸는 방법이 대안이다.

| e2e 시나리오 | 확인 |
|---|---|
| 선언한 주소로 창을 열고 `getJson` | 로컬 서버가 쿠키와 `GET` 을 받고, 응답 `{status, body}` 가 플러그인에 도달 |
| 선언 밖 주소로 `create` | 거부, 창 수 0 |
| 선언한 주소가 선언 밖으로 3xx / `window.location` / `window.open` | 이동 취소, 창이 원래 주소에 남음, 시스템 브라우저 호출 없음(가짜 `openExternal` 기록) |
| 가시 창의 링크가 선언한 `openExternal` 주소일 때 | 시스템 브라우저 호출 1회, 정규화된 URL |
| 비-GET: 서버가 받은 모든 `getJson` 요청의 메서드를 기록 | 전부 `GET` |
| 없는 창 id | 오류 코드, 앱 유지 |
| 창 오류: 렌더러 강제 종료(`webContents.forcefullyCrashRenderer`) | 앱·다른 플러그인·다른 창 유지, `getJson` 은 `E_UNAVAILABLE`, 다시 `create` 하면 성공 |
| 플러그인 프로세스 종료 | 그 플러그인의 창만 사라짐 |
| 앱 종료 | 창 잔존 0, 종료 시간 안전망 안 |
| 재시작 후 쿠키 유지 | 같은 파티션에서 이전 쿠키가 서버에 도달(파티션 이름 규칙 확인) |
| 두 플러그인이 같은 호스트를 선언 | 한 쪽의 쿠키가 다른 쪽에 가지 않음 |

사람 확인(H)은 M5 기준 6 에서 실제 LMS 로그인 후 `getJson` 응답 구조(상태 값만 기록, 본문·쿠키는 기록하지 않음)와 4장의 `session.fetch` 호환성, 임베디드 로그인 차단 여부를 확인한다. 실제 LMS 호출은 이용 조건 확인 결과가 `docs/progress/` 에 기록된 뒤에만 한다(`m5-draft.md` 결정 3).

## 대안

| 주제 | 안 | 장점 | 단점 | 결정 |
|---|---|---|---|---|
| 창 종류 | **`BrowserWindow`(채택)** | 보이고 숨기기가 쉽고 `webPreferences` 를 모두 쓴다. 로그인 창으로도 쓴다 | 창 하나당 프로세스 | 채택 |
| | `WebContentsView` | 부모 창에 붙여 쓰기 좋다 | 독립 창이 없으면 로그인 UI 를 따로 만들어야 한다 | 제외 |
| | `<webview>` 태그 | — | 렌더러 안에 넣어야 하고 Electron 이 권장하지 않는다 | 제외 |
| 세션 | **플러그인 id 별 persist 파티션(채택)** | ADR-0003 규칙. 재시작 후 로그인 유지, 플러그인 간 분리 | 지우기 UI 필요 | 채택 |
| | 창마다 별도 파티션 | 더 잘게 분리 | 같은 사이트의 두 창이 로그인을 공유하지 못한다. 필요성 없음 | 제외 |
| | 메모리 파티션(`persist:` 없음) | 디스크에 쿠키가 안 남는다 | 앱을 켤 때마다 다시 로그인. 기준 7("쿠키 세션 유지")에 어긋난다 | 제외 |
| | 앱 기본 세션 | 간단 | 앱 창과 쿠키가 섞이고 분리가 없다 | 제외 |
| `getJson` 수행 | **main 의 `session.fetch`(채택, 사용자 결정 1)** | preload 불필요, 페이지 변조·현재 위치와 무관 | 서버가 `Origin` 등을 확인하면 달라 보일 수 있음(미확인) | 추천 |
| | 페이지 안 `executeJavaScript` 로 `fetch` | Jungle Bell 과 같은 방식, 같은 출처 요청 | 페이지가 `fetch` 를 가로챌 수 있고 로그인 페이지에 있으면 엉뚱한 출처로 간다. 스크립트 실행 경로를 호스트가 소유 | 대안 |
| 이동 차단 | **이벤트 가드 + `onBeforeRequest`(채택)** | 이동 방식 누락을 서로 보완 | 코드 두 곳 | 채택 |
| | `will-navigate` 만 | 간단 | `loadURL`·리다이렉트·하위 프레임 일부가 빠질 수 있다(미확인) | 제외 |
| | 모든 하위 요청도 호스트 허용 목록 | 가장 엄격 | 로그인 사이트(Google 등)의 보조 도메인을 매니페스트에 모두 적어야 한다 | 제외 |
| 새 창 | **항상 거부 + 선언 주소만 시스템 브라우저(채택)** | 앱 안에 새 창이 안 생긴다 | 일부 로그인 팝업 방식(팝업 OAuth)이 깨진다 | 채택 |
| | 앱 안에서 새 창 허용 | 팝업 로그인 지원 | 이동 가드를 창마다 복제하고 창 수가 늘어난다 | 제외 |
| 창 닫기 | **X → 숨김(채택)** | 플러그인 핸들과 일치 | 앱 종료 때만 파괴 | 채택 |
| | X → 파괴 | 단순 | 플러그인이 모르는 사이 핸들이 죽는다 | 제외 |

## 사용자 결정 (2026-10-08)

| # | 질문 | 결정 |
|---|---|---|
| 1 | `getJson` 수행 방식 | **main 의 `session.fetch`.** 서버가 `Origin` 을 확인해 실패하면 기준 6 에서 드러나므로, 그때 페이지 안 `executeJavaScript` 방식으로 바꿀지 다시 묻는다 |
| 2 | `getJson` 요청 출처 | **항상 홈 출처.** SDK 주석의 "현재 출처"는 문구만 고친다(규약 변경 필요 1) |
| 3 | `show`(및 `create` 의 `show: true`)에 사용자 액션 맥락 요구 | **요구한다.** `hide` 는 요구하지 않는다 |
| 4 | 체커 세션(쿠키) 지우기 | **M5 에서는 UI 를 만들지 않는다.** M8 마감에서 트레이 항목을 검토한다 |
| 5 | Google 등이 내장 창 로그인을 막을 때 | **막히면 그 시점에 멈추고 사용자에게 알려 다시 결정한다.** 사용자 에이전트 변경 같은 우회는 미리 허용하지 않는다 |

## 규약 변경 필요

`packages/plugin-sdk/src/v1/` 은 이 ADR 이 바꾸지 않는다. 다음은 필요성만 기록한다.

1. **`getJson` 문서 주석 (코드 변경 없음, 문구만).** "against the window's current origin" 을 "against the window's home origin (origin of the `url` passed to `windows.create`)"로 바꾸는 것을 제안한다. 타입은 그대로다. 사용자 결정 2 로 승인됐으며, `v1/` 수정 금지 규칙에 따라 이 ADR 이 아니라 별도 task 에서 사용자 확인 후 고친다. 대안: 주석을 그대로 두고 구현을 "현재 출처"에 맞추기(결정 2(b)).
2. **로그인 필요 판별 방법이 계약에 없다.** 플러그인은 `getJson` 의 `status`(401, 3xx)로만 추정한다. 창이 지금 어느 출처에 있는지 묻는 `currentOrigin()` 같은 필드는 없다. 홈 출처 고정(결정 2(a))이면 필요성이 낮아지므로 **지금은 추가하지 않는다.** 필요해지면 `CheckerWindowHandle` 에 메서드 추가(필드 추가만이므로 ADR-0003 규칙상 `apiVersion` 은 `"1"` 유지)를 별도 ADR 로 제안한다.
3. **`permissions.network` 가 "요청 보낼 호스트"와 "이동해 갈 호스트"를 구분하지 않고, 경로 제한이 없다.** 이 ADR 은 홈 출처만 요청하는 규칙으로 대응했다. `GET /logout` 같은 부작용 경로를 막으려면 창 권한에 경로 허용 목록이 필요하다(예: `permissions.windows` 를 객체로 확장). 기존 필드의 타입을 바꾸므로 `apiVersion` 상승 대상이다. `jungle` 은 경로 두 개(`/api/v2/me/cohorts`, `…/attendance/today`)만 쓰므로 M5 에는 쓰지 않고 외부 플러그인 ADR 때 다시 본다.
4. **`window.dispose` (호스트 프로토콜).** SDK 계약이 아니라 호스트-러너 메시지이므로 ADR-0005 2장의 메서드 표에 한 줄을 더하는 정도다. 6장 참고.

## 미결 사항

- Electron 버전과 `will-frame-navigate`, `session.fetch` 의 쿠키 동작, 최초 빈 문서(`about:blank`) 처리는 **확인됨(§프로토타입 결과)**. 브라우저 비밀번호 관리자 부재는 **미확인**이다(숨김 창 자동 실행만으로 제안 UI 를 판별할 수 없음). 결과에 따라 3·4장 일부가 바뀔 수 있다.
- `window.dispose` 를 새 메서드로 하나 `handle` 방식으로 하나는 구현 시점에 coordinator 가 정한다(6장).
- 없는 창 id 와 남의 창 id 에 같은 오류 코드를 쓸지(소유 여부 비노출)는 구현 때 하나로 고정한다.
- 실제 LMS 의 헤더 요구(`Origin`, `Referer`)와 응답 구조는 기준 6 의 사용자 로그인 뒤에야 알 수 있다. 그 전에는 가짜 서버로만 시험한다.
- 배포 실행에서 체커 창의 기본 위치·표시 방식(모니터, 항상 위)은 정하지 않았다. `jungle` 을 실제로 쓰며 필요하면 정한다.
- 대기 CPU 에 숨김 창이 미치는 영향은 M5 기준 12 의 측정으로 정한다.

## 프로토타입 결과 (2026-10-08)

`tools/checker-prototype/README.md` 의 한 줄 명령으로 재실행했다. Windows 의 설치된 Electron **44.5.1**과 `127.0.0.1` 임의 포트의 로컬 HTTP 서버 A·B 만 사용했다. 각 실행에서 임시 `userData`와 `persist:` 파티션을 새로 만들고 종료 시 지웠다. 실제 LMS 또는 외부 사이트에는 접속하지 않았다. 아래의 “영향”은 구현 전에 검토할 근거이며 3·4장 본문은 이 프로토타입 작업에서 수정하지 않았다.

### 1. 이동·리다이렉트·팝업 이벤트

| 실제 동작 | 결과 | ADR 설계에 미치는 영향 |
|---|---|---|
| 같은 출처 링크 클릭 | 주 프레임 `will-frame-navigate` 다음 `will-navigate` 발생. B 링크는 `will-navigate.preventDefault()`만으로 막혔고 A 문서에 남았다 | 주 프레임 링크 차단 지점으로 `will-navigate` 사용 가능 |
| `location.href`를 B로 변경 | 주 프레임 `will-frame-navigate` 발생. 여기서 `preventDefault()`하자 `will-navigate`까지 가지 않고 A에 남았다 | `will-frame-navigate`에서도 주 프레임을 검사해야 하며, 선행 이벤트가 막으면 후속 이벤트는 없는 것이 정상 |
| A의 302가 B로 이동 | `loadURL(A/redirect-b)`에서 `will-redirect` 발생. `preventDefault()`로 B 도착을 막았다 | 서버 리다이렉트 차단은 `will-redirect`에서 가능. `loadURL` 최초 요청은 `will-navigate`로 관찰되지 않았다 |
| A의 302가 A로 이동 | `will-redirect`, 이어 `did-redirect-navigation` 발생. 후자에서 `preventDefault()`를 호출해도 A의 목적지에 도착했다 | `did-redirect-navigation`은 관찰용이며 차단 지점으로 쓰지 않는다 |
| iframe의 A→B 이동 | 하위 프레임(`isMainFrame: false`)의 `will-frame-navigate`에서 막혔고 iframe은 A에 남았다 | 하위 프레임 검사에 이 이벤트를 쓸 수 있다 |
| `window.open(B)`와 `target="_blank"` 링크 | 둘 다 `setWindowOpenHandler` 호출, `{action: "deny"}` 뒤 창 수 1개 유지. `details.userGesture`는 양쪽 모두 제공되지 않았고 `disposition`도 둘 다 `foreground-tab`이었다 | 팝업 거부는 가능하지만 이 핸들러의 관찰값만으로 스크립트 호출과 실제 사용자 클릭을 구분할 근거가 없다. 가시성만으로 시스템 브라우저 위임을 승인하면 스크립트 팝업도 위임될 수 있다 |

### 2. 최초 로드와 특수 URL

| 실제 동작 | 결과 | ADR 설계에 미치는 영향 |
|---|---|---|
| 새 숨김 창의 `loadURL(A/home)` | 주 프레임 `will-navigate` 없음. 페이지의 초기 iframe 로드에는 하위 프레임 `will-frame-navigate` 발생 | 최초 URL은 `loadURL` 호출 전에 별도로 검사해야 한다 |
| main의 `loadURL("about:blank")`, `loadURL("data:…")` | 둘 다 로드됐으며 위 `will-*` 이벤트 없음 | 호스트가 호출하는 `loadURL`의 입력을 호출 전에 검사해야 한다 |
| A 페이지가 `location.href = "about:blank"` 실행 | `will-navigate`·`will-frame-navigate`·`onBeforeRequest(<all_urls>)` 모두 없음. `did-start-navigation`만 발생하고 실제로 `about:blank`에 도착 | 계획한 이벤트 가드와 요청 가드만으로 이 이동을 차단할 수 없다. 구현 전 추가 통제 방식을 정해야 한다 |
| A 페이지가 `location.href = "data:…"` 실행 | 위 이벤트와 요청 없음, A에 남음. `about:blank` 페이지에서도 같은 실행은 `data:`에 도착하지 않음 | 이 실험에서는 페이지 스크립트의 `data:` 이동이 성립하지 않았으나, main의 `loadURL(data:)`는 성립했다. 일반적인 `data:` 차단 보장으로 확대하지 않는다 |

### 3. 파티션 쿠키와 `session.fetch` 제한

| 실제 동작 | 결과 | ADR 설계에 미치는 영향 |
|---|---|---|
| A의 `Set-Cookie` 후 같은 persist 파티션의 `session.fetch(A/echo, {credentials: "include"})` | A가 쿠키를 받음(참) | 4장의 파티션 세션 `fetch` 방식은 이 조건에서 동작한다 |
| 다른 persist 파티션에서 A로 동일 요청 | A가 쿠키를 받지 않음(참) | 플러그인별 파티션 분리의 근거가 된다 |
| 원래 파티션에서 **다른 포트**의 B로 동일 요청 | B도 A의 쿠키를 받음(“B에는 붙지 않는다”는 거짓). 두 URL은 모두 호스트 `127.0.0.1`이었다 | 쿠키는 포트별로 격리되지 않는다. 4장의 홈 **출처** 고정 검사가 B 요청을 막아야 하며, 포트 차이를 쿠키 격리 근거로 삼을 수 없다 |
| 스트림 읽기 1 MiB 상한 | 1,048,577바이트 응답을 읽다가 초과 판정 후 스트림 취소 | 4장의 크기 제한 구현 가능 |
| `AbortController` 20초 상한 | 응답을 끝내지 않는 로컬 경로가 `AbortError`로 중단됨. 로컬 Windows/Electron 44.5.1 완성 실행에서 관찰한 최댓값은 20,105ms | 4장의 시간 제한 구현 가능. 경계의 정확한 밀리초 보장은 하지 않는다 |

### 4. 숨김 창과 비밀번호 UI

`show: false`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, preload 없음으로 A 페이지가 로드되고 쿠키가 설정됐다(참). `getLastWebPreferences()`도 위 설정을 반환했다. 따라서 1장의 숨김 창 구성과 2장의 쿠키 세션 생성은 이 조건에서 가능하다. 로그인 폼의 `input type=password`는 로드했지만 창을 보이지 않고 실제 계정 로그인도 하지 않았으므로 Electron의 저장 제안·자동 완성 UI 제공 여부는 **미확인**이다. 2장의 “비밀번호 관리자 부재” 추정은 확정 근거로 쓰지 않는다.

### 5. 닫기와 크래시

`window.close()` 후 `closed` 이벤트가 왔다. 별도 창에서 `forcefullyCrashRenderer()` 후 `render-process-gone`의 이유는 `crashed`였고, 이어 창을 파괴하자 `closed`가 왔다. 두 경우 모두 main은 다음 동작을 실행하고 정상 종료했다. 5장의 창 단위 정리·재생성 설계가 이 이벤트를 사용할 수 있다. 자동 `closed`가 렌더러 크래시만으로 발생하는지는 확인하지 않았고, 프로토타입은 크래시 이벤트 뒤 명시적으로 창을 파괴했다.

### 3·4장과 어긋나는 문장(본문 수정 보류)

- 3장 “`about:blank`, `data:`, `blob:`, `file:`, `javascript:`, `http:` 이동은 모두 막는다”: `about:blank` 페이지 이동은 현재 적힌 두 가드 모두 거치지 않았다. `data:`의 main `loadURL`도 가드를 거치지 않았다.
- 3장 “`session.webRequest.onBeforeRequest` … 이것이 최종 방어선이다”: `about:blank` 페이지 이동에서 `<all_urls>` 요청이 발생하지 않았다.
- 3장 “보이는 창에서 사용자가 누른 링크만 시스템 브라우저로 넘어간다”: `setWindowOpenHandler`의 관찰값에 사용자 제스처가 없어 스크립트 `window.open`과 링크 클릭을 구별할 수 없었다.

## 결정 변경 (2026-10-08, D-028)

프로토타입에서 `setWindowOpenHandler` 가 스크립트 팝업과 실제 클릭을 구별하지 못함이 확인되어, 3장의 "보이는 창이면 선언한 주소만 시스템 브라우저로 넘긴다"를 **폐기**한다. `setWindowOpenHandler` 는 항상 `{ action: "deny" }` 를 반환하고 `shell.openExternal` 을 호출하지 않으며, 로그에는 호스트 이름만 남긴다. 8장의 e2e "가시 창의 링크가 선언한 `openExternal` 주소일 때" 행은 "어떤 새 창 요청도 시스템 브라우저를 호출하지 않는다"로 바꾼다.

`about:blank` 로의 페이지 스크립트 이동은 요청이 발생하지 않아 이벤트 가드로 막을 수 없다. 구현은 `did-start-navigation` 에서 허용 밖 주 프레임 URL 이면 `webContents.stop()` 후 홈 URL 을 다시 로드하는 것을 최선으로 시도하고, 막히지 않는 경우는 남는 위험으로 둔다(빈 문서는 네트워크·데이터가 없다). 호스트가 호출하는 `loadURL` 의 입력은 호출 전에 `allowedNetworkUrl` 로 검사한다.
`window.dispose` 는 별도 메시지 `window.dispose {id, generation}` 으로 한다(6장).

## 구현 중 확인된 변경: `getJson` 은 `net.request` (2026-10-08, 사용자 결정 1의 취지 유지)

Electron 44.5.1 에서 `session.fetch(url, { redirect: "manual" })` 은 3xx 응답을 돌려주지 않고 오류를 던진다(서버는 첫 요청만 받고 리다이렉트를 따라가지 않음. 로컬 서버로 확인). 4장의 "3xx 를 `{status, body: null}` 로 돌려준다"를 만족시킬 수 없어, 구현은 main 의 `net.request({ session: 체커 파티션 세션, method: "GET", redirect: "manual", useSessionCookies: true })` 의 `redirect` 이벤트에서 상태 코드만 받는다. 사용자 결정 1(main 이 파티션 세션으로 직접 요청, 페이지 스크립트 미실행)은 그대로다. 헤더는 `Accept: application/json` 만, 본문 1 MiB·20초 제한, 돌려주는 값은 `{status, body}` 뿐인 것도 같다.

## 구현 중 확인된 변경: 승인된 권한의 단일 출처 (Astra 리뷰)

`SessionHost.windows.create` 가 세션의 승인된 `permissions.network`/`windows` 와 플러그인 이름을 인자로 받는다. 창 관리자는 별도 매니페스트 스캔을 하지 않으므로 사용자가 승인한 권한과 창 가드가 쓰는 호스트가 어긋날 수 없다.

## 사용 방식 갱신: jungle 의 창 하나 (2026-10-08, D-039·D-040)

실사용에서 두 가지가 드러났다. (1) [출석 페이지 열기]가 시스템 브라우저로 열리면 브라우저의 로그인과 체커 창의 로그인이 따로 놀아, 사용자가 로그아웃해도 앱이 알 수 없었다. (2) 같은 플러그인의 창 둘(조회용과 출석용)이 같은 파티션을 동시에 쓰자 조회 결과가 몇 초 간격으로 ok 와 401 을 오갔다(웹앱 토큰 갱신 충돌로 추정, 미확정). 그래서 jungle 은 창 `lms-checker` 하나만 쓰고, 시작 주소를 `/check-in` 으로 둔다. 사용자 액션([로그인]·[출석 페이지 열기])은 기존 창을 dispose 하고 같은 id 로 새로 만들어 `show: true` 로 연다(낡은 화면 방지, 5장의 세대 추적이 늦은 dispose 를 막는다). 새 창의 세션이 이후 조회에도 쓰인다. 플러그인 매니페스트에서 `openExternal` 권한은 제거했다. 호스트 계약(3·4·5장)은 바뀌지 않는다.
