# Orca 멀티 에이전트 오케스트레이션 통합 가이드
### Claude Pro 이상 + Codex Plus 기반 · 전역 skill + 프로젝트 설정 구조

Claude 계정 하나(Pro 이상)와 Codex(ChatGPT Plus) 계정 하나로 Orca에서 **coordinator–worker 구조의 멀티 에이전트 워크플로우**를 구성하고, 이를 **어느 프로젝트에서나 재사용**할 수 있게 정리한 문서입니다.

> **주의:** Orca 오케스트레이션은 실험 기능이라 명령과 플래그가 자주 바뀝니다. 적용 전에 `orca skills get orchestration --full` 결과와 대조하세요. 이 문서는 2026년 10월 기준입니다.

## 목차

1. [구성 개요](#1-구성-개요)
2. [설정 구조: 전역과 프로젝트 나누기](#2-설정-구조-전역과-프로젝트-나누기)
3. [준비물과 설치](#3-준비물과-설치)
4. [전역 레이어: orchestrate skill](#4-전역-레이어-orchestrate-skill)
5. [프로젝트 레이어: CLAUDE.md와 AGENTS.md](#5-프로젝트-레이어-claudemd와-agentsmd)
6. [실행 흐름](#6-실행-흐름)
7. [Worker 동작 규칙](#7-worker-동작-규칙)
8. [한도 관리](#8-한도-관리)
9. [새 프로젝트 온보딩 절차](#9-새-프로젝트-온보딩-절차)
10. [트러블슈팅](#10-트러블슈팅)
11. [체크리스트](#11-체크리스트)

---

## 1. 구성 개요

```
            ┌──────────────────────────────────┐
  사용자 ─▶ │ Coordinator: Claude Code          │  작업 분해, 라우팅, 머지 판단
            │ Pro: Sonnet 기본, 계획 단계만 Opus  │  (orchestrate skill 로드)
            └────────────────┬─────────────────┘
                             │ orca orchestration worker-start
          ┌──────────────────┼───────────────────┐
          ▼                  ▼                   ▼
   Codex · Luna        Codex · Sol         Codex · Astra
   단순 작업            일반 구현             교차 리뷰
   (child worktree)    (child worktree)    (current worktree)
          │                  │                   │
          └───── worker_done (요약 보고) ──────────┘
                             ▼
                Coordinator가 확인하고 머지 결정
```

### 역할 분담

| 역할 | 담당 | 이유 |
|---|---|---|
| Coordinator | Claude Code (Sonnet 5.5 기본) | 계획과 판단에 강함. 토큰을 적게 쓰도록 설계 |
| 큰 작업의 첫 분해 | Claude Opus (`/model`로 잠깐 전환) | 설계 품질. Pro는 Opus 별도 한도가 빠듯하므로 이 단계에만 |
| 단순 작업 | Codex + Luna | 한도 소모가 가장 적음 |
| 일반 구현 | Codex + Sol | 명세가 명확한 구현에 충분 |
| 교차 리뷰 | Codex + Astra | 다른 회사 모델이 Claude의 계획과 결과를 검증 |
| 막힌 작업 | Claude Sonnet worker (예외적으로만) | Pro 한도 보호 |

---

## 2. 설정 구조: 전역과 프로젝트 나누기

오케스트레이션의 **일하는 방식**(라우팅, 승격, 토큰 절약)은 프로젝트가 바뀌어도 같습니다. 반면 **실행 정보**(테스트 명령, 수정 금지 영역)는 저장소마다 다릅니다. 이 둘을 분리하면 새 프로젝트에서는 짧은 설정만 추가하면 됩니다.

| 요소 | 범위 | 위치 |
|---|---|---|
| 계정 로그인, Orca 설정 | 전역 | 머신 단위로 한 번 |
| `orca-cli` skill | 전역 | 설치 명령으로 한 번 |
| 라우팅, 승격, 토큰 절약, 머지 원칙 | **전역** | `~/.claude/skills/orchestrate/` |
| 테스트·빌드 명령, 수정 금지 영역, 병렬 상한 | 프로젝트 | `<repo>/CLAUDE.md` |
| Codex worker 행동 지침 | 프로젝트 | `<repo>/AGENTS.md` |
| worktree, Task, Run | 프로젝트 | Orca가 실행 중에 생성 |

### 파일 배치

```
~/.claude/
├── CLAUDE.md                        # (선택) skill 존재를 알리는 한 줄만
└── skills/
    └── orchestrate/
        ├── SKILL.md                 # 오케스트레이션 절차 본문
        └── commands.md              # Orca 명령 치트시트 (필요할 때만 읽음)

<repo>/
├── CLAUDE.md                        # "오케스트레이션 설정" 섹션
└── AGENTS.md                        # Codex worker 지침
```

### 왜 전역 CLAUDE.md가 아니라 skill인가

전역 CLAUDE.md는 **모든 세션에 항상 로드**됩니다. 오케스트레이션을 쓰지 않는 간단한 작업에서도 토큰을 차지하죠. skill은 설명(description)만 상주하고, 본문은 필요할 때만 불러옵니다. Claude Pro처럼 한도가 빠듯한 계정일수록 이 차이가 커집니다.

---

## 3. 준비물과 설치

### 3-1. 준비물

| 항목 | 조건 |
|---|---|
| Claude 구독 | Pro 이상 (Max면 여유가 더 있음) |
| ChatGPT 구독 | **Plus 이상.** Go는 Codex CLI를 쓸 수 없어 worker로 사용 불가 |
| Orca | 데스크톱 앱 (macOS / Windows / Linux) |
| Claude Code CLI | Claude 계정으로 로그인 |
| Codex CLI | ChatGPT 계정으로 로그인 |
| git 저장소 | worker들이 worktree를 나눠 쓰므로 필수 |

### 3-2. Orca 설치

- 다운로드: https://onorca.dev/download
- macOS Homebrew:

```bash
brew install --cask stablyai/orca/orca
```

### 3-3. 에이전트 CLI 로그인

각 CLI를 공식 문서에 따라 설치한 뒤 구독 계정으로 로그인합니다.

```bash
claude      # 첫 실행 시 Claude 계정(Pro/Max)으로 로그인
codex       # 첫 실행 시 "Sign in with ChatGPT"로 Plus 계정 로그인
```

로그인 후 각 CLI에서 다음을 확인합니다.

- Claude Code: `/status`, `/usage`
- Codex: `/status`, `/model` → **Luna, Sol, Astra의 실제 모델 ID를 메모**합니다 (4장 skill에 넣음)

### 3-4. Orca CLI 등록과 오케스트레이션 활성화

1. Orca 앱 **Settings → General → Orca CLI**에서 CLI를 등록합니다.
2. **Settings → Experimental**에서 Orchestration을 켭니다.
3. 확인:

```bash
command -v orca
orca status --json
```

### 3-5. Orca 기본 skill 설치

```bash
npx skills add https://github.com/stablyai/orca --skill orca-cli
# 설정 UI가 없는 환경이면:
orca skills install --skill orca-cli

# 최신 오케스트레이션 명령 전체 확인
orca skills get orchestration --full
```

---

## 4. 전역 레이어: orchestrate skill

아래 두 파일을 `~/.claude/skills/orchestrate/`에 만듭니다. `<...>` 자리는 3-3에서 확인한 실제 모델 ID로 바꾸세요.

### 4-1. `~/.claude/skills/orchestrate/SKILL.md`

~~~markdown
---
name: orchestrate
description: Orca에서 Claude를 coordinator로, Codex를 worker로 두고 작업을 분해·위임·리뷰·머지한다. 사용자가 "orchestrate", "오케스트레이션으로", "worker에게 맡겨" 등으로 여러 단계의 구현 작업을 맡길 때 사용한다. 한 파일 수정 같은 단순 요청에는 쓰지 않는다.
model: sonnet
---

# Orchestrate

너는 coordinator다. 직접 구현하지 않고, 작업을 Orca orchestration task로
분해해 worker에게 맡기고, 결과를 검증해 머지 여부를 결정한다.

## 0. 시작 전 확인

1. `orca status --json`이 성공하는지 확인한다. 실패하면 멈추고 사용자에게 알린다.
2. 프로젝트 CLAUDE.md의 "오케스트레이션 설정" 섹션을 읽는다.
   - 섹션이 없으면 테스트 명령과 수정 금지 영역을 사용자에게 한 번 묻는다.
3. 플래그가 기억과 다르게 동작하면 `orca skills get orchestration --full`로 확인한다.
4. 명령 문법이 필요하면 같은 폴더의 commands.md를 읽는다.
   - orca 명령은 Bash 도구로 실행한다. PowerShell은 JSON 인자와 `@그룹` 주소를 깨뜨린다.
5. 프로젝트 설정에 "진척 문서" 경로가 있으면 그 폴더의 STATUS.md만 읽는다.
   - "결정 대기"와 "사람 확인 대기"는 사용자에게 먼저 짚어 준다.
   - 경고 신호가 기록되어 있으면 그에 따른 대응(병렬 축소 등)을 이번 세션에 적용한다.
   - 나머지 진척 문서(milestones, weekly 등)는 필요할 때만 읽는다.
6. 요청 내용 없이 호출되면 작업 재개로 본다. STATUS.md의 결정 대기와 사람 확인 대기를
   먼저 보여 주고, "다음 할 일"부터 진행한다. STATUS.md가 없으면 무엇을 할지 묻는다.

## 1. 계획

- 큰 작업(파일 5개 이상, 설계 판단 포함)의 분해는 Opus로 한다. 지금 Sonnet이면 분해 전에 사용자에게 Opus 전환을 권한다 (6장 표).
- run-create로 Run을 만들고 objective에 사용자 목표를 한 줄로 적는다.
- task는 하나의 worktree 안에서 끝나는 크기로 쪼갠다.
- 서로 같은 파일을 건드리는 task는 의존성(--deps)으로 순서를 정한다.
- task는 현재 마일스톤의 완료 기준 중 어느 것에 기여하는지 spec에 적는다.
  어느 기준에도 기여하지 않는 작업은 만들지 말고 백로그로 보낸다.

## 2. 작업 명세 (task-create --spec)

모든 spec은 다음 네 줄을 포함한다.

```
범위: <수정할 파일/디렉터리>
완료 조건: <측정 가능한 조건>
검증: <프로젝트 CLAUDE.md의 테스트 명령>
금지: <건드리면 안 되는 것>
```

기존 테스트에 대한 조건은 "기존 동작 불변(기대값 확장 허용)"으로 쓴다. "기존 테스트 무수정 통과"는 배열 전체를 비교하는 테스트와 충돌한다 (M5, worker 질문). worker spec 의 검증은 typecheck·lint 와 바꾼 범위의 단위 테스트 파일·바꾼 영역의 e2e 파일 단독 실행으로 쓴다(전체 `pnpm test`·전체 e2e 는 적지 않는다 — M7: 병렬 worker 가 서로 타임아웃을 냄). 전체 검증은 coordinator 가 머지 전에 깨끗한 worktree 에서 단독으로 한다: 전체 단위 + 전체 e2e 1번 + 새로 만들었거나 단언·동작이 바뀐 e2e 파일만 3번(실행 옵션·이름만 바꾼 파일은 제외). 무관한 테스트가 실패하면 그 파일만 다시 돌려 통과하면 진행하고 기록한다. 겹치지 않는 브랜치는 통합 브랜치로 합쳐 한 번에 검증한다. 전체 e2e 연속 3번은 마일스톤 종료 점검 때만 한다 (D-050, 2026-10-09). worker_done 이 거부된 task(시작 실패 처리)는 커밋을 검증·머지한 뒤 task-update --status completed 로 닫아야 후속 task 가 풀린다. 검증용 깨끗한 worktree 는 Orca 작업 폴더(orca/workspaces) 밖의 짧은 경로(예: %TEMP%dpv)에 git worktree add --detach 로 만들고 끝나면 지운다 — Orca 폴더 안에 직접 만들면 사용자가 Orca 에서 닫을 수 있고, 긴 경로에서는 빌드가 os error 3 으로 실패한다. cd·생성이 실패하면 바로 멈추게 쓴다(|| exit 1).

범위 밖이라도 다음 두 가지는 묻지 않고 해도 된다고 spec 에 기본으로 허용한다 (M3 에서 같은 질문이 반복됨, 2026-10-07):
- 범위 안의 인터페이스를 넓혀서 생기는 호출부의 최소 수정 (예: 필수 메서드 추가에 따른 host 리터럴 한 줄)
- 워크스페이스 패키지 의존성 추가에 따른 `pnpm-lock.yaml` importer 항목 갱신 (다른 lockfile 변경은 안 됨)

## 3. Worker 라우팅

| 작업 유형 | agent | model | effort | worktree |
|---|---|---|---|---|
| 포맷팅, 린트, 타입 에러, 단순 테스트, 코드 탐색·요약, 문서 정리 (**1순위: GLM**, 사용자 결정 2026-10-07 — Codex 한도를 다른 모델에 쓰기 위해) | opencode | (모델 지정 불가, opencode 설정의 zai-coding-plan/glm-5.3) | 지정 불가 | new-child, --name 필요 |
| (GLM 실패·불가 시) 위와 같은 작업 | codex | <luna-model-id> | 기본 | new-child |
| 명세가 명확한 기능 구현, 리팩터링 | codex | <sol-model-id> | high | new-child |
| 교차 리뷰, 엣지 케이스 점검 | codex | <astra-model-id> | xhigh | current |
| 설계 판단 필요, 또는 Codex가 두 번 실패 | claude | <sonnet-model-id> | 기본 | new-child |

- effort가 "기본"이면 --effort를 생략한다.
- **GLM(opencode) 규칙:** 위 Luna 급 작업은 GLM 을 먼저 쓰고, Luna 는 GLM 이 실패했거나 사용할 수 없을 때의 대체로 쓴다. 범위가 좁고 검증이 명확한 task 만 맡긴다. 핵심·보안 로직, 설계 판단, 검증은 맡기지 않는다. 결과는 coordinator 가 직접 검증한다. 시험(2026-10-07)에서 품질은 좋았으나 매우 느렸고(약 1시간) 마지막 검증 뒤 커밋·보고를 빠뜨려 재촉이 필요했다 → spec 끝에 "검증이 끝나면 커밋하고 worker_done 을 보낸다"를 적고, 급한 task 에는 쓰지 않는다. 두 번째 시험(2026-10-07, 프레임 생성 도구: 새 파일 3개와 기존 파일 수정, 테스트 포함)은 결과 품질은 좋았으나 몇 시간이 걸렸고 재촉이 필요했다. 그래서 **GLM 에 맡기는 task 는 작게 쪼갠다(새 파일 1~2개 또는 기존 파일 수정 위주, 완료까지 한 시간 안팎 목표)**. 큰 task 는 단계(연산 추가 → CLI → 테스트)로 나눠 각각 따로 보내고, 설계 판단은 coordinator 가 미리 정해 spec 에 적는다. 한 시간 넘게 새 파일이 생기지 않으면 터미널을 읽어 상태를 확인하고 재촉하거나 중단한다. **GLM worker 는 동시에 2개까지 띄운다** (2026-10-07: 3개를 동시에 돌리다 Z.ai 5시간 한도가 소진돼 모두 멈춤). 한도 소진으로 멈추면 worker-stop(안 되면 terminal close) 뒤 같은 worktree 에서 Codex(Luna 급은 Luna, 그 이상은 Sol)로 --retry-of 이어 받는다. opencode 는 --model/--effort 를 못 쓰고 새 worktree 에는 --name 이 필요하다.
- 병렬 worker 수는 프로젝트 설정의 상한을 따르고, 없으면 3개.
- Astra worker는 동시에 하나만 띄우고, 꼭 필요할 때만 쓴다(5장).
- new-child는 커밋이 하나 이상 있는 저장소에서만 쓴다. 커밋이 없으면 먼저 사용자에게 알린다.

## 4. 실패와 승격

한 Task의 시도는 최대 3회다. 연속 3회 실패하면 Orca가 그 Task를 failed로 닫는다.

0. GLM failed → 같은 task를 Luna로 --retry-of 재시도
1. Luna failed → 같은 task를 Sol로 --retry-of 재시도
2. Sol failed → worker-read로 원인을 보고 spec을 고친다.
   - 그 Task의 두 번째 실패면 Claude Sonnet으로 재할당한다 (마지막 시도).
   - 첫 번째 실패면 Sol로 한 번 더 보낸다.
3. Codex 한도 초과 오류 → 바로 Claude Sonnet으로 재할당
4. 세 번째도 실패 → 더 재시도하지 않고 사용자에게 보고한다.
   새 Run이나 새 Task로 우회하지 않는다.

- 실패(failed)나 중단(stopped)이 확인된 시도만 재시도한다. 응답이 없다는 것만으로 재시도하지 않는다.
- 재시도할 때는 --worktree를 항상 명시한다. --retry-of는 위치를 상속하지 않는다.
  new-child에서 실패한 작업은 그 worktree를 `id:<worktreeId>`로 지정한다.

## 5. 리뷰와 머지

- 구현 task의 리뷰는 coordinator가 직접 검증하는 것이 기본이다.
- **Astra 리뷰는 아껴 쓴다 (사용자 지시, 토큰 소모가 큼).** 기본은 coordinator가 직접 검증한다(명령 실행, 실제 경로 확인). Astra 리뷰는 프로젝트의 "확인 필요 영역"(보안·권한)을 건드리는 변경이거나 사용자가 요청할 때만 쓴다. 쓸 때는 coordinator가 이미 한 검증(typecheck, lint, test, build, e2e)은 spec에서 빼고, 보안·설계 쟁점만 좁혀서 맡긴다.
- **한도 절약 규칙 (사용자 논의, 2026-10-07).** (1) task는 3~4개 항목 단위로 쪼갠다. (2) worker spec에는 바꾼 영역의 e2e 파일만 1번 돌리게 하고, 전체 검증은 coordinator가 한다(전체 e2e 1번 + 단언·동작이 바뀐 파일 3번, D-050). (3) task 시작과 끝에 Codex 주간 한도 %를 읽어 STATUS.md 자원 표에 적는다. (4) task를 만들 때 Luna로 갈 수 있는지(문서 동기화, STATUS 수치 수집, 린트·타입·테스트 정리, 코드 탐색, 잡무)를 먼저 따진다. 핵심·보안 로직과 검증은 Luna에 맡기지 않는다.
  리뷰 spec에는 원래 task의 완료 조건과 프로젝트의 리뷰 기준을 넣는다.
- 리뷰에서 문제가 나오면 수정 task를 새로 만들어 원래 worker 등급으로 보낸다.
- 프로젝트 설정의 "확인 필요 영역"을 건드리는 머지는 gate-create로 사용자 확인을 받는다.

## 6. 토큰 절약 (Claude 한도 보호)

- coordinator 모델은 단계에 따라 나눈다. 한 세션에서 `/model`로 오가기보다 단계가 바뀔 때 세션을 새로 여는 편이 실수가 적다 (상태는 STATUS.md와 Orca Run에 남는다).

  | 단계 | 모델 |
  |---|---|
  | 계획, 완료 기준 동결, 작업 분해 | Opus |
  | 실행 루프 (worker 배정, 대기, ack, release, 진척 문서 갱신) | Sonnet |
  | 리뷰 결과 판단, 사용자에게 올릴 설계 결정 정리 | Opus |
  | 마일스톤 종료 점검 | Opus |
  | 일일·주간 점검, 기록 추가 | Sonnet |

- 실행 루프 중 리뷰 보고에 "막음"이 있거나 설계 결정이 필요하면, 판단을 내리기 전에 사용자에게 Opus 전환(`/model opus`)을 권한다.
- Opus 세션에서 계획이나 판단이 끝나고 남은 일이 대기와 정리뿐이면, Sonnet으로 바꾸거나 새 세션에서 `/orchestrate`로 이어 가라고 한 줄로 알린다.
- worker 결과는 worker_done의 --body 요약으로 판단한다.
  전체 diff를 직접 읽지 않는다. 의심스러우면 리뷰 worker에게 맡긴다.
- worker-read는 --limit 50 이하로 읽는다.
- 끝난 worker는 바로 worker-release 한다. worker_done이 수락된 뒤에만 release 한다.
- worker의 question에는 reply로 답한 뒤에 --ack 한다.

## 6-1. worker 상태 확인 (대기만 믿지 않는다)

- Codex worker 시작 직후 업데이트 안내("1. Update now"가 기본 선택)가 보이면 Enter 를 보내지 말고 `--text 3`(다음 버전까지 건너뛰기)을 보낸다. 안내 화면이 시작 지시문을 가렸으면 "task-list --json 으로 <taskId> 의 spec 을 읽고 수행하라"고 다시 보낸다. 이 경우 Orca 가 시작 실패로 처리해 worker_done 이 거부될 수 있으므로, worker 의 커밋을 coordinator 가 직접 검증해 머지한다 (M5 에서 3회).
- worker 상태가 failed 인데 worktree 에 커밋이 있으면 버리지 말고 커밋을 직접 검증한다 (M5: 커밋 뒤 보고 없이 끝난 worker 2회).
- Codex 가 한도로 멈춰 같은 worktree 에서 다른 worker 가 이어받을 때는, 시작 직후 "커밋 안 된 변경이 진행분이니 버리지 말고 git diff 로 읽어 이어서 완성하라"는 안내를 반드시 보낸다. 이어받은 worker 의 완료 보고는 "통과"라고 적혀 있어도 믿지 않고, 머지 전에 coordinator 가 typecheck 부터 직접 돌린다 (M7 6e: typecheck 통과 보고와 달리 테스트 목 타입 오류가 있었다).
- worker-start 직후 worker-read --source terminal 로 화면을 한 번 본다. 지시문이 입력창에
  미제출로 남아 있으면(draft 가 보이고 작업 표시가 없음) `orca terminal send --enter` 로 제출한다.
- check --wait 가 시간 초과로 끝나면 worker-list 의 live 표시만 보고 넘어가지 않는다.
  worker-read --source terminal 로 화면을 읽어 오류(모델 용량 초과, 한도 초과, 권한 질문)로
  턴이 끝났는지 확인한다. 끝나 있으면 같은 터미널에 이어서 진행하라고 보내거나 승격 규칙을 따른다.
- worker-release 결과가 released 가 아니면(retained 등) 사유와 함께 사용자에게 알린다.
  남은 터미널은 사용자가 닫으라고 한 경우에만 terminal close 로 닫는다.
- spec 의 "범위"에는 지시한 일을 하는 데 필요한 파일을 모두 적는다 (테스트 파일 포함).

## 7. 완료 보고와 진척 갱신

세션을 마치기 전에 진척 문서가 있으면 STATUS.md를 갱신한다.

1. 수치를 모은다: `orca orchestration task-list --json`, `git log --since`, 테스트 결과.
   수집과 초안 작성은 Luna worker에게 맡겨도 된다.
2. 갱신한다: 현재 마일스톤의 완료 기준 상태, 흐름, 품질, 결정 대기, 다음 할 일(최대 3개).
   자원 사용률은 확인할 수 없으면 "미확인"으로 두고 사용자에게 요청한다.
3. 경고 신호(기획안의 경고 기준)를 대조해 해당하는 것을 적고, 대응 규칙을 제안한다.
4. worker가 제안한 범위 밖 개선은 backlog.md에 한 줄로 옮긴다.
5. "가치 메모" 칸은 비워 둔다. 사람이 채운다.

그다음 사용자에게 다음만 보고한다.
- 머지된 변경 요약 (task별 한 줄)과, 그로 인해 충족된 완료 기준
- 실패하거나 blocked된 task와 이유
- 사람 확인 대기, 결정 대기 항목
- 발생한 경고 신호와 제안하는 대응
~~~

### 4-2. `~/.claude/skills/orchestrate/commands.md`

SKILL.md 본문을 짧게 유지하려고 명령 문법은 별도 파일로 분리했습니다. coordinator는 문법이 필요할 때만 이 파일을 읽습니다.

~~~markdown
# Orca orchestration 명령 치트시트

## 셸
- 아래 명령은 POSIX 셸(bash) 문법이다. Windows에서는 Bash 도구(Git Bash)로 실행한다.
- PowerShell로는 실행하지 않는다. JSON 인자의 큰따옴표가 벗겨지고(`["yes","no"]` → `[yes,no]`),
  `@codex`와 쉼표 목록이 다르게 해석된다.

## Run, Task
orca orchestration run-create --objective "<목표>" --json
orca orchestration task-create --task-title "<제목>" --spec "<명세>" --json
orca orchestration task-create --task-title "<제목>" --spec "<명세>" --deps '["<선행 taskId>"]' --json
orca orchestration task-list --json
orca orchestration task-list --ready --brief --json
orca orchestration task-update --id <taskId> --status blocked --result '{"reason":"..."}' --json

## Worker 시작
orca orchestration worker-start --task <taskId> --worktree new-child --name <이름> \
  --agent codex --model <model-id> --effort <level> --setup run --json
orca orchestration worker-start --task <taskId> --worktree current \
  --agent codex --model <model-id> --effort xhigh --json

- effort가 "기본"이면 --effort를 생략한다.
- --name, --setup 은 new-child / new-top-level 에서만 쓴다. current나 기존 worktree에서는 거부된다.
- 결과의 launch.requested 와 launch.effective 를 비교해 실제 적용된 모델을 확인한다.
- 종료 코드 0은 ready일 때뿐이다. 실패하면 다시 띄우지 말고 failedStage, residualResources를 읽는다.

## 재시도 (worktree 반드시 명시)
orca orchestration worker-start --task <taskId> --retry-of <dispatchId> \
  --worktree id:<worktreeId> --agent <agent> --model <model-id> --json

- <worktreeId>는 실패한 시도가 쓰던 worktree의 전체 id(`<repo-id>::<path>`)다.
  첫 worker-start 결과나 `orca worktree list --json`에서 얻는다.
- new-child로 시작한 작업을 --worktree current로 재시도하면 coordinator의 worktree에서 돈다.
- 실패(failed)나 중단(stopped)이 확인된 시도만 재시도한다.
- 한 Task가 연속 3회 실패하면 Orca가 그 Task를 failed로 닫는다. 새 Run이나 다른 Task로 우회하지 않는다.

## 대기와 수신
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
orca orchestration check --ack <deliveryId> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json

- --types 는 --wait 를 깨우는 조건일 뿐이다. 돌아오는 Delivery는 항상 FIFO 배치 전체이므로
  모든 메시지를 처리한 뒤 --ack 한다.
- 타임아웃이나 빈 결과는 실패가 아니다. 빈 결과가 세 번 이어지면 worker-list로 확인한다.

## 질문에 답하기
orca orchestration reply --id <messageId> --body "<답>" --json

## 점검과 정리
orca orchestration worker-list --run <runId> --json
orca orchestration worker-show --dispatch <dispatchId> --json
orca orchestration worker-read --dispatch <dispatchId> --limit 50 --json
orca orchestration worker-stop --dispatch <dispatchId> --json
orca orchestration worker-abandon --dispatch <dispatchId> --json
orca orchestration worker-retain --dispatch <dispatchId> --json
orca orchestration worker-release --dispatch <dispatchId> --json
orca orchestration worker-list --run <runId> --terminal-state reclaimable --json

- 에이전트가 살아 있는지는 worker-list의 projection.liveness로 판단한다.
  worker-show의 observation.status는 터미널 생존만 보여 준다.
- unverifiable은 "모름"이다. 이것만으로 stop, abandon, retry, release 하지 않는다.
- worker_done이 수락되면 Task와 Dispatch는 자동으로 닫힌다. task-update --status completed를 따로 하지 않는다.
- 세션을 끝내기 전에 reclaimable 목록이 비었는지 확인한다.
- worker 화면 읽기: orca orchestration worker-read --dispatch <dispatchId> --source terminal --limit 15 --json
  (result.terminal.tail 이 화면, result.terminal.draft 가 미제출 입력)
- 미제출 지시문 제출: orca terminal send --terminal <handle> --enter --json
- 멈춘 worker 재개: orca terminal send --terminal <handle> --text "<이어서 진행하라는 지시>" --enter --json

## 결정 게이트
orca orchestration gate-create --task <taskId> --question "<질문>" --options '["yes","no"]' --json
orca orchestration gate-resolve --id <gateId> --resolution "yes" --json
orca orchestration gate-list --task <taskId> --json

## 메시지
orca orchestration send --to dispatch:<dispatchId> --subject "<제목>" --body "<내용>" --json
orca orchestration send --to "@codex" --subject "<제목>" --body "<내용>" --json

- 특정 worker에게 보내는 지시는 dispatch:<dispatchId>를 쓴다. @codex 같은 그룹은 현재 Run의 살아 있는 worker 전체에 간다.
- send 성공은 전달 대기열에 들어갔다는 뜻이다. 상대가 읽었다는 보장은 아니다.

## 주의
- --model / --effort 는 --terminal 과 함께 쓸 수 없다.
- --effort 는 --model 과 함께 써야 한다.
- orchestration run / run-stop 은 폐기된 명령이다. run-create + worker-start를 쓴다.
- release가 release_pending / release_unknown이면 terminal close로 강제 종료하지 않는다.
- 플래그가 여기와 다르게 동작하면 `orca orchestration <명령> --help`가 기준이다.
~~~

### 4-3. (선택) `~/.claude/CLAUDE.md`

skill은 설명만으로도 자동 호출되지만, 습관적으로 쓰게 하려면 전역 CLAUDE.md에 한 줄만 둡니다.

```markdown
- 여러 단계의 구현 작업을 받으면 orchestrate skill 사용을 먼저 제안한다.
```

### 4-4. 호출 방법

- 명시적 호출: `/orchestrate 결제 모듈 테스트 커버리지 80%까지 올려줘`
- 자연어: "이거 오케스트레이션으로 처리해줘"

---

## 5. 프로젝트 레이어: CLAUDE.md와 AGENTS.md

새 프로젝트마다 아래 두 파일만 채우면 됩니다.

### 5-1. `<repo>/CLAUDE.md`에 추가할 섹션

```markdown
## 오케스트레이션 설정

- 테스트: `pnpm test`
- 타입 체크: `pnpm typecheck`
- 린트: `pnpm lint`
- worktree 셋업: `pnpm install` (worker-start --setup run 시 실행)
- 병렬 worker 상한: 2   # 모노레포라 충돌이 잦음
- 수정 금지: `db/migrations/`, `.github/workflows/`
- 확인 필요 영역 (머지 전 gate): `packages/ui/` 공용 컴포넌트, `config/`
- 리뷰 기준: 결제 관련 코드는 금액 계산 경계값과 통화 반올림을 반드시 확인
- 진척 문서: `docs/progress/` (세션 시작 시 STATUS.md 읽기, 종료 시 갱신)
- 경고 기준: 재시도율 30%, 사람 확인 대기 5개, 미머지 3일, 주 중반 한도 80%
```

### 5-2. `<repo>/AGENTS.md` (Codex worker용)

Codex는 저장소의 AGENTS.md를 지침으로 읽습니다. worker의 **행동 제약**은 여기에 둡니다.

```markdown
# Agent 지침

## 작업 범위
- task spec의 "범위" 밖 파일은 수정하지 않는다.
- spec의 "금지" 항목을 어겨야만 끝낼 수 있다면 멈추고 orca orchestration ask로 묻는다.

## 코드 규칙
- TypeScript strict 모드를 유지하고 any를 새로 추가하지 않는다.
- 테스트는 vitest, 파일명은 `*.test.ts`.
- 새 의존성 추가 금지 (필요하면 ask로 확인).

## 완료 전
- spec의 "검증" 명령을 실행하고 결과를 worker_done --body에 한 줄로 적는다.
- 실패해도 worker_done --outcome failed로 반드시 보고한다.
```

---

## 6. 실행 흐름

coordinator에게 목표만 주면 skill이 아래 흐름을 실행합니다. 처음에는 직접 실행하며 익혀도 좋습니다.

```bash
# 1. Run과 Task
orca orchestration run-create --objective "결제 모듈 테스트 보강" --json
orca orchestration task-create --task-title "billing unit tests" \
  --spec "범위: src/billing/ 테스트 파일
완료 조건: 커버리지 80% 이상
검증: pnpm test
금지: 프로덕션 코드 수정" --json

# 2. Worker (Luna)
orca orchestration worker-start --task <taskId> --worktree new-child \
  --name billing-tests --agent codex --model <luna-model-id> --setup run --json

# 3. 완료 대기
orca orchestration check --wait --types "worker_done,escalation,question" \
  --timeout-ms 900000 --json

# 4. 실패 시 승격
orca orchestration worker-read --dispatch <dispatchId> --limit 50 --json
orca orchestration worker-start --task <taskId> --retry-of <dispatchId> \
  --worktree id:<worktreeId> --agent codex --model <sol-model-id> --effort high --json

# 5. 교차 리뷰 (Astra)
orca orchestration task-create --task-title "review billing tests" \
  --spec "범위: billing-tests worktree의 변경
완료 조건: 문제 목록 또는 '문제 없음'
검증: 경계값, 통화 반올림 확인
금지: 코드 수정" --json
orca orchestration worker-start --task <reviewTaskId> --worktree current \
  --agent codex --model <astra-model-id> --effort xhigh --json

# 6. 정리
orca orchestration worker-release --dispatch <dispatchId> --json
```

---

## 7. Worker 동작 규칙

Orca가 띄운 worker는 자동으로 규칙 안내(preamble)를 받습니다.

- 끝나면 성공이든 실패든 `worker_done`을 **정확히 한 번** 보낸다 (`--outcome`, `--task-id`, `--dispatch-id` 포함).
- 오래 걸리는 작업 중에는 `heartbeat`를 보낸다.
- 막히는 질문은 터미널 프롬프트 대신 `orca orchestration ask`로 묻는다.

```bash
orca orchestration send --type worker_done \
  --subject "billing 테스트 추가 완료" \
  --body "테스트 12개 추가, 커버리지 83%, pnpm test 통과. refund 엣지 케이스는 미처리." \
  --task-id <taskId> --dispatch-id <dispatchId> \
  --outcome succeeded --files-modified "src/billing/refund.test.ts" --json
```

`--body` 요약의 품질이 coordinator의 토큰 사용량을 좌우합니다. AGENTS.md에서 요약 형식을 정해 두는 걸 권합니다.

---

## 8. 한도 관리

### Claude Pro

| 항목 | 내용 |
|---|---|
| 한도 구조 | 5시간 세션 한도 + 주간 한도 + **Opus 별도 주간 한도** |
| 공유 | Claude Code와 claude.ai 채팅이 같은 한도 사용 |
| 운용 원칙 | 기본 Sonnet, Opus는 계획만. diff는 직접 읽지 않기. skill로 상주 토큰 줄이기 |
| 확인 | Settings → Usage, Claude Code의 `/usage` |

### Codex Plus

| 모델 | 5시간당 대략적인 메시지 수 (Plus 추정치) | 용도 |
|---|---|---|
| GPT-5.6 Luna | 250–2,000 | 대량 단순 작업, 탐색 |
| GPT-6 Sol | 15–150 | 일반 구현 |
| GPT-6 Astra | 3–30 | 리뷰 전용 |

- 모델을 나눠 써도 **한도 풀은 하나**입니다.
- ChatGPT 앱의 에이전트 기능(Work)과 한도를 공유합니다.
- Orca의 사용량 추적 화면에서 Claude와 Codex 사용량, 리셋 시각을 볼 수 있습니다.

### 한도 소진 시

1. **Codex 소진:** skill 규칙에 따라 Claude Sonnet으로 재할당하거나 리셋을 기다립니다.
2. **Claude 소진:** coordinator가 멈춥니다. 진행 중인 worker는 계속 돌고 결과는 Orca에 남습니다. 리셋 후 `orca orchestration task-list --json`으로 이어서 진행합니다.

---

## 9. 새 프로젝트 온보딩 절차

1. **설정 섹션 작성:** `<repo>/CLAUDE.md`에 5-1의 "오케스트레이션 설정" 섹션을 추가합니다.
2. **AGENTS.md 작성:** 5-2 템플릿에서 코드 규칙만 저장소에 맞게 수정합니다.
3. **구조 파악 (처음 보는 큰 저장소일 때):** Luna 탐색 worker로 디렉터리 구조, 주요 모듈, 테스트 위치를 요약시키고, 그 결과를 CLAUDE.md에 반영합니다.

   ```
   /orchestrate 이 저장소 구조를 Luna worker로 요약해서 CLAUDE.md 오케스트레이션 설정에 반영해줘
   ```

4. **시운전:** 작은 task 하나로 구현(Luna) → 리뷰(Astra) → 머지까지 한 번 완주합니다.
5. **조정:** worker끼리 충돌이 잦으면 병렬 상한을 낮추고, 리뷰에서 반복되는 지적은 AGENTS.md 규칙으로 옮깁니다.

---

## 10. 트러블슈팅

| 증상 | 확인할 것 |
|---|---|
| `orca` 명령을 찾을 수 없음 | Settings → General → Orca CLI 등록 여부 |
| orchestration 명령이 동작하지 않음 | Settings → Experimental 활성화, `orca status --json` 성공 여부 |
| `orchestration run`이 아무것도 안 함 | 폐기된 명령. `run-create` + `worker-start` 사용 |
| `--model`과 `--terminal`을 함께 쓰면 오류 | 두 플래그는 함께 쓸 수 없음 |
| skill이 호출되지 않음 | `~/.claude/skills/orchestrate/SKILL.md` 경로와 frontmatter 확인. `/orchestrate`로 명시 호출 |
| worker가 범위 밖 파일을 수정 | AGENTS.md "작업 범위" 규칙 확인, spec의 "범위"와 "금지"를 더 구체적으로 |
| worker가 완료를 보고하지 않음 | `worker-show`, `worker-read`로 확인 후 `worker-stop`하고 재시도 |
| release가 `release_pending` 또는 `release_unknown` | `terminal close`로 강제 종료하지 말고 결과에 나온 복구 절차를 따름 |
| 상태가 꼬임 | 다른 coordinator가 없을 때만 `orca orchestration reset --tasks --json` |

---

## 11. 체크리스트

### 한 번만 (머신 단위)

- [ ] Claude Pro 이상, ChatGPT Plus 이상 구독
- [ ] Claude Code, Codex CLI 로그인
- [ ] Codex `/model`로 Luna, Sol, Astra 모델 ID 확인
- [ ] Orca 설치, Orca CLI 등록, `orca status --json` 성공
- [ ] Settings → Experimental에서 오케스트레이션 활성화
- [ ] `orca-cli` skill 설치
- [ ] `~/.claude/skills/orchestrate/SKILL.md`, `commands.md` 생성 (모델 ID 교체)

### 프로젝트마다

- [ ] `CLAUDE.md`에 "오케스트레이션 설정" 섹션 추가
- [ ] `AGENTS.md` 작성
- [ ] 작은 task로 구현 → 리뷰 → 머지 시운전
- [ ] 1–2주 운영 후 한도 사용률과 실패 패턴을 보고 라우팅과 병렬 상한 조정

---

## 참고 자료

- Orca 오케스트레이션: https://www.onorca.dev/docs/cli/orchestration
- Orca CLI 개요: https://www.onorca.dev/docs/cli/overview
- Orca 저장소: https://github.com/stablyai/orca
- Codex 요금과 한도: https://learn.chatgpt.com/docs/pricing
- Claude Pro 플랜: https://support.claude.com/en/articles/8325606-what-is-the-pro-plan
