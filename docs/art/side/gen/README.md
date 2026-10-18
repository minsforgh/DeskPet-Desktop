# ART-6 옆모습 기준 후보

앞모습 기준 `base_final.png`를 참조해 image_gen으로 만든 오른쪽 바라보기 서 있는 옆모습 후보 4장이다. 모든 후보는 투명 배경 raw PNG와 `height 96`, `colors 16` 정리 결과를 함께 보관한다.

## 비교 그림

[앞모습과 후보 나란히 비교](side-compare.png) — 왼쪽부터 base, candidate-01, candidate-02, candidate-03, candidate-04. 후보 sprite를 2배 nearest-neighbor로 확대했다.

## 후보 및 평가

| 순위 | 후보 | raw | sprite | preview | check | 한 줄 평가 |
|---:|---|---|---|---|---|---|
| 1 | candidate-01 | [raw](raw/candidate-01.png) | [sprite](processed/candidate-01/candidate-01.sprite.png) | [preview](processed/candidate-01/candidate-01.sprite.preview.png) | [check](processed/candidate-01/candidate-01.sprite.check.png) | 가장 명확한 우측 측면이며 큰 귀·흰 프릴·남색 리본·푸른 눈·앞치마·꼬리·두 발이 모두 읽힌다. 약점은 꼬리가 몸 뒤에서 크게 부풀어 치마와 일부 겹친다. |
| 2 | candidate-02 | [raw](raw/candidate-02.png) | [sprite](processed/candidate-02/candidate-02.sprite.png) | [preview](processed/candidate-02/candidate-02.sprite.preview.png) | [check](processed/candidate-02/candidate-02.sprite.check.png) | 01과 같은 안정적인 측면이고 앞치마와 두 발의 기준선이 좋다. 약점은 얼굴이 작고 눈·입 인상이 약해 앞모습 동일성이 한 단계 떨어진다. |
| 3 | candidate-03 | [raw](raw/candidate-03.png) | [sprite](processed/candidate-03/candidate-03.sprite.png) | [preview](processed/candidate-03/candidate-03.sprite.preview.png) | [check](processed/candidate-03/candidate-03.sprite.check.png) | 좁고 깔끔한 옆 실루엣, 큰 귀와 꼬리까지 유지된다. 약점은 머리장식과 눈이 뭉개지고 두 발이 겹쳐 보여 지면 정렬 확인이 어렵다. |
| 4 | candidate-04 | [raw](raw/candidate-04.png) | [sprite](processed/candidate-04/candidate-04.sprite.png) | [preview](processed/candidate-04/candidate-04.sprite.preview.png) | [check](processed/candidate-04/candidate-04.sprite.check.png) | 꼬리·리본·앞치마·푸른 눈은 잘 보이고 밝고 어두운 배경 모두 읽힌다. 약점은 정면을 더 보는 3/4에 가까워 '완전한 측면' 기준에서 우선순위가 낮다. |

추천 1순위는 candidate-01이다. 앞모습과 같은 캐릭터로 읽히는 장식 보존과 오른쪽 측면성, 두 발의 지면 정렬이 네 후보 중 가장 균형이 좋다. 네 후보 모두 밝은/어두운 check 배경에서 실루엣은 읽히지만, 96px로 축소되면서 프릴의 작은 점과 얼굴 입 디테일은 추가 확인이 필요하다.

## 사용자에게 물을 질문

1. 1순위 candidate-01의 큰 꼬리 부피와 몸 겹침을 그대로 유지할까요, 아니면 꼬리를 조금 더 뒤로 분리할까요?
2. candidate-01처럼 눈이 보이는 측면을 선호하나요, candidate-03처럼 더 엄격한 좁은 측면을 선호하나요?
3. 두 발을 현재처럼 거의 겹치되 각각 보이게 둘까요, 아니면 candidate-02처럼 발 간격을 한 픽셀 더 벌릴까요?
