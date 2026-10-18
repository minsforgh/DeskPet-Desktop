# ART-6 옆모습 기준 이미지 시안 생성 기록

생성일: 2026-10-07 (Asia/Seoul)

## 참조 이미지와 호출

- 참조 이미지 1: `docs/art/base/base_final.png` — 앞모습 최종 기준. image_gen 대화 컨텍스트에 직접 열어 참조로 첨부했다.
- 참조 이미지 2: `docs/art/side/side-vs-front.png` — 기존 옆모습 방향 비교. 첫 호출에 함께 첨부했다.
- image_gen 내장 도구를 사용했다. 별도 이미지 서비스·다운로드·외부 요청은 사용하지 않았다.
- 호출 옵션: `transparent_background=true`.
- 첫 호출: `num_last_images_to_include=2` (앞모습 기준과 비교 이미지), 출력 `exec-402e8163-10d9-4fc4-904f-06f0a362a18a.png`.
- 후속 3회: `num_last_images_to_include=1` (직전 생성 결과를 참조), 출력 `exec-78d43efb-744c-47ee-acde-2535b2cecb2e.png`, `exec-16b82035-1116-4b43-a820-5d1e28f8d57b.png`, `exec-936dc302-51d6-47bf-80cf-c67f61c48adb.png`.
- 런타임이 모델명을 별도로 반환하지 않아 모델명은 `image_gen built-in (runtime model unspecified)`로 기록한다.

## 프롬프트 전문

첫 호출에 사용한 전문:

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate
Input images: image 1 is the front-view base_final.png identity, proportion, palette, and costume reference; image 2 is a side-vs-front comparison showing the desired right-facing profile direction.
Primary request: Create ONE original pixel-art standing character candidate based faithfully on image 1, shown from the RIGHT side looking right. Keep the same adult silver-haired wolf maid identity, approximately five-head-tall proportion, colors, costume, and calm expression.
Subject: full-body adult silver-haired ponytail maid, large wolf ears, navy ribbon on ponytail, white frilled headpiece, blue eye visible in profile, navy long classic maid dress, white apron, small navy neck bow, black shoes, one large wolf tail behind her. Both feet visible and planted evenly on the same ground line.
Composition/framing: strict right-facing side profile, slight 3/4 back allowed only if it improves recognition; one character centered, entire ears, ponytail, tail, and both shoe tips inside canvas with margins.
Style/medium: clean coarse pixel art with hard square pixels, about 16 flat colors, no antialiasing, no semitransparency, no gradients, no dithering.
Scene/backdrop: genuinely transparent background.
Constraints: preserve image 1's character identity and recognizable head frill, large ears, ponytail ribbon, blue eye, apron, skirt silhouette, tail, and black shoes. Make the profile readable and polished, not a new design. One figure only.
Avoid: front view, walking pose, lifted foot, extra limbs, extra characters, props, text, border, cast shadow, glow, smooth vector edges, blurry rendering, realistic painting, tiny unreadable details.
```

후속 호출 2 전문:

```text
Use case: stylized-concept. Create ONE transparent-background coarse pixel-art candidate of the same silver-haired wolf-eared adult maid as the supplied reference, right-facing strict side profile, standing still with BOTH shoes fully visible and aligned on one ground line. Preserve front reference identity: white frilled headpiece, large wolf ears, navy ponytail ribbon, blue eye, navy classic long maid dress, broad white apron, navy neck bow, black shoes, large wolf tail. About 5 heads tall, clean 16-color flat clusters, sharp square pixels, no antialiasing or semitransparency. Full figure inside canvas with margins. No walking, no props, no shadow, no text, no extra figure.
```

후속 호출 3 전문:

```text
Use case: stylized-concept. Generate one polished pixel-art side-view reference based on the supplied character. Right-facing profile with a visible blue eye and nose, silver ponytail tied by dark navy bow trailing behind, prominent wolf ears and separate fluffy tail, white maid frill and apron, long navy skirt, black shoes. Keep adult 5-head proportions and exact calm palette/identity. Standing pose, two feet planted at equal baseline. Transparent background, hard-edged 16-color pixel blocks, no antialiasing, no gradients, no dithering, no shadow, no objects, no text, full body with margins.
```

후속 호출 4 전문:

```text
Use case: stylized-concept. Make a single right-facing side-profile pixel-art candidate of the same wolf maid character from the supplied reference, not a redesign. Emphasize recognition from front: silver hair and ponytail, navy ribbon, oversized wolf ears, blue eye, white head frill, dark navy maid dress, white apron and frills, black shoes, large wolf tail behind. Nearly complete profile with only slight 3/4 allowed; both legs and both shoes visible, straight quiet standing pose on same ground line. Transparent background; coarse clean square pixels, approximately 16 flat colors, no anti-aliasing, no alpha fringes, no gradients, no extra items or characters, whole figure inside canvas.
```

## 처리 명령

저장소 루트에서 먼저 `pnpm install`을 실행했다. 각 raw 원본에 대해 다음 명령을 후보별로 실행했다.

```sh
pnpm sprites:pixelize docs/art/side/gen/raw/candidate-01.png --out docs/art/side/gen/processed/candidate-01 --height 96 --colors 16
pnpm sprites:pixelize docs/art/side/gen/raw/candidate-02.png --out docs/art/side/gen/processed/candidate-02 --height 96 --colors 16
pnpm sprites:pixelize docs/art/side/gen/raw/candidate-03.png --out docs/art/side/gen/processed/candidate-03 --height 96 --colors 16
pnpm sprites:pixelize docs/art/side/gen/raw/candidate-04.png --out docs/art/side/gen/processed/candidate-04 --height 96 --colors 16
```

```sh
pnpm sprites:retouch docs/art/side/gen/processed/candidate-01/candidate-01.sprite.png --palette docs/art/base/palette.json --out docs/art/side/gen/processed/candidate-01
pnpm sprites:retouch docs/art/side/gen/processed/candidate-02/candidate-02.sprite.png --palette docs/art/base/palette.json --out docs/art/side/gen/processed/candidate-02
pnpm sprites:retouch docs/art/side/gen/processed/candidate-03/candidate-03.sprite.png --palette docs/art/base/palette.json --out docs/art/side/gen/processed/candidate-03
pnpm sprites:retouch docs/art/side/gen/processed/candidate-04/candidate-04.sprite.png --palette docs/art/base/palette.json --out docs/art/side/gen/processed/candidate-04
```

pixelize 결과는 각각 49x96, 49x96, 44x96, 50x96이며 모두 16색이었다. retouch 결과는 팔레트 내 12, 12, 10, 10색이며 수정 수는 모두 0이었다. 비교 그림은 기존 PNG 모듈의 nearest-neighbor 배율만 사용해 `base_final.png` 2배와 후보 sprite 2배를 나란히 놓았다.

코드 변경이 없으므로 `pnpm typecheck`, `pnpm lint`, `pnpm test`는 실행하지 않았다.
