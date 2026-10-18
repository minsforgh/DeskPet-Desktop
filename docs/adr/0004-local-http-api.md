# ADR 0004: 로컬 HTTP API와 deskpet CLI

## 상태

승인 (2026-10-07, 사용자 gate 승인. 제안 2026-10-06)

## 배경

기획안 6-4는 외부 도구가 `PetEvent`를 보내는 정식 로컬 통로를 정의한다. M1의 개발용 named pipe `event` 명령은 인증이 없으므로 이벤트 주입에서 제외한다. 로컬 HTTP 서버는 CLAUDE.md의 확인 필요 영역이어서 이 ADR과 구현은 보안 리뷰 및 사용자 승인을 받아야 한다.

## 결정

서버는 Node `http`로 `127.0.0.1`에만 바인딩하고 기본 포트는 7777이다. `--event-port=<번호>`로 바꿀 수 있으며 0이면 운영체제가 빈 포트를 선택한다. 포트 충돌이 생겨도 앱은 계속 실행하고 오류를 로그와 개발 제어 `state.eventServer`에 남긴다.

| 요청 | 성공 | 실패 |
|---|---|---|
| `POST /event` | `202 {"accepted":true}` | JSON·`PetEvent` 검증 실패 `400 {"errors":[...]}` |
| `GET /status` | `200`과 `version`, `character {id,state}`, `visible`, `eventServer {port}`, `queue {pending}`, `plugins`(원소 형식은 ADR-0005 7장 `manager.status()`, CLI 는 개수만 표시) | 서버를 열지 못하면 HTTP 응답 자체가 없고 개발 제어 `state.eventServer`에서 `port`를 생략한다. |
| `POST /action/:id` | `200 {"executed":true}` (허용 목록의 액션을 실행함) | 본문이 비어 있지 않은데 JSON 객체가 아님 `400`, 허용 목록에 없거나 id 형식 오류 `404`, 액션 실행 실패 `500`. 인증·`Host`·`Origin`·`Content-Type`·크기·시간 규칙은 `/event` 와 같다 |
| 그 밖의 경로·메서드 | — | 경로 `404`, 메서드 `405` |

모든 요청은 `Authorization: Bearer <토큰>`을 요구한다. 토큰이 없거나 틀리면 이유를 드러내지 않는 `401`을 돌려준다. 처음 실행 시 `crypto.randomBytes(32)`로 만들고 userData의 `event-server.json`에 `{ "port": 실제포트, "token": 토큰, "pid": 앱 PID }`로 저장한다. 서버를 열기 전에 이전 실행의 포트를 지우고, 정상 종료 때도 포트를 지운다. 듣지 못할 때 파일에는 토큰만 남는다. 비정상 종료로 포트가 남아도 CLI는 `process.kill(pid, 0)`으로 기록된 프로세스가 살아 있는지 확인한 뒤에만 Bearer 토큰을 보낸다. PID 재사용은 남는 한계다. 토큰 없는 `/status` 신원 확인은 이 API의 전 경로 인증 규칙과 충돌하므로 사용하지 않는다. 임시 파일을 쓴 뒤 이름을 바꾸며 토큰은 `crypto.timingSafeEqual`로 비교한다. 로그에는 토큰과 이벤트의 `text`·`detail`을 남기지 않는다.

요청 본문은 64 KiB를 넘으면 `413`, `application/json`이 아닌 `Content-Type`은 `415`로 거부한다. TCP 연결 시점부터 헤더와 본문 수신을 합쳐 5초가 지나면 408 응답 없이 소켓을 끊는다. 동시 연결 상한은 16개다. `Host`는 실제 포트를 붙인 `127.0.0.1` 또는 `localhost`만 허용하며 다른 값은 `403`이다. `Host` 또는 `Authorization` 헤더가 중복되면 `400`이다. `Origin`이 있는 요청도 `403`이고 CORS 허용 헤더는 보내지 않는다. 연결이 끊기거나 JSON이 잘못되어도 앱은 계속 실행한다.

`deskpet event`와 `deskpet status`는 위 API를 사용한다. CLI는 Windows에서 `%APPDATA%\deskpet\event-server.json`, macOS에서 `~/Library/Application Support/deskpet/event-server.json`, Linux에서 `${XDG_CONFIG_HOME:-~/.config}/deskpet/event-server.json`을 읽는다. `--user-data-dir`과 `DESKPET_USER_DATA_DIR`로 위치를 바꿀 수 있다. 요청 대상은 항상 `127.0.0.1`이다. `--file` 입력은 실행 작업 폴더 안의 상대 경로만 읽고 링크·상위 경로·절대 경로는 거부한다.

## 버전 정책

현 HTTP API는 앱 버전 `0.0.0`과 함께 시작하며 `/status.version`에 앱 버전을 담는다. 기존 필드의 의미를 바꾸거나 제거할 때는 새 버전의 경로 또는 명시적 API 버전 협상을 추가하고 ADR에 기록한다. 호환되는 필드 추가는 현재 경로에 허용한다.

## 한계와 후속 작업

토큰 파일은 사용자 계정 권한으로 보호되며 암호화하지 않는다. 같은 사용자로 실행되는 프로그램은 읽을 수 있다. 설정 화면에서의 확인·재발급은 M4다. `/action/:id`의 허용 목록은 앱의 `ActionRegistry` 에 등록된 액션 id 다(M3 2단계, 2026-10-07). 본문은 비어 있거나 `{"args": ...}` 이며 id 는 퍼센트 디코딩 없이 그대로 비교한다. M3 에서 등록된 액션은 무해한 `deskpet.ping`(펫이 웃음) 하나이고, 플러그인 액션 등록과 사용자 호출 맥락에서만 쓰기를 허용하는 규칙(ADR-0003)은 M4 호스트에서 연결한다. M3 1단계에서는 이벤트를 기록하고 notify를 큐에 넣어 말풍선과 표정을 표시한다. urgent도 다른 말풍선과 같은 최소 5초 간격을 지키며 우선순위만 앞선다.

## D-032 선택 필드 voice 추가(2026-10-08)

`POST /event`의 `PetEvent` 본문에 선택 필드 `voice`를 허용한다. 형식은 `{ "kind": "done" | "waiting" | "failed" | "info" | "deadline" | "reminder" | "alert", "slots"?: { "task"?: string, "result"?: string, "folder"?: string, "message"?: string } }`이며 각 슬롯 값은 제어 문자가 없는 500 코드 포인트 이하 문자열이다. 앱은 현재 캐릭터의 어투 템플릿을 사용하고 없으면 기존 `text`를 사용한다. 기존 이벤트는 변경 없이 수락하고 `text`의 기존 검증도 유지한다.

`deskpet event --voice <종류> --slot <이름>=<값>`은 같은 필드를 보낸다. `--slot`은 반복할 수 있고 첫 `=` 뒤 전체를 값으로 사용한다. 이 필드는 하위 호환 추가이므로 HTTP 경로와 `apiVersion`을 유지하며 기존 클라이언트에 영향이 없다.

### D-033 어투 종류 확장(2026-10-08)

`voice.kind`에 `deadline`(마감 임박)·`reminder`(일정)·`alert`(로그인·오류 같은 상태 경고)를 추가해 `done|waiting|failed|info|deadline|reminder|alert` 7종으로 한다. 슬롯 이름은 그대로이며 새 종류는 주로 `message`를 쓴다. 허용 값만 늘어나는 하위 호환 변경이므로 `apiVersion`은 유지하고, 기존 4종의 동작과 알 수 없는 종류의 거부는 그대로다.
