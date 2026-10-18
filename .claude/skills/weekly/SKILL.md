---
name: weekly
description: 주간 점검 준비. 이번 주 점검 파일을 만들고 수치 칸을 채운다. 사용자가 "/weekly", "주간 점검"을 요청할 때 사용한다.
model: sonnet
---

# 주간 점검 준비

1. `docs/progress/weekly/TEMPLATE.md`를 복사해 `docs/progress/weekly/YYYY-Www.md`(ISO 주 번호)를 만든다.
   이번 주 파일이 이미 있으면 새로 만들지 않고 그 파일의 빈 수치 칸만 채운다.
2. 수치 칸을 채운다. 출처는 다음 셋이다.
   - `orca orchestration task-list --json` (Bash 도구로 실행)
   - `git log --since=<이번 주 월요일>`과 미머지 브랜치 목록
   - `pnpm test` 결과
   - `node tools/usage/weekly-resources.mjs --from <이번 주 월요일 ISO> --to <다음 주 월요일 ISO> --markdown` (4장 자원 표)
3. 확인할 수 없는 수치(한도 사용률 등)는 추측하지 않고 "미확인"으로 둔다.
4. 판단 칸과 가치 칸은 비워 둔다. 사람이 채운다.
5. `docs/plan.md` 16-5장 경고 신호와 대조해, 해당하는 신호가 있으면 정해진 대응 규칙과 함께 표시한다.
6. 만든 파일 경로, 사람이 채워야 할 칸, 발생한 경고 신호를 짧게 보고한다.

커밋하지 않는다. 다른 진척 문서는 수정하지 않는다.
