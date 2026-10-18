# M14 기준선 — M0–M13 오케스트레이션 지표 고정 (완료 기준 1)

> 공개 사본: 사용자 경로·다른 프로젝트명·실제 Run ID는 일반 이름과 별칭으로 바꿨습니다. 아래 명령은 당시 측정 방법을 설명하며 그대로 실행할 수 있는 명령이 아닙니다. 원본 로그·외부 도구는 포함하지 않아 독립 재계산에는 한계가 있습니다. [사본 안내](../PUBLIC-SNAPSHOT.md)

> 측정일 **2026-10-17**. M14 "오케스트레이션 보강"의 개선 전 기준선을, M13 종료 시점까지 전 기간을 다시 측정해 이 문서에 고정한다.
> 원 측정은 백로그 2026-10-16 AoGD 항목(M13 진행 중 잰 값). 이 문서의 값이 기준 12(재측정·비교)의 비교 기준이 된다.

## 1. 측정일 · 대상 기간

| 항목 | 값 |
|---|---|
| 측정일 | 2026-10-17 (M14 1단계, worktree `m14-1-baseline`) |
| 대상 | DeskPet M0–M13 오케스트레이션 전체 |
| 기간(정의) | M0 Run 생성 2026-10-05T14:28:28Z ~ M14 시작 명령(`/milestone-start`) 2026-10-17T12:21:08Z (11.5일) |
| 기간(실제 dispatch) | 2026-10-05 23:35 ~ 2026-10-17 11:45 KST, 276.2h (도구 출력) |
| 토큰 측정 창 | `--from 2026-10-05T00:00:00Z --to 2026-10-17T12:21:08Z` (아래 참고) |

토큰 측정 상한을 12:21:08Z로 잡은 이유: M13 종료 세션의 마지막 기록은 2026-10-17T05:29:11Z(세션 `/clear`)이고, 그 뒤 같은 세션 파일에서 12:21:08Z에 M14 `/milestone-start`가 시작됐다. 두 시각 사이에 deskpet 관련 기록이 없으므로 이 경계가 파일을 못 가르는 세션도 시각으로 정확히 자른다. 하한 2026-10-05T00:00:00Z는 M0 킥오프 대화 포함.

## 2. 재현 명령

도구: external-tools `ai-workflow/tools/`(저장소 밖, 읽기 전용). Node 24 필요(zstd·node:sqlite). 명령은 PowerShell·Git Bash 모두 그대로 실행된다.

**대상 Run 선정 기준** — `orca orchestration run-list`의 Run 중 objective가 DeskPet 마일스톤(M0–M13)을 가리키거나, `worker-list --run <id>`의 worktree 경로가 `C:/Users/Example/orca/workspaces/deskpet/...` 아래인 Run 18개. 제외: example-project-a 3개(`run_public_003`, `run_public_004`, `run_public_005` — worktree가 `orca/workspaces/example-project-a/`), AoGD 1개(`run_public_006` — `orca/workspaces/example-project-b/`), 현재 M14 Run(`run_public_007`), legacy(`run_legacy_local`).

선정된 18개 Run: M0 `run_public_008`, M1 `run_public_009`, M2 `run_public_010`, M3 `run_public_011`, CLI 안내·잡무 `run_public_012`, M4 `run_public_013`, M5-1 `run_public_014`, M5-2 `run_public_015`, 잡무 브로커(pet.e2e 조사 이어) `run_public_016`, M6-1 `run_public_017`, M6-2 `run_public_018`, M7 `run_public_019`, M8 `run_public_020`, M9 `run_public_021`, M10 `run_public_022`, M11 `run_public_001`, M12 `run_public_002`, M13 `run_public_023`.

### 2-1. 토큰 사용량

```bash
node C:/Users/Example/Desktop/Wiki/external-tools/ai-workflow/tools/agent-usage.mjs --match deskpet --coordinator Desktop-deskpet --from 2026-10-05T00:00:00Z --to 2026-10-17T12:21:08Z
```

```
tool	role	model	sessions	calls	input	cacheRead	cacheWrite	output	inShare
claude	coordinator	claude-opus-5-5	11	3455	0.01M	1247.00M	13.07M	2.46M	47%
codex	worker	gpt-6-sol	115	-	13.44M	584.44M	0.00M	2.48M	22%
claude	coordinator	claude-sonnet-5-5	8	1443	0.00M	405.15M	4.08M	1.08M	15%
claude	worker	claude-sonnet-5-5	70	1921	0.00M	217.17M	6.92M	1.92M	8%
opencode	worker	glm-5.3	33	1237	3.17M	91.62M	0.00M	0.97M	4%
codex	worker	gpt-6-astra	14	-	1.72M	35.59M	0.00M	0.28M	1%
codex	worker	gpt-5.6-luna	11	-	0.94M	27.57M	0.00M	0.10M	1%
claude	worker	claude-opus-5-5	1	33	0.00M	5.60M	0.20M	0.09M	0%
total input-side 2657.70M, output 9.38M; coordinator 63% of input, 38% of output
```

### 2-2. 프로세스 지표

```bash
node C:/Users/Example/Desktop/Wiki/external-tools/ai-workflow/tools/orca-run-metrics.mjs --run run_public_008,run_public_009,run_public_010,run_public_011,run_public_012,run_public_013,run_public_014,run_public_015,run_public_016,run_public_017,run_public_018,run_public_019,run_public_020,run_public_021,run_public_022,run_public_001,run_public_002,run_public_023 --gap-min 60
```

```
runs 18, tasks 229, dispatches 243
first-pass 201/226 (89%), retried 25, handled without worker 3
non-success dispatch reasons {
  timeout: 1,
  abandoned: 2,
  'Agent startup blocked: agent-update-prompt': 7,
  '{\\': 1,
  'Terminal closed by operator request': 1,
  stopped: 10,
  'The assigned worker terminal is no longer live after orchestration recovery.': 3
}
task minutes: median 11, p90 23, max 414, sum 66.9h
span 2026-10-05 23:35 -> 2026-10-17 11:45 KST (276.2h), busy 50.9h (18%)
hours by concurrency { '0': '225.2', '1': '36.4', '2': '13.1', '3': '1.4' }
idle gaps >= 60 min:
  2026-10-06 01:43 -> 03:12 (89 min)
  2026-10-06 11:20 -> 12:36 (76 min)
  2026-10-06 19:13 -> 20:33 (80 min)
  2026-10-06 21:56 -> 01:24 (208 min)
  2026-10-07 02:23 -> 03:30 (68 min)
  2026-10-07 04:15 -> 09:39 (324 min)
  2026-10-07 09:47 -> 11:01 (74 min)
  2026-10-07 19:03 -> 20:11 (69 min)
  2026-10-07 20:19 -> 01:27 (308 min)
  2026-10-08 02:54 -> 09:25 (392 min)
  2026-10-08 11:19 -> 13:42 (143 min)
  2026-10-08 20:34 -> 23:26 (171 min)
  2026-10-09 07:25 -> 08:26 (61 min)
  2026-10-09 09:32 -> 15:23 (351 min)
  2026-10-09 16:59 -> 20:31 (212 min)
  2026-10-10 01:20 -> 02:36 (76 min)
  2026-10-10 04:03 -> 10:50 (407 min)
  2026-10-10 11:48 -> 15:38 (230 min)
  2026-10-10 17:18 -> 13:58 (2680 min)
  2026-10-12 17:22 -> 16:40 (1399 min)
  2026-10-13 20:11 -> 02:44 (1833 min)
  2026-10-15 12:25 -> 14:16 (111 min)
  2026-10-15 16:19 -> 22:54 (1835 min)
  2026-10-17 04:15 -> 11:24 (428 min)
```

`{\`로 잘려 나오는 원인 1건은 worker가 스스로 보고한 실패(`lastFailure`가 `{"provenance":"worker_report","outcome":"failed",...}` — M3 m3-stage1, 검증 결과 2건 차단을 이유로 실패 보고). 도구가 `"lastFailure":"..."` 정규식으로 앞 80자만 자르기 때문에 이렇게 보인다.

## 3. 지표 표 (기준선)

| 지표 | 값 |
|---|---|
| Run / task / dispatch | 18 / 229 / 243 |
| 첫 시도 완료율 | **89%** (201/226, dispatch 1개이고 workerState=succeeded인 task) |
| 재시도 task | **25 (11%)** — worker 없이 처리 3 task는 분모에서 제외 |
| 실패 dispatch (합계 25) | stopped 10, 업데이트 안내 시작 차단 7, 복구 뒤 터미널 소실 3, timeout 1, abandoned 2, worker 실패 보고 1, 운영자 터미널 닫힘 1 |
| └ 범주 묶음(백로그 분류와 같은 축) | 중지 계열 11 (stopped 10 + 운영자 닫힘 1) / 업데이트 안내 7 / 복구 뒤 소실 3 / 기타 4 (timeout 1 + abandoned 2 + worker 실패 보고 1) |
| task 소요 시간(마지막 dispatch 기준) | median 11분 / p90 23분 / max 414분 / 합계 66.9h |
| worker 가동 / 전체 구간 | 50.9h / 276.2h (18%) |
| 동시 worker 시간(가동 중) | 1개 36.4h · 2개 13.1h · 3개 1.4h |
| └ **worker 2개 이상 동시 비율** | **28%** (14.5h / 50.9h = 28.5%) |
| 입력 토큰(캐시 읽기·쓰기 포함) | 2657.70M — **coordinator 63%** / worker 37% |
| └ 모델별 입력 비중 | Opus(coordinator) **47%** · gpt-6-sol(worker) 22% · Sonnet(coordinator) 15% · Sonnet(worker) 8% · glm-5.3(worker) 4% · gpt-6-astra(worker) 1% · gpt-5.6-luna(worker) 1% · Opus(worker) 0% |
| 출력 토큰 | 9.38M — coordinator 38% / worker 62% |

실패 dispatch 25건의 목록(감사용):

| Run(마일스톤) | worktree | 원인(도구 출력) |
|---|---|---|
| M0 | m0-contracts | timeout |
| M3 | m3-stage1 | worker 실패 보고(`{\`) |
| M3 | m3-stage1 | abandoned |
| M3 | art-base-retouch | 업데이트 안내 시작 차단 |
| CLI 잡무 | reminders-plugin | stopped |
| CLI 잡무 | bubble-buttons | stopped |
| CLI 잡무 | dnd-wiring | Terminal closed by operator request |
| M4 | host-cron | stopped |
| 잡무 | attendance-window | 업데이트 안내 시작 차단 |
| 잡무 | voice-contract | 업데이트 안내 시작 차단 |
| M6-2 | m6-e-interactions-editor | stopped |
| M6-2 | m6-f-reminders-tab | stopped |
| M7 | m7-anim-preview | 업데이트 안내 시작 차단 |
| M7 | m7-sequence-run | stopped |
| M8 | m8-terrain-settings | stopped |
| M8 | m8-hold-expression | 업데이트 안내 시작 차단 |
| M8 | m8-core-terrain | 업데이트 안내 시작 차단 |
| M8 | m8-test-strings | abandoned |
| M9 | m9-packaging | 복구 뒤 터미널 소실 |
| M9 | m9-launch-args | 복구 뒤 터미널 소실 |
| M9 | m9-guide-fix | 복구 뒤 터미널 소실 |
| M10 | m10-package | stopped |
| M10 | m10-adr-slack | 업데이트 안내 시작 차단 |
| M12 | m12-b7-reactions-ui | stopped |
| M13 | m13-7-lines-data-editor | stopped |

## 4. 기존 측정값(백로그 2026-10-16 AoGD 항목)과 대조

| 지표 | 백로그(2026-10-16, M13 진행 중) | 이번 측정(2026-10-17, M13 포함 전체) | 차이·이유 |
|---|---|---|---|
| task | 222 | 229 | 원 측정 뒤 M13 마무리 task 7건 추가 |
| dispatch | 233 | 243 | 같은 이유로 +10 |
| 첫 시도 완료율 | 88% | 89% | 추가된 task가 대부분 첫 시도 성공 |
| 재시도율 | 12% | 11% | 같은 수준(분모 증가) |
| 실패 dispatch | 25 (중지 9 · 업데이트 7 · 소실 5 · 기타 3) | 25 (중지 계열 11 · 업데이트 7 · 소실 3 · 기타 4) | 총수 같음. ① 원 측정 후 M13-7 정지 1건 추가 ② 나머지는 범주 경계 차이 — 원 측정은 서술 분류라 기준이 기록되지 않았고, "소실 5"는 복구 소실 3 + 운영자 닫힘 1 + worker 실패 보고 1로 묶은 것으로 추정(이렇게 보면 네 범주가 정확히 대응). 이 문서의 묶음 규칙은 §3에 명시 |
| coordinator 입력 비중 | 63% | 63% | 같음 |
| Opus(coordinator) | 47% | 47% | 같음 |
| Sonnet(coordinator) | 16% | 15% | M13 마지막 날 좁은 차이로 반내림(409.23M/2657.70M) |
| worker 2개 이상 동시 | 29% | 28% (28.5%) | 가동 48.5h→50.9h 중 2개 이상 구간 비중이 소폭 낮아짐 |

결론: 백로그 값과 본질적 차이는 없다. task·dispatch 수와 완료율은 원 측정이 M13 진행 중이었던 것, 실패 분류는 집계 규칙 차이가 전부다.

## 5. M14 재측정(완료 기준 12)에서 비교할 지표

같은 선정 기준·같은 명령으로 잰다. M14 Run(`run_public_007`)만 따로 보는 것이 본 비교이고, M0–M13 누적(이 문서의 표)도 함께 찍어 회귀가 없는지 확인한다. 토큰 창은 M14 기간(`--from 2026-10-17T12:21:08Z`)으로 새로 잡는다.

| 지표 | 기준선(이 문서) | 방향 | 이어지는 완료 기준 |
|---|---|---|---|
| 첫 시도 완료율 | 89% | 높을수록 좋음 | 12 |
| 재시도 task 비율 | 11% | 낮을수록 좋음 | 12 |
| 실패 dispatch 수 | 25건 / 11.5일 | 낮을수록 좋음 | 12 |
| └ 업데이트 안내 시작 차단 | 7건 | 낮을수록 좋음 | 7 (start-worker 사전 점검이 줄이는 대상) |
| └ 복구 뒤 터미널 소실 | 3건 | 낮을수록 좋음 | 3 (watcher·이벤트 대기로 빈 소실 감지) |
| coordinator 입력 비중 | 63% | 낮을수록 좋음 | 11 (컨텍스트 규칙·로그 요약) |
| coordinator Opus 비중 | 47% | 낮을수록 좋음 | 11 (메인 Sonnet, 동결·종료만 Opus) |
| worker 2개 이상 동시 비율 | 28% | 높을수록 좋음 | 4 (이벤트 기반 대기가 빈 슬롯을 줄이는 대상) |
| task / dispatch 수 | 229 / 243 | 방향 없음(규모 확인용) | – |

## 부록: 측정 한계(external-tools `agent-usage-metrics.md` 경고 요약)

- coordinator 폴더에는 오케스트레이션 외 대화형 세션도 섞여 coordinator 비중은 **상한값**으로 읽는다.
- 첫 시도 성공은 "dispatch 1개"만이 아니라 "dispatch 1개 **이고** workerState=succeeded"로 판정한다(한 조건만 보면 과대 보고한 사례가 있음).
- `dispatch-show`는 task의 마지막 dispatch만 주므로, 재시도 task의 소요 시간은 마지막 시도 기준이다.
- Claude Code 기록은 같은 message id가 여러 줄로 중복되어 id로 제거하며, Codex 사용량은 세션 누적치의 마지막 값, opencode은 SQLite에서 읽는다(도구가 처리).
- worker 없이 처리된 3 task(M0·M12·M13 각 1, coordinator 직접 수행)는 첫 시도율 분모에서 제외된다.
