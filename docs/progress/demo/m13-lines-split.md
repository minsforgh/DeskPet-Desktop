# M13-7fix 대사 나누기 규칙 바로잡기 (D-076)

규칙: 앞말 = 호칭·부름(또는 사과), 끝말 = 혼자 읽히는 맺음말만, 의심되면 나누지 않는다.

## 플러그인 기본 대사
`plugins/{jungle,orca,claude-code,codex}/lines.json` 은 캐릭터 어투가 없는 정보문이라 M13-7 이전(main)의 문자열로 되돌렸다. 평문은 main 과 같다.

## wolf-maid 템플릿 (전 → 후, 괄호는 앞말 / 내용 / 끝말)
| 종류 | 전 | 후 |
|---|---|---|
| done 1 | `{task} 끝났어요, 주인님! {result}` | 주인님, / `{task} → {result}` / 완료입니다! |
| done 2 | 주인님, `{task} 마쳤습니다. {result}` | 같음 |
| done 3 | `{task} 끝났어요,` / 주인님! | 주인님, / `{task} 끝났어요!` / 확인해 주세요 |
| done 4 | `{folder} 작업이 끝났어요,` / 주인님! | 주인님, / `{folder} 작업이 끝났어요.` / 수고하셨어요! |
| failed 1 | `죄송해요, 주인님… {task} 잘 안 됐어요. {result}` | 죄송해요, 주인님… / `{task} 잘 안 됐어요. {result}` |
| failed 3 | `죄송해요, 주인님… {task} 잘 안` / 됐어요. | 죄송해요, 주인님… / `{task} 잘 안 됐어요.` / 다시 확인해 주세요 |
| failed 4 | `죄송해요, 주인님… {folder} 작업에 문제가` / 생겼어요. | 죄송해요, 주인님… / `{folder} 작업에 문제가 생겼어요.` / 확인해 주세요 |
| info 2 | `잠시 말씀드릴게요, 주인님. {message}` | 주인님, / `잠시 말씀드릴게요. {message}` |

## wolf-maid 줄 (바뀐 것만)
| id | 전 | 후 |
|---|---|---|
| jungle.login-lost 1 | 주인님, `LMS 로그인이` / 풀렸어요 | 주인님, / `LMS 로그인이 풀렸어요.` / 확인해 주세요 |
| jungle.attendance-complete | `오늘도 수고하셨어요,` / 주인님! | 주인님, / `오늘 출석까지 마쳤어요.` / 수고하셨어요! |
| jungle.start-deadline 2 | `서둘러 주세요! 학습 시작 10시까지 {minutes}분` / 남았어요 | `학습 시작 10시까지 {minutes}분 남았어요.` / 서둘러 주세요! |
| jungle.manual-login-lost | `LMS 로그인이 풀렸어요. 확인해` / 주세요 | `LMS 로그인이 풀렸어요.` / 확인해 주세요 |
| jungle.manual-complete 2 | `오늘 출석까지 끝났어요.` / 안심하세요 | 같음 |
| orca.worker-succeeded 1 | `{task} 끝났어요,` / 주인님! | 주인님, / `{task} 끝났어요` / 완료입니다! |
| orca.worker-succeeded 2 | 주인님, `{task}` / 마쳤어요! | 주인님, / `{task} 마쳤어요!` |
| orca.worker-failed 1 | `죄송해요, 주인님… {task}` / 실패했어요 | 죄송해요, 주인님… / `{task} 실패했어요` |
| orca.coordinator-waiting 2 | `{task}에서 기다리고 있어요. 가 봐` / 주세요 | `{task}에서 기다리고 있어요.` / 가 봐 주세요 |
| orca.escalation 2 | `문제가 생겼어요. {task} 확인해` / 주세요 | `{task}에서 문제가 생겼어요.` / 확인해 주세요 |
| orca.question 2 | `질문이 도착했어요. {task} 확인해` / 주세요 | `{task} 질문이 도착했어요.` / 확인해 주세요 |
| orca.gate-decided 1 | `주인님,` / 결정했어요 (내용이 호칭) | 주인님, / `결정했어요` |
| orca.gate-decided 2 | `알겠습니다, 주인님. 결정을` / 전달했어요 | 알겠습니다, 주인님, / `결정을 전달했어요` |
| claude-code·codex.done-task-result 1 | 주인님, `{folder}에서 {task} → {result}` / 끝났어요! | 주인님, / `{folder}에서 {task} → {result}` / 완료입니다! |
| claude-code·codex.done-task 1 | 주인님, `{folder}에서 {task}` / 끝났어요! | 주인님, / `{folder}에서 {task}` / 완료입니다! |
| claude-code·codex.done-result 1 | 주인님, `{folder}에서 {result}` / 확인했어요! | 주인님, / `{folder}에서 {result}` / 확인해 주세요 |
| claude-code·codex.done-default | `{folder} 작업이 끝났어요,` / 주인님! 그리고 주인님, `{folder} 작업` / 마쳤습니다 | 주인님, `{folder} 작업이 끝났어요` 그리고 주인님, `{folder} 작업` / 완료입니다! |
| claude-code·codex.waiting-default 1·2 | `{folder}이 입력을` / 기다려요 · `{folder}에서 주인님을 기다리고` / 있어요 | 주인님, `{folder}이 입력을 기다려요` · 주인님, `{folder}에서 기다리고 있어요` |

나머지 줄은 서술어 조각을 끝말에서 내용으로 합치기만 했다(예: `확인할 수` / `없어요` → `확인할 수 없어요`, `{task} 확인이` / `필요해요` → 한 줄). `"주인님,"` 이 앞말인 줄과 slack·reminders 줄은 끝말이 있던 것만 합쳤다.
