# DeskPet

바탕화면 위에 사는 캐릭터가 에이전트 작업 완료, 출석 마감, 메신저 멘션을 지켜보다가 표정과 말풍선으로 알려 주는 앱. 모든 기능은 플러그인으로 붙고 뗄 수 있다.

- 기획안: `docs/plan.md`
- 문서 안내: `docs/README.md`

## 오케스트레이션 설정
- 테스트: `pnpm test`
- 타입 체크: `pnpm typecheck`
- 린트: `pnpm lint`
- worktree 셋업: `pnpm install && pnpm build:host && node node_modules/electron/install.js` (새 worktree 에서 `pnpm test` 의 단위 4파일이 `@deskpet/plugin-host` 빌드 결과를 찾으므로, M8. 새 worktree 에 Electron 실행 파일이 없어 e2e·패키징이 실패한 일이 M10·M11 에 한 번씩 있어 Electron 설치를 더함, M11)
- 병렬 worker 상한: 3
- worker 대기 알림(DeskPet CLI): `node C:/Users/Example/Desktop/deskpet/packages/cli/dist/index.js` — watcher 의 `--notify-deskpet` 값 (M14 기준 4)
- worker 기준 브랜치: 새 worktree로 worker를 띄울 때 `--base-branch main`을 명시한다 (Orca 기본값은 `origin/main`이라 로컬 main이 앞서 있으면 오래된 커밋에서 시작한다)
- 머지 전 확인 (D-050): `apps/desktop`이 바뀐 브랜치는 coordinator가 깨끗한 worktree(커밋 안 된 편집이 없는 곳)에서 전체 `pnpm test:e2e` 1번과, 새로 만들었거나 단언·동작이 바뀐 e2e 파일만 3번 직접 실행한다(실행 옵션·이름만 바꾼 파일은 전체 1번으로 충분). 변경과 무관한 테스트가 실패하면 그 파일만 단독으로 다시 돌려 통과하면 진행하고 STATUS.md에 기록한다. 서로 겹치지 않는 브랜치는 합쳐서 한 번에 검증해도 된다. 전체 e2e 연속 3번은 마일스톤 종료 점검 때만 한다
- 수정 금지: `packages/plugin-sdk/src/v1/` (규약 변경은 ADR과 사용자 확인 필요)
- 확인 필요 영역 (머지 전 gate): `packages/plugin-host/` 권한 검사, `apps/desktop/src/main/event-server`
- 리뷰 기준: 외부 시스템 쓰기 동작이 사용자 버튼 없이 실행되는 경로가 없는지 반드시 확인. 승인된 예외는 slack Socket Mode 의 연결 열기(`apps.connections.open` POST)와 수신 ack 두 동작뿐이고, 호스트가 v2 연결 권한으로만 보낸다(D-062). 그 밖의 자동 송신은 결함으로 본다
- 진척 문서: `docs/progress/` (세션 시작 시 STATUS.md 읽기, 종료 시 갱신)
- 경고 기준: 재시도율 30%, 사람 확인 대기 5개, 미머지 3일, 주 중반 한도 80% (16-5장)
- 마일스톤 시작과 종료: `/milestone-start <n>`, `/milestone-close <n>`으로만 한다 (사용자가 직접 호출). `docs/progress/milestones.md`에 완료 기준이 동결되지 않은 마일스톤의 task는 만들지 않고 `/milestone-start <n>`을 안내한다.
- 마일스톤 종료 안내: 현재 마일스톤의 완료 기준이 모두 충족 또는 사람 확인 대기가 되면, 완료 보고의 첫 줄에서 `/milestone-close <n>`을 안내한다. 다음 마일스톤의 task를 이어서 만들지 않는다.
