# 프롬프트 모음

coordinator(Claude Code)에 붙여 넣어 쓰는 프롬프트입니다. `<...>` 부분만 채우세요.
1–3번은 순서대로 한 번씩 쓰고, 4번은 반복해서 쓰는 명령 목록입니다.

> 팁: 4번의 명령은 Orca **Settings → Quick Commands**에 프로젝트 범위로 저장해 두면 버튼 한 번으로 실행할 수 있습니다.
> coordinator 세션은 Orca의 floating terminal에 띄워 두면 worktree를 오가도 항상 손에 닿습니다.

---

## 0. 먼저 직접 해야 할 일

프롬프트로 대신할 수 없는 부분입니다.

1. Orca 설치, Claude Code와 Codex CLI 로그인
2. Orca **Settings → General → Orca CLI** 등록, **Settings → Experimental**에서 오케스트레이션 켜기
3. Codex에서 `/model`로 Luna, Sol, Astra 모델 ID 확인, Claude Code에서 Sonnet 모델 ID 확인
4. `deskpet` 폴더를 만들고 `git init`, 이 `docs/` 폴더를 그 안에 넣기
5. Orca에서 저장소를 열고 Claude Code 세션 띄우기

---

## 1. skill 설치 (머신당 한 번)

```
docs/orchestration-guide.md의 4장을 기준으로 전역 skill을 설치해줘.

- ~/.claude/skills/orchestrate/SKILL.md 와 commands.md 를 4-1, 4-2절 내용 그대로 만들어.
- 모델 ID는 다음으로 교체해:
  - Luna: <luna-model-id>
  - Sol: <sol-model-id>
  - Astra: <astra-model-id>
  - Sonnet: <sonnet-model-id>
- orca-cli skill이 없으면 3-5절 명령으로 설치해.
- 마지막으로 `orca status --json`과 `orca skills get orchestration --full`을 실행해서,
  commands.md의 플래그와 실제 CLI가 다른 부분이 있으면 목록으로 알려줘. 고치기 전에 나에게 먼저 확인받아.
```

---

## 2. 저장소 초기 세팅 (프로젝트당 한 번)

```
docs/plan.md(기획안)를 읽고 이 저장소의 초기 세팅을 해줘. 아직 기능 구현은 하지 마.

1. 기획안 11장의 디렉터리 구조를 빈 폴더와 최소 설정 파일로 만들어.
   - pnpm 모노레포, TypeScript strict, vitest, 린트 설정
   - pnpm test / typecheck / lint / build 가 빈 상태에서 통과해야 해
2. CLAUDE.md를 만들어. 내용은:
   - 프로젝트 한 줄 소개와 docs/plan.md, docs/README.md 위치
   - 기획안 13-3장의 "오케스트레이션 설정" 섹션 그대로
3. AGENTS.md를 docs/orchestration-guide.md 5-2절 템플릿 기반으로 만들되,
   이 프로젝트 규칙을 추가해:
   - packages/plugin-sdk/src/v1/ 수정 금지
   - 외부 시스템에 쓰기 요청을 보내는 코드 금지 (사용자 버튼으로 호출되는 액션 제외)
   - worker_done --body 형식: "한 일 / 검증 결과 / 남은 것 / 기여한 완료 기준 번호"
4. docs/progress/STATUS.md의 첫 상태를 채워. 현재 마일스톤은 M0, 결정 대기에는 기획안 15장 항목을 넣어.
5. 첫 커밋을 만들어.

끝나면 만든 파일 목록과, 내가 결정해야 할 것만 짧게 보고해.
```

---

## 3. 마일스톤 시작

```
/milestone-start 0
```

- 완료 기준 초안(기획안 16-3장 기준)을 보여 주고, 확인하면 `docs/progress/milestones.md`에 동결한 뒤 `orchestrate` 절차로 task를 나눠 진행합니다.
- M0의 규약 내용은 기획안 5장(확장 구조)과 6장(핵심 규약)이 기준이고, 산출물은 ADR 3건, `packages/core`·`packages/plugin-sdk`의 타입과 스키마, 구현 없이 실패하는 계약 테스트입니다.
- 머지 전에는 gate로 승인을 요청합니다. 승인하기 전에는 마일스톤이 완료로 표시되지 않습니다.
- M1부터도 같은 명령에 번호만 바꿔 씁니다 (4번 표 참고).

---

## 4. 반복해서 쓰는 명령

반복 작업은 skill로 만들어 두었습니다. 절차 원문은 각 skill 파일에 있고, 여기에는 목록만 둡니다.

| 언제 | 명령 | 하는 일 | skill 위치 |
|---|---|---|---|
| 새 세션을 열었을 때 | `/orchestrate` | STATUS.md의 결정 대기·사람 확인 대기를 먼저 보여 주고 "다음 할 일"부터 진행 | `~/.claude/skills/orchestrate/` (전역) |
| 매일 (5분) | `/today` | 오늘 처리할 것만: 사람 확인 대기, 결정 대기, 경고 신호 | `.claude/skills/today/` |
| 매주 | `/weekly` | 이번 주 점검 파일을 만들고 수치 칸 채우기 | `.claude/skills/weekly/` |
| 아이디어가 떠올랐을 때 | `/idea <내용>` | backlog.md에 한 줄 추가만 (구현하지 않음) | `.claude/skills/idea/` |
| 다음 마일스톤 시작 | `/milestone-start <n>` | 완료 기준 구체화 → 확인 → 동결 → task 분해 | `.claude/skills/milestone-start/` |
| 마일스톤 종료 | `/milestone-close <n>` | 기준별 근거 확인, 데모, 문서 반영 목록, 계속/조정/멈춤 권고 | `.claude/skills/milestone-close/` |

- `/milestone-start`, `/milestone-close`는 직접 호출할 때만 실행됩니다. Claude가 알아서 발동하지 않습니다.
- 모델은 skill마다 정해 두었습니다: `/milestone-start`, `/milestone-close`는 Opus, `/orchestrate`, `/today`, `/weekly`, `/idea`는 Sonnet. 실행 중 리뷰 판단이나 설계 결정이 필요하면 coordinator가 Opus 전환을 권합니다.
- Orca **Settings → Quick Commands**에는 인자가 없는 `/orchestrate`, `/today`, `/weekly`만 등록하면 됩니다. 버튼에는 명령 이름만 넣고, 절차를 바꿀 때는 skill 파일을 고칩니다.
- 절차를 바꾸고 싶으면 이 문서가 아니라 skill 파일을 수정합니다.
