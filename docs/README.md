# docs

DeskPet 프로젝트의 기획, 작업 방식, 진척 기록을 모아 둔 폴더입니다.

| 파일 | 역할 | 언제 보나 |
|---|---|---|
| `plan.md` | **기획안.** 무엇을 만들지: 구조, 플러그인 규약, 마일스톤과 완료 기준, 진척 관리 규칙 | 마일스톤 계획과 종료 때 |
| `jungle-plugin-design.md` | `jungle` 플러그인 상세 설계 (정글 출석 상태 읽기) | M5 진행 때 |
| `setup-new-pc.md` | **새 PC 에서 이어서 작업하기.** 저장소 밖에 있는 스킬·메모리·hook·앱 데이터를 옮기는 체크리스트 | PC 를 바꾸거나 다시 설치할 때 |
| `plugin-guide.md` | **플러그인 작성 가이드.** 매니페스트·권한·`PluginContext`·설정 스키마·테스트·배치 방법과, 처음부터 끝까지 따라 하는 예제 | 플러그인을 만들거나 고칠 때 |
| `orchestration-guide.md` | **작업 방식.** Orca + Claude + Codex 에이전트 팀 구성, `orchestrate` skill 원문 | 처음 세팅할 때 |
| `prompts.md` | coordinator에게 붙여 넣을 시작·반복 프롬프트 모음 | 매번 |
| `progress/` | **진척 기록.** 현재 상태, 마일스톤 체크, 결정, 백로그, 주간 점검 | 매일 `STATUS.md`만 |

## 시작 순서

1. `orchestration-guide.md` 3장대로 Orca, Claude Code, Codex를 세팅한다 (직접).
2. `prompts.md`의 1번 프롬프트로 `orchestrate` skill을 설치한다.
3. `prompts.md`의 2번 프롬프트로 저장소를 초기 세팅한다.
4. `prompts.md`의 3번대로 `/milestone-start 0`으로 M0를 시작한다.
5. 이후로는 `prompts.md` 4번의 명령(`/orchestrate`, `/today` 등)을 반복한다.

## 평소에 보는 파일

- 매일: `progress/STATUS.md`
- 결정이 필요할 때: `progress/decisions.md`
- 아이디어가 떠오를 때: `progress/backlog.md`에 한 줄 (바로 구현하지 않기)
- 매주: `progress/weekly/TEMPLATE.md`를 복사해 `progress/weekly/YYYY-Www.md`로 작성
