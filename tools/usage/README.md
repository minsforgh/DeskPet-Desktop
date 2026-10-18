# 사용률 수집기 (tools/usage)

Codex 와 Claude 의 rate-limit 사용률을 모아 `pnpm usage` 한 줄 요약과
`docs/progress/STATUS.md` 의 자원 표를 갱신하는 운영 도구다. 어느 코드도 세션 내용
(트랜스크립트, 프롬프트, 비용 상세)을 읽거나 저장하지 않고, rate_limits 숫자와 시각만 다룬다.

| 파일 | 역할 |
|---|---|
| `codex-usage.mjs` | `~/.codex/sessions` 의 token_count 이벤트에서 최신 사용률을 뽑는다. 별도 설정이 필요 없다. |
| `claude-statusline-tee.mjs` | Claude Code statusLine 커맨드. stdin JSON 에서 사용률 숫자만 스냅샷으로 저장하고, 원본 stdin 을 Orca 상태줄 스크립트(`~/.orca/agent-hooks/claude-statusline.cmd`)에 그대로 넘겨 Orca 표시를 유지한다. 아무것도 출력하지 않는다. |
| `claude-usage.mjs` | 위 스크립트가 남긴 스냅샷(`claude-rate-limits.json`)을 판독한다. |
| `collect.mjs` | CLI. `pnpm usage` 가 여기를 실행한다. |

## Claude 사용률 수집 설정 (한 번만)

Claude Code 는 사용률을 파일로 남기지 않고, statusLine 커맨드의 stdin JSON
(`rate_limits.five_hour` / `rate_limits.seven_day`, 구독 로그인일 때만) 으로만 알려준다.
그래서 이 저장소의 `.claude/settings.local.json` 에 statusLine 티를 끼운다:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node tools/usage/claude-statusline-tee.mjs",
    "refreshInterval": 60
  }
}
```

설정을 넣은 뒤 **새 Claude Code 세션**을 시작해야 적용된다. 세션이 살아 있는 동안
`refreshInterval` 초마다 stdin 이 들어오고, 그때마다 스냅샷이 갱신된다.

- 상대 경로는 세션의 작업 디렉터리가 이 저장소 루트일 때만 찾아진다. 스냅샷
  (`~/.deskpet/usage/claude-rate-limits.json`)이 생기지 않으면 절대 경로로 바꾼다
  (Windows 에서도 슬래시로 쓰면 된다):
  `"command": "node C:/Users/<user>/orca/workspaces/deskpet/<worktree>/tools/usage/claude-statusline-tee.mjs"`
- 동작 확인: 세션에서 한 번 응답을 받은 뒤 `pnpm usage` 를 실행해 `Claude 5시간 … · 기준 …`
  줄이 나오는지, 또는 스냅샷 파일의 수정 시각이 갱신되는지 본다.
- 사용자 전역 설정(`~/.claude/settings.json`)은 건드리지 않는다. 이 저장소 로컬
  설정이므로 **이 저장소에서 연 세션이 실행 중일 때만** 값이 갱신된다.
- 스냅샷 위치는 `DESKPET_USAGE_DIR` 환경변수로 바꿀 수 있다(기본 `~/.deskpet/usage/`).
- 값이 낡았는지는 `pnpm usage` JSON 출력의 `asOf`(마지막 수집 시각)와 각 창의
  `resetPassed`(기록된 리셋 시각이 지났는지)로 판단한다. 세션을 닫으면 갱신도 멈춘다.

## 사용

### 주간 자원 표

```sh
node tools/usage/weekly-resources.mjs --from 2026-10-12T00:00:00+09:00 --to 2026-10-19T00:00:00+09:00 --markdown
```

시작을 포함하고 끝을 제외합니다. 입력 토큰은 external-tools의 `agent-usage.mjs` 출력에서 일반 입력·캐시 읽기·캐시 쓰기를 합산합니다. 기본 경로는 `C:/Users/Example/Desktop/Wiki/external-tools/ai-workflow/tools/agent-usage.mjs`이고, `DESKPET_AGENT_USAGE` 환경 변수로 바꿀 수 있습니다. coordinator Opus 비중은 coordinator 입력 중 Opus의 몫이며, 표의 비교 열에는 전체 입력 중 Opus coordinator의 몫도 함께 표시합니다.

Orca Run은 worker-list의 worktree 경로에 `/orca/workspaces/deskpet/`가 있는 경우만 고릅니다. 혼합 Run에서는 DeskPet worker의 dispatch만 셉니다. 재시도율은 지정 기간과 겹친 dispatch가 2개 이상인 task 수를 기간과 겹친 dispatch가 하나 이상인 task 수로 나눕니다. 후속 수정 비율은 기간에 생성된 전체 task 중 제목에 `fix`(대소문자 무관), `수정`, `보완`, `재작업` 중 하나가 포함된 task의 비율입니다. worker 없는 task도 이 분모에 포함합니다. Codex 주간·5시간 사용률은 가장 최근 rate_limits 기록의 기준 시각과 함께 보여 주므로, 지정 기간의 누적 사용량을 뜻하지 않습니다. 못 읽는 지표는 원인을 붙여 `미확인`으로 표시합니다.

```sh
pnpm usage                                   # 한 줄 요약 (Codex 줄 + Claude 줄)
node tools/usage/collect.mjs                 # JSON (codex, claude)
node tools/usage/collect.mjs --write-status docs/progress/STATUS.md
```

- `--text` 요약의 Claude 줄 예: `Claude 5시간 23% (리셋 17:00 KST), 주간 41% (리셋 10/12 09:00 KST) · 기준 14:30 KST`.
  스냅샷이 없으면 `Claude 미확인`.
- `--write-status` 는 `| Codex 주간 |` 과 `| Claude 주간 |` 행을 같은 형식으로 교체한다.
  없는 행은 건너뛰고 둘 다 없으면 오류로 끝난다. `| Claude Opus 주간 |` 행은 건드리지 않는다.

## 공개 사본의 외부 측정 도구

주간 집계 도구의 개인 PC 절대 경로는 제거했습니다. 별도 `agent-usage.mjs`를 보유했다면 `DESKPET_AGENT_USAGE` 환경 변수로 지정하세요. 기본 상대 경로 `./external-tools/agent-usage.mjs`는 이 저장소에 포함하지 않습니다. 도구가 없을 때 토큰 집계는 미확인으로 표시합니다. 원본 대화·사용량 로그와 외부 운영 스크립트는 공개하지 않습니다.
