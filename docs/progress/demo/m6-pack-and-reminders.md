# M6 데모: 캐릭터 팩 편집과 reminders [알림] 탭

> 데모 정의(milestones.md M6): 내장 팩의 어투·상호작용을 고쳐 저장("(내 버전)" 팩 자동 생성) → 재시작 후에도 그 팩 문구로 hook·jungle·reminders 알림이 뜬다. 새 reminders 화면에서 규칙을 추가하고 다음 알림 시각을 확인한다.
>
> 근거: 아래 e2e 는 모두 사용자가 보는 결과(말풍선 문구, 우클릭 메뉴, 설정 창 화면 값, 디스크 파일)를 단언한다. main `04d376b` 에서 전체 e2e 3연속 30/30 통과(2026-10-09 04:14–04:28). 사용자가 실제 앱으로 확인(2026-10-09 "확인").

## 시나리오와 근거

| # | 데모 단계 | 보이는 결과 | 근거 (e2e) |
|---|---|---|---|
| 1 | 설정 창 [캐릭터] 탭에서 wolf-maid 를 골라 [이 캐릭터 쓰기] | 펫이 wolf-maid 로 바뀌고 재시작 후에도 유지 | `apps/desktop/e2e/settings-character.e2e.test.ts`, `character-packs.e2e.test.ts` |
| 2 | [어투] 하위 탭에서 done 첫 변형을 고치고 [저장] | `wolf-maid-mine` "(내 버전)" 팩이 생겨 현재 팩이 되고, done 알림 말풍선에 고친 문구. 내장 `characters/wolf-maid/voice.json` 불변 | `voice-editor.e2e.test.ts` |
| 3 | [상호작용] 하위 탭에서 쓰다듬기 대사를 고치고 새 항목을 추가해 [저장] | 우클릭 메뉴에 새 항목, 누르면 고친/새 대사가 말풍선에 그대로(어투 미적용). 말풍선 끄기·숨김·되돌리기·120자 초과 오류 | `interactions-editor.e2e.test.ts`(6건) |
| 4 | 예전 settings.json 의 상호작용 | 첫 시작에 "(내 버전)" 팩으로 옮겨지고 `.bak` 이 남으며 메뉴 순서 유지 | `interactions-pack.e2e.test.ts`, `pet-menu.e2e.test.ts` |
| 5 | reminders·jungle·hook 알림 | wolf-maid 팩이면 어투 문구("주인님, 시간이에요. 회의 시작이에요"), placeholder 면 원문 | `reminders.e2e.test.ts`, jungle 단위 테스트(`plugins/jungle/src/*.test.ts`), hook 은 M5 기준 15 |
| 6 | [알림] 탭에서 [+ 새 알림] → 오전/오후·시·분·요일 지정 → 카드 [저장] | 카드에 "다음 알림: 오늘 오후 …", 시계를 당기면 말풍선 발화, 다른 카드의 저장 안 한 편집은 저장되지 않음, 삭제는 카드 안에서 확인 | `reminders-tab.e2e.test.ts`(3건) |
| 7 | 개발자 모드(D-044) 켜고 내장 팩 저장 | 임시 내장 폴더의 `voice.json` 이 바뀌고 "-mine" 팩이 생기지 않음. 끄면 다시 파생 | `character-devmode.e2e.test.ts` |
| 8 | 깨진 팩(`characters/mochi`) | 목록에 "manifest.json 이 없어요" 짧은 문구, 영역 안에 표시 | `character-devmode.e2e.test.ts`, `character-panel.test.ts` |

## 없는 것

- 설정 창 화면 스크린샷·녹화: 개발 제어 `screenshot` 은 펫 창만 찍고 설정 창 캡처 명령이 없다. 데스크톱 캡처는 다른 창이 섞여 coordinator 가 찍지 않는다. 필요하면 사용자 몫(선택).
