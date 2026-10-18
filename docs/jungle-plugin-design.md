# 데스크톱 펫 `jungle` 플러그인 설계

크래프톤 정글 출석 상태를 **읽기만** 해서 데스크톱 펫이 반응하게 하는 플러그인 설계입니다.

> **원칙:** 이 플러그인은 출석 버튼을 누르지 않습니다. 비밀번호를 저장하지 않습니다. 사용자가 직접 로그인한 세션으로 상태 조회(GET)만 합니다. 버튼은 펫이 열어 주는 페이지에서 사용자가 직접 누릅니다.

이 문서의 시간 규칙(1장)은 사용자가 확인해 준 정글 규칙이고, 응답 구조(2장)는 2026-10-08 사용자가 직접 로그인해 관찰한 결과다(`docs/progress/milestones.md` M5 기준 6). 판정 구현은 `plugins/jungle/src/attendance-phase.ts`에 있으므로 이 문서는 코드를 옮기지 않고 파일을 가리킨다.

---

## 1. 하루 상태 판정 규칙

시간 기준은 모두 KST다. 하루의 경계는 **04:00**이고 00:00–03:59는 전날로 취급한다.

| 상태 | 조건 | 남은 시간 표시 |
|---|---|---|
| `NeedStart` | 시작 안 함, 04:00–10:00 | 10:00까지 |
| `StartOverdue` | 시작 안 함, 10:00 이후 (10분 유예 포함) 또는 23:00–04:00 | 유예 10분 동안만 |
| `Studying` | 시작함, 04:00–23:00 | 23:00까지 (종료 가능 시각) |
| `NeedEnd` | 시작함, 23:00–다음 날 04:00 | 다음 날 04:00까지 (종료 마감) |
| `Complete` | 종료함 | 없음 |

- 시작 마감은 **10:00**, 마감 뒤 **10분 유예**(10:10까지)가 있다.
- 종료는 **23:00**부터 가능하고 **다음 날 04:00**이 종료 마감이다.
- 주말·휴일 처리는 하지 않는다 (LMS 응답이 정을 내줄 때까지).

구현은 순수 함수 `attendancePhase`(상태 판정)와 `attendanceDay`(출석 날짜 계산)로 `plugins/jungle/src/attendance-phase.ts`에 있고, 경계 시각(03:59:59, 04:00:00, 09:59:59, 10:00:00, 10:09:59, 10:10:00, 22:59:59, 23:00:00, 00:30 등) 테스트는 `plugins/jungle/src/attendance-phase.test.ts`에 있다. 표와 구현이 어긋나면 구현이 표를 따른다.

---

## 2. 관찰된 LMS 응답 구조

2026-10-08에 사용자가 앱의 로그인 창에서 직접 로그인해 확인한 관찰 결과다. 로그와 여기 적는 것은 **필드명과 타입뿐이고 값은 없다**. 관찰 기록 원본은 `docs/progress/milestones.md` M5 기준 6 행.

### 2-1. 조회 경로 (GET 두 개)

| 순서 | 경로 | 용도 |
|---|---|---|
| 1 | `GET /api/v2/me/cohorts` | 내 기수 목록. 진행 중인 기수 하나를 고른다 |
| 2 | `GET /api/v2/me/cohorts/{cohortId}/attendance/today` | 오늘 출석 상태 |

둘 다 체커 창의 `getJson`으로 보낸다. 요청은 항상 홈 출처 `https://jungle-lms.krafton.com`으로 간다(3-2).

### 2-2. `cohorts` 응답

배열이고 각 원소의 필드는 다음과 같다.

| 필드 | 타입 |
|---|---|
| `id` | string |
| `name` | string |
| `courseName` | string |
| `courseId` | string |
| `cohortClassId` | string |
| `cohortClassName` | string |
| `startDate` | string |
| `endDate` | string |
| `isActive` | boolean |
| `enabledFeatures` | string[] |
| `enrolledAt` | string |

**기수 선택 규칙:** `isActive === true`인 기수 중 종료일(`endDate`)이 지나지 않은 가장 이른 것을 고른다. 없으면 종료일이 가장 늦은 것(이미 끝난 기수 중 마지막)을 쓴다. 구현은 `plugins/jungle/src/checker.ts`의 `selectCohort`.

### 2-3. `attendance/today` 응답

| 필드 | 타입 |
|---|---|
| `id` | string |
| `date` | string |
| `status` | string |
| `checkedAt` | string (관찰 당시) |
| `checkedOutAt` | null (관찰 당시) |
| `isStudying` | boolean |

- 관찰 당시 상태는 "시작함·종료 안 함"이었다 (`checkedAt`은 문자열, `checkedOutAt`은 `null`).
- 판정은 `checkedAt`(시작)과 `checkedOutAt`(종료)의 **null 여부**로 한다.
- 시작 전 형태는 아직 확인하지 못했다. `checkedAt`이 `null`인지 필드가 아예 없는지 모르므로 둘 다 "미시작"으로 처리한다.
- `status` 문자열의 값은 아직 확인하지 못했다.

### 2-4. 비공식 내부 API

이 API는 공개 문서가 없는 내부 API라 언제든 바뀔 수 있다. 응답 형식이 다르면 조용히 실패하지 말고 "확인 불가" 상태를 펫에 표시한다(6장). Google 로그인은 앱의 내장 창에서 막히지 않는 것을 관찰했다.

---

## 3. 펫 플러그인 구조 (Electron)

플러그인은 Electron API를 직접 쓰지 않고 `ctx.windows`와 `getJson`만 쓴다(`docs/adr/0003-plugin-manifest-and-api-v1.md`). 현재 파일 구성:

```
plugins/jungle/
├── manifest.json                       # 권한 선언: network 호스트, windows 창 id
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── index.ts                        # definePlugin: 트레이 항목·액션, 말풍선
    ├── checker.ts                      # 체커 창 열기, getJson 조회, 기수 선택, shape 기술
    ├── checker.test.ts
    ├── attendance-phase.ts             # 하루 상태 판정 (순수 함수)
    ├── attendance-phase.test.ts        # 경계 시각 테스트
    └── no-write-requests.test.ts       # 쓰기 요청 금지 패턴 검사
```

### 3-1. 숨김 체커 창

체커 창은 플러그인이 Electron `BrowserWindow`를 직접 만들지 않고 `ctx.windows.create`로 호스트에 요청해 연다. 창이 갈 수 있는 곳과 로그인 세션 저장소는 플러그인 코드가 아니라 매니페스트와 호스트가 정한다.

```json
// manifest.json (권한 부분, 현재 선언)
{
  "permissions": {
    "network": ["jungle-lms.krafton.com", "accounts.google.com"],
    "windows": ["lms-checker"],
    "secrets": false,
    "shell": false
  }
}
```

숨김 체커 창 만들기는 `plugins/jungle/src/checker.ts`의 `openChecker`가 맡는다. 시작 주소는 `/check-in`이며, 조회와 사용자 화면에 같은 `lms-checker` 창을 쓴다. `plugins/jungle/src/monitor.ts`는 사용자 [로그인]·[출석 페이지 열기] 액션마다 기존 창을 정리하고 새 창을 보여 준다. 자동 조회는 숨김 창만 만들며, `show`는 사용자 액션 안에서만 허용된다(ADR-0006 사용자 결정 3).

### 3-2. 상태 조회 (GET만)

페이지 안에서 임의 스크립트를 실행하지 않는다. 체커 창이 제공하는 조회 함수 `getJson(path)` 하나만 쓴다. 조회·기수 선택 구현은 `plugins/jungle/src/checker.ts`의 `checkOnce`가 맡으며, 이 문서에는 코드를 옮기지 않고 파일을 가리킨다.

호스트가 보장하는 것 (`docs/adr/0006-checker-window.md`):

- **홈 출처 고정:** `getJson`은 창의 "현재 출처"가 아니라 **홈 출처**(`windows.create`의 `url` 출처)로만 요청한다. 창이 로그인 페이지에 가 있어도 요청이 LMS가 아닌 곳으로 새지 않는다. (이전 문서의 "M5에서 확인할 것" 우려는 이 결정으로 **해소됐다**. ADR-0006 사용자 결정 2.)
- **main이 직접 요청:** 페이지 안 스크립트 주입 없이 main이 요청한다. 구현은 `session.fetch`가 아니라 main의 `net.request`(체커 파티션 세션, `useSessionCookies`)이다. Electron 44.5.1에서 `session.fetch`는 `redirect: "manual"`일 때 3xx를 돌려주지 않기 때문이다.
- **GET 구조적 고정:** 프로토콜에 `method`·`headers`·`body` 키가 없어 쓰기 요청은 표현 자체가 불가능하다.
- **3xx 비추종:** 리다이렉트를 따라가지 않고 상태 코드만 돌려준다. **로그인 풀림은 401 또는 3xx로 판별**한다 (`checker.ts`의 `isNeedsLogin`).
- **새 창 요청 항상 거부:** 새 창 요청은 항상 거부하고 시스템 브라우저 위임도 하지 않는다 (결정 D-028). 팝업 로그인(OAuth)은 지원하지 않는다.
- **이동 제한:** 창의 최초 주소와 이후 이동은 `permissions.network`에 선언한 호스트로만 허용한다.
- **세션 분리:** 로그인 쿠키를 담는 세션 저장소는 호스트가 플러그인별 파티션으로 배정하고 앱 재시작 후에도 유지한다. 플러그인은 저장소를 고를 수 없다.
- 창은 `sandbox`·`contextIsolation`으로 열고 Node 통합과 preload가 없다.

---

## 4. 펫 반응 설계

| 상태 | 펫 표정 | 말풍선 | 우선순위 |
|---|---|---|---|
| `NeedStart` (여유) | idle | 조용함 | – |
| `NeedStart` (마감 30분 전) | surprised | "학습 시작 아직이야! 10시까지 30분" | high |
| `StartOverdue` (유예 10분) | surprised (반복) | "지금 누르면 아직 괜찮아!" | high |
| `Studying` | idle / 가끔 응원 | 남은 시간은 툴팁으로만 | low |
| `NeedEnd` (23:00) | happy | "이제 학습 종료 누를 수 있어" | normal |
| `NeedEnd` (마감 30분 전) | surprised | "04시 전에 학습 종료!" | high |
| `Complete` | happy | "오늘도 수고했어" (한 번만) | normal |
| 로그인 필요 | sleepy | "LMS 로그인이 풀렸어" + [로그인] | high |

말풍선의 버튼 동작은 이렇게 둔다.

- **[출석 페이지 열기]·[로그인]:** 둘 다 기존 `lms-checker` 창을 정리하고 `ctx.windows.create("lms-checker", { url: "https://jungle-lms.krafton.com/check-in", show: true, width: 1000, height: 760, title: "정글 LMS" })`로 새 창을 만든다. 로그인 만료 시 창은 로그인 페이지로 이동한다. `permissions.openExternal`은 선언하지 않으며 출석 버튼은 사용자가 앱 안 창에서 직접 누른다.
- **로그인 대기:** 두 액션 후 최대 3분 동안 로그인이 아직 확인되지 않으면 5초 간격으로 조회한다(분당 최대 12회). `ok`를 확인하면 대기를 끝내고 30초 간격으로 4회 조회한 뒤 상태별 간격으로 돌아간다. 오류는 대기 중에도 지수 백오프를 따른다.
- **[다시 확인]:** 즉시 재조회하고 현재 상태를 짧은 말풍선으로 보여 준다 (트레이의 "정글 출석 지금 확인"과 같은 동작). 자동 조회는 단계 전이가 있을 때만 알린다. 상태 문구와 버튼은 `plugins/jungle/src/status-text.ts`가 만든다.

출석 페이지에서 버튼을 누르고 돌아오면, 다음 조회 때 `Complete`나 `Studying`으로 바뀌어 펫이 조용해진다. 반응을 빠르게 하려면 [출석 페이지 열기]를 누른 뒤 1–2분 동안 조회 간격을 짧게 둔다.

---

## 5. 갱신 주기

LMS 서버에 부담을 주지 않도록 간격을 넉넉하게 잡는다.

| 상황 | 간격 |
|---|---|
| `Complete` | 30분 (다음 날 04:00 직후 한 번 확인) |
| `Studying` | 15분 |
| `NeedStart`, `NeedEnd` (여유) | 10분 |
| 마감 30분 이내 | 2–3분 |
| [로그인]·[출석 페이지 열기] 직후, 로그인 대기 | 최대 3분간 5초 간격 (오류는 백오프) |
| 로그인 확인 직후 | 30초 간격으로 최대 4번 |
| 잠자기에서 깨어남 | 즉시 1회 (`ctx.schedule.onResume`) |
| 오류 | 지수 백오프 (1, 2, 4, 8분 … 최대 30분) |

---

## 6. 보안과 운영 원칙

1. **쓰기 요청 금지:** 조회는 `getJson`으로 GET 두 개만 호출한다. `getJson`은 메서드를 지정할 수 없어 쓰기 요청이 구조적으로 불가능하다(3-2). `plugins/jungle/src/no-write-requests.test.ts`가 src 의 테스트 외 `.ts` 파일 전체에서 금지 패턴(`method`, `POST`/`PUT`/`PATCH`/`DELETE`, `fetch(`, `ctx.fetch`, `XMLHttpRequest`, `sendBeacon`, `FormData`, `WebSocket`, `body:`)을 재귀 검사한다.
2. **비밀번호 미저장:** 로그인은 사용자가 앱 안 체커 창에서 직접 한다. 앱은 쿠키 세션만 유지한다.
3. **출처 제한:** 체커 창은 매니페스트 `permissions.network`에 선언한 LMS와 로그인 호스트 밖으로 이동하지 않는다. 이 제한은 호스트가 강제한다. 새 창 요청은 항상 거부한다 (D-028). 시스템 브라우저를 여는 권한은 선언하지 않는다.
4. **로그 마스킹:** 응답 본문이나 쿠키를 로그에 남기지 않는다. 상태 값(started, ended, needsLogin)만 남긴다. 응답 구조 관찰(2장)도 값 없는 shape 만 기록했다.
5. **비공식 API:** 이 API는 공개 문서가 없는 내부 API라 언제든 바뀔 수 있다(2-4). 응답 형식이 다르면 조용히 실패하지 말고 "확인 불가" 상태를 펫에 표시한다.
6. **잠자기 한계:** 컴퓨터가 꺼져 있거나 잠들어 있으면 확인하지 못한다. 깨어나면 즉시 다시 확인한다(5장).

---

## 7. 구현 순서 (오케스트레이션 task 단위)

현재 진행 상태 기준(`docs/progress/milestones.md` M5 1단계):

| 순서 | task | 상태 |
|---|---|---|
| 1 | 하루 상태 판정 순수 함수 + 경계 시각 테스트 (`src/attendance-phase.ts`) | ✅ 완료 (M5 기준 3) |
| 2 | 쓰기 요청 금지 패턴 검사 테스트 (`src/no-write-requests.test.ts`) | ✅ 완료 (M5 기준 4) |
| 3 | 골격: 체커 창 열기·로그인 창 표시·`getJson` 두 경로 조회 (`src/checker.ts`, `src/index.ts`, `manifest.json`) | ✅ 완료 |
| 4 | 기수 선택 규칙 + 실제 응답 구조 관찰 (사용자 직접 로그인, 값 없는 shape) | ✅ 완료 (M5 기준 6) |
| 5 | 응답 → 시작/종료 판정 순수 로직 (`checkedAt`·`checkedOutAt` null 여부) + 테스트 | 진행 예정 |
| 6 | 연결: 상태별 갱신 주기·지수 백오프·잠자기 복귀, 펫 이벤트와 말풍선 버튼 매핑 | 진행 예정 |
| 7 | 보안 리뷰: GET만 쓰는지, 로그 마스킹, 이동 제한 | 진행 예정 |
