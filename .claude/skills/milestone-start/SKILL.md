---
name: milestone-start
description: 다음 마일스톤을 시작한다. 완료 기준을 구체화해 사용자 확인을 받고 동결한 뒤 orchestrate로 진행한다. 사용자가 "/milestone-start <번호>"로 호출한다.
disable-model-invocation: true
model: opus
---

# 마일스톤 시작

대상 마일스톤: M$ARGUMENTS

번호가 없으면 `docs/progress/STATUS.md`의 현재 마일스톤 다음 번호를 제안하고 확인받는다.

## 1. 시작해도 되는지 확인

- `docs/progress/milestones.md`에서 직전 마일스톤의 "판단"이 기록됐는지 본다.
  기록이 없으면 `/milestone-close`가 먼저라고 알리고 멈춘다.
- 동시에 진행하는 마일스톤은 하나다 (`docs/plan.md` 16-6장). 아트 작업만 예외다.

## 2. 완료 기준 구체화

- `docs/plan.md` 16-3장의 해당 행과 12장 로드맵을 바탕으로, `milestones.md`의 주석 템플릿 형식에 맞춰 초안을 만든다.
- 기준은 관찰 가능한 문장으로 쓰고, 각 기준에 검증 방법(A 자동 / R 에이전트 리뷰 / H 사람 확인)을 붙인다.
- 직전 마일스톤에서 이월된 기준(➡️)이 있으면 포함한다.
- 초안을 사용자에게 보여 주고 확인을 기다린다. **확인받기 전에는 task를 만들지 않는다.**

## 3. 동결

- 확인받은 기준을 `milestones.md`에 적고 시작 날짜를 기록한다.
- `STATUS.md`의 "현재 마일스톤"을 새 마일스톤으로 바꾼다.
- 동결 이후 추가하고 싶은 기준은 `backlog.md`로 보낸다.

## 4. 진행

`orchestrate` skill의 절차대로 task로 분해해 진행한다. 각 task의 spec에 기여하는 완료 기준 번호를 적는다.
