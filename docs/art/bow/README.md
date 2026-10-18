# Bow / curtsy 마스터와 인사 프레임

2026-10-11 사용자 결정: bow는 **bow-03**, curtsy는 **curtsy-12**를 사용한다. curtsy는 정면의 뜬 파란 눈을 유지하고 입꼬리만 아주 조금 올린다. 이번 작업에서는 새 이미지를 생성하지 않았다. 중단 전에 만든 `gen/processed/master-bow-h88`, `master-curtsy-h94`를 그대로 재사용했다.

ART-7e 후속 결정: 현재 후보를 유지하면서 움직임을 키우고 내장 팩에 인사 두 상태를 추가한다. bow는 최대 12px, curtsy는 최대 8px로 움직이며 기존 팩의 행동·대사·시트는 보존한다.

[기본 캐릭터 · bow · curtsy 동일 배율 비교](masters.compare.png) — 왼쪽부터 base_final, bow, curtsy. 발바닥을 같은 높이에 두고 밝은 배경과 어두운 배경에서 확인한다.

## 크기와 정리 방법

| 항목 | bow | curtsy |
| --- | --- | --- |
| 선택한 원본 | `gen/raw/bow-03.png` | `gen/raw/curtsy-12.png` |
| 재사용한 pixelize 결과 | 49×88 | 60×94 |
| 최종 마스터 | [106×192](bow_base.png) | [130×192](curtsy_base.png) |
| 2배 nearest 후 배치 (x,y) | (0,16) | (8,4), 머리는 추가로 4px 아래 |
| 다리 영역 | x30–51, y168–191 | x52–77, y172–191 |
| 발 중심 / 발바닥 행 | 40.5 / 191 | 64.5 / 191 |
| 130×192 팩 셀의 offsetX | 24 | 0 |
| 팩 안 발 중심 | 64.5 | 64.5 |
| 실제 사용 색 | 기본 팔레트 중 12색 | 기본 팔레트 중 13색 |

기본 얼굴 지도는 폭 24px이고, 선택한 결과에서 얼굴 범위를 잡으면 bow 26px, curtsy 24px다. 포니테일을 제외한 머리 영역은 두 마스터 모두 폭 44px다. 96px 결과를 그대로 확대하면 얼굴과 머리가 더 커지고 bow의 발 정렬 시 왼쪽 치마 여유도 부족해져, 각각 높이 88/94로 처리한 결과를 사용했다. 기본 귀의 폭은 지도 기준 17/14px이며 후보의 귀는 대략 12–14px로 조금 더 좁다. bow의 숙인 머리와 curtsy의 자세 차이를 포함한 비교이며, 해부학적으로 완전히 같은 모양으로 다시 그린 것은 아니다.

`make-masters.mjs`는 고정된 입력에서 마스터, 부위 지도, 프레임 spec, 비교 이미지를 함께 생성한다. 불투명 픽셀이 캔버스를 벗어나면 오류로 멈추므로 치마나 꼬리를 조용히 자르지 않는다. curtsy는 오른쪽 끝 x127까지 들어가 130px 셀을 넘지 않는다.

색은 단순한 RGB 최근접 대신 원본 양자화 팔레트의 재질별 대응표로 바꿨다. 드레스는 `dress/dress-shadow`, 앞치마는 `apron/apron-shadow`, 얼굴·손은 `skin`, 다리는 `stocking/shoe`로 구분했다. 특히 원본의 옅은 살색이 은발로 합쳐지지 않도록 직접 대응했다. 모든 불투명 색은 `../base/palette.json`에 포함되며 알파는 0 또는 255다.

편집 기록:

- 앞치마 안에서 사방이 흰색인 고립된 그림자 점을 bow 8개, curtsy 18개 정리했다(처리 원본 좌표 기준, 각 2×2px). 주름처럼 이어지는 그림자는 유지했다.
- 밝은 머리색이 바로 투명 영역에 닿는 경계를 1px 윤곽으로 연결했다. bow 65px, curtsy 21px를 수정했다. 떨어진 단독 불투명 점 검사에서는 제거할 점이 없었다.
- bow의 감은 눈은 원본 형태를 유지했다. curtsy 왼쪽 홍채 2×2px를 오른쪽과 같은 `eye` 색으로 맞춰 양쪽의 뜬 파란 눈을 유지했다.
- curtsy 입 주변의 양자화 잔상을 살색으로 정리하고 4px 입선을 두었다. 중립 입선과 비교해 **양 끝 두 픽셀만 각각 1px 위로** 옮겼다. 치아·벌린 입은 추가하지 않았다.
- 부위 지도는 양 끝을 포함하는 좌표이며 `head`, `face`, `upper`, `legs`와 발 anchor를 제공한다. 세부 동작과 이음새 수정은 각 프레임과 op의 `note`에 기록했다.
- ART-7e: bow 얼굴 아래의 짙은 V자 영역을 살색/앞치마색으로 정리하고 가로로 작은 `ribbon`색 나비 리본을 그렸다. 포니테일 아래 덩어리 내부의 투명한 틈은 머리 중간색과 그림자로 연결했다. 팔과 머리 사이의 바깥 틈은 유지했다.
- ART-7e: curtsy의 귀가 8px 상승해도 잘리지 않도록 머리를 4px 아래로 옮기고, 몸통 y72–107 구간을 4행 줄여 손과 다리 위치를 유지했다. 얼굴은 크기를 바꾸지 않았다. 마스터 위쪽 불투명 시작은 y8이고 최대 상승 프레임에서는 y0이다.

## 프레임

| 상태 | 프레임 | fps / 길이 | 상체 상승량 순서 (마스터 대비 px) | 정지 / 복귀 |
| --- | --- | --- | --- | --- |
| bow | 9 | 8 / 1.125초 | 12, 8, 3, 0, 0, 0, 4, 9, 12 | 4–6번 정지, `loop:false`, `next:idle` |
| curtsy | 10 | 8 / 1.25초 | 8, 6, 2, 0, 0, 0, 1, 3, 6, 8 | 4–6번 정지, `loop:false`, `next:idle` |

첫 프레임과 마지막 프레임은 각 인사 마스터에서 가장 덜 숙인 단계로 같게 만들었다. 머리·상체·손 영역은 표의 상승량만큼, 치마 중간은 그 2/3, 치마 아래는 1/3만큼 움직인다(정수 반올림). bow의 세 영역은 y0–119 / 120–147 / 148–167, curtsy는 y0–107 / 108–147 / 148–171이다. 다리와 신발은 고정한다. 인접 영역 사이의 작은 빈 줄만 재질별 `rect`로 연결하므로 한 이음새가 길어지는 양은 최대 4px다. 투명한 틈은 유지하며 curtsy의 치마 폭도 유지한다. 3프레임 정지 전후에 서로 다른 간격을 두어 내려갔다가 천천히 복귀한다.

`sprites:frames`의 state에는 fps와 frames만 들어간다. 비반복과 idle 복귀는 팩 state의 `loop`/`next`로 지정했다. 출력 폴더의 `frames.json`이 실행마다 교체되므로 두 상태를 별도 폴더에 출력한다.

- [bow 4배 스트립 — 밝은/어두운 배경](out-bow/bow.strip.preview.png), [원본 스트립](out-bow/bow.strip.png)
- [curtsy 4배 스트립 — 밝은/어두운 배경](out-curtsy/curtsy.strip.preview.png), [원본 스트립](out-curtsy/curtsy.strip.png)

## 다시 만들기

저장소 루트에서 실행한다. Windows PowerShell에서 실행 정책이 `pnpm.ps1`을 막으면 아래처럼 `pnpm.cmd`를 사용한다.

```powershell
pnpm.cmd --filter @deskpet/sprite-pipeline build
node docs/art/bow/make-masters.mjs
pnpm.cmd sprites:frames --spec docs/art/bow/states-bow.json --out docs/art/bow/out-bow --preview-scale 4
pnpm.cmd sprites:frames --spec docs/art/bow/states-curtsy.json --out docs/art/bow/out-curtsy --preview-scale 4
```

재사용 입력의 출처 명령은 다음과 같다. 기존 처리 결과가 있으면 다시 실행할 필요가 없다.

```powershell
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/bow-03.png --out docs/art/bow/gen/processed/master-bow-h88 --height 88 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-12.png --out docs/art/bow/gen/processed/master-curtsy-h94 --height 94 --colors 16
```

## 팩 생성과 내장 팩 반영

`docs/art/pack/wolf-maid.json`에 두 상태를 추가했다. 기존 front/side 출력 폴더가 없었으므로 기존 spec을 읽어 scratch에 출력했다. `.tmp-pack/`은 커밋하지 않는다.

```powershell
pnpm.cmd sprites:frames --spec docs/art/frames/states.json --out .tmp-pack/front --preview-scale 1
pnpm.cmd sprites:frames --spec docs/art/side/states-side.json --out .tmp-pack/side --preview-scale 1
@'
import { readFileSync, writeFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync('docs/art/pack/wolf-maid.json', 'utf8'));
for (const [name, state] of Object.entries(spec.states)) {
  state.frames = ['bow', 'curtsy'].includes(name)
    ? `../docs/art/bow/out-${name}/${name}`
    : `${name === 'walk' ? 'side' : 'front'}/${name}`;
}
writeFileSync('.tmp-pack/wolf-maid.json', JSON.stringify(spec, null, 2) + '\n');
'@ | node --input-type=module
pnpm.cmd sprites:pack --spec .tmp-pack/wolf-maid.json --out .tmp-pack/character
pnpm.cmd sprites:check .tmp-pack/character
```

scratch manifest와 현재 내장 manifest를 비교하면 생성본은 이름이 다르고 `voice`, `meta`, `interactions`, `reactions`, `motions`가 없다. 따라서 **생성 manifest로 덮어쓰지 않고**, 기존 manifest의 `states`에 생성본의 `bow`, `curtsy`만 추가했다. `sheets/bow.png`, `sheets/curtsy.png` 두 파일만 복사했다. 기존 최상위 필드와 9개 상태 값은 객체 비교로 같음을 확인했고, 기존 시트 9장과 행동·대사 JSON 4개의 SHA-256도 모두 같았다.

2026-10-12 검증 결과:

- bow: `9 frames, 8 fps, 106x192`, curtsy: `10 frames, 8 fps, 130x192`. 두 상태 모두 4배 미리보기 생성 성공.
- `sprites:pack`: `wolf-maid: 11 states, 11 decorations; sprites:check passed`.
- `sprites:check characters/wolf-maid`: `OK; upper decorations 11`.
- 프레임 CLI의 팔레트·이진 알파·발바닥 행 191·발 중심 검증 통과. 두 상태 모두 `loop:false`, `next:idle`이다.
- 같은 배율의 마스터 비교와 두 스트립을 직접 열어 밝은/어두운 배경의 얼굴, 윤곽, 치마 연결, 발 위치를 확인했다.
- 마스터·spec·프레임 출력 32개는 재생성 전후 SHA-256이 같았다. 기존 팩 필드와 시트·행동 파일의 보존도 모든 e2e가 끝난 뒤 다시 확인했다.

| 검증 명령 | 결과 |
| --- | --- |
| `pnpm.cmd build:host` | 통과 |
| `pnpm.cmd test` | 98개 파일 통과, 1,194개 테스트 통과 / 3개 건너뜀 |
| `pnpm.cmd typecheck` | 통과 |
| `pnpm.cmd lint` | 오류 0, 기존 `event.e2e.test.ts:119` 고정 sleep 경고 1 |
| `pnpm.cmd test:e2e apps/desktop/e2e/character-packs.e2e.test.ts` | 1개 통과 |
| `pnpm.cmd test:e2e apps/desktop/e2e/interactions-pack.e2e.test.ts` | 1개 통과 |
| `pnpm.cmd test:e2e apps/desktop/e2e/wolf-maid-facing.e2e.test.ts` | 1개 통과 |
| `pnpm.cmd test:e2e apps/desktop/e2e/pet-menu.e2e.test.ts` | 5개 통과 |

e2e는 저장소 루트의 `test:e2e` 스크립트로 각 파일을 단독 실행했다(`apps/desktop/package.json`에는 해당 스크립트가 없다). 테스트 기대값과 앱 소스는 수정하지 않았다. 이번 spec이 전체 단위 테스트를 명시하므로 전체 `pnpm test`도 실행했다. 처음에는 샌드박스가 esbuild의 상위 경로 읽기를 막아 테스트가 시작하지 못했고 권한을 높인 실행에서 통과했다. 린트는 단위 테스트의 임시 디렉터리 삭제와 겹쳐 한 번 실패했으므로 단위 테스트 종료 후 단독 실행했다. 이때 발견한 생성 스크립트의 `node:process` import 누락을 고친 뒤 통과했다.

실제 Electron 앱을 별도의 scratch 사용자 폴더로 실행하고 내장 wolf-maid를 로드했다. 기존 `DesktopApp` 준비 조건을 사용하고 시계·전체 화면 입력을 고정한 뒤, 개발 제어 명령으로 각 프레임을 125ms씩 진행했다(팩의 8fps 기준). 19개 프레임의 상태·번호와 한 번 재생 후 idle 복귀를 단언하고 각각 화면을 캡처했다. [실제 앱 비교](app-compare.png)는 104×154 창의 원래 크기다. 위쪽 bow / 아래쪽 curtsy, 각 행은 시작 → 완전히 숙임 → 마지막 → idle 순서다. 확대 전보다 머리와 손의 수직 이동이 보이며 발은 고정된다.

## 직접 확인한 약점

앱 배율 0.8에서 bow의 상체 이동 폭은 약 9.6px, curtsy는 약 6.4px다. 이전보다 커졌지만 curtsy는 치마가 더 벌어지는 동작 없이 상체가 내려간다. 큰 체중 이동이나 별도의 무릎 관절 애니메이션은 없다. 치마를 세 영역으로 나눴어도 연결부 주름 일부는 최대 4px 길어진다.

기본 idle과 인사 후보는 머리 각도·손 위치·치마 모양이 다르다. 시작/끝을 덜 숙인 단계로 맞췄지만 실제 앱에서도 idle로 전환할 때 실루엣 변화가 남는다. bow는 감은 눈과 숙인 얼굴 때문에 눈이 뜬 기본 얼굴보다 얼굴이 작아 보인다. curtsy의 귀는 기본보다 다소 좁고 파란 홍채는 작다.

완료 보고용 본문: 한 일 / 인사 동작 확대, bow 리본·포니테일 정리, 내장 팩에 두 상태만 추가 / 검증 결과 / build:host·전체 단위 테스트·typecheck·lint·지정 e2e 4파일 통과, 실제 앱 19프레임과 idle 복귀 확인, 기존 팩 데이터 보존 / 남은 것 / 기존 lint 경고 1건; 환경에 Orca CLI가 없어 worker_done 전송 불가 / 기여한 완료 기준 번호 / TASK-art7e 1–3.
