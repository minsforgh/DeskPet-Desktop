# 가이드 검토 기록: water 플러그인 (M9 기준 2 뒷부분)

`docs/plugin-guide.md` 한 파일만 보고 "물 마시기"(id `water`)를 처음부터 만들었다. 다른 문서·소스는 열지 않았다(소스를 열어야 했던 경우 없음).

## 결과 요약

- 타입 검사·빌드·테스트(8개) 통과, 격리 실행에서 `water` 가 `running` 으로 `deskpet status --json` 에 나옴, 버튼 → 액션 → 말풍선(`오늘 0잔 마셨어요 (목표 8잔)`) 확인, 로그에 `[plugin:water] water: activated`.
- 가이드대로 막힘 없이 동작한 부분이 대부분이고, 빈틈은 아래 7건이다.

## 빈틈 (가이드 절 번호 / 증상 / 제안)

1. **2.1·2.6, 3.1 — `plugins/` 밖에서 만들 때의 방법이 없다 (막힘).** 이번 범위는 `docs/examples/water/` 인데 가이드는 `plugins/<id>/` 만 전제한다. `pnpm --filter @deskpet/plugin-water typecheck` 는 `No projects matched the filters` 로 실패했다. 이유는 워크스페이스가 `plugins/*` 만 잡기 때문이다(2.1 에 적혀 있으나 "그 밖의 위치는 안 된다"는 말은 없다). 또 `tsconfig.json` 의 `extends` 가 `../../tsconfig.base.json` 이라 깊이가 다른 폴더에서는 틀린다(`../../../`). 우회: `plugins/water` 로 임시 복사 + `extends` 경로 수정 + `pnpm install` 로 검증한 뒤 지움. **제안:** "예제를 `docs/examples` 에 둘 때는 어떻게 검증하는가"를 한 단락 적거나, 예제는 `plugins/` 에서 만들고 옮기라고 안내한다. `pnpm test docs/examples/water` 가 되는지도 확인하지 못했다.
2. **2.6 — `pnpm install` 이 `pnpm-lock.yaml` 을 바꾼다.** 가이드는 "바뀐 lock 을 커밋"이라고 하지만, 예제처럼 lock 을 건드리면 안 되는 작업(이번 금지 조건)에서는 어떻게 하라는 말이 없다. 새 패키지는 lock 에 항목이 생기므로 피할 수 없다. 이번에는 검증 뒤 `git checkout pnpm-lock.yaml` 로 되돌렸다. **제안:** "임시 검증이면 lock 을 되돌려도 된다" 한 줄.
3. **4.3 / 2.7 — 권한이 `{}` 인 플러그인은 허용 창이 없어서 "허용 뒤 running" 흐름을 볼 수 없다.** 문서대로(4.3 "비어 있으면 창 없이 바로 허용으로 기록") 정상 동작이었고 `--permission-answer=allow` 는 영향이 없었다. 다만 2.7 과 완료 기준만 읽으면 모든 플러그인이 허용 창을 거치는 것처럼 읽힌다. **제안:** 2.7 에 "권한 없는 플러그인은 `--permission-answer` 가 필요 없다" 를 적는다.
4. **5장 — 상태 저장 수단이 없다는 말이 없다 (모호).** "오늘 마신 잔 수"처럼 재시작 뒤에도 남아야 할 값을 둘 곳이 `ctx` 에 보이지 않는다(`secrets` 는 비밀용). 이번에는 메모리 변수로 두어 앱을 다시 켜면 0 으로 돌아간다. **제안:** "ctx 에 영속 저장소는 없다. 메모리 상태는 재시작 때 사라진다. 필요하면 `secrets` 를 쓰거나 아직 지원하지 않는다" 를 명시.
5. **9장 — 날짜가 바뀌는 로직의 테스트 방법이 없다.** 하네스에 시계 대체가 없다. vitest 의 `vi.useFakeTimers()` + `vi.setSystemTime()` 이 `Date` 에는 통했다(하네스의 `runEvery` 는 직접 호출이라 영향 없음). **제안:** 9장에 "시간에 의존하는 코드는 vitest 가짜 타이머로 `Date` 를 고정한다" 한 줄과 예.
6. **2.7 "버튼 눌러 보기" — 이벤트 `source: "http"` 로 플러그인 액션 버튼이 실행되는 이유가 설명되지 않는다 (모호).** 7장은 "버튼 `action` 은 `<자기 id>.` 로 시작" 이라 했는데 외부 `http` 이벤트가 `water.today` 를 가진 것이 통과했다. 동작은 했으나 규칙의 예외인지 확인할 수 없다. **제안:** 한 문장으로 외부 이벤트의 `action` 규칙을 적는다. 또 이 방법으로는 `water.drank`(카운트 올림 + `react`)의 화면 결과를 확인하지 못했다(말풍선 텍스트만 읽음). `react` 가 실제 재생되는지 보는 방법이 없다.
7. **2.7 격리 실행 1) — `Copy-Item <dist> <대상>\dist -Recurse` 는 대상 `dist` 가 이미 있으면 `dist\dist` 로 중첩된다.** 재실행(코드 고친 뒤 다시 복사)에서 발생한다. 이번엔 `-Force` 와 처음 한 번만 실행해서 피했다. **제안:** 복사 전에 대상 폴더를 지우거나 `Copy-Item plugins\stretch\dist\* ...` 로 바꾼다.

## 확인한 단계 (이상 없음)

1. 1장 `pnpm install`, `pnpm build:host` → 성공. `pnpm --filter @deskpet/cli build`, `pnpm --filter @deskpet/desktop build` 성공. `electron.exe` 가 없어서 가이드의 `node node_modules/electron/install.js` 로 받음 → 해결(가이드 설명이 정확했다).
2. 2.2~2.5 manifest/package/tsconfig/코드/테스트 구조는 그대로 따라 해서 typecheck·build·테스트 통과. `import type` 만 써서 `dist/` 를 저장소 밖으로 복사해도 실행됨.
3. 3.2 id 접두 규칙, 7장 `react`·`notify`·`ttlMs`·`key` 규칙, 6장 `configSchema`·기본값 규칙 → 설명대로 동작(범위 검사를 코드에서 한 것 포함).
4. 2.7 격리 실행(`--dev-control`, `--user-data-dir`, `--plugins-dir`, `--event-port=0`) → `water` `running`. 10.4 로그 위치·형식 일치. 사용자 실제 데이터 폴더는 쓰지 않았다(임시 폴더).
5. 확인하지 못한 것: 트레이/펫 메뉴 화면 확인, 설정 창 폼 확인, `react` 표정 재생, 간격 알림이 실제 시간에 뜨는지(60분).

반영: 26695a8에서 1–7 처리
