# DeskPet Slack 알림 설정

이 문서는 Slack을 처음 쓰는 사람을 위한 안내입니다. 개인 테스트 워크스페이스에 내부용 앱을 하나 만들고, DeskPet이 Slack 메시지를 받을 수 있도록 두 토큰과 설정값을 입력합니다. DeskPet은 Slack에 메시지를 쓰지 않습니다. Socket Mode 연결을 열고 메시지 수신을 확인하는 동작만 자동으로 하며, 연결 확인(ack)은 메시지 게시가 아닙니다.

> 주의: Slack 화면의 이름과 위치는 Slack이 바꾸거나 워크스페이스 정책에 따라 다를 수 있습니다. 이 문서에서 실제 화면을 확인하지 못한 이름·메뉴 위치에는 `(화면 이름 확인 필요)`를 표시했습니다.

## 1. 준비: 관리자인 테스트 워크스페이스

본인이 워크스페이스 관리자(또는 앱 설치를 승인할 수 있는 관리자)인 개인 테스트 워크스페이스를 준비합니다. 회사 워크스페이스에서 먼저 시험하지 말고, 본인만 사용하는 워크스페이스에서 시작하세요. 워크스페이스가 없다면 [Slack 가입 및 워크스페이스 만들기](https://slack.com/get-started#/createnew)를 열어 새 워크스페이스를 만들고, 이름과 URL을 정한 뒤 본인이 관리자로 들어갑니다.

이 안내의 앱은 한 워크스페이스에서만 쓰는 내부용 앱입니다. Socket Mode 앱은 공개 Slack Marketplace에 등록하는 앱이 아닙니다. 자세한 앱 배포 범위는 [Slack 앱 배포 문서](https://api.slack.com/docs/slack-apps-mgmt)를 참고하세요.

## 2. 앱 만들기: 매니페스트 붙여 넣기

1. [Slack Your Apps](https://api.slack.com/apps)를 열고 로그인합니다.
2. `Create New App` → `From a manifest`를 선택합니다. 실제 버튼 이름이 다르면 `(화면 이름 확인 필요)`입니다.
3. 테스트 워크스페이스를 선택하고 아래 YAML 전체를 붙여 넣습니다.
4. `Next` → 설정 요약 확인 → `Create`를 선택합니다. 실제 버튼 이름이 다르면 `(화면 이름 확인 필요)`입니다.

아래 매니페스트에는 봇 scope와 봇 사용자를 넣지 않았습니다. DeskPet은 설치 사용자의 관점에서 메시지를 받으므로, 이 설정만으로 봇을 만들지 않고 사용자 scope와 사용자 이벤트를 사용합니다. 이 조합이 현재 Slack 워크스페이스에서 그대로 허용되는지는 실제 앱 생성 화면에서 확인이 필요하므로, 생성 화면에서 거부되면 그 오류를 기록해 coordinator에게 문의하세요. 봇 scope를 임의로 추가하지 마세요.

```yaml
_metadata:
  major_version: 1
display_information:
  name: DeskPet Slack 알림
oauth_config:
  scopes:
    user:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - users:read
      - channels:read
      - groups:read
      - im:read
      - mpim:read
settings:
  event_subscriptions:
    user_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

이 scope는 공개 채널·비공개 채널·1:1 DM·그룹 DM의 메시지 수신과 사용자/대화 이름 확인에 필요한 **사용자 scope**입니다. `chat:write` 등 쓰기 scope, 이메일 scope, 봇 scope는 넣지 않습니다. 근거는 [Slack 앱 매니페스트 문서](https://api.slack.com/reference/manifests), [message 이벤트 문서](https://docs.slack.dev/reference/events/message/), [Slack 토큰 문서](https://docs.slack.dev/authentication/tokens)입니다.

## 3. 앱 수준 토큰 만들기: `xapp-`

1. 앱 설정에서 `Basic Information` → `App-Level Tokens`로 이동합니다. 메뉴 이름이나 위치가 다르면 `(화면 이름 확인 필요)`입니다.
2. `Generate Token and Scopes`를 선택합니다.
3. 토큰 이름을 `deskpet-socket`처럼 입력하고 scope로 `connections:write` **하나만** 추가합니다.
4. 생성된 `xapp-`로 시작하는 값을 복사해 안전한 임시 장소에 둡니다. 이 값은 나중에 DeskPet의 비밀값 칸에 넣습니다.

Socket Mode 연결 생성에 필요한 앱 수준 토큰과 `connections:write`의 근거는 [Slack Socket Mode 설정 문서](https://api.slack.com/apis/connections/socket)와 [connections:write scope 문서](https://docs.slack.dev/reference/scopes/connections.write/)입니다.

## 4. 워크스페이스에 설치하고 사용자 토큰 받기: `xoxp-`

1. 앱 설정에서 `OAuth & Permissions` → `Install to Workspace`를 선택합니다. 실제 메뉴 이름이 다르면 `(화면 이름 확인 필요)`입니다.
2. 권한 목록에서 아래 사용자 scope가 모두 있는지 확인합니다. 빠진 scope가 있으면 앱 매니페스트의 사용자 scope를 고친 뒤 다시 설치합니다.
3. 설치 승인 화면에서 `Allow`를 선택합니다. 반드시 본인이 관리하는 테스트 워크스페이스에만 설치합니다.
4. 표시된 `User OAuth Token`을 복사합니다. 반드시 `xoxp-`로 시작하는 **사용자 토큰**이어야 하며, `xoxb-` 봇 토큰은 사용하지 않습니다.

이 앱은 사용자인 본인의 멘션과 DM을 받아야 하므로 사용자 토큰을 사용합니다. 설치와 OAuth 권한의 공식 안내는 [Slack 앱 배포 문서](https://api.slack.com/docs/slack-apps-mgmt), [Slack OAuth 문서](https://api.slack.com/authentication/oauth-v2), [Slack 토큰 종류 문서](https://api.slack.com/concepts/token-types)를 참고하세요.

## 5. 내 멤버 ID 확인

Slack에서 내 프로필을 열고 `멤버 ID 복사`를 선택합니다. 프로필 메뉴의 실제 위치와 문구는 `(화면 이름 확인 필요)`입니다. 복사한 값은 보통 `U...` 또는 `W...` 형식이며, 이메일 주소나 표시 이름이 아닙니다. 공식적인 사용자 ID 표기와 사용자 조회는 [Slack 메시지 서식 문서](https://docs.slack.dev/messaging/formatting-message-text/)와 [users.info 문서](https://docs.slack.dev/reference/methods/users.info/)를 참고하세요.

## 6. DeskPet에 값 넣기

DeskPet을 열고 설정 창의 플러그인 설정으로 이동합니다. 화면 이름은 아직 구현 전이므로 **구현 후 이름이 바뀔 수 있음**을 기억하세요.

다음처럼 입력합니다.

| DeskPet 항목 | 넣을 값 | 저장 위치 |
| --- | --- | --- |
| 앱 수준 토큰 | 3단계에서 복사한 `xapp-...` | 비밀값 칸 |
| 사용자 토큰 | 4단계에서 복사한 `xoxp-...` | 비밀값 칸 |
| 내 멤버 ID | 5단계의 `U...` 또는 `W...` | 일반 설정 칸 |
| 지정 채널 ID | 알림을 받을 채널 ID(여러 개면 제품이 안내하는 형식으로 입력) | 일반 설정 칸 |
| 키워드 | 추가로 알림 받을 단어 목록 | 일반 설정 칸 |
| 멘션만 알림 | 켬/끔 | 일반 설정 칸 |
| 본문 숨기기 | 켬/끔 | 일반 설정 칸 |

`멘션만 알림`을 켜도 DM은 계속 알림 대상입니다. 이 설정은 지정 채널·키워드에 대한 일반 알림만 줄이고, 나를 멘션한 메시지와 나에게 온 DM은 유지합니다. `본문 숨기기`를 켜면 말풍선에 Slack 메시지 본문 미리보기를 표시하지 않습니다.

토큰은 일반 설정 칸이나 메모장·로그에 넣지 말고 비밀값 칸에만 넣습니다. 채널 ID를 모르면 해당 채널의 정보 화면에서 ID를 복사합니다. 채널 정보 메뉴와 DeskPet 설정 항목의 실제 이름·위치는 `(화면 이름 확인 필요)`입니다.

## 7. 토큰 재발급·앱 삭제와 보안

- 토큰이 노출됐거나 의심되면 앱 설정의 `Basic Information`에서 앱 수준 토큰을 폐기하고 새 `xapp-` 토큰을 `connections:write`만으로 다시 만듭니다. 메뉴 위치는 `(화면 이름 확인 필요)`입니다.
- 사용자 토큰은 `OAuth & Permissions`에서 앱을 워크스페이스에 다시 설치하거나 권한을 갱신해 새로 발급합니다. 이전 `xoxp-` 값은 DeskPet에서 지우고 새 값으로 바꿉니다.
- 앱을 없애려면 앱 설정의 `Settings` → `Delete App`(화면 이름 확인 필요)을 사용합니다. 삭제 전에 DeskPet의 두 토큰을 지우세요.
- `xapp-`와 `xoxp-` 토큰을 다른 사람에게 보내거나 공개 저장소·이슈·스크린샷에 올리지 마세요. 토큰은 비밀번호와 같습니다.
- DeskPet은 Slack에 메시지·답장·반응을 쓰지 않습니다. 자동으로 하는 일은 Socket Mode 연결 열기, 수신 이벤트 확인(ack), 메시지 수신뿐입니다. 이는 [Socket Mode 공식 문서](https://api.slack.com/apis/connections/socket)의 연결 방식과 ADR-0011(D-062)의 범위에 따른 것입니다.

## 8. 문제 해결

### `토큰 확인 필요`

다음 순서로 확인합니다.

1. 앱 수준 토큰이 `xapp-`로 시작하고 사용자 토큰이 `xoxp-`로 시작하는지 확인합니다.
2. 토큰 앞뒤에 공백이나 줄바꿈이 붙지 않았는지 확인하고, DeskPet의 비밀값 칸에 다시 저장합니다.
3. Slack 앱 설정에서 해당 토큰을 폐기했거나 앱을 삭제하지 않았는지 확인합니다. 폐기했다면 7단계에 따라 다시 발급합니다.
4. 설치한 워크스페이스와 DeskPet에서 선택한 테스트 워크스페이스가 같은지 확인합니다.

Slack API의 인증 오류와 토큰 종류는 [Slack 토큰 문서](https://docs.slack.dev/authentication/tokens)와 [auth.test 문서](https://docs.slack.dev/reference/methods/auth.test/)를 참고하세요.

### `권한 부족(missing_scope)`

1. 오류에 표시된 scope 이름을 확인합니다. 매니페스트의 사용자 scope 목록과 비교합니다.
2. 특히 채널 종류별로 `channels:history`, `groups:history`, `im:history`, `mpim:history`가 필요한지 확인하고, 사용자 조회에는 `users:read`, 채널·대화 이름 조회에는 `channels:read`, `groups:read`, `im:read`, `mpim:read`가 있는지 확인합니다.
3. 앱 설정에서 권한을 바꾼 뒤에는 워크스페이스에 앱을 다시 설치해 새 `xoxp-`를 발급하고 DeskPet에도 새 토큰을 저장합니다.
4. `chat:write`, 이메일 scope, 임의의 봇 scope를 해결책으로 추가하지 않습니다. 이 설정의 범위에는 Slack 쓰기가 없습니다.

scope의 의미와 `missing_scope` 응답은 [Slack 권한 scope 문서](https://api.slack.com/scopes), [message 이벤트 문서](https://docs.slack.dev/reference/events/message/), [Slack Web API 오류 문서](https://api.slack.com/web)를 참고하세요.
