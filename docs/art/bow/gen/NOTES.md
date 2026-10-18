# ART-7 인사 동작 기준 이미지 후보 생성 기록

생성일: 2026-10-11 (Asia/Seoul)

## 참조 이미지와 호출

- 참조: `docs/art/base/base_final.png` (106×192). 직접 열어 정체성·성인 체형·의상·팔레트를 확인했다.
- image_gen 내장 도구만 사용했다. 외부 이미지 서비스·다운로드를 사용하지 않았다.
- 모든 호출: `transparent_background=true`.
- 첫 bow-01 호출: `num_last_images_to_include=1` (직접 연 base_final).
- 나머지 호출: `referenced_image_paths=["C:/Users/Example/orca/workspaces/deskpet/art-bow/docs/art/base/base_final.png"]`. 현재 도구의 로컬 참조 경로 옵션으로 원본을 매번 다시 첨부해 정체성을 유지했다.
- 모델: `image_gen built-in (runtime model unspecified)`.
- 생성 원본은 기본 저장 위치에 남겨두고 아래 raw 파일로 복사했다.

| 후보 | 도구 출력 파일 | 저장 파일 |
|---|---|---|
| bow-01 | `exec-c348695b-c1c8-4b4d-a444-82f402845b30.png` | `raw/bow-01.png` |
| bow-02 | `exec-6ded09b4-d3c0-4438-864a-318875d62582.png` | `raw/bow-02.png` |
| bow-03 | `exec-4ae6bc87-48dc-4892-bf3d-5c2c1bebcfbf.png` | `raw/bow-03.png` |
| bow-04 | `exec-bc2503ac-a404-48df-b2f9-4bcd22efe428.png` | `raw/bow-04.png` |
| curtsy-01 | `exec-fbe7a95a-c3ac-44c2-90ec-3bbe2990c109.png` | `raw/curtsy-01.png` |
| curtsy-02 | `exec-b72562e9-fc83-4758-87d9-230fc7c4a7b2.png` | `raw/curtsy-02.png` |
| curtsy-03 | `exec-85dfe600-12fd-47e5-b3f6-9739b6cc3800.png` | `raw/curtsy-03.png` |
| curtsy-04 | `exec-05cb84b6-1a1e-4471-934e-dd1fb9a7cfc6.png` | `raw/curtsy-04.png` |

## 프롬프트 전문

### bow-01

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate, bow-01
Input images: image 1 is base_final.png, the authoritative front-view identity, adult proportions, costume and palette reference.
Primary request: Create ONE full-body pixel-art candidate of this same wolf maid at the deepest point of a polite waist BOW, seen strictly from the FRONT. She bends forward toward the viewer with no turn to either side. Her lowered head shows the TOP of the silver head and white maid frill between both wolf ears; the face is mostly hidden. Keep both shoulders symmetric, both arms visible, and both hands gently overlapped together in front of the white apron just like the reference. Legs stay straight, both black shoes planted on one horizontal ground line.
Subject: adult silver-haired wolf maid, approximately five-head-tall adult anatomy before bending, silver ponytail tied with navy ribbon on the reference side, large wolf ears, white frilled headpiece, long navy classic maid dress, white apron, navy neck bow, black shoes, one large silver wolf tail.
Composition/framing: strict frontal camera, centered full figure with all ears, ponytail, skirt, tail and shoes inside canvas with margins. Torso foreshortens toward the viewer; never a sideways bow or profile. Clearly deep waist bend around 45 degrees.
Style/medium: coarse clean square pixel art, about 16 flat colors matching reference, no antialiasing, no semitransparency, no gradients, no dithering.
Scene/backdrop: genuinely transparent background.
Constraints: preserve the exact recognizable character identity and costume; one figure only, calm respectful pose, hands joined rather than lifting skirt.
Avoid: side view, three-quarter view, head turned sideways, kneeling, bent knees, extra limbs, child or chibi proportions, props, text, border, cast shadow, glow, smooth vector edges.
```

### bow-02

```text
Use case: stylized-concept
Asset type: pixel-art bow reference candidate bow-02.
Input images: base_final.png is the sole authoritative FRONT identity, costume, palette and adult proportion reference.
Primary request: ONE full-body wolf maid at the lowest point of a deep respectful waist bow, strict FRONT view. Change only the pose from the reference. Both shoulders and knees face the viewer evenly. Bend the torso deeply forward toward the viewer about 60 degrees, foreshortening the upper body, lowering the head well toward the joined hands. Show the crown of her silver hair, the white head frill and two large wolf ears, with the face concealed. Her two hands remain gently overlapped in front of her apron. Legs straight, two black shoes on exactly the same ground line.
Subject: same adult approximately five-head-proportioned silver-haired wolf maid, side ponytail tied by navy bow, white maid frill, large wolf ears, long navy classic maid dress, white apron, navy neck bow, black shoes, one large silver wolf tail behind.
Composition: frontal symmetric body, no horizontal rotation, complete character with margins. Clear waist bend, not just a downward tilt of the head; no side or three-quarter view.
Style: coarse square pixel clusters, approximately 16 flat colors from the reference, no antialiasing, no semitransparency, no gradient or dithering.
Background: genuinely transparent. No props, lettering, shadows, borders, extra figures or limbs. Preserve recognizable adult identity, costume, ponytail and tail, not chibi.
```

### bow-03

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate bow-03.
Input images: supplied base_final.png is the authoritative front-view wolf maid design.
Primary request: Create ONE new full-body candidate of the SAME adult wolf maid performing a formal bow, deepest moment, strictly viewed from the FRONT. Her torso hinges forward from the waist about 50 degrees toward the camera, head lowered centrally with the crown and white frill visible and only a tiny sliver of closed eyes under the fringe. Both shoulders remain facing the viewer. Both hands lie neatly one over the other at the center of the apron, wrists relaxed. Straight standing legs and black shoes on one level baseline.
Invariants: adult about five-head anatomy before bending, silver hair, navy ribbon on silver side ponytail, large paired wolf ears, white head frill, navy long classic maid dress, white apron with ruffled hem, small navy neck ribbon, black shoes, one large silver wolf tail. Keep the same restrained palette and recognizable outfit.
Composition: full figure centered with space around all extremities. Bow projects toward viewer, never sideways; bilateral frontal shoulders and shoes. Compress torso with foreshortening to make the waist bow readable.
Style: bold coarse hard square pixels, about 16 flat colors, transparent background, no antialiasing, partial transparency, gradients or dithering. No props, text, shadows, extra figures, extra fingers or limbs, profile view, three-quarter view or child proportions.
```

### bow-04

```text
Use case: stylized-concept
Asset type: pixel-art character bow candidate bow-04.
Input images: base_final.png is the exact adult wolf maid front-view design reference.
Primary request: ONE full-body FRONT-view deepest bow pose. Strongly hinge forward at the waist toward the viewer, about 65 degrees: the head moves down to cover the chest and the torso visibly shortens, while the long skirt and straight legs remain upright. Top of silver head, two wolf ears and white maid frill clearly visible; face completely hidden beneath the lowered fringe. Shoulders face the viewer evenly. Hands remain softly overlapped at center-front of the apron, same graceful joined-hand gesture as reference.
Invariants: same adult five-head anatomical proportion before bending, silver side ponytail, navy hair bow, big wolf ears, white head frill, navy neck bow, long navy classic maid gown, white apron, black shoes on a common baseline, one big silver wolf tail behind at the reference side.
Style: coarse hard square pixel art, approximately 16 flat colors faithful to reference, genuinely transparent background. Full character with margin. No horizontal turning or profile, no three-quarter view, kneeling, chibi redesign, extra limbs, extra people, props, text, shadows, antialiasing, semitransparency, gradients or dithering. Emphasize torso foreshortening and crown view, not merely closed eyes on an upright pose.
```

### curtsy-01

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate curtsy-01.
Input images: base_final.png is the authoritative FRONT identity, adult proportions, palette and costume reference.
Primary request: Create ONE full-body candidate of this same adult silver-haired wolf maid at the lowest moment of a restrained formal CURTSY, strict FRONT view. Each hand gently pinches the skirt fabric on its own side and lifts it slightly outward, making two clear small fabric folds; fingers visibly touch the navy skirt, not the apron. Knees bend modestly beneath the long skirt, upper body and head bow only slightly, eyes calmly closed. Both shoulders face the viewer, both black shoes visible and their soles align on ONE horizontal ground line.
Subject/invariants: approximately five-head-tall adult anatomy, silver ponytail with navy ribbon on the reference side, large wolf ears, white head frill, long navy classic maid dress, broad white apron, navy neck bow, black shoes, one large silver wolf tail behind. Preserve reference identity and colors.
Composition: frontal symmetric polite curtsy, full body with margins around ears, ponytail, spread skirt, tail and shoes. No side rotation or profile. Gentle knee dip, not a deep waist bow.
Style: coarse clean square pixel art, about 16 flat colors, hard opaque clusters and true transparent background. No antialiasing, partial transparency, gradients or dithering.
Avoid: child or chibi redesign, high skirt lift, exposed thighs, lifted foot, extra limbs, open hands floating away from fabric, props, text, border, cast shadow or extra figures.
```

### curtsy-02

```text
Use case: stylized-concept
Asset type: pixel-art curtsy reference candidate curtsy-02.
Input images: supplied base_final.png is the authoritative front-view identity, adult proportion, costume and color reference.
Primary request: ONE full-body FRONT view of the exact same adult wolf maid at the deepest moment of a modest curtsy. Visibly dip the hips by bending both knees slightly under the long skirt; bring the knees a little toward each other, shoes a little apart, both soles perfectly level on one ground line. Bow the torso and head gently forward toward viewer, eyes closed and calm. Each hand delicately PINCHES its own side of the navy skirt between thumb and fingers and raises the side fabric a little, forming clear restrained folds. White apron stays in the center.
Invariants: adult anatomy about five heads tall before dipping, silver hair and silver side ponytail tied with navy ribbon, large paired wolf ears, white head frill, navy neck bow, long navy maid dress, white apron, black shoes, single large silver wolf tail. Maintain recognizable original design, not chibi.
Composition: strictly frontal face, shoulders, torso and skirt, symmetric gentle dip with no turn. Full body inside canvas with margins. Knees bent enough for a readable curtsy but not a squat, long skirt remains modest.
Style: coarse sharp square pixel art, about 16 flat reference colors, genuinely transparent background, no antialiasing, partial transparency, gradients or dithering. No sideways profile, three-quarter view, deep waist bow, floating hand, raised foot, props, text, shadow, extra limbs or figures.
```

### curtsy-03

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate curtsy-03.
Input images: base_final.png is the authoritative front-view adult wolf maid reference.
Primary request: ONE new full-body strict FRONT view candidate of this same maid performing a graceful CURTSY at its lowest moment. Each hand visibly holds a small pinch of navy skirt fabric at its respective side, spreading the skirt modestly outward with relaxed slightly bent elbows. Gently bend knees and lower hips, lightly incline chest and head forward, show calm closed eyes. One shoe may be tucked a little inward behind the other but BOTH shoe bottom edges must remain visible and exactly aligned on one horizontal baseline; no lifted foot.
Preserve identity: adult roughly five-head-tall anatomy, silver hair, silver ponytail at reference side with navy bow, large wolf ears, white frilled maid headpiece, navy neck ribbon, long navy classic maid dress, central white apron, black shoes, one large silver wolf tail.
Composition: straight frontal shoulders, face and torso, no rotation, entire figure with transparent margin. Gentle forward nod and small knee dip, not a deep bow. Both skirt-pinching hands clearly separate from the apron.
Style: clean coarse square pixel clusters, about 16 flat colors faithful to base, genuinely transparent backdrop. No anti-aliasing, semitransparency, gradients, dithering, cast shadows, text, props, extra figures, extra limbs, chibi proportions, side or three-quarter view.
```

### curtsy-04

```text
Use case: stylized-concept
Asset type: pixel-art character curtsy candidate curtsy-04.
Input images: base_final.png supplies the exact FRONT-view identity, palette, costume and adult proportions.
Primary request: Create ONE full-body same adult silver wolf maid making a restrained formal curtsy, at the lowest point of a gentle knee bend. Stay strictly FRONT-facing with shoulders level and torso gently inclined toward the viewer. Bow the head a little, eyes softly closed. With both hands delicately pinch and lift the navy skirt edges only a small amount at the sides, elbows slightly outward, fingers closed around the fabric with no extra digits. Keep the spread narrow and elegant, white apron hangs centrally. Both knees bend subtly inward, both feet planted apart by a small gap and black shoe soles on exactly the same ground line.
Preserve: adult approximately five-head anatomy, silver side ponytail with navy hair bow, large wolf ears, white maid frill, navy neck bow, long navy classic maid dress and white apron, black shoes, one large silver wolf tail behind, original restrained cool palette.
Composition: one centered complete figure with margins, frontal face and shoulders, visibly slight torso bow and knee dip; no profile or three-quarter view. The pose is a polite curtsy, not a dance or squat.
Style: coarse hard-edged square pixel art, about 16 flat colors, true transparent background. No antialiasing, semitransparency, gradients, dithering, text, props, ground shadow, extra characters, limbs, lifted feet or child proportions.
```

## 처리 명령

저장소 루트에서 기존 의존성으로 실행했다. 팔레트 강제 매핑·리터치·프레임 제작은 하지 않았다.

```sh
pnpm sprites:pixelize docs/art/bow/gen/raw/bow-01.png --out docs/art/bow/gen/processed/bow-01 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/bow-02.png --out docs/art/bow/gen/processed/bow-02 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/bow-03.png --out docs/art/bow/gen/processed/bow-03 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/bow-04.png --out docs/art/bow/gen/processed/bow-04 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/curtsy-01.png --out docs/art/bow/gen/processed/curtsy-01 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/curtsy-02.png --out docs/art/bow/gen/processed/curtsy-02 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/curtsy-03.png --out docs/art/bow/gen/processed/curtsy-03 --height 96 --colors 16
pnpm sprites:pixelize docs/art/bow/gen/raw/curtsy-04.png --out docs/art/bow/gen/processed/curtsy-04 --height 96 --colors 16
node docs/art/bow/gen/make-compare.mjs
```

## 재생성 기록

curtsy-03 첫 결과는 교차한 신발의 밑선 차이 때문에, bow-04 첫 결과는 축소 후 손의 피부색이 사라져 재생성했다. 위 표와 최초 프롬프트는 호출 이력이며, 해당 두 raw 파일과 processed 폴더는 아래 재생성 결과로 교체했다. 탈락 원본은 도구 기본 저장 위치에 보존되고 커밋에는 포함하지 않는다. 두 재호출도 동일 base_final 경로와 `transparent_background=true`를 사용했다.

### curtsy-03 최종 재호출

- 출력: `exec-fa5daf58-8f72-4f9b-9ceb-576f306d0e42.png` → `raw/curtsy-03.png`.
- 위의 해당 후보 pixelize 명령을 다시 실행했다.

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate curtsy-03, replacement for unequal shoe baseline.
Input images: base_final.png is the sole authoritative front-view identity and costume reference.
Primary request: ONE full-body strict FRONT view of this same adult silver-haired wolf maid at the low point of a modest curtsy. Both legs bend slightly at the knees, both feet side by side with a small gap, NO crossed legs and NO foot behind the other. Draw two distinct black shoes with straight horizontal bottom edges at EXACTLY the same height. Each hand visibly pinches a small piece of navy skirt fabric at its respective side and lifts it modestly, elbows relaxed. Bow chest and head gently forward, show calm closed eyes and clearly peach-colored face and hands. Keep the face and hands in solid readable skin-colored pixel clusters that survive shrinking to a 96-pixel-tall sprite.
Invariants: adult anatomy approximately five heads tall before knee bend, silver ponytail tied with navy ribbon at reference side, large paired wolf ears, white head frill, navy neck ribbon, long navy classic maid dress, central white apron, black shoes, single large silver wolf tail.
Composition: symmetrical frontal shoulders, torso and face, never sideways or three-quarter. Whole figure within transparent margins; gentle knee dip and forward head incline, not standing at attention or deep bow.
Style: coarse opaque square pixel clusters, about 16 flat colors, true transparent backdrop. Keep clean connected outlines without scattered edge pixels. No antialiasing, semitransparency, gradients, dithering, shadows, text, props, extra figures, limbs, child proportions, crossed legs or uneven soles.
```

### bow-04 최종 재호출

- 출력: `exec-89aecb55-3c52-4a46-9ead-8515a6c9bcc9.png` → `raw/bow-04.png`.
- 위의 해당 후보 pixelize 명령을 다시 실행했다.

```text
Use case: stylized-concept
Asset type: pixel-art deepest bow reference candidate bow-04, replacement to clarify hands and forward waist bend.
Input images: base_final.png is the exact authoritative adult wolf maid identity, front camera, costume, anatomy and palette reference.
Primary request: ONE full-body FRONT view of this same adult maid making a clearly DEEP waist bow toward the viewer. Her upper body hinges forward at the waist, nearly horizontal, so the upper torso is foreshortened to a very SHORT area. Her large lowered head occupies the chest area, showing mostly the TOP/CROWN of silver hair between the wolf ears, and its lower edge is close above her joined hands. The face is hidden. Hands gently overlap together at the center-front of the apron and MUST remain plainly peach skin-colored in a large clean flat pixel cluster, distinct from the white cuffs and apron. Straight vertical lower legs, two black shoes side by side on exactly one level bottom line.
Preserve the same approximately five-head adult anatomy before bowing, silver ponytail tied at reference side by navy ribbon, two large wolf ears, white head frill visible across the bowed crown, navy neck bow partly hidden by the head, long navy classic maid dress, white apron, black shoes, one large silver wolf tail.
Composition: frontal symmetric shoulders, hands and feet, body bends in depth toward the viewer, absolutely no turn left or right. Full character with transparent margin around every extremity. Keep skirt and legs upright; head and torso project forward and DOWN. Do not simply tilt the head on a long upright torso.
Style: clean coarse hard square pixels, about 16 flat colors, solid peach hands that survive 96px reduction, true transparent background. No antialiasing, semitransparency, gradients, dithering, scattered edge specks, chibi redesign, bent knees, kneeling, profile or three-quarter view, extra figures, limbs, props, text or shadow.
```

## 비교 그림과 직접 확인한 소견

`make-compare.mjs`는 저장소의 `readPng`, `writePng`, `scaleNearest`를 재사용한다. 입력 경로 인수나 새 의존성은 없다. 실행 전에 pixelize 명령으로 기존 core·sprite-pipeline 빌드가 준비되어 있어야 한다.

`compare.png`는 1200×1800이며 위에서부터 bow 밝음·bow 어두움·curtsy 밝음·curtsy 어두움의 네 줄이다. 배경은 각각 #e8e8e8·#282828, 열은 BASE·01·02·03·04다. 기준과 후보 모두 최근접 **2배**이며 아래쪽을 같은 위치에 맞췄다. 기준은 원본 높이 192px, 후보는 96px이므로 기준이 화면에서 두 배 높다. 체격이나 숙임의 절대 높이를 비교하는 정규화 도표가 아니라, 요청한 동일 확대 배율의 도트 비교다.

생성된 원본을 보고, 모든 최종 후보의 `*.check.png`를 직접 열어 밝음·어두움 양쪽을 확인했다. 재생성한 두 후보도 다시 열었다. 프롬프트의 각도는 요청 목표이며 실제 그림에서 측정한 숙임 각도는 아니다.

| 후보 | 정리 결과 | 직접 본 소견 |
|---|---|---|
| bow-01 | 53×96, 16색 | 정면 유지, 정수리와 살짝 남은 얼굴로 숙임이 읽히지만 허리 압축은 약함; 귀·프릴·포니테일·꼬리 유지, 모은 손의 피부색은 남으나 두 손 구분은 작음; 정수리 위 돌출 픽셀과 머리·꼬리의 점 모양 경계가 눈에 띔. |
| bow-02 | 58×96, 16색 | 정면 유지, 얼굴이 거의 가려져 01보다 깊은 숙임 인상; 의상·귀·리본·꼬리 유지, raw의 겹친 손은 분명하지만 정리 후 피부색이 희게 합쳐짐; 머리와 포니테일 가장자리의 끊긴 윤곽이 남음. |
| bow-03 | 54×96, 16색 | 정면 유지, 감은 눈과 얼굴이 보여 숙임은 네 장 중 약한 편; 정체성과 모은 손 피부색 유지, 손은 작은 단일 덩어리; 밝은 배경에서 귀·포니테일·앞치마의 점 모양 윤곽이 보임. |
| bow-04 (재생성) | 57×96, 16색 | 정면 유지, 얼굴을 가린 큰 정수리와 짧아진 상체가 네 장 중 깊은 숙임을 가장 잘 전달; 귀·프릴·리본·꼬리 유지, 모은 손의 복숭아색이 축소 후에도 분명; 머리 윗부분·포니테일 테두리에 잔점, 손가락 세부는 합쳐짐. |
| curtsy-01 | 55×96, 15색 | 정면 유지, 가벼운 고개 숙임은 보이나 무릎 굽힘은 약함; 주요 정체성 유지, raw의 치마를 집는 손은 명확하지만 축소 후 작은 쐐기 모양; 머리·포니테일 윤곽에 점 모양 끊김. |
| curtsy-02 | 61×96, 16색 | 정면 유지, 안쪽으로 기운 다리와 넓은 치마로 무릎을 굽힌 인상은 가장 강함; 의상·머리·꼬리 유지, raw의 양손 집기 동작은 명확하지만 정리 후 얼굴·손의 피부색이 대부분 소실; 머리와 치마 경계 잔점. |
| curtsy-03 (재생성) | 57×96, 16색 | 정면 유지, 약한 숙임과 나란한 두 발, 무릎 굽힘은 절제됨; 귀·프릴·리본·꼬리·앞치마 유지, 양손이 치마에 닿고 피부색이 잘 남음; 손가락 구분은 축소되며 머리·앞치마에 작은 잔점. |
| curtsy-04 | 54×96, 15색 | 정면 유지, 차분히 숙인 얼굴이나 무릎 굽힘은 약해 서 있는 자세에 가까움; 정체성 유지, 양손과 치마 접점이 잘 보임; 손 집기의 세부는 단순화되고 포니테일·꼬리 윤곽에 잔점. |

- **bow 추천: bow-04.** 가려진 얼굴·정수리·상체 압축·피부색 손이 함께 남아 가장 깊이 숙인 순간의 기준으로 읽기 좋다. 실제 허리 투시와 가장자리는 후속 정리 대상으로 남는다.
- **curtsy 추천: curtsy-03.** 정면·치마 접점·얼굴과 손의 피부색·두 신발 밑선이 균형 있게 유지된다. 동작을 더 크게 보이게 하려면 02의 무릎·치마 실루엣도 참고할 만하다.
- raw에는 부드러운 경계와 미세 색 변화가 일부 있어 프롬프트의 무안티에일리어싱 요구가 완벽히 구현된 것은 아니다. 최종 processed는 이진 알파·15~16색으로 정리됐지만 잔점과 일부 피부색 손실은 남았다. 이번 후보 비교에서 임의 리터치로 숨기지 않았다.

## 검증 결과

- 최종 8개에 대해 위 `pnpm sprites:pixelize ... --height 96 --colors 16` 명령 성공. 재생성한 bow-04·curtsy-03도 같은 명령으로 다시 정리했다.
- Windows PowerShell 실행 정책이 `pnpm.ps1`을 차단해 동일한 pnpm 명령의 `pnpm.cmd` 진입점을 사용했다.
- `node docs/art/bow/gen/make-compare.mjs`: 성공. 재실행 전후 SHA-256 일치 확인.
- `pnpm.cmd exec eslint docs/art/bow/gen/make-compare.mjs`: 성공. 첫 검사에서 URL 전역 선언 오류를 발견해 `node:url`에서 명시적으로 가져오도록 수정했다.
- 저장소 PNG reader로 최종 sprite 8개를 검사: 높이 모두 96, 색 수 모두 16 이하, 투명 배경 있음, 반투명 픽셀 0. 아래 8행의 불투명 영역을 좌우로 나눈 신발 밑선은 모두 [95, 95].
- 비교 PNG의 크기 1200×1800, 네 줄의 배경색 교대 검증. 원본 복사본과 도구 출력의 SHA-256 일치 확인.
- `git diff --check`: 성공. 앱·패키지 소스 변경이 없어 전체 typecheck·단위 테스트·e2e는 실행하지 않았다.
- `TASK-art7.md`는 수정·스테이징·커밋하지 않는다. 변경 파일은 `docs/art/bow/gen/` 안에 한정한다.
- Orca 보고 연동: `orca skills get orchestration` 실행 시 `orca : 'orca' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.` 오류. 선택한 실행 파일을 찾을 수 없어 스킬 지침에 따라 다른 Orca 바이너리로 대체하지 않았으며 `worker_done` 전송은 불가했다.

## 완료 보고 본문

한 일 / bow·curtsy 각 4장 raw·pixelize 결과, 비교 PNG·재생성 스크립트·프롬프트 전문·후보별 소견 작성 및 커밋.
검증 결과 / pixelize 8개, 비교 스크립트 실행·재현성, 96px·색 수·알파·신발 밑선·배경·원본 해시 검사, 제한 파일 ESLint·diff 검사 통과.
남은 것 / 사용자의 후보 선택과 coordinator의 팔레트 정리·중간 프레임 작업. 일부 잔점·피부색 소실 등 후보별 한계는 위 표 참고. Orca CLI 부재로 worker_done 전송 불가.
기여한 완료 기준 번호 / 별도 완료 기준 번호가 없어 TASK-art7의 할 일 1~6에 대응.

## 후속 생성(curtsy v2)

생성일: 2026-10-11 (Asia/Seoul)

### 사용자 결정과 요청

- **bow는 사용자가 bow-03을 선택했다.** 앞 절의 bow-04 추천은 이전 생성 당시 의견이다. 이번 작업에서 bow 원본·processed 파일은 변경하지 않았다.
- 기존 curtsy-01~04는 모두 기각됐다. 파일은 보존하고 새로운 후보를 curtsy-05~08로 추가했다.
- 양손으로 치마 자락을 훨씬 넓게 펼쳐 든 부채꼴 실루엣, 무릎을 깊게 굽혀 몸 전체가 눈에 띄게 낮아진 커트시, 살짝만 숙인 상체.
- 눈을 뜨고 정면을 보는 차분한 미소와 base_final의 푸른 눈. 정면·정체성·두 신발 밑선·투명 배경·굵은 픽셀 조건 유지.

### 참조 이미지와 호출 옵션

- 모든 새 후보의 참조: `docs/art/base/base_final.png`. 첫 호출 전에 직접 열었고, 네 번 모두 원본 경로를 참조로 첨부했다.
- 기존 curtsy의 좁은 치마·감은 눈 자세를 피하기 위해 기존 후보는 생성 참조로 첨부하지 않았다.
- 도구: image_gen 내장 도구만 사용, 모델 `image_gen built-in (runtime model unspecified)`.
- 호출 옵션: `referenced_image_paths=["C:/Users/Example/orca/workspaces/deskpet/art-bow/docs/art/base/base_final.png"]`, `transparent_background=true`.
- 도구의 원본 출력을 변경 없이 다음 raw 경로에 복사했다.

| 후보 | 도구 출력 파일 | 저장 파일 |
|---|---|---|
| curtsy-05 | `exec-e69a8eae-844c-4fd9-af14-f241aa7e8054.png` | `raw/curtsy-05.png` |
| curtsy-06 | `exec-aa1abe97-21b9-4194-9e22-903e72b59399.png` | `raw/curtsy-06.png` |
| curtsy-07 | `exec-1ca7efb9-e185-4167-871d-59f838470a55.png` | `raw/curtsy-07.png` |
| curtsy-08 | `exec-fd012700-4fd6-411d-88b8-c3bcb73547b9.png` | `raw/curtsy-08.png` |

### 프롬프트 전문

#### curtsy-05

```text
Use case: stylized-concept
Asset type: pixel-art character reference candidate curtsy-05, deep curtsy with a very wide fan-shaped skirt.
Input images: base_final.png is the authoritative identity, costume, palette and adult anatomy reference ONLY. Change its standing pose substantially.
Primary request: ONE full-body adult wolf maid in a DEEP CURTSY, STRICT FRONT view, looking directly at the viewer with BOTH BLUE EYES OPEN and a small calm smile. Her hips and entire body are visibly lowered by a pronounced bend of BOTH knees under the skirt. Keep the torso mostly upright with only a slight forward incline, the face fully visible. This is the low point of a formal curtsy, not standing with a nod.
Critical silhouette: BOTH ARMS reach far OUT TO THE SIDES, hands well beyond shoulder width, each hand grasping and lifting its side skirt hem. The navy skirt opens dramatically into a broad semicircular FAN, MUCH wider than the normal standing skirt: spread from hand to hand roughly equal to the figure's lowered total height, at least three shoulder widths. Long fabric arcs down from both widely spread hands into a modest low center hem; white apron stays central. Strong diagonal fan folds, not a narrow bell skirt or hands resting by the hips.
Legs: deeply bent knees to lower the hips naturally, two black shoes both clearly visible under the low central hem, with BOTH horizontal shoe bottom edges EXACTLY on one ground line. No raised or floating shoe.
Identity: same adult five-head-tall anatomy before knee bend; silver hair and silver side ponytail with navy ribbon, large wolf ears, white frilled headpiece, recognizable blue open eyes, navy neck bow, long navy classic maid dress, white apron, black shoes, one large silver wolf tail at reference side. Preserve peach face and hands as strong readable flat clusters.
Style: coarse hard square pixel art, approximately 16 flat reference colors, opaque connected clusters and genuinely transparent background, suitable to reduce to 96 pixels tall. Full ears, ponytail, very wide skirt, tail and shoes inside canvas with ample margin.
Avoid: closed eyes, downcast eyes, narrow skirt, straight upright legs, barely bent knees, deep torso bow, side view, three-quarter view, chibi or child redesign, extra figures, extra limbs, high thigh exposure, props, text, shadow, antialiasing, semitransparency, gradients, dithering or scattered edge pixels.
```

#### curtsy-06

```text
Use case: stylized-concept
Asset type: pixel-art character deep curtsy candidate curtsy-06.
Input images: supplied base_final.png is the exact front-view adult wolf maid identity, costume and palette reference, NOT a pose to copy.
Primary request: ONE full-body adult wolf maid at the BOTTOM of a very deep formal CURTSY, strictly facing FRONT, eyes OPEN, both blue irises looking directly at the viewer, subtle calm closed-mouth smile. Bend both knees substantially so the pelvis, waist and shoulders are unmistakably lowered toward the floor; shins tilt, knees flex together beneath the skirt. Only a very slight forward chest incline, never a head-down waist bow. Keep adult anatomical proportions, the shorter silhouette must come from bending legs, not enlarging the head or shortening limbs.
Critical pose and skirt: extend BOTH ARMS broadly sideways with softly bent elbows. Each hand visibly grips and raises the outer navy skirt hem FAR out at the sides. The fabric stretches into a magnificent wide fan, about 3.5 shoulder widths across, around as wide as the crouched figure is tall. Lift the side hems to around hip/waist height, while the central skirt and white apron hang down modestly over the knees. Wide sweeping diagonal fabric folds clearly link the waist, both far-out hands and the low central hem. This is substantially wider than a normal bell skirt.
Feet: two clearly separate black shoes, BOTH bottoms at exactly the SAME horizontal ground line, both planted, visible under the center skirt. Natural deep knee bend, not sitting, kneeling or standing straight.
Invariants: same adult approximately five-head anatomy when standing; silver hair and side ponytail tied with navy bow, large paired wolf ears, white maid head frill, blue open eyes, navy neck bow, long navy classic maid dress with white apron, black shoes, ONE large silver wolf tail at the reference side. Solid peach face and hands.
Style/composition: bold coarse square pixel clusters, approximately 16 flat colors, true transparent background. Full frontal figure with margins around wide skirt and all extremities. Design for 96px-tall sprite readability with clear large blue-eye and peach-skin clusters.
Avoid: closed or downcast eyes, narrow skirt, hands near hips, barely lowered pose, straight legs, twisted torso, side or three-quarter camera, baby/chibi redesign, thigh exposure, extra characters or limbs, props, lettering, cast shadow, antialiasing, translucent pixels, gradients or dithering.
```

#### curtsy-07

```text
Use case: stylized-concept
Asset type: pixel-art deep-curtsy character candidate curtsy-07.
Input images: base_final.png is the sole identity, adult anatomy, front-view costume and color reference.
Primary request: ONE full-body same adult silver-haired wolf maid, strictly FRONT-facing, in a visibly LOW formal CURTSY with a dramatically WIDE skirt. Her BOTH BLUE EYES stay clearly OPEN and look straight at the viewer, with a restrained friendly smile. Only a slight forward inclination of the chest. The hips are lowered through a strong knee bend; lower legs visibly flex beneath the center hem, not upright straight standing legs. Keep normal adult anatomy, not chibi.
Silhouette: each hand grips the corresponding outer navy skirt hem, arms extended widely outward with elegant relaxed elbows. Lift and stretch the skirt far to both sides, at least THREE shoulder widths, into an expansive fan or broad shallow semicircle. The skirt is wider than the normal standing reference by a large margin, with hanging curved fabric folds from each far-out hand and a low central hem. White apron remains draped over the center knees.
Pose variation: a subtly asymmetric natural curtsy, one bent knee tucked a little inward, while torso and head remain square to the front. BOTH black shoes visibly rest on exactly the SAME horizontal baseline; no shoe lifting or vertical offset. Both hands must visibly touch and pinch the fabric.
Preserve: adult approximately five-head body proportion when standing, silver hair, navy-bowed silver side ponytail, large paired wolf ears, white head frill, OPEN blue eyes, navy neck bow, long navy classic maid dress, broad white apron, black shoes, one large silver wolf tail. Peach face and hands, clear dark outlines.
Pixel rendering: broad hard square pixel clusters, about 16 flat colors matching the reference, no antialiasing or partially transparent pixels, no gradients, no dithering. TRUE transparent empty background, alpha zero everywhere outside silhouette. Absolutely no glow, haze, cast shadow or background color.
Composition: one full frontal character with margins around wide skirt, ears, tail and shoes. Avoid closed eyes, narrow bell-shaped skirt, straight standing legs, merely nodding, deep waist bow, side view, three-quarter view, children, extra figures or limbs, text, props, high exposed thighs and rough detached edge specks.
```

#### curtsy-08

```text
Use case: stylized-concept
Asset type: transparent pixel-art sprite candidate curtsy-08.
Reference: base_final.png defines the same adult silver-haired wolf maid identity, costume and colors. Use its design, but completely replace the standing pose.
Draw ONE character only, full body, strictly facing FRONT, at the LOWEST moment of a deep curtsy. Her blue eyes are BOTH OPEN and gaze directly at the viewer, with a gentle composed smile. She bends the knees deeply and lowers her hips considerably; torso remains nearly upright with a slight polite forward incline. The shape must clearly show a lowered body, adult anatomy compressed by the knee bend, not a child or chibi.
BOTH hands pinch the outer edges of the long navy skirt and pull them very FAR SIDEWAYS, arms spread broadly, creating a huge graceful fan-shaped skirt at least three shoulder widths wide. The skirt width is greater than the lowered figure's height. Side hems lifted to hip level, central hem draping modestly over the bent knees, white apron centered with compressed folds. Use balanced gently arched elbows and large unmistakable fan folds. Show both bent lower legs under the middle hem; two black shoes side by side, bottom edges precisely on the SAME horizontal ground line. No floating or raised foot.
Keep reference silver hair, navy-bowed silver side ponytail, large wolf ears, white frilled headpiece, open blue eyes, navy neck bow, long navy maid gown, white apron, black shoes, ONE large silver wolf tail on the reference side, peach face and hands. Adult five-head anatomy when standing.
Rendering: deliberately coarse hard square PIXEL ART, around 16 flat colors with large opaque connected clusters, readable open blue eyes at 96px sprite height. Canvas around the character must be entirely alpha=0 TRANSPARENT, including between arms and skirt, without ANY painted background, backlight, aura, glow, haze, cast shadow, gradient or floor. Hard cutout edge, no antialiasing or semitransparent pixels, no dithering.
Complete full figure with generous margins around ears and broad skirt tips. No closed eyes, downward gaze, narrow skirt, straight legs, shallow standing nod, deep waist bow, side/three-quarter angle, text, props, extra figures or limbs.
```

### 배경 정리 추가 시도 기록

06의 도구 미리보기에서 후광처럼 보이는 번짐이 있어 내장 image_gen으로 배경 정리도 한 번 시도했다. 출력에서도 번짐이 보여 최종 후보로 채택하지 않았고, **최종 raw/curtsy-06.png는 위 표의 최초 생성 출력**이다. 추가 출력은 도구 기본 저장 위치에만 보존했다. 이후 지정된 pixelize 처리 결과를 밝고 어두운 배경에서 확인하니 네 장 모두 바깥 번짐이 제거되어 최초 생성 4장을 그대로 사용했다.

- 편집 참조: `exec-aa1abe97-21b9-4194-9e22-903e72b59399.png` (06 최초 출력).
- 옵션: `referenced_image_paths=[06 최초 출력의 로컬 경로]`, `transparent_background=true`.
- 미채택 출력: `exec-f70b6843-e371-458c-b19d-ee64ad7a8ce8.png`.
- 프롬프트 전문:

```text
Use case: background-extraction
Asset type: transparent pixel-art sprite, curtsy-06 cleanup.
Input image: the supplied deep-curtsy wolf maid is the EDIT TARGET.
Edit only the background and edge contamination. Remove the entire gray/navy glowing aura, haze, halo and shadow around this character, including all gaps between her outstretched arms and skirt. Output a genuinely transparent PNG cutout with alpha ZERO everywhere outside the exact hard pixel silhouette. All character pixels should be opaque, with hard square edges, no translucent fringe, no soft masking.
Preserve the character's current pose and pixel art: very wide fan-shaped navy skirt held with both hands, lowered bent-knee curtsy, open blue eyes gazing forward, calm smile, silver ponytail, white maid frill, wolf ears and tail, white apron, two shoes on one ground line. Keep the full body and same composition. Do not add or redesign anything. No background of any color, checkerboard, glow, shadows, text, gradients or blur.
```

### 처리 명령

PowerShell의 pnpm.ps1 실행 정책 때문에 동일한 pnpm 명령의 pnpm.cmd 진입점으로 실행했다.

```sh
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-05.png --out docs/art/bow/gen/processed/curtsy-05 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-06.png --out docs/art/bow/gen/processed/curtsy-06 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-07.png --out docs/art/bow/gen/processed/curtsy-07 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-08.png --out docs/art/bow/gen/processed/curtsy-08 --height 96 --colors 16
node docs/art/bow/gen/make-compare.mjs
pnpm.cmd exec eslint docs/art/bow/gen/make-compare.mjs
git diff --check
```

### 비교 그림과 후보별 소견

비교 스크립트에 05~08 그룹을 추가했다. 넓은 후보가 잘리지 않게 칸 너비를 240→320px로 늘려 최신 `compare.png`는 **1600×2700, 총 6줄**이다. 기존 bow·curtsy 4줄 뒤에 새 curtsy의 밝음(#e8e8e8)·어두움(#282828) 2줄을 붙였다. 기준과 모든 후보의 최근접 2배·같은 하단 배치는 유지했다.

원본 4장과 최종 `*.check.png` 4장을 각각 직접 확인하고 전체 비교 그림도 열었다. 아래 폭은 꼬리까지 포함한 sprite 전체 폭이며 치마만 잰 값은 아니다. 모두 높이 96으로 정규화되므로 몸이 낮아진 절대 높이는 수치 비교할 수 없고, 굽힌 다리·짧아진 하체·접힌 앞치마로 판단했다.

| 후보 | 정리 결과 | 치마 폭·낮아짐·눈·정체성·잡티 소견 |
|---|---|---|
| curtsy-05 | 98×96, 16색 | 이전보다 크게 벌린 부채꼴 치마와 넓은 양팔, 네 후보 중 폭과 낮아짐은 가장 절제됨; 원본은 푸른 눈을 뜨고 정면 미소, 축소 후 눈·입은 작아짐; 귀·프릴·포니테일·리본·꼬리 유지, 손 피부색 남음; 머리·앞치마 가장자리 잔점. |
| curtsy-06 | 130×96, 16색 | 낮게 퍼진 넓은 치마와 굽힌 다리·접힌 앞치마로 깊은 커트시가 잘 읽힘; 원본은 열린 푸른 눈·정면 미소, 축소 후 푸른색과 피부색이 흐려짐; 주요 의상·머리·꼬리 유지, 원본의 치마 잡기는 명확; 정리 후 눈·손의 세부와 가장자리 잔점이 약점. |
| curtsy-07 | 139×96, 16색 | 매우 넓은 부채꼴 치마, 안쪽으로 겹친 굽힌 다리로 낮아진 인상 강함; 원본의 푸른 눈·정면 시선·차분한 미소 유지, 축소 후 얼굴·손 피부색이 회백색으로 뭉치고 눈은 어둡게 단순화됨; 귀·포니테일·프릴 유지하나 꼬리는 팔 뒤에 많이 가림; 손·머리 경계 잔점. |
| curtsy-08 | 139×96, 16색 | 양옆으로 크게 든 치마와 낮은 하체, 중앙의 위로 접힌 앞치마로 깊은 커트시가 가장 균형 있게 보임; 원본은 열린 푸른 눈으로 정면을 보며 미소, 축소 후 눈이 어두워지고 미소는 미세하지만 얼굴·양손 피부색은 유지; 귀·프릴·포니테일·목 리본·꼬리 보존; 앞치마 주름·치마 가장자리 잔점이 남음. |

**추천: curtsy-08.** 사용자가 요청한 큰 치마 폭과 깊이 낮아진 자세를 함께 가장 잘 전달하며, 96px 결과에서도 얼굴·손 피부색과 전체 정체성이 남는다. 원본에서 명확한 푸른 홍채·미소·치마를 집는 손가락은 96px·16색 변환에서 어두워지거나 단순화되므로 후속 팔레트 정리 때 확인할 항목이다. raw에는 반투명 경계·번짐·미세 색 변화가 있으나, 지정 처리 후 배경 번짐과 반투명은 제거됐다. 이번에는 리터치나 팔레트 강제 매핑을 하지 않았다.

### 검증 결과

- 지정 pixelize 명령 4개 성공: 높이 모두 96, 색 수 모두 16, 투명 배경 있음, 반투명 픽셀 0.
- 하단 8행의 불투명 신발 영역을 좌우로 나눠 측정한 밑선은 네 후보 모두 [95, 95].
- 비교 스크립트를 명령으로 직접 재실행하고 전후 SHA-256 일치 확인: `994b1d79d12686f62362f7de1968afc48b7c2f0386be9b70d0d36df91165ce7b`.
- 비교 PNG 1600×2700, 6줄 배경색 교대 확인. 새 두 줄에서 후보 픽셀과 원본 sprite의 최근접 2배 배치를 실제 픽셀로 대조해 통과.
- raw 4개가 도구 출력과 SHA-256이 같은지 확인. 기존 bow·curtsy-01~04 원본·processed 파일 변경 없음.
- 변경 스크립트 ESLint 및 `git diff --check` 통과. 앱·패키지 소스 변경이 없어 전체 테스트·e2e는 실행하지 않았다.
- 커밋 범위는 `docs/art/bow/gen/`만이며 `TASK-art7*.md`는 제외한다.
- Orca CLI 부재로 worker_done 전송 불가. 보고 본문: 한 일 / curtsy-05~08 원본·pixelize·비교 2줄·프롬프트와 소견 추가, bow-03 사용자 선택 기록. 검증 결과 / 위 4개 처리·픽셀·알파·밑선·비교 재현성·ESLint·diff 검사 통과. 남은 것 / 사용자 후보 선택과 후속 팔레트·프레임 정리, worker_done 전송 불가. 기여한 완료 기준 번호 / TASK-art7b의 할 일 1~6.

## 후속 생성 2(curtsy-02 수정)

생성일: 2026-10-11 (Asia/Seoul)

### 사용자 결정과 요청

- **curtsy는 1차 후보 curtsy-02를 기준으로 한다. 05~08은 사용하지 않는다.** 이전 절의 추천은 당시 후보 검토 이력이며 이번 사용자 결정으로 대체됐다. bow-03 선택은 유지한다.
- curtsy-02의 자세·구도·치마를 잡는 손·전체 크기를 최대한 유지하고 두 영역만 수정한다.
- 흰 앞치마를 치마의 퍼짐에 맞춰 옆으로 넓히고, 아랫단 프릴도 넓어진 곡선을 따라가게 한다.
- base_final과 같은 푸른 눈을 뜨고 정면을 보는 차분한 표정으로 바꾼다.
- 원본 후보는 모두 보존하고 수정본만 09~12로 추가한다. 어두운 배경 번짐이 있는 결과는 채택하지 않는다.

### 입력 이미지와 호출 옵션

- 편집 대상(Image 1): `docs/art/bow/gen/raw/curtsy-02.png`. 생성 전에 직접 열어 자세·손·치마·발·꼬리를 확인했다.
- 얼굴·눈 기준(Image 2): `docs/art/base/base_final.png`. 원본도 다시 직접 열었다.
- 네 번 모두 image_gen 내장 도구의 편집 방식으로 같은 두 파일을 첨부했다. 직전 생성물을 다시 편집하지 않아 누적 자세 변화를 피했다.
- 옵션: `referenced_image_paths=["C:/Users/Example/orca/workspaces/deskpet/art-bow/docs/art/bow/gen/raw/curtsy-02.png", "C:/Users/Example/orca/workspaces/deskpet/art-bow/docs/art/base/base_final.png"]`, `transparent_background=true`.
- 모델: `image_gen built-in (runtime model unspecified)`. 외부 이미지 서비스·다운로드 없음.
- 네 결과 모두 어두운 후광·번짐이 없어 재생성 없이 채택했다. raw는 도구 출력을 변경 없이 복사했다.

| 후보 | 도구 출력 파일 | 저장 파일 |
|---|---|---|
| curtsy-09 | `exec-a8910163-a668-49e3-b4d5-65adb91c4f1a.png` | `raw/curtsy-09.png` |
| curtsy-10 | `exec-b079698e-1f85-4b2e-9874-cd9f823623f5.png` | `raw/curtsy-10.png` |
| curtsy-11 | `exec-a2c3de0b-e7fa-4c7f-ac8a-f1fb1cd78aff.png` | `raw/curtsy-11.png` |
| curtsy-12 | `exec-98f8715d-1816-4311-b18b-42124afc2f02.png` | `raw/curtsy-12.png` |

### 프롬프트 전문

#### curtsy-09

```text
Use case: precise-object-edit
Asset type: edited pixel-art character candidate curtsy-09.
Input images: Image 1 (curtsy-02.png) is the EDIT TARGET and authoritative pose, composition, size, silhouette and costume. Image 2 (base_final.png) is a supporting reference ONLY for the open BLUE EYES and calm face. Do not copy Image 2's standing pose.
Make only TWO LOCAL CHANGES to Image 1:
1. Widen the WHITE LOWER APRON to follow the existing lifted skirt. Keep the waist attachment exactly where it is, but flare both apron sides outward into a broad naturally draped fan or trapezoid over the navy skirt. The lower apron width should be about 75 percent of the navy skirt width at the same height, instead of a narrow vertical column. Keep the hem at nearly the original vertical height. The white lower ruffle/frill follows this widened curved hem continuously; show a few restrained radial fabric folds.
2. OPEN both eyes to show the same calm blue irises as Image 2, looking straight at the viewer, with a composed neutral-to-gentle expression. Preserve Image 1's face position, head size and head angle.
LOCK EVERYTHING ELSE from Image 1: exact front-view curtsy stance, bent knees, shoe placement and shared baseline, body height and width, hands pinching the navy skirt at exactly the same points, arm angles, navy skirt spread and outline, waist position, head and ears, silver ponytail and navy ribbon, white head frill, navy neck bow, one large silver wolf tail. Do NOT spread the arms or navy skirt farther, do NOT deepen the crouch, do NOT change character proportions.
Style: same coarse hard square pixel art as the target, approximately 16 flat colors; full figure at the same overall scale and framing. Preserve a genuinely TRANSPARENT empty background, transparent gaps around limbs, NO backdrop, NO dark haze or glow, NO cast shadow. All outside pixels should be alpha zero. No antialiasing, semitransparency, gradients, dithering, text, props, added limbs or figures. Keep peach face and hands and blue eyes as readable solid clusters.
```

#### curtsy-10

```text
Use case: precise-object-edit
Asset type: edited pixel-art reference candidate curtsy-10.
Input images: Image 1 curtsy-02.png is the EDIT TARGET. Image 2 base_final.png supplies ONLY blue open eyes and facial identity.
Edit Image 1 locally, preserving its pose, framing and overall scale. Change only the LOWER WHITE APRON and EYES:
APRON: keep the existing narrow waist fastening, and widen the apron below it into a naturally spreading, gently curved fan that follows the existing lifted navy skirt. Make the white apron around 80 percent as wide as the navy skirt at its broad lower section, with sloping outward side edges rather than parallel vertical sides. Lift the apron side corners slightly along the lifted skirt while retaining its low curved center hem at the original height. Expand the bottom white frill across the entire wider hem. Keep folds simple and soft-looking but made of flat square pixels.
EYES: replace closed lashes with two OPEN calm BLUE eyes looking directly forward, same blue as the second reference. Preserve head position, face shape and adult expression; no exaggerated smile, no change in head tilt.
Everything outside those two edits is LOCKED to Image 1: unchanged arm angles, same hands pinching the same skirt locations, unchanged navy skirt outline and spread, same modest bent-knee curtsy and torso angle, same body height and overall width, same black shoes and equal bottom baseline, identical silver ponytail, navy bow, wolf ears, white head frill, neck bow, and single large silver wolf tail. Do not turn, deepen the pose, spread the skirt farther or borrow the second reference's standing pose.
Keep the target's coarse square pixel-art appearance and approximately 16 flat colors, preserving solid peach skin and readable blue irises. Genuine transparent background with empty alpha-zero space around the entire hard-edged silhouette and inside gaps. NO dark gradient backdrop, glow, aura, haze, shadow, semitransparency, antialiasing, dithering, text, props or extra limbs. One full figure, same composition and margins as Image 1.
```

#### curtsy-11

```text
Use case: precise-object-edit
Asset type: edited pixel-art character candidate curtsy-11.
Input images: Image 1 curtsy-02.png is the editing target. Image 2 base_final.png is ONLY the reference for blue open eyes and facial identity.
Perform a minimal local edit of Image 1. Two changes only:
A. The white apron below the waist must spread sideways with the existing spread navy skirt. Give it a broad, gently bell-shaped drape, progressively wider from its ORIGINAL waist fastening toward the hem, about three quarters the width of the navy skirt at that level. Preserve the apron center hem height; curve the hem up slightly toward its wider side corners, with the white ruffled border continuing naturally across the full widened curve. Use a few clean fan-shaped folds instead of a straight narrow hanging column. Keep the navy skirt itself exactly its current width.
B. Open both eyes, calm BLUE irises facing the viewer, like Image 2. Keep the existing head angle, face shape and position. The expression should be composed and gentle, no closed or downcast eyes.
Preserve Image 1's entire pose and layout: same hand grip locations on the navy skirt, same bent fingers and wrists, arm angles and cuffs, original mildly lowered curtsy and bent knees, torso angle, black shoes on the same level baseline, same total height and full-body silhouette. Keep all wolf-maid identity features identical: adult anatomy, silver side ponytail, navy ribbon, large wolf ears, white head frill, navy neck bow, long navy maid gown, white apron bib, single large silver wolf tail. Do not copy Image 2's standing pose or change the body proportions.
Match original coarse square pixel art, about 16 flat colors, solid readable peach skin and blue eyes. Preserve a TRUE TRANSPARENT background and cutout, empty alpha-zero background around all edges and gaps. No dark glow, shadow, aura, haze or gradient background; no antialiasing, semitransparency, gradients, dithering, extra people, limbs, props or text. Same full figure framing and size as the editing target.
```

#### curtsy-12

```text
Use case: precise-object-edit
Asset type: curtsy-12, minimal edited pixel-art character candidate.
Input images: Image 1 curtsy-02.png is the ONLY pose/composition editing target; Image 2 base_final.png is the OPEN BLUE EYE and face reference only.
Keep Image 1 unchanged except for TWO regions: eyes and white apron below the waist.
APRON EDIT: make the white lower apron follow the already-lifted navy skirt as a broad naturally spread fabric panel. Keep the original waist and central hem height. Widen the lower sides smoothly so the apron spreads almost to the inner sides of both hands, reaching approximately 80 percent of the navy skirt width at apron hem level. A broad rounded lower edge with continuous white frill should follow this spread. Let the apron drape rather than become a rigid triangle: gentle outward side curves, a few simple radial fold shadows and a softly rounded center. Do not move the hands or alter the navy skirt to accommodate the apron.
EYE EDIT: open both eyes with clear calm blue irises looking straight toward the viewer, matching Image 2. Same face placement, head shape, head tilt and composed expression, no closed eyelids.
UNCHANGED: all body proportions and total size, modest bent-knee curtsy, torso angle, arm positions, fingertips pinching the skirt at original locations, original navy skirt outline and width, feet and shoe baseline, front viewpoint, silver hair and ponytail, navy hair bow, wolf ears, white head frill, upper apron bib, navy neck bow, shoes, ONE large silver wolf tail. Do not use the second image's standing pose. Do not make the figure lower, wider or more chibi.
Use coarse square pixel-art blocks and approximately 16 flat colors faithful to the target, keeping blue irises and peach skin distinct at small scale. Full figure, same framing as target. Background MUST remain genuinely transparent outside the silhouette and through all gaps. No dark background, haze, halo, glow or shadow at all. No antialiasing, partially transparent edge pixels, gradients, dithering, props, lettering, new figures or extra limbs.
```

### 처리 명령

PowerShell에서 기존과 같이 pnpm.cmd 진입점을 사용했다.

```sh
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-09.png --out docs/art/bow/gen/processed/curtsy-09 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-10.png --out docs/art/bow/gen/processed/curtsy-10 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-11.png --out docs/art/bow/gen/processed/curtsy-11 --height 96 --colors 16
pnpm.cmd sprites:pixelize docs/art/bow/gen/raw/curtsy-12.png --out docs/art/bow/gen/processed/curtsy-12 --height 96 --colors 16
node docs/art/bow/gen/make-compare.mjs
pnpm.cmd exec eslint docs/art/bow/gen/make-compare.mjs
git diff --check
```

### 비교와 후보별 소견

최신 `compare.png`는 **1600×3600, 총 8줄**이다. 이전 6줄 아래에 `curtsy-02 | curtsy-09 | curtsy-10 | curtsy-11 | curtsy-12` 순서의 밝음(#e8e8e8)·어두움(#282828) 두 줄을 추가했다. 추가 줄에서는 기준도 curtsy-02의 96px sprite로 사용해 전부 같은 크기·최근접 2배·같은 발 밑선에서 비교한다. 앞선 6줄은 픽셀 단위로 이전 커밋과 일치한다.

생성 원본 4장, 각 후보의 밝음·어두움 `*.check.png`, 전체 비교 그림을 직접 열었다. 전부 61×96·16색이며, curtsy-02의 정리본도 61×96이다. 아래 실루엣 겹침도는 같은 좌표에서 불투명 영역의 교집합/합집합(IoU)을 측정한 값이다. 외곽과 크기의 유지 정도를 보조할 뿐, 모든 의상 내부 픽셀이 같은지 증명하는 값은 아니다.

| 후보 | curtsy-02와 자세·크기 | 앞치마·눈·정체성·투명·잡티 소견 |
|---|---|---|
| curtsy-09 | 손의 치마 접점·팔 각도·굽힌 다리·발 배치가 거의 같음; 61×96, 실루엣 99.16% | 앞치마가 넓은 부채꼴로 퍼지고 하단 프릴이 곡선을 따름; 원본은 열린 푸른 눈·정면의 차분한 얼굴이나 축소 후 피부색 대부분이 희게 합쳐지고 눈은 어두운 점으로 줄어듦; 귀·머리·리본·꼬리 유지, 투명 배경에 어두운 번짐 없음; 머리·포니테일 경계 잔점. |
| curtsy-10 | 원본의 손·치마 외곽·무릎·발 위치가 가장 안정적으로 유지됨; 61×96, 실루엣 99.65% | 앞치마가 아래쪽으로 자연스럽게 넓어지고 둥근 프릴이 이어짐, 주름이 절제됨; 원본은 열린 푸른 눈·정면 시선, 축소 후 눈 색은 어두워지지만 얼굴·양손 피부색이 잘 남음; 주요 정체성 유지, 배경 투명·후광 없음; 앞치마와 머리 가장자리의 작은 잔점. |
| curtsy-11 | 자세·손 위치·전체 크기 거의 같음; 61×96, 실루엣 99.48% | 넓어진 앞치마에 방사형 주름이 10보다 명확하고 하단 프릴이 자연스럽게 이어짐; 원본의 열린 푸른 눈·정면 유지, 축소 후 눈이 작고 얼굴 피부색은 옅어지나 손은 남음; 의상·포니테일·귀·꼬리 유지, 투명 배경·번짐 없음; 앞치마 주름과 머리 경계 잔점. |
| curtsy-12 | 손·팔·무릎·발의 원래 자세 유지, 61×96, 실루엣 99.18% | 앞치마가 손 가까운 높이부터 옆으로 퍼져 옆단을 든 느낌이 가장 강함, 낮고 둥근 프릴; 원본의 열린 푸른 눈·정면 유지, 축소 후 눈은 어둡지만 피부색 남음; 주요 정체성 유지, 투명 배경·번짐 없음; 양옆 앞치마 접힘이 다소 각지고 프릴·머리 경계 잔점. |

**추천: curtsy-10.** 원본 자세와 외곽을 가장 가깝게 유지하면서 좁은 기둥 같던 앞치마를 넓고 둥글게 정리했고, 96px 결과에서 얼굴·양손 피부색도 가장 안정적이다. 앞치마가 손을 따라 직접 들린 느낌을 더 강하게 원하면 12를 비교할 수 있다.

네 원본 모두 푸른 홍채가 보이는 열린 눈이다. 지정된 96px·16색 변환 후에는 작은 눈의 푸른색·흰자·표정이 어둡거나 옅게 단순화되므로 원본과 함께 검토해야 한다. raw에는 미세한 색·알파 변화가 남아 있으나 눈에 보이는 어두운 후광은 없으며, processed는 완전 투명/불투명 알파로 정리됐다. 이번 작업에서 별도 팔레트 매핑·리터치·프레임 제작은 하지 않았다.

### 검증 결과

- 지정 pixelize 명령 4개 성공. 모두 61×96, 16색, 투명 배경 있음, 반투명 픽셀 0. 신발 하단은 네 후보 모두 [95, 95].
- 원본 PNG에 완전 투명 픽셀이 존재함을 확인. 최초 모서리 알파 0 검사는 09·11에서 실패해 수치를 조사했다: 09는 [1,0,0,0], 10은 [0,0,0,0], 11은 [0,0,1,0], 12는 [0,0,0,0]. 1/255의 미세 잔여값이므로 raw의 완전 이진 알파를 주장하지 않는다. 눈에 보이는 어두운 번짐은 없고 processed의 반투명 0 검사는 통과했다. raw 복사본 네 장은 도구 출력과 SHA-256 일치.
- `node docs/art/bow/gen/make-compare.mjs` 명령을 직접 재실행해 성공 및 동일 해시 확인: `ccbc888a80269cf4ebcf643aeee359bc488e04bd0a2b8ac757af9332a989fc20`.
- 비교 크기 1600×3600, 8줄 배경색, 마지막 두 줄의 기준 curtsy-02와 후보 09~12를 실제 픽셀로 대조. 원본 sprite의 각 픽셀이 2×2로 복제되는지 및 투명 영역이 배경색인지 확인.
- 기존 비교 6줄은 이전 커밋과 픽셀 단위로 동일. 기존 raw·processed 및 금지 경로 변경 없음.
- 비교 스크립트 ESLint·diff 공백 검사 통과. 앱·패키지 변경이 없으므로 전체 테스트·e2e는 실행하지 않았다.
- `TASK-art7*.md`는 커밋에서 제외. 변경 파일은 `docs/art/bow/gen/` 안에 한정한다.
- Orca CLI 부재로 worker_done 전송 불가. 보고 본문: 한 일 / curtsy-02 기반 수정본 09~12·pixelize 결과·기준 포함 비교 2줄·프롬프트와 소견 추가. 검증 결과 / 위 4개 처리·크기·알파·밑선·원본 해시·비교 배치와 재현성·기존 줄 보존·ESLint·diff 검사 통과. 남은 것 / 사용자 후보 선택 및 후속 팔레트·프레임 작업, worker_done 전송 불가. 기여한 완료 기준 번호 / TASK-art7c의 할 일 1~6.
