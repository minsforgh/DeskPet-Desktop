# 새 PC 에서 이어서 작업하기

PC 를 바꿔도 지금의 개발 방식(Claude coordinator + Orca + Codex·GLM·Sonnet worker)을 그대로 쓰기 위한 체크리스트.

## 저장소에 이미 있는 것 (clone 만 하면 된다)

- 프로젝트 규칙: `CLAUDE.md`(오케스트레이션 설정), `AGENTS.md`
- 프로젝트 스킬: `.claude/skills/` (`/milestone-start`, `/milestone-close`, `/today`, `/weekly`, `/idea`)
- 진척 문서: `docs/progress/` (세션은 `STATUS.md` 부터 읽고 이어진다)
- 설계와 결정: `docs/plan.md`, `docs/adr/`, `docs/progress/decisions.md`

## 저장소 밖이라 따로 옮기는 것

| 항목 | 이 PC 의 위치 | 새 PC 에서 |
|---|---|---|
| `/orchestrate` 스킬 | `~/.claude/skills/orchestrate` (external-tools `_skills/orchestrate` 로의 정션) | external-tools clone 뒤 정션 생성 (external-tools `_skills/README.md`) |
| Claude 프로젝트 메모리 | `~/.claude/projects/C--Users-JUNGLE-Desktop-deskpet/memory/` | external-tools `_backup/claude-memory/deskpet/` 를 복사 (external-tools `_backup/README.md`) |
| Claude Code hook (펫 알림) | `~/.claude/settings.json` | `docs/hooks/claude-code.md` 대로 다시 설정 |
| Codex notify 래퍼 (펫 알림) | `~/.codex/config.toml` | `docs/hooks/` 의 Codex 안내대로 다시 설정 |
| 메모리 폭주 감시 (memwatch) | 작업 스케줄러 `memwatch`, 로그 `%LOCALAPPDATA%\memwatch\` | external-tools `ai-workflow/tools/memory-incident-runbook.md` 의 설치 명령을 한 번 실행 (2026-10-10 grep.exe 장애의 원인 분석용) |
| 실행 중인 앱 데이터 | `%APPDATA%\deskpet` (settings, 플러그인 허용 기록, 사용자 팩) | 폴더째 복사. 단 플러그인 secret 은 Windows DPAPI 로 암호화돼 새 PC 에서 풀리지 않으므로 다시 입력. jungle 로그인도 다시 |

## 설치와 로그인

1. Git, Node, pnpm, Claude Code, Codex CLI, opencode, Orca 설치
2. 로그인: Claude 계정 2개, Codex, Z.ai(opencode 설정의 GLM 키)
3. deskpet 과 external-tools clone
4. deskpet 에서 `pnpm install && pnpm build:host`. Electron 바이너리가 없으면 `node node_modules/electron/install.js` (`docs/plugin-guide.md` 1장)
5. 확인: `pnpm test`, `pnpm test:e2e` 1회, `pnpm package`
6. Orca 에 deskpet 저장소를 등록하고 새 탭 기본 에이전트 등 설정을 맞춘다. 완료된 Orca Run 기록은 옮기지 않는다(진척은 `STATUS.md` 에 있다)

## 잃어도 되는 것

- 빌드 결과물(`dist/`, `out/`, `release/`): 다시 빌드
- `docs/art/*/out`: `docs/art/pack/README.md` 의 명령으로 다시 생성
- Orca worktree: 머지된 것만 있으므로 없어도 된다. 머지 안 된 worker 브랜치가 있으면 PC 를 바꾸기 전에 머지하거나 push 한다
