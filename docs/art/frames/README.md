# 동작 프레임 (코드 생성)

`states.json` 이 `base_final.png`(106x192)에 프레임별 편집을 적용해 동작 프레임을 만든다(D-019). 다시 만드는 명령:

```
pnpm sprites:frames --spec docs/art/frames/states.json --out docs/art/frames/out --preview-scale 4
```

`out/<상태>/frame-NN.png` 가 프레임, `out/<상태>.strip.preview.png` 가 밝은·어두운 배경 위 확대 미리보기, `out/frames.json` 이 상태별 fps·프레임 수다. 모든 프레임은 팔레트 15색과 완전 투명만 쓰고, 발 아랫변 행 191·가로 중심 x40.5 에서 ±2px 이내라는 검사를 통과한다.

| 상태 | 프레임 | fps | 만든 방법 | 상태 |
|---|---|---|---|---|
| idle | 8 | 8 | 꼬리가 치마 뒤로 천천히 흔들림 | v1 |
| blink | 4 | 12 | 반쯤 → 감김(눈꺼풀을 기존보다 2px 아래로, 사용자 요청) → 반쯤 | v1 |
| talk | 4 | 8 | 입 모양 3종 | v1 (크게 벌린 입이 다소 각짐) |
| happy | 6 | 10 | 눈은 그대로, 입은 벌리지 않고 입꼬리만 올라가는 미소(살짝 → 크게) + 꼬리 (v3, 사용자 요청 2026-10-07) | v3 |
| surprised | 5 | 12 | 눈썹 올림 + 입 o + 꼬리 곤두섬 | v1 |
| worried | 6 | 8 | 눈썹 + 처진 입 + 꼬리 처짐 | v1 |
| sleep | 4 | 3 | 눈 감음(blink 와 같은 위치) + 꼬리 숨쉬기 | v1 |
| walk | 6 | 10 | 왼발·오른발이 번갈아 치마 아래에서 올라감 + 꼬리 | v1 (움직임이 작음) |
| drag | 4 | 8 | 놀란 얼굴 + 발 좌우 흔들림 + 꼬리 들림 | v1 (몸 전체가 들리는 표현은 없음: 발 아랫변 고정 검사 때문) |

9개 상태 모두 v1 이 만들어졌다. 프레임 수와 fps 는 `characters/placeholder/manifest.json` 의 값을 따랐다(walk 6f@10, drag 4f@8). 표정은 모두 1차(v1)이며, 눈여겨 볼 약점: 귀는 기준에서 이미 이미지 위쪽 끝(y0)에 닿아 위로 움직일 수 없어 귀 동작이 없다.

## 프레임 출처 표시와 교체 규칙

각 프레임 묶음이 어떻게 만들어졌는지 아래 표에 적는다. 나중에 사용자가 Aseprite 등으로 `out/` 이미지를 직접 마감하면 그 상태의 "출처"를 `손 마감`으로 바꾼다.

| 출처 | 뜻 | 다시 만들기 |
|---|---|---|
| 코드 생성 | spec(`states.json`, `states-side.json`)로만 만든 것 | spec 을 고쳐 `pnpm sprites:frames` 를 다시 돌리면 된다 |
| 손 마감 | 이미지를 직접 고친 것. **이미지가 정답** | `sprites:frames` 를 다시 돌리면 덮어써진다. 그 상태는 `out/` 을 건드리지 않게 spec 에서 빼거나, 마감본을 `docs/art/frames/final/<상태>/` 에 복사해 두고 그것을 캐릭터 팩의 원본으로 쓴다 |

| 상태 | 시점 | 출처 | 비고 |
|---|---|---|---|
| idle, blink, talk, happy, surprised, worried, sleep, drag | 앞 | 코드 생성 | `states.json` |
| walk | 옆(오른쪽 진행, 왼쪽은 좌우 반전) | 코드 생성 | `docs/art/side/states-side.json` |

기준 아트(`base_final.png`, 옆모습 `side_base.png`)를 바꾸면 코드 생성 상태는 spec 재실행으로 전부 갱신되고, 손 마감 상태는 따로 손봐야 한다.

## 사용자 피드백

- (비어 있음)
