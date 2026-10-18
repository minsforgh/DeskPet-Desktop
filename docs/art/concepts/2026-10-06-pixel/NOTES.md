# ART-2A 픽셀 기준 이미지 후보

작성일: 2026-10-06. 기준: D-002의 디자인 A / 픽셀 방향.
내장 image_gen 도구로 생성했다. 코드로 그리거나 이미지를 가공하지 않았으며, 선택된 생성 원본을 바이트 그대로 raw/에 복사했다. 동작 프레임은 만들지 않았다.

## 참조와 생성 방식

작업 시작 때 ../2026-10-06/a-pixel.png와 a-illustration.png를 직접 열었다. 은발 포니테일·늑대 귀와 꼬리·남색 긴 클래식 메이드복·흰 앞치마·머리 프릴·남색 리본을 유지하고, 기존 픽셀 시안보다 눈과 입의 대비를 높이는 방향으로 프롬프트를 작성했다. 기존 작품·캐릭터·작가·스튜디오·게임 이름은 프롬프트에 쓰지 않았다.

p1 첫 시도는 transparent_background=true였지만 어두운 후광 배경이 나와 제외했다. 이후에는 허용된 흰 배경으로 통일했으며 최종 6장 모두 transparent_background=false, RGB PNG다. 배경은 시각적으로 흰색이나 원본에 미세한 색 변화가 남아 있어 정확한 단일 RGB 배경이나 16색 indexed PNG를 보장하지 않는다.

파일명의 48/64/96은 **프롬프트의 목표 논리 해상도**이며 실제 파일 해상도가 아니다. 생성 모델이 정확한 도트 격자·등신·팔레트를 보장하지 않아 후보 사이의 밀도 차이도 요청만큼 일정하지 않다. 특히 p3/p4는 비슷한 밀도다. 이번 결과는 후처리할 디자인 후보이며 바로 앱에 넣을 완성 스프라이트가 아니다.

각 최종 파일을 생성 결과 표시와 view_image 직접 열기로 확인했다. 전신·정면·발끝·필수 캐릭터 요소·얼굴·도트 경계를 시각적으로 검토했다. 130–190px에서의 평가는 원본의 얼굴 비중과 대비에 따른 예상이다. 이미지 가공 금지 범위 때문에 축소 파일이나 후처리 미리보기는 만들지 않았고 앱 실측도 하지 않았다.

## 추천 순서

| 순위 | 후보 | 추천 이유와 주의점 |
| --- | --- | --- |
| 1 | p6-best-guess | p5의 큰 눈·단순한 덩어리에 긴 몸통과 치마를 조합해 얼굴 가독성과 성인 메이드 인상의 균형이 가장 좋다. 입 가장자리를 격자에 맞추는 손질이 필요하다. |
| 2 | p3-mid-64 | 눈과 입의 대비가 강하고 넓은 색 덩어리가 정리하기 쉽다. p6보다 둥글고 귀여운 인상이 강하다. |
| 3 | p4-mid-96 | p3의 비율을 유지하면서 미소와 손이 조금 더 분명하다. p3보다 현저히 세밀한 96px 변형이라고 보기 어렵다. |
| 4 | p1-tall-64 | 긴 체형과 간단한 얼굴의 절충안이다. 목표 64px보다 도트가 세밀하고 축소 때 얼굴 면적이 줄어든다. |
| 5 | p2-tall-96 | 성인 체형·긴 치마·원 디자인의 단정함이 가장 잘 남는다. 여섯 중 작은 얼굴과 세부 주름 때문에 축소/정리 부담이 크다. |
| 6 | p5-small-48 | 가장 굵은 도트와 큰 얼굴로 표정 전달에는 유리하다. 작은 체형이라 키 큰 성인 메이드라는 방향에는 가장 덜 맞는다. |

## p1-tall-64

파일: [raw/p1-tall-64.png](raw/p1-tall-64.png)

직접 열어 본 판단 및 재시도: 1회 재시도. 첫 결과의 어두운 후광 배경과 과도한 디테일을 보고 투명 요청을 단색 흰 배경으로 바꾸고, 64개 논리 픽셀 행·큰 사각형·단순한 프릴을 더 강하게 명시했다. 최종은 흰 배경, 전신 정면, 발끝까지 보인다. 큰 파란 눈 두 개와 짙은 작은 웃는 입이 분리되어 읽힌다. 은발 포니테일·늑대 귀·꼬리·프릴·리본·남색 긴 옷·흰 앞치마가 모두 있다. 긴 치마와 체형이 성인 인상을 유지한다. 외곽 계단과 큰 흰 앞치마 면은 정리하기 좋지만 손·프릴·머리카락의 도트 크기는 불균일하고 미세한 음영이 남는다. 목표 64px보다 세밀하다. 작은 표시에서는 중간 체형 후보보다 눈이 작게 보일 것으로 예상한다.

최종 입력 참조: 없음 (새 생성).
생성 원본 파일명: exec-b72791e9-c68f-4299-aadf-a5270d826cfb.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
Create one ORIGINAL pixel-art sprite on a completely solid pure WHITE #FFFFFF background, uniform white everywhere outside the character. No lighting, no glow, no vignette, no shadows. Full body, strict front view, both complete shoes, space above wolf ears and below feet. Only one character; no text or props.
A calm adult Japanese anime-inspired wolf maid: silver high ponytail tied with navy bow; two upright silver wolf ears; big bright BLUE eyes, fully visible on both sides of bangs; obvious dark short smile; white frilled maid headband; navy neck bow; long-sleeved high-collar NAVY classic ankle-length maid dress; large white apron and cuffs; dark shoes; one silver fluffy wolf tail. Modest clothes. Hair ponytail beside shoulder, distinct tail beside skirt.
TALL adult 5-6-head proportion. Crucial: extremely coarse authentic sprite, ONLY 64 logical pixels from top of ears to bottom of feet, enlarged as giant identical square blocks. Think 12 logical pixels across face, blue eyes two pixels wide and mouth two pixels wide. Very simple hard staircase contours and flat 16-color palette, NO gradients, NO antialiasing, NO small subpixel details, NO fabric texture. The entire character is constructed from the same large square pixel size. Simplify the hair, dress folds and frills severely. Readable in a 130px desktop pet. This is the p1-tall-64 design reference, not an animation sheet.
```

## p2-tall-96

파일: [raw/p2-tall-96.png](raw/p2-tall-96.png)

직접 열어 본 판단 및 재시도: 재시도 없음. 전신 정면과 양쪽 신발이 모두 보이며 필수 의상·헤어·늑대 요소가 모두 있다. 포니테일과 꼬리는 높이와 형태가 달라 구별된다. 파란 눈과 열린 짙은 입이 읽히지만 얼굴 자체가 작다. 가장 길고 단정한 성인 실루엣이다. 앞치마의 큰 면은 좋으나 손가락·프릴·가느다란 머리카락·치마 주름에 세부 픽셀이 많아 격자/팔레트 정리 난도가 높다. 외곽은 계단형이지만 정확한 96px 격자는 아니다. 130px 표시에서 표정 손실 가능성이 큰 후보다.

최종 입력 참조: 없음 (새 생성).
생성 원본 파일명: exec-f6bb1682-336f-441a-91e4-6ea9506d1c51.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
Create ONE original crisp pixel-art full-body standing FRONT VIEW sprite of an adult Japanese anime-inspired silver-haired wolf maid. Uniform pure WHITE background, no shadow, glow, vignette, text, props, borders or other characters. Entire ears, ponytail, tail and both shoes comfortably inside the canvas with margins.
She has a long high SILVER PONYTAIL with navy ribbon, silver upright WOLF EARS, one fluffy SILVER WOLF TAIL extending separately beside the lower skirt, large expressive bright BLUE EYES unobscured by bangs, and a visible short dark smiling mouth. White frilled headband between ears, navy neck ribbon, high collar, long sleeves, white cuffs, modest NAVY ankle-length CLASSIC MAID DRESS and WHITE full apron. Calm poised adult, standing straight facing the viewer with hands neatly together at waist.
Variant p2-tall-96: elegant TALL 5-6 heads high body proportions excluding ears, long skirt and slender adult silhouette. Design on an approximately 96-pixel-high logical sprite grid, enlarged with nearest-neighbor hard square blocks. Slightly more detailed than a 64px sprite but still unmistakably coarse low-resolution pixel art. One consistent pixel grid, hard stair-step contours, minimal flat 16-color palette, large flat color regions, simplified frills and only two solid shadow shades. Keep face large enough for readable blue eye clusters and mouth at 130-190px display height. Absolutely NO antialiasing, gradients, dithering, painted texture, blurry edges, tiny mixed-size pixel details or photorealism. Produce one reference pose only.
```

## p3-mid-64

파일: [raw/p3-mid-64.png](raw/p3-mid-64.png)

직접 열어 본 판단 및 재시도: 재시도 없음. 전신 정면, 발끝, 모든 필수 캐릭터 요소를 확인했다. 큰 파란 눈과 검은 짧은 입이 분명하며 앞머리가 눈을 가리지 않는다. 포니테일과 꼬리가 별도 덩어리로 보인다. 긴 치마는 유지됐고 얼굴은 둥글어 귀여운 인상이 강하다. 큰 색 덩어리와 단순한 손·앞치마 덕에 정리하기 좋은 편이다. 머리카락과 프릴에 미세한 음영/불균일 픽셀이 남아 정확한 64px·16색은 아니다. 얼굴 면적과 눈/입 대비상 작은 표시에서 유리한 후보로 판단한다.

최종 입력 참조: 없음 (새 생성).
생성 원본 파일명: exec-158152b6-0ddb-4938-9a67-614799e38e75.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
One original low-resolution pixel-art desktop pet sprite, full body strict front view, standing calmly with both feet fully visible, pure solid WHITE background. No text, props, border, shadow or glow.
A mature silver-haired wolf maid in modest navy ankle-length classic maid dress with long sleeves, high collar, white cuffs, broad white apron, white frilled headband and navy neck bow. Silver high ponytail with navy bow, two triangular silver wolf ears, one fluffy silver wolf tail beside skirt. Clearly visible large vivid BLUE eyes and dark small smiling mouth, bangs part to reveal both eyes.
p3-mid-64: proportions approximately 3.5 to 4 heads tall excluding ears, enlarged head for expression but a composed adult maid feeling, long skirt, slim upright body, not a baby. Coarse sprite constructed on only about 64 logical pixel rows, enlarged using square nearest-neighbor blocks. Face about 14 pixels wide; each eye is a large 3x3 blue/dark cluster; distinct 2-pixel dark mouth. ALL pixels same large size. Use ONLY approximately 16 flat opaque colors including white, no antialiasing or gradients whatsoever. Simple large silver hair masses with 2 shadow tones, simplified skirt with 2 navy shades, white apron with 1 gray shadow, blocky minimal frills. Hard clear staircase silhouette. No texture, no thin hair strands, no tiny fingers or delicate drawn details. Keep ponytail beside shoulder separate from tail lower down. Center entire figure with clear white margin around ear tips and shoe soles. One character, one pose, no animation frames.
```

## p4-mid-96

파일: [raw/p4-mid-96.png](raw/p4-mid-96.png)

직접 열어 본 판단 및 재시도: 1회 재시도. 첫 결과는 머리가 작고 몸이 길어 p2와 비슷했으며 입 색도 옅었다. p3를 참조 이미지로 넣고 머리가 전체의 약 1/4을 차지하도록 비율을 고정하고 짙은 입을 강조했다. 최종 전신 정면, 양쪽 신발, 모든 필수 캐릭터 요소를 확인했다. 큰 눈과 웃는 입은 읽히고 p3보다 입 곡선/손 구분이 늘었다. 큰 면과 단순한 외곽 덕에 정리는 비교적 쉽지만 입 곡선과 눈 일부에 격자에서 벗어난 작은 세부가 있다. 목표 96px와 p3의 64px 차이는 실제 원본에서 약하다. 큰 얼굴 덕에 작은 표시에서 유리하나 귀여운 인상은 남는다.

최종 입력 참조: raw/p3-mid-64.png (비율·캐릭터 참조 / image_gen 편집 입력).
생성 원본 파일명: exec-3d3feb0a-74a3-4aef-a609-7f5987eb0692.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
Use the supplied p3 reference sprite as the character identity and PROPORTION reference. Redraw it as the p4-mid-96 variant: keep the BIG HEAD, 3.5-4 heads high body excluding ears, short torso and long skirt. The head excluding ears occupies roughly ONE QUARTER of the whole figure height. Do not elongate into a 5-6-head fashion figure. Increase logical sprite detail slightly from 64 to about 96 pixel rows, but use uniformly sized square pixel blocks and a flat 16-color palette. Hard staircase edges, no antialiasing, gradients, texture, fine strands or glow.
One original Japanese anime-inspired adult wolf maid, calm composed face. Preserve silver high ponytail with navy ribbon, silver wolf ears, single fluffy silver wolf tail, clearly large BLUE eyes, fully visible DARK small smiling mouth, white maid frill headband, navy neck bow, modest high collar long sleeves navy ankle-length dress, white cuffs and long white apron, dark shoes. Both eyes uncovered by bangs. Keep separate ponytail and tail silhouette, complete frontal standing full body with both entire shoes. PURE SOLID WHITE background and clear margin around all extremities. No text, props, border, shadow, extra people, or animation frames. Retain mature maid styling despite the enlarged head.
```

## p5-small-48

파일: [raw/p5-small-48.png](raw/p5-small-48.png)

직접 열어 본 판단 및 재시도: 재시도 없음. 전신 정면과 두 발, 포니테일·늑대 귀·꼬리·머리 프릴·남색 리본·긴 메이드복·흰 앞치마가 모두 보인다. 가장 큰 눈과 직사각형의 짙은 입이 또렷하다. 손과 꼬리, 치마가 큼직한 덩어리로 단순화되어 정리하기 가장 쉬운 축이다. 48px 수준을 요청했으나 실제 도트 수는 그보다 많아 보이고 면 내부의 미세한 명도 변화는 남아 있다. 둥근 큰 머리와 짧은 체형으로 표정 전달에는 좋지만 키 큰 성인이라는 인상이 약하다. 레트로 소형 비율 비교용 후보로 권한다.

최종 입력 참조: 없음 (새 생성).
생성 원본 파일명: exec-0f98fa6c-f48e-4b5a-85ed-4a2b9d101594.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
Draw one ORIGINAL very coarse retro PIXEL SPRITE on pure flat WHITE background. Exactly one whole character facing straight forward, standing still, entire ears and both complete shoes visible with ample margin. No text, props, border, scene, shadows or glow.
An adult silver-haired wolf maid, stylized 2.5-3 HEADS TALL excluding ears. Large head, compact body, mature composed expression. SILVER HIGH PONYTAIL tied with navy bow, two upright silver WOLF EARS, one fluffy SILVER WOLF TAIL visibly beside the lower body. Large BLUE EYES with dark upper outline and clear DARK MOUTH, bangs not covering either eye. White frilled maid headband, NAVY ribbon at collar, MODEST long-sleeve high-collar NAVY CLASSIC LONG DRESS covering the legs, WHITE APRON and cuffs, dark shoes.
p5-small-48: design as if the entire sprite is only 48 logical PIXELS HIGH and about 28 pixels WIDE. Enlarge these pixels as GIANT uniform squares. This is tiny low-resolution retro sprite craft: few huge color clusters, chunky stair-step outline, 16 flat colors total, ZERO antialiasing, ZERO gradients or texture. Hair only three broad shapes, tail a simple chunky curve, 3-step frills, hands a simple skin block, no detailed fingers, no fine lines, no tiny highlights. Eyes should each occupy an obvious 2-3 pixel blue cluster, mouth a distinct 2-pixel dark mark. Keep adult maid costume and silver ponytail/wolf ears/tail all legible at 130px. No animation frames.
```

## p6-best-guess

파일: [raw/p6-best-guess.png](raw/p6-best-guess.png)

직접 열어 본 판단 및 재시도: 1회 재시도. 첫 다섯 결과를 보고 p3의 얼굴 비중과 p5의 굵은 색 덩어리를 살리되 긴 체형을 더하는 조합을 선택했다. 첫 새 생성은 다시 세밀한 도트가 되어, p5를 참조로 몸통·치마를 늘려 약 4등신과 64–72px 수준을 목표로 편집 생성했다. 최종 전신 정면, 양쪽 발끝, 모든 필수 캐릭터 요소가 있다. 큰 파란 눈과 짙은 웃는 입이 읽히고, 길어진 치마로 p5보다 성인 메이드 느낌이 남는다. 포니테일과 꼬리가 서로 떨어진 큰 모양으로 읽힌다. 얼굴·손·앞치마·머리카락의 넓은 덩어리가 격자 정리에 유리하다. 입은 사각 계단보다 부드러운 곡선이어서 후처리 때 먼저 도트화할 부분이다. 원본의 미세 음영과 불균일 도트가 남으므로 정확한 16색/격자 완성본은 아니다. 작은 표시에서 얼굴 가독성과 긴 실루엣의 균형을 기대할 수 있어 1순위로 추천한다.

최종 입력 참조: raw/p5-small-48.png (굵은 도트·캐릭터 참조 / image_gen 편집 입력).
생성 원본 파일명: exec-00fff4fb-fe92-48d3-91fc-8ac64e1f8776.png.
최종 도구 설정: transparent_background=false.

최종 프롬프트 전문:

```text
EDIT this original silver wolf maid sprite to become the balanced p6-best-guess reference. Keep its chunky square-pixel craft, limited flat color scheme, very readable large BLUE eyes, separate dark mouth, all character identity and pure white background. CHANGE the proportions: lengthen the torso slightly and the long skirt substantially so the full standing character is about 4 HEADS HIGH excluding ears, with a poised slender ADULT maid impression. Keep the head large enough to read at 130px. Use about 64-72 logical pixel rows from ears to shoe soles, each pixel an identical coarse square. Use fewer larger color clusters, not extra microdetail. Make the mouth a simple short dark smile.
Preserve silver high PONYTAIL with navy bow, silver WOLF EARS, one fluffy silver WOLF TAIL separate from ponytail, WHITE frilled headband, NAVY neck ribbon, modest high collar and long sleeves, dark NAVY ankle-length classic maid dress, WHITE cuffs and long WHITE APRON, dark shoes. Fully frontal face and body, simple hands together at waist, both shoes completely visible, plenty of white margin around ears and feet. Keep mature calm eyes, avoid babyish face. Exactly ONE character, no text, borders, props, cast shadow, glow, scenery or extra frames.
Most important: REALLY BIG PIXELS, uniform square grid, clean hard staircase silhouette, about 16 solid colors, no gradients, antialiasing, fine texture, tiny fingers, fine frill detail or smooth illustration outlines. Broad shapes only. This is a single standing reference sprite for a small desktop companion.
```

## 검증 결과와 남은 작업

PNG 6개 모두 존재하고 System.Drawing.Bitmap으로 읽혔다. Get-FileHash -Algorithm SHA256으로 각 raw 파일과 image_gen 원본을 비교해 6개 모두 동일함을 확인했다. 파일별 크기는 다음과 같다.

| 파일 | 해상도 | 바이트 |
| --- | --- | ---: |
| p1-tall-64.png | 1024 × 1536 | 1,138,219 |
| p2-tall-96.png | 1024 × 1536 | 1,200,284 |
| p3-mid-64.png | 1122 × 1402 | 947,509 |
| p4-mid-96.png | 1122 × 1402 | 1,060,914 |
| p5-small-48.png | 958 × 1642 | 967,468 |
| p6-best-guess.png | 958 × 1642 | 1,046,884 |

검증은 파일 존재/바이트 크기/실제 이미지 해상도/열기 확인이다. 코드 변경이 없으므로 pnpm 명령은 실행하지 않았다. README는 만들지 않았다. 본 task에서 새 의존성, 이미지 후처리, 외부 이미지 다운로드, 동작 프레임, 앱 변경은 없다.

남은 작업: coordinator의 배경·격자·팔레트 후처리와 130/160/190px 실제 표시 비교, 사용자 기준 이미지 선택. 이 문서는 선택을 위한 후보 평가이며 정확한 저해상도나 제한 색수 달성을 인증하지 않는다.

기여한 완료 기준 번호: 마일스톤 번호 해당 없음. 병행 아트 작업 ART-2A, 기획안 9장 캐릭터 기준 이미지 확정 자료. Task 자체 완료 조건은 원본 PNG 6장 + NOTES, 각 이미지 직접 열기 기록, 현재 worktree 브랜치 커밋이다.
