# ADR 0011: Slack 플러그인

## 상태

승인 (2026-10-12, D-062), 구현 완료 (M10 조정 종료, 2026-10-12, D-064). 구현 결과는 끝의 "구현에서 확정·변경된 점"에 있다. 끝의 "사용자에게 물을 질문" 6개는 답을 받았다(질문 4만 추천안에 설정 하나를 더함). 연결 방식은 A(호스트 중개 Socket Mode)다. 새 규약 버전(v2)의 구체적인 API·메시지 봉투·수명주기는 구현 첫 task 에서 이 ADR 에 덧붙이고 coordinator 확인 뒤 사용자 gate 를 받는다. 구현과 Slack 앱 설치는 이 ADR의 범위가 아니다.

표기: **코드 확인**은 이 작업에서 저장소를 직접 읽어 확인한 사실(경로·줄 번호), **공식 문서 확인**은 아래에 연결한 Slack 문서의 사실, **추측**은 실제 워크스페이스 또는 구현으로 확인하지 못한 가정이다. 줄 번호는 이 초안을 쓰던 `m10-adr-slack` 작업 트리 기준이다.

## 배경과 현재 경계

M10은 한 워크스페이스에서 **나를 멘션한 메시지와 나에게 온 DM**을 30초 안에 말풍선으로 보여 주고, 지정 채널·키워드도 선택적으로 받는다. 답장·반응·읽음 처리·과거 메시지 불러오기는 범위 밖이다(코드 확인: `docs/progress/milestones.md:517-550`). 기존 기획안은 Socket Mode와 `xapp-`·`xoxb-`를 가정한다(코드 확인: `docs/plan.md:417-421`). 이 ADR은 **나**를 봇이 아닌 설치 사용자로 해석하므로, 사용자 토큰이 필요한 이유를 아래에 적는다.

- 규약 v1에는 `network`, `openExternal`, `secrets` 권한과 `ctx.fetch`가 있으나 WebSocket API가 없다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:4-9`, `:82-113`). 호스트가 지원하는 `apiVersion`도 현재 `"1"`뿐이다(코드 확인: `packages/plugin-host/src/discover.ts:13`, `:45`; ADR-0003 `docs/adr/0003-plugin-manifest-and-api-v1.md:32-34`). `packages/plugin-sdk/src/v1/`은 고치지 않는다.
- `ctx.fetch`는 GET·HEAD만 자동 경로에서 허용하고, POST 등은 사용자 버튼·트레이 액션의 열린 호출 안에서만 허용한다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:107-108`, `packages/plugin-host/src/session.ts:378-385`; ADR-0005 `docs/adr/0005-plugin-host.md:70-79`). 호스트는 응답 본문을 전부 읽어 전달하므로 이벤트 스트림으로 쓸 수 없다(코드 확인: `packages/plugin-host/src/session.ts:104-125`, `:422-427`; ADR-0005 `docs/adr/0005-plugin-host.md:51`).
- `utilityProcess`는 OS 샌드박스가 아니다. 플러그인이 Node의 WebSocket/네트워크 API를 직접 열면 `PluginContext`의 허용 호스트 검사를 우회한다(코드 확인: `docs/adr/0005-plugin-host.md:11`, `apps/desktop/src/plugin-runner/index.ts:1-9`, `packages/plugin-host/src/permissions.ts:4-17`). **직접 WebSocket 연결은 설계 대안에서 제외한다.**
- 호스트의 네트워크 허용 규칙은 HTTPS, 기본 포트, 정확히 선언된 호스트만 받으며 IP와 끝 점 호스트를 거부한다(코드 확인: `packages/plugin-host/src/permissions.ts:4-17`). 외부 링크도 HTTPS·기본 포트·정확한 호스트와 선언된 경로를 요구하며, 사용자 액션 중에만 열린다(코드 확인: `packages/plugin-host/src/permissions.ts:20-28`, `docs/adr/0005-plugin-host.md:73`, `:159`).

## 결정 제안: 연결 방식

**추천: A, 호스트가 검증하는 Socket Mode를 M10의 목표 방식으로 채택한다.** 사용자 멘션과 DM을 이벤트로 받으면 채널 수에 비례해 조회할 필요가 없고 30초 목표에 가장 가깝다. 단, 이는 **현행 v1에서 구현 가능한 방식이 아니다.** 자동 `apps.connections.open` POST와 WebSocket 확인 응답(ack)은 현행 메서드 규칙 및 “외부 시스템 쓰기 요청은 버튼 액션만” 코드 지침과 충돌할 여지가 있다. 사용자에게 아래 질문 1의 좁은 **연결 관리 예외**를 승인받기 전에는 구현하지 않는다. 예외가 거절되면 B를 소규모 워크스페이스용 대안으로 다시 승인받고 30초 목표의 적용 범위를 정한다.

| 방식 | 예상 지연·요청 수 | 권한·보안 | 규약 변경 / 구현 범위 |
|---|---|---|---|
| **A. 호스트 중개 Socket Mode (추천)** | 이벤트 전달은 폴링 주기 없이 진행. Slack·네트워크·화면 큐 지연 때문에 30초 보장은 실사용 측정 필요(추측). 연결 생성 시 `apps.connections.open` POST 1회, 갱신·재연결 때 추가; 메시지마다 Socket Mode ack 프레임 1개. | `slack.com`의 POST와 반환된 `wss` URL을 **main**에서 별도 검사. 임의 `wss` 호스트·리다이렉트·포트 금지. 티켓 URL과 토큰은 플러그인에 넘기지 않고, 승인된 연결 권한을 단일 출처로 사용. | 새 버전의 **호스트 관리 이벤트 연결** 권한/API·메시지 봉투·수명주기 제안. `apiVersion: "2"`로 분리하고 호스트는 1과 2를 함께 지원하는 방안(ADR-0003 버전 정책). v1 폴더는 보존. 연결 관리 POST/ack는 일반 `ctx.fetch` 예외로 풀지 않는다. |
| **B. v1 `ctx.fetch` GET 폴링** | 30초 간격이면 `conversations.history`가 **대화당 분당 2회**. Tier 3의 공개 최소치 50+/분이면 이론상 25개 대화가 상한이며, 페이지·다른 조회·여유를 빼면 더 적다. 실제 지연은 최대 한 주기+응답·검색 색인 지연(추측). | `slack.com`만 `permissions.network`에 선언하고 Bearer 헤더를 사용. `xoxp-`로 설치 사용자가 볼 수 있는 대화 조회. 호스트 검사 통과, 규약 변경 없음. | 대화 목록·각 대화 커서·페이지·스레드·검색 결과 누락을 관리해야 한다. 많은 채널/DM에서 30초 목표를 보장할 수 없다. |
| **C. 공개 HTTPS Events API 수신/중계 서버** | 이벤트형으로 지연은 작을 수 있으나(추측) 공개 엔드포인트 운영과 PC 전달 경로가 필요. PC가 다시 중계 서버를 조회하면 그 폴링 지연이 붙는다. | 메시지 본문이 별도 서버를 통과하고 서명 검증·접근 통제가 추가된다. 직접 수신은 PC의 공개 URL이 필요하다. | 제품 범위의 서버·운영·테스트가 새로 필요해 M10에는 추천하지 않는다. [Slack의 전송 방식](https://docs.slack.dev/apis/events-api/)은 Socket Mode 또는 공개 HTTP URL이다. |

**A의 프로토콜 경계.** [Slack `apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open/)은 `POST https://slack.com/api/apps.connections.open`과 `Authorization: Bearer xapp-…`만 문서화하며 GET은 `insecure_request` 오류다. 새 v2 권한은 일반 `network` 확대가 아닌 `socketMode: ["slack.com"]`처럼 **서비스를 지정하는 별도 승인값**을 제안한다. 호스트가 승인값으로 `slack.com`의 고정 엔드포인트에만 요청하고, TLS로 받은 일시적 URL을 `wss`, 기본 포트, 사용자 정보 없음, `slack.com`의 하위 호스트, `/link/` 경로로 재검사한 뒤 연결한다. 이는 반환 URL의 동적 하위 호스트를 Slack 응답에 **한정해서 신뢰 위임**하는 새 권한 의미다. 문서는 URL이 동적으로 바뀐다고만 하므로 **이 조건이 모든 실제 연결 URL을 포괄하는지는 확인 못함(추측)**. 실제 응답과 Slack의 공식 보장 범위를 구현 전에 조사하고, 조건이 맞지 않으면 A를 보류한다. [Socket Mode 문서](https://docs.slack.dev/apis/events-api/using-socket-mode/)는 `envelope_id` ack와 주기적 연결 갱신을 요구한다. ack는 메시지 게시가 아닌 수신 확인이지만 외부 송신이므로 질문 1에서 명시적으로 다룬다.

**B의 GET 가능 범위.** [users.conversations](https://docs.slack.dev/reference/methods/users.conversations/)는 GET, Tier 3(50+/분)이며 `types=public_channel,private_channel,im,mpim`과 커서로 대화를 찾는다. [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)는 GET, 보통 Tier 3(50+/분)이며 대화별 `oldest`/커서로 새 메시지를 조회한다. 스레드 답글은 [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/) GET이 따로 필요하다. [search.messages](https://docs.slack.dev/reference/methods/search.messages/)는 GET, Tier 2(20+/분), **사용자 토큰 `search:read`만** 받는다. 멘션·키워드 검색의 보조 수단일 수 있으나 Slack이 이를 legacy 방법이라 부르고 가까운 여러 일치 항목을 하나로 반환할 수 있다고 밝히므로 단독 알림 원천으로 삼지 않는다. 검색이 `<@내 ID>`·DM을 완전하고 30초 안에 반환하는지는 **추측**으로 남겨 실사용 시험이 필요하다. 이 API들은 모두 `Authorization` 헤더로 토큰을 보내고 URL 쿼리에는 넣지 않는다.

2025-05-29 이후 **상업적으로 Marketplace 밖에 배포한 앱**의 `conversations.history`·`conversations.replies`는 1회/분·최대 15개로 줄었다. [Slack의 정정 공지](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)와 [방법 문서](https://docs.slack.dev/reference/methods/conversations.history/)는 **고객이 직접 만든 내부용 앱은 이 변경 대상이 아니며 Tier 3**라고 명시한다. M10의 개인/사내용 설치가 Slack에서 실제로 이 분류를 받는지는 설치 방식에 달려 있어 관리자 확인이 필요하다. 대상이 되면 30초마다 여러 대화를 조회하는 B는 불가능하다. [요청 한도 문서](https://docs.slack.dev/apis/web-api/rate-limits/)의 Tier 수치는 최소 가이드이며 방법·워크스페이스·앱 단위로 적용된다.

## 토큰·권한과 설정

**추천 토큰은 `xapp-`와 설치 사용자 `xoxp-` 2개다.** `xapp-`에는 Socket Mode의 [`connections:write`](https://docs.slack.dev/reference/scopes/connections.write/)만 부여한다. `xoxp-`에는 구독할 대화 유형의 `channels:history`(공개 채널), `groups:history`(비공개 채널), `im:history`(1:1 DM), 필요한 경우 `mpim:history`(그룹 DM)를 요청한다. [`message.*` 이벤트](https://docs.slack.dev/reference/events/message/)는 해당 유형의 history scope를 요구하고 [Events API](https://docs.slack.dev/apis/events-api/)는 승인한 사용자의 관점에서 이벤트를 준다. 공개/비공개 채널을 쓰지 않으면 해당 scope와 구독을 빼며, 그룹 DM을 받지 않으면 `mpim:history`도 뺀다. 보낸 사람 이름 표시에는 [`users:read`와 `users.info` GET](https://docs.slack.dev/reference/methods/users.info/), 채널 이름 조회에는 해당 유형의 `*:read`와 [`conversations.info` GET](https://docs.slack.dev/reference/methods/conversations.info/)을 **필요할 때만** 추가한다. 없거나 조회 실패하면 ID를 표시한다. 이메일 scope와 모든 `*:write`는 요청하지 않는다.

`xoxb-` 봇 토큰만 쓰면 봇이 참여한 대화와 **봇에게 온** DM만 볼 수 있다([Slack 토큰](https://docs.slack.dev/authentication/tokens), [users.conversations](https://docs.slack.dev/reference/methods/users.conversations/)). [`app_mention`](https://docs.slack.dev/reference/events/app_mention/)도 사용자가 아닌 **앱/봇 멘션**이다. 따라서 기존 기획안의 `xoxb-`만으로는 M10의 “나를 멘션”·“나에게 온 DM”을 만족하지 못한다. 봇 초대 방식으로 목표를 바꾸는 경우에만 `xoxb-`를 다시 검토한다.

매니페스트 제안: `permissions.network: ["slack.com"]`(이름 조회용 GET 및 B 대안), v2 `permissions.socketMode: ["slack.com"]`, `permissions.secrets: true`, `permissions.openExternal: ["https://app.slack.com/client/*"]`, `permissions.shell`·`windows` 없음. B를 선택하면 `xoxp-`에 대화 발견용 `channels:read`·`groups:read`·`im:read`(필요하면 `mpim:read`)도 주고, 검색을 시험할 때만 `search:read`를 더한다. 설정 폼은 `appToken`·`userToken`을 `secret: true`로 선언하고 `ctx.secrets.get`으로만 읽는다. 일반 설정에는 내 Slack 사용자 ID, 지정 채널 ID 목록, 키워드 목록, “멘션만 알림”을 둔다. 토큰 값은 `ctx.config`, `settings.json`, 상태 파일에 넣지 않는다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:55-60`, `:103-108`; `apps/desktop/src/main/settings-service.ts:216-246`; `packages/plugin-host/src/secrets-store.ts:113-125`; `apps/desktop/src/main/plugin-bridge.ts:63-68`). `safeStorage`를 사용할 수 없으면 평문으로 대체하지 않고 저장·활성화를 실패시킨다(코드 확인: `packages/plugin-host/src/secrets-store.ts:113-123`). 내 사용자 ID는 Slack의 “멤버 ID 복사”로 입력할 수 있다([Slack 서식 안내](https://docs.slack.dev/messaging/formatting-message-text/)). `users:read`가 승인됐다면 [`users.info` GET](https://docs.slack.dev/reference/methods/users.info/)으로 사용자 토큰의 유효성은 확인할 수 있다. 토큰 **소유자**와 입력 ID가 같은지 자동 검증하려면 [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)가 POST 전용이므로 별도 연결 관리 예외가 필요하다. 승인 전에는 설정 검증과 실사용 확인을 요구한다.

## 받을 메시지와 표시

Socket Mode에서 사용자 관점의 `message.channels`·`message.groups`·`message.im`(그룹 DM을 켜면 `message.mpim`)을 구독한다. 메시지의 `user === 내 사용자 ID`, `bot_id`/`bot_profile` 존재, `subtype: bot_message` 및 일반 새 메시지가 아닌 변경·삭제·시스템 subtype은 제외한다([메시지 이벤트](https://docs.slack.dev/reference/events/message/), [봇 메시지](https://docs.slack.dev/reference/events/message/bot_message/)). 같은 이벤트의 재전달은 `event_id` 또는 `(team_id, channel, ts)`로 메모리에서 중복 제거한다. 첫 연결 때 과거 기록을 역조회하지 않는다.

나를 멘션한 메시지는 원문의 `<@내 사용자 ID>` 토큰으로 판정한다. DM은 `message.im`의 다른 사람이 보낸 일반 메시지로 판정한다. 지정 채널·키워드 규칙은 채널 ID가 목록에 있고 텍스트에 설정 키워드가 포함되면 추가로 알린다. **“멘션만 알림”을 켜면** 채널/키워드 일반 알림은 끄고 멘션과 DM은 유지한다(이 이름이 DM까지 끄는 뜻인지는 질문 3). 여러 규칙에 해당하는 한 메시지는 한 번만 알린다. 스레드 답글·파일만 있는 메시지의 정확한 이벤트 모양과 멘션 누락 가능성은 가짜 서버와 실사용에서 확인한다(추측).

말풍선은 `보낸 사람 · #채널(또는 DM)`과 **최대 120자** 미리보기, `[Slack 에서 열기]`를 제안한다. 길이는 화면 검증 전의 **추측**이며 렌더링된 유니코드 문자 기준으로 자르고 끝에 `…`를 붙인다. Slack `mrkdwn`의 `<@U…>`·`<@W…>`는 조회된 표시 이름 또는 `@ID`, `<#C…>`는 채널 이름 또는 `#ID`, `<https://…|라벨>`은 라벨, `<https://…>`은 짧은 URL 설명으로 평문 변환한다([Slack 서식](https://docs.slack.dev/messaging/formatting-message-text/)). HTML/임의 링크를 말풍선의 실행 가능한 마크업으로 넣지 않고 줄바꿈·제어 문자를 정리한다. 미리보기를 원치 않으면 후속 설정으로 숨길 수 있게 할지는 질문 4로 남긴다.

본문·토큰·WebSocket 티켓 URL은 로그, 예외 원문, 오류 기록, 영구 state, `/status`에 남기지 않는다. 캐시도 이름/채널 ID와 마지막 본 ts 등 최소 정보만 메모리에 두고 재시작 시 버린다. PetEvent의 말풍선 텍스트는 표시를 위해 일시적으로 들어가므로 기존 큐의 보존·기록 경로를 구현 때 확인한다(추측). 상태에는 `연결 중/연결됨/다시 연결 중/토큰 확인 필요` 같은 고정 코드만 보낸다. `ctx.log`에는 고정 오류 코드·횟수만 쓴다.

`[Slack 에서 열기]`는 사용자 버튼 액션에서 `ctx.openExternal`을 호출한다. 기본 URL은 Slack이 안내하는 **채널 경로** `https://app.slack.com/client/<team_id>/<channel_id>`로 구성하고, 두 ID의 형식을 검증한다([Slack URL/ID 안내](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID)). 정확한 메시지 링크는 [`chat.getPermalink` GET](https://docs.slack.dev/reference/methods/chat.getPermalink/)으로 얻을 수 있지만 반환 호스트가 워크스페이스별 `…slack.com`이라 현재 `openExternal`의 **매니페스트 정확 호스트** 규칙과 맞지 않는다. 메시지 위치까지 여는 새 권한 설계는 승인 없이는 추가하지 않는다. 이 제약을 감안한 기본값이 채널 열기이며, 사용자가 기대하는 이동 위치는 질문 5다.

## 재연결·한도·오류

- Socket Mode의 `warning`/`refresh_requested`/끊김에서는 이전 연결을 닫고 새 연결을 호스트가 만든다([Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)). 재연결은 지수 백오프와 무작위 분산을 쓰고, 온라인 복귀 때 재시도한다. **초기·최대 대기 시간은 추측으로도 고정하지 않는다.** 구현 전 가짜 서버의 끊김·복귀 지연, Slack 연결 생성 응답, M10의 30초 목표를 측정해 코드 주석에 조건과 최댓값을 적는다. 새 연결이 살아난 후 이전 연결 정리가 새 연결을 지우지 않도록 세대 번호를 확인한다.
- GET 방식도 동일하게 실패 시 백오프하되, 대화별 마지막 ts를 성공적으로 처리한 메시지 뒤에만 전진시킨다. HTTP 429면 [`Retry-After` 초](https://docs.slack.dev/apis/web-api/rate-limits/) 이상 그 **메서드·워크스페이스**의 요청을 멈추고, 다른 메서드의 한도와 구분한다. 헤더가 없거나 잘못됐으면 측정한 기본 백오프를 적용한다. Slack의 `ok: false`도 처리한다.
- `invalid_auth`, `token_revoked`, `token_expired`, `not_authed` 등 토큰 오류는 `토큰 확인 필요` 상태로 바꾸고 연결 재시도를 중단한다. 고정 문구 **“토큰 확인 필요”**를 설정된 토큰 값 한 세대당 한 번만 알린다. 설정에서 토큰을 다시 저장하면 세대를 올리고 상태·알림 횟수를 초기화한다. 권한 부족(`missing_scope`)은 별도 고정 상태와 설정 안내로 처리한다. 토큰·응답 본문은 오류 메시지로 전달하지 않는다.

## 검증 계획

실제 Slack에 요청을 보내지 않는 가짜 서버 e2e를 2단계에 만든다. 현재 허용 호스트 검사는 `https`·기본 포트·호스트 이름을 요구하므로 `https://127.0.0.1:<임의 포트>`를 매니페스트에 넣는 방법은 거부된다(코드 확인: `packages/plugin-host/src/permissions.ts:4-17`). e2e 전용 `DesktopApp.launch` 경로에서 **호스트가 권한 검사를 마친 뒤** `https://slack.com` 요청과 Socket Mode 프레임을 루프백 가짜 서버로 전달하는 테스트 전용 전송 어댑터를 주입하는 방안을 제안한다. 운영 빌드에는 이 경로를 싣지 않고, OS hosts 파일·신뢰 저장소·실제 Slack DNS를 바꾸지 않는다. 가짜 서버는 요청 메서드·Authorization 헤더·대상 호스트, WebSocket ack, 끊김, 429/`Retry-After`, 토큰 오류를 기록한다. 허용되지 않은 호스트가 **어댑터에 닿기 전에** 막히는 것도 확인한다. 이 전송 방법은 구현 전 호스트 구조와 함께 검증할 **추측**이다.

e2e는 실제 사용 진입점인 설정 폼에서 토큰 저장→앱 활성화→가짜 이벤트를 넣고, 말풍선의 보낸 사람·채널·미리보기·버튼, 버튼이 여는 창/URL, `/status`, 토큰 오류 알림 1회를 직접 단언한다. 내 메시지·봇·일반 채널 메시지·멘션만 설정·중복·묶음·방해 금지/전체 화면 보류도 확인한다. 훅은 효과 완료 뒤 응답하게 한다. 보안 검사는 `settings.json`·로그·오류 기록·state에 토큰/본문이 없음을 확인한다. 실사용 기준 9에서는 관리자 승인된 내부 앱으로 채널·DM을 보내 30초 목표와 연결 호스트를 측정한다.

## 사용자에게 물을 질문

**답(2026-10-12, D-062):** 1 예(연결 열기 POST·수신 ack 두 동작만 호스트가 자동 송신, v2 권한에 묶음) · 2 사용자 토큰 `xoxp-` · 3 DM 유지 · 4 표시(120자) **+ "본문 숨기기" 설정을 이번에 함께 넣는다** · 5 채널/DM 열기 · 6 개인 테스트 워크스페이스(본인이 관리자)에 내부용 앱으로 시작.

1. **Socket Mode를 위해 호스트의 연결 관리 POST(`apps.connections.open`)와 WebSocket 수신 ack만 자동 외부 송신 예외로 승인할까요?** 추천: 예, 두 동작만 새 권한/API에 묶는다. 이유: v1 폴링으로는 채널 수가 늘 때 30초 목표를 유지하기 어렵고, 메시지 게시 권한은 열지 않아도 된다.
2. **사용자 토큰(`xoxp-`)으로 본인 대화를 감시할까요, 봇을 초대해 봇 대상 메시지만 볼까요?** 추천: 사용자 토큰. 이유: “나를 멘션”과 “나에게 온 DM”이라는 완료 기준을 그대로 충족한다.
3. **“멘션만 알림”에서 DM도 끌까요?** 추천: DM은 유지한다. 이유: DM은 멘션 표기가 없어도 나에게 직접 온 메시지다.
4. **말풍선에 본문 미리보기(제안 120자)를 기본 표시할까요?** 추천: 표시한다. 이유: M10의 미리보기 완료 기준을 충족하며 길이는 화면 테스트로 조정할 수 있다.
5. **`[Slack 에서 열기]`가 현재 권한으로 가능한 채널/DM을 열어도 될까요?** 추천: 먼저 채널/DM을 연다. 이유: 메시지별 permalink는 워크스페이스별 호스트를 반환해 현재 정확 호스트 권한에 맞지 않는다.
6. **이 Slack 앱을 워크스페이스 내부용 앱으로 만들고 관리자 승인을 받을 수 있나요?** 추천: 내부용 한 워크스페이스에서 시작한다. 이유: scope와 설치 정책을 확인하고, GET 대안의 2025년 한도 분류도 확정할 수 있다.

## v2 규약 상세 (D-062 후속 설계)

이 절은 연결 방식 A의 구현 계약이다. 아래의 코드 경로·줄 번호는 2026-10-12 작업 트리에서 직접 확인한 **현행 코드**이고, 새 API·파일 배치·전송 경계는 아직 구현하지 않은 **설계**다. 실제 Slack 응답이나 Electron 안의 WebSocket 동작처럼 이 작업에서 실행해 확인하지 않은 사항은 **추측**으로 표시한다. 기존 결정과 v1 동작은 유지한다.

### 1. 버전과 매니페스트 검증

`packages/plugin-sdk/src/v1/`은 그대로 둔다. 새 `packages/plugin-sdk/src/v2/contracts.ts`, `schemas.ts`, `index.ts`에 v2 전용 `PluginManifest`(`apiVersion: "2"`), `PluginPermissions`, `PluginContext`, `PluginDefinition`과 스키마를 둔다. v2는 v1의 공통 타입을 필요한 만큼 재사용하되, **v1 전체를 v2 이름으로 다시 내보내지 않는다**. 특히 v2 `PluginContext`의 `secrets.get`을 그대로 상속하면 토큰을 플러그인에 넘기지 않는 결정과 충돌한다. v2에서는 비밀 값 읽기를 노출하지 않고 아래의 호스트 중개 API로 키 이름만 보낸다. v1 import 및 기존 `definePlugin`/스키마 export는 그대로 두고, `@deskpet/plugin-sdk/v2` 서브패스와 v2용 `definePlugin`을 추가한다. 현재 패키지 exports에는 `.`와 `./testing`만 있으므로 `packages/plugin-sdk/package.json:7-16`이 변경 지점이다. 이 파일 변경은 **후속 구현 task**에만 속한다.

호스트의 `validatePluginManifest`는 `apiVersion`을 먼저 판별하여 v1 입력은 기존 v1 검증으로, v2 입력은 v2 스키마/검증으로 보내고 결과를 판별 가능한 합집합으로 돌려준다. 필수 필드, 알 수 없는 권한 거부, 권한 배열의 형식 검사는 현재 `packages/plugin-sdk/src/index.ts:27-78`, v1 `apiVersion: "1"`과 권한 목록은 `packages/plugin-sdk/src/v1/schemas.ts:7-27`, v1 타입은 `packages/plugin-sdk/src/v1/contracts.ts:3-26`에 있다. `packages/plugin-host/src/discover.ts:4-5,41-46`의 검증 호출·오류 매핑과 `SUPPORTED_API_VERSIONS`(`:13`)를 `"1" | "2"`에 맞추되, 기존 v1 매니페스트의 승인·실행 결과를 바꾸지 않는다. SDK 계약 테스트와 discover 테스트에 v1 회귀, v2 허용, 버전 누락/미지원, v1의 `socketMode` 거부, v2 권한 값 허용·거부 예시를 넣는다. 내부 IPC의 `Envelope.v: 1`은 API 버전과 별개이므로 그대로 사용하고 새 요청 메서드/콜백만 검증 목록에 추가한다(코드 확인: `packages/plugin-host/src/envelope.ts:1-6,32-45`, `packages/plugin-host/src/session.ts:94-100`).

### 2. 권한과 승인 문구

v2 매니페스트는 `permissions: { network: ["slack.com"], socketMode: ["slack.com"], secrets: true, openExternal: ["https://app.slack.com/client/*"] }`를 쓴다. `socketMode`는 중복 없는 정확한 호스트명 문자열 배열이며 M10에서는 **`["slack.com"]`만 허용**한다. 누락·빈 배열은 연결 권한 없음이고, URL/IP/와일드카드/대소문자 변형/다른 호스트는 거부한다. 새 형식 패턴을 구현할 때 허용·거부 예시를 실제 검증기에 통과시켜 테스트한다. `network`는 사용자 토큰을 main이 붙이는 GET에, `socketMode`는 main의 자동 연결 열기 POST와 수신 ack에 각각 필요하다. 어느 하나라도 미승인 상태이면 네트워크를 열지 않는다. 사용자 액션이 아닌 다른 HTTP 쓰기와 메시지 전송은 기존 제한을 유지한다(코드 확인: `packages/plugin-host/src/session.ts:378-385`).

승인 대화상자에는 별도 줄 **“Slack 실시간 연결: slack.com에 연결 요청을 보내고 수신 확인을 자동으로 보냅니다”**를 보인다. 현재 권한 문구 조합은 `apps/desktop/src/main/plugin-host-app.ts:70-87`, 승인 대기 후 실행 순서는 `packages/plugin-host/src/manager.ts:163-207`에 있다. 승인은 `checkGrant` 결과와 승인된 매니페스트 권한 한 곳에서만 읽는다. 새 키가 해시·부분집합·저장된 grant 검증에 참여하도록 `packages/plugin-host/src/grants.ts:30-85`를 갱신하지 않으면, 재시작 때 v2 grant가 무효화된다. 철회 또는 권한 확대 뒤 재승인 전에는 연결을 닫고 새 연결을 열지 않는다. 권한 대화상자에서 거부한 경우에도 열기 POST가 0회인지 e2e로 확인한다.

### 3. v2 `PluginContext` 계약

**승인(2026-10-12, D-063):** 아래 설계를 승인하며 두 가지를 고쳤다. ① API 묶음 이름은 `ctx.socketMode` 가 아니라 `ctx.slack`(묶음 전체가 slack.com 전용이고 `get` 은 Socket Mode 가 아닌 Web API 조회다). 매니페스트 권한 이름 `permissions.socketMode` 는 자동 연결 예외를 나타내므로 그대로 둔다. ② 호스트 중개 GET 허용 메서드는 `users.info`·`conversations.info` 두 개뿐이다. 폴링 대안(B)용 메서드는 토큰이 붙는 경로를 넓히므로 넣지 않는다.

아래는 `packages/plugin-sdk/src/v2/contracts.ts`에 넣을 정확한 공개 시그니처다. `Disposable`은 v1의 `dispose(): void` 계약을 따른다(코드 확인: `packages/plugin-sdk/src/v1/contracts.ts:28-30`). v2의 나머지 공통 기능은 v1 계약을 재사용하되, `secrets`는 값 읽기를 노출하지 않는다. 설정 폼은 기존처럼 main의 비밀 저장소에 토큰을 저장한다(코드 확인: `apps/desktop/src/main/plugin-host-app.ts:299-303`, `apps/desktop/src/main/plugin-bridge.ts:151-160`).

```ts
import type { PluginContext as V1PluginContext, Disposable } from "../v1/contracts.js";

export type SocketModeStatus =
  | "connecting" | "connected" | "reconnecting"
  | "token-required" | "permission-required";

export interface SocketModeEvent {
  type: string;
  event: Readonly<Record<string, unknown>>;
}

export interface PluginContext extends Omit<V1PluginContext, "secrets"> {
  slack: {
    connect(options: {
      appTokenSecret: string;
      onEvent(event: SocketModeEvent): Promise<void> | void;
      onStatus(status: SocketModeStatus): void;
    }): Promise<Disposable>;
    get(options: {
      userTokenSecret: string;
      method: "users.info" | "conversations.info";
      query?: Readonly<Record<string, string>>;
    }): Promise<{ status: number; body: unknown }>;
  };
}
```

`connect`의 Promise는 main이 권한·키 형식·등록을 확인하면 연결 상태와 무관하게 핸들을 돌려준다. 핸들의 `dispose()`가 명시적 연결 중지다. `onStatus`는 위 다섯 값만 받고 네트워크 오류 본문은 받지 않는다. 수신 이벤트는 `events_api` 봉투의 `payload.event` 객체만 `{ type: event.type, event }`로 전달한다. `envelope_id`, `accepts_response_payload`, 원본 봉투, 연결 URL, `xapp-` 및 `xoxp-` 값은 IPC·플러그인 콜백에 싣지 않는다. 잘못된 이벤트 모양은 전달하지 않는다. `get`은 나열한 Slack GET 메서드(보낸 사람·채널 이름 표시용 두 개)만 `https://slack.com/api/<method>`로 호출하며 호스트가 `userTokenSecret` 키로 비밀 저장소에서 `xoxp-`를 읽어 Authorization 헤더를 붙인다. 플러그인 지정 URL·헤더·HTTP 쓰기 메서드는 받지 않는다. `connect`도 `appTokenSecret` 키의 `xapp-`를 main에서 읽는다. 키 이름은 기존 `validSecretKey`로 검사한다(코드 확인: `packages/plugin-host/src/session.ts:536-544`, `packages/plugin-host/src/secrets-store.ts:17-21`). v1의 `ctx.secrets.get`은 v1 세션에서만 유지하고, v2 세션은 런타임 요청에서도 이를 거부한다. v2 `ctx.fetch`를 직접 사용해도 토큰 자동 주입은 없다.

콜백 전달은 기존 runner의 핸들 등록·`invoke` 경로를 확장하되, 승인된 권한을 별도로 다시 스캔하지 않는다(코드 확인: `packages/plugin-host/src/runner.ts:161-179,300-305`, `packages/plugin-host/src/session.ts:160-174`). `onEvent`는 사용자 액션 문맥 밖에서 실행되어 임의 POST/exec 권한을 얻지 않는다.

### 4. main 연결 수명주기와 URL 검증

main 연결 관리자는 승인된 v2 `socketMode` 권한과 살아 있는 세션을 확인한 뒤 `POST https://slack.com/api/apps.connections.open`을 직접 보낸다. 이 POST와 수신 ack만 버튼 없는 외부 쓰기 예외다. main은 정상 봉투의 `envelope_id`를 **받아 형식을 검사하자마자** 같은 WebSocket에 ack를 보내고, 이후 이벤트를 플러그인 콜백 큐에 넘긴다. 플러그인 처리 완료/실패를 ack 조건으로 삼지 않는다. ack는 게시 성공 표시가 아닌 수신 확인이다. 콜백 실패는 안전한 오류 코드로 기록하고 중복 이벤트는 플러그인이 `event_id` 등으로 거른다. ack 실패/연결 종료는 재연결 대상이다. Slack의 `type: "disconnect"`와 `reason: "warning"`은 고정 오류 코드만 기록하고 연결 상태를 다시 평가하며, `reason: "refresh_requested"`는 새 URL을 얻어 새 소켓이 연결된 뒤 이전 소켓을 닫고, 다른 disconnect는 이전 소켓을 닫아 재연결한다([Slack Socket Mode 문서](https://docs.slack.dev/apis/events-api/using-socket-mode/)). 이 이벤트들의 실제 순서와 30초 목표는 가짜 서버 및 실사용 측정으로 확인할 **추측**이다.

연결마다 증가하는 세대 번호를 붙여 WebSocket 콜백·POST 응답·재시도 타이머·늦은 close가 현재 세대인지 확인한다. 플러그인 비활성화/프로세스 종료, 권한 철회, 핸들 dispose, 앱 종료 때 타이머와 소켓을 닫는다. `appToken` 재저장·삭제 때도 이전 세대를 즉시 무효화하고 새 비밀을 다시 읽으며, `userToken` 재저장·삭제 때는 GET 캐시/상태를 무효화한다. 현재 비밀 저장은 `apps/desktop/src/main/plugin-host-app.ts:299-303`, 세션 dispose는 `packages/plugin-host/src/session.ts:178-184`, manager의 세대/정리는 `packages/plugin-host/src/manager.ts:177-180,468-516`에 있다. 권한 철회 UI/API는 현행 코드에서 확인하지 못했으므로 **추측**: 후속 task에서 철회 진입점과 종료 연결을 함께 설계·검증한다.

연결 실패는 지수 백오프와 지터를 쓰고 한 번에 재시도 타이머 하나만 둔다. 최초/최대 지연과 타임아웃 수치는 구현 때 가짜 서버의 끊김·429·복구 및 실제 Slack 30초 측정 조건과 최댓값을 주석에 남긴 뒤 정한다. `invalid_auth`/`token_revoked`/`token_expired`/`not_authed`는 `token-required`, `missing_scope`는 `permission-required`로 고정하고 자동 재시도를 멈춘다. main은 `apps.connections.open`의 반환 URL을 전송 **전에** 파싱해 `wss:`, userinfo 없음, 기본 포트(443)만, IP/끝 점 없는 DNS 이름, `slack.com`의 하위 호스트(`*.slack.com`, 단순 문자열 접미사만 허용하지 않음), `/link/` 경로를 모두 확인한다. query에는 접속 비밀이 있을 수 있으므로 오류·상태·로그에 URL을 넣지 않는다. 기존 일반 HTTPS 허용 함수는 이 동적 URL 정책을 대신하지 못한다(코드 확인: `packages/plugin-host/src/permissions.ts:4-17`). 실제 Slack이 이 조건을 만족하는 URL만 준다는 보장은 이 작업에서 확인하지 못한 **추측**이며, 불일치 시 연결을 보류하고 조건을 재검토한다.

### 5. WebSocket과 e2e 전송 경계

Electron main의 Node 24 전역 `WebSocket`을 클라이언트로 사용하고 새 의존성은 추가하지 않는다([Node 24 전역 객체 문서](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html)). `node:net`은 원시 TCP 소켓이므로 TLS/WebSocket 핸드셰이크와 프레임 처리를 직접 구현하는 수단으로 선택하지 않는다. Electron main에서 전역 API의 실제 가용성과 close/error 동작은 후속 단위/e2e에서 확인할 **추측**이다. Node/Electron 버전은 현행 `package.json:8,33-35`와 실제 패키징 런타임에서 다시 확인한다.

main 연결 관리자에 `openConnection`(HTTPS 요청)·`connectWebSocket`(소켓 생성)의 주입 가능한 전송 경계를 둔다. 권한, 토큰 키, 목적지/반환 URL 검사를 **먼저** 끝낸 후 기본 전송 또는 테스트 전송을 선택한다. 기존 GET 테스트 경계는 `apps/desktop/src/main/plugin-host-app.ts:181-189`의 `setFetchTargetForTest`, 제어 명령은 `apps/desktop/src/main/index.ts:1321-1327`에 있다. 새 테스트 전송은 검사를 통과한 `slack.com` HTTPS와 검사를 통과한 `*.slack.com` wss만 지정한 `127.0.0.1` 임의 포트 가짜 서버로 보낸다. 원래 호스트·메서드·헤더 및 WebSocket ack를 가짜 서버가 검사하되 실제 Slack DNS나 OS hosts/신뢰 저장소는 바꾸지 않는다. 가짜 서버의 WebSocket upgrade/프레임 검증은 Node 내장 HTTP/crypto로 구현해 새 패키지를 넣지 않는다. 전송 어댑터는 테스트 전용이며, 허용되지 않은 호스트·권한 거부 요청은 어댑터 호출 전에 차단하는 테스트를 둔다.

어댑터 설정 명령은 `--dev-control`이 유효한 패키징 안 된 실행에서만 노출한다. 현재 `parseLaunchArgs`의 `isPackaged` 분기와 개발 제어 이름 검사는 `apps/desktop/src/main/launch-args.ts:21-49`, e2e 실행 인자는 `apps/desktop/e2e/desktop-app.ts:30-55`에 있다. 설치본에서 동일 인자를 전달해도 어댑터 제어 통로가 닫혀 있고 루프백 전송이 없음을 `pnpm package:check`의 설치본 실행·`/status`·개발 통로 검사에 추가한다(코드 확인: `scripts/check-installer.mjs:139-178`, `package.json:29`). 후속 앱 초기화에 새 비동기 준비가 생기므로 `DesktopApp.waitReady`의 플러그인 호스트 준비 조건도 확장한다(코드 확인: `apps/desktop/e2e/desktop-app.ts:111-138`).

### 6. 기록 경계와 구현 task 순서

main의 연결 관리자에서는 토큰, Slack 응답 본문, 이벤트 본문, 전체 wss URL을 로그·예외 메시지·오류 기록·`/status`에 넘기지 않는다. 고정 상태/오류 코드, HTTP 상태, 재시도 횟수만 보낸다. 현재 플러그인 출력 마스킹은 **이미 읽어 기억한** 비밀 값에 의존하므로 새 main 연결 값과 wss URL 보호를 이 마스킹에만 맡기지 않는다(코드 확인: `apps/desktop/src/main/plugin-bridge.ts:63-77,151-162`, `apps/desktop/src/main/log-mask.ts:1-25`). `maskErrorText`는 64자리 hex/home 경로만 별도로 가린다(`apps/desktop/src/main/log-mask.ts:27-41`). 플러그인 종료 stderr가 오류 기록으로 들어가는 경로와 `/status`의 플러그인 상태 목록도 점검한다(코드 확인: `apps/desktop/src/main/index.ts:1746-1749,1903-1906`, `packages/plugin-host/src/manager.ts:159-160`). 테스트는 가짜 토큰·본문·wss URL을 각각 심어 settings.json, 로그, errors.log, state, `/status`, 플러그인 IPC/출력에서 노출이 없는지 확인한다. 사용자에게 보이는 상태 문구는 한국어 고정 문자열로 변환한다.

| 순서 | 구현 task (각 3~4개 작업 단위) | 범위 파일 제안 |
|---|---|---|
| 1 | v2 타입·스키마·export; 버전별 검증과 discover; `socketMode` 권한 해시/승인 문구; v1/v2 계약 테스트 | `packages/plugin-sdk/src/v2/*`, `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/package.json`, `packages/plugin-host/src/{discover,grants}.ts`, `apps/desktop/src/main/plugin-host-app.ts` 및 해당 `*.test.ts` |
| 2 (1 뒤) | main 연결 관리자·URL 검사; 세대/ack/재연결; 비밀 키 기반 GET과 runner/session IPC; 개발 전송 어댑터 및 단위 테스트 | `packages/plugin-host/src/{session,runner,permissions,envelope,manager}.ts`, `apps/desktop/src/main/{plugin-bridge,plugin-host-app,index,launch-args}.ts`, 새 연결 관리자와 해당 `*.test.ts` |
| 3 (2 뒤) | Slack 플러그인 매니페스트·설정; 이벤트 필터/중복·말풍선·버튼; 기존 화면 e2e와 새 가짜 서버 e2e | `plugins/slack/*`, `apps/desktop/e2e/desktop-app.ts`, `apps/desktop/e2e/{plugin-host,bubble,bubble-actions,settings}.e2e.test.ts` 중 실제 화면 선택자에 맞는 파일 및 필요한 e2e 도우미 |
| 4 (3 뒤) | 설치 산출물 포함/비포함 점검; `package:check`의 개발 어댑터 차단 검증; 전체 e2e·성능/실 Slack 측정 후 지연값 확정 | `scripts/{package-bundle,package-verify,check-installer}.mjs`, `electron-builder.config.mjs`, 관련 패키징 테스트·측정 기록 |

각 구현 task는 실제 spec에서 범위를 다시 좁힌다. 특히 task 2의 자동 쓰기는 승인된 연결 열기와 ack 두 종류로 제한하고, task 3의 사용자 GET에는 토큰 값이 플러그인으로 건너가지 않도록 한다. 전체 e2e와 설치본 점검은 coordinator가 충돌 없이 한 곳에서 실행한다.

변경 이력: 2026-10-12 D-063 승인(이름 `ctx.slack`, GET 메서드 2개로 축소). 그 전: D-062 승인 후 v2 규약 상세, 호스트 중개 API, 권한/수명주기/검증 경계 및 구현 task 순서를 추가했다. 기존 결정 문장은 변경하지 않았다.


## 구현에서 확정·변경된 점 (M10, 2026-10-12)

- **구현 순서와 근거:** v2 타입·검증·권한 승인(2161373) → 연결 관리자(`packages/plugin-host/src/slack-connection.ts`, 1a412b1) → 런타임 연결·테스트 전송 어댑터·가짜 Slack 서버 e2e(3d420c1) → slack 플러그인(455bf18) → /status 배지(5633732) → 설치본 포함(9159221). plugin-host 변경은 머지 전 사용자 gate 를 받았다.
- **팀 ID:** 연결 관리자는 `payload.event` 만 넘기므로, [Slack 에서 열기]의 팀 ID 는 이벤트의 `team`/`team_id` → 없으면 `users.info` 응답의 `user.team_id` → 둘 다 없으면 버튼 없음 순서로 정했다(호스트 변경 없음).
- **/status 배지:** 플러그인의 `setBadge` 문구를 `PluginStatus.badge` 로 싣는다(세대별 보관, 비밀 마스킹, 80자, 제어 문자 제거).
- **테스트 훅:** 개발 제어의 `checkerWindowsForTest` 가 열린 URL 목록(`externalUrls`)도 돌려준다.
- **확인하지 못한 추측(실제 Slack 미사용):** 반환 wss 주소가 항상 `*.slack.com/link/` 형태인지, 사용자 권한 이벤트가 Socket Mode 로 전달되는지, 메시지 수신에 사용자 토큰이 실제로 필요한지(이름 조회에만 쓰일 가능성). 기준 9 를 내려 두면서(D-064) 확인하지 않았다.
- **한계:** 개인이 만든 앱은 관리자 승인 없이 기업 워크스페이스에 설치할 수 없다. 메신저 알림은 Windows 알림 읽기로 받는 방향을 검토한다(D-064).

## 변경 이력

- 2026-10-12 M10 종료 점검: 구현 결과 반영(사용자 승인).
