# ART-3 픽셀 기준 이미지 2차 후보

2026-10-06. 내장 image_gen으로 생성한 기준 포즈 후보 5장이다. 동작 프레임은 만들지 않았다. raw 파일은 생성 PNG를 바이트 그대로 복사했으며 코드로 그리거나 가공하지 않았다. 모든 호출은 transparent_background=true였다.

## 먼저 직접 열어 본 기준 그림

- [a-pixel](../../2026-10-06/a-pixel.png): 가장 길고 성숙한 실루엣, 차분한 남색·회은색, 작은 푸른 눈과 입, 크게 흐르는 포니테일과 꼬리. 의상과 실루엣의 중심 기준.
- [p6-best-guess](../raw/p6-best-guess.png): 더 큰 얼굴과 푸른 눈, 긴 치마와 단순한 큰 색 덩어리. 얼굴 가독성과 긴 체형의 중간 기준.
- [p5-small-48](../raw/p5-small-48.png): 가장 큰 얼굴과 짧은 몸, 굵은 블록과 큰 눈. 소형 비율의 끝 기준.

세 파일 모두 view_image로 직접 열었고, ../NOTES.md의 1차 프롬프트를 읽었다. 이번 후보는 세 장 사이의 비율을 비교하기 위한 자료다. 등신 수는 머리카락 정수리부터 턱까지를 한 머리로 보고 귀를 제외해 육안으로 판단한 근삿값이며, 정확한 치수 인증은 아니다.

## 추천 순서

| 순위 | 후보 | 한 줄 평 |
| --- | --- | --- |
| 1 | q3-p6-refined | 큰 얼굴의 가독성과 긴 성인 실루엣의 균형이 좋다. |
| 2 | q2-between-a-p6 | 약 5등신의 단정한 긴 치마와 가장 차분한 눈·미소 조합이다. |
| 3 | q1-a-eyes | a-pixel 디자인을 가장 가깝게 유지하며 눈 가독성을 높였다. |
| 4 | q4-between-p6-p5 | 큰 얼굴과 긴 치마가 함께 남는 약 3.5등신 비교안이다. |
| 5 | q5-p5-refined | p5 비율에 차분한 회청색 눈을 더한 소형 비교안이다. |

원 디자인 보존을 최우선으로 선택한다면 q1, 얼굴 비중과 긴 성인 실루엣의 균형을 우선하면 q3을 권한다. q1과 q2의 비율 차이는 작다. q4와 q5는 큰 얼굴에 따른 장단점을 비교하기 위한 후보이며, 성인 캐릭터의 복장과 차분한 표정은 유지하되 체형의 장신 인상은 약해진다.

## 공통 검토 한계

최종 5개를 저장한 뒤 각각 view_image로 다시 직접 열었다. 한 명·전신·정면·발끝·필수 요소·글자와 소품 없음·읽히는 얼굴을 확인했다. 계단형 외곽과 큰 색 덩어리는 분명하다. 생성 원본에는 면 내부의 미세한 명도 변화, 일부 불균일한 도트 및 투명 경계 잔여 픽셀이 있어 정확한 96px·16색 완성 스프라이트는 아니다. 완전히 평평한 16색이나 무안티에일리어싱 달성을 인증하지 않는다. 후속 스크립트의 격자·팔레트 정리를 전제로 한 기준 이미지로 평가했다. 축소 미리보기나 이미지 후처리는 생성하지 않았고, 작은 앱 표시에서의 가독성은 아직 실측하지 않았다.

## q1-a-eyes

파일: [raw/q1-a-eyes.png](raw/q1-a-eyes.png)

직접 열어 본 판단 및 재시도: 재시도 없음. a-pixel의 가는 몸통, 긴 치마, 한쪽으로 크게 흐르는 포니테일과 꼬리, 손을 모은 자세를 가장 가깝게 유지했다. 5–6등신 목표 중 약 5등신 쪽 인상이며 눈의 푸른 면적이 원본보다 커졌다. 따뜻한 피부 위에 작은 갈색 입이 읽히고, 턱·흰 칼라·남색 리본이 분리된다. 전신 정면, 귀와 양쪽 신발 끝, 필수 의상과 늑대 요소 모두 확인했다. 큰 색 덩어리와 계단 외곽은 정리에 유리하나 머리 끝의 가는 갈래, 치마의 음영과 투명 경계 주변 미세 픽셀은 정리 대상이다. 원 디자인 보존을 우선할 때 가장 좋은 선택이다.

최종 입력 참조: a-pixel, p6 (이 순서).

생성 원본 파일명: exec-0b884b96-7a03-4011-ac87-ea5b2a780845.png.

최종 프롬프트 전문:

```text
Input images: image 1 a-pixel is the primary design/proportion/color reference; image 2 p6 is only the eye-size reference. q1-a-eyes: preserve a-pixel's tall 5-6-head adult body, long skirt silhouette, narrow torso, swept ponytail and tail, clothing and quiet gray/navy palette as closely as possible. Change principally the eyes: enlarge the blue eye clusters to the readable size relative to face in p6, while keeping restrained blue, not bright cyan. Do not enlarge the head or shorten the body. Keep a-pixel's calm small mouth clearly visible.
Use case: stylized-concept. Create ONE original pixel-art standing character reference, not animation frames. Reference images show the same original character; preserve her identity and simple silhouette. Exactly one adult silver-haired wolf maid, full body, STRICT FRONT VIEW, with both shoes, ear tips, entire ponytail and tail comfortably inside canvas. Silver-gray high ponytail tied with navy ribbon flowing broadly to viewer's right; upright wolf ears; one separate silver-gray fluffy wolf tail flowing to that same side below. White maid head frill, modest high-collar long-sleeved dark NAVY classic long maid dress, white cuffs and broad white apron, small navy neck ribbon, simple hands together at waist, dark shoes. Warm peach skin clearly distinct from cool silver hair. Readable BLUE eyes with restrained muted blue irises, never neon/cyan/glowing; separate small dark warm-brown pixel mouth ON THE FACE. Leave visible peach chin and white collar between mouth and neck bow; neck bow must not resemble a second mouth.
Coarse pixel art: approximately 96 logical pixel rows from ears to soles, enlarged identical square blocks, sharp hard staircase outline, roughly 16 FLAT colors, large simple color clusters, two silver shadow tones, two navy tones, one apron shadow. NO antialiasing, gradients, blurry edges, texture, dithering, individual hair strands, delicate frills or tiny fingers. Calm restrained palette and composed adult expression. Transparent background; if transparency cannot be provided use uniform pure white. No cast shadow, glow, scenery, props, letters, labels, borders or other figures. No sexualization.
```

## q2-between-a-p6

파일: [raw/q2-between-a-p6.png](raw/q2-between-a-p6.png)

직접 열어 본 판단 및 재시도: 재시도 없음. a-pixel 쪽에 가까우면서 얼굴이 조금 커진 약 5등신의 긴 성인 실루엣이다. q1과의 비율 차이는 작고, 눈의 단순한 청색 면과 미소가 더 차분하다. 긴 치마·흰 앞치마·회은색 머리와 꼬리가 세 기준 그림의 공통 방향을 지킨다. 눈과 작은 갈색 미소가 읽히고 목 리본이 입과 혼동되지 않는다. 전신 정면과 양쪽 발끝, 귀·포니테일·꼬리·프릴·리본을 확인했다. 앞치마의 넓은 면과 단순한 눈은 정리에 좋지만 입 곡선, 머리카락 끝, 프릴의 작은 계단과 미세 음영은 격자 정리가 필요하다.

최종 입력 참조: a-pixel, p6, p5 (이 순서).

생성 원본 파일명: exec-c2c57a1a-edfc-4caa-929a-f4d0479b5ac0.png.

최종 프롬프트 전문:

```text
Input images: image 1 a-pixel and image 2 p6 are equal silhouette/proportion references; image 3 p5 only supports identity. q2-between-a-p6: interpolate between a-pixel and p6, about FIVE heads tall excluding ears. Head slightly larger relative to body than a-pixel, smaller than p6. Preserve elegant mature impression, slender upright torso and long ankle-length A-line skirt. Use a-pixel's quiet navy/silver palette, p6-like readable blue eyes made less saturated. Simple broad ponytail and tail shapes.
Use case: stylized-concept. Create ONE original pixel-art standing character reference, not animation frames. Reference images show the same original character; preserve her identity and simple silhouette. Exactly one adult silver-haired wolf maid, full body, STRICT FRONT VIEW, with both shoes, ear tips, entire ponytail and tail comfortably inside canvas. Silver-gray high ponytail tied with navy ribbon flowing broadly to viewer's right; upright wolf ears; one separate silver-gray fluffy wolf tail flowing to that same side below. White maid head frill, modest high-collar long-sleeved dark NAVY classic long maid dress, white cuffs and broad white apron, small navy neck ribbon, simple hands together at waist, dark shoes. Warm peach skin clearly distinct from cool silver hair. Readable BLUE eyes with restrained muted blue irises, never neon/cyan/glowing; separate small dark warm-brown pixel mouth ON THE FACE. Leave visible peach chin and white collar between mouth and neck bow; neck bow must not resemble a second mouth.
Coarse pixel art: approximately 96 logical pixel rows from ears to soles, enlarged identical square blocks, sharp hard staircase outline, roughly 16 FLAT colors, large simple color clusters, two silver shadow tones, two navy tones, one apron shadow. NO antialiasing, gradients, blurry edges, texture, dithering, individual hair strands, delicate frills or tiny fingers. Calm restrained palette and composed adult expression. Transparent background; if transparency cannot be provided use uniform pure white. No cast shadow, glow, scenery, props, letters, labels, borders or other figures. No sexualization.
```

## q3-p6-refined

파일: [raw/q3-p6-refined.png](raw/q3-p6-refined.png)

직접 열어 본 판단 및 재시도: 재시도 없음. q2보다 얼굴 비중이 조금 커지고 긴 치마를 유지한 약 4–4.5등신 목표의 상단 쪽 후보다. p6의 큰 얼굴 방향에 a-pixel의 차분한 색과 성인 실루엣을 더했으며, p6 원본보다는 조금 더 길고 성숙해 보인다. 푸른 눈과 짧은 갈색 입은 각각 분명하고 피부와 머리색이 구분된다. 전신 정면, 양쪽 신발, 필수 요소가 모두 보이고 포니테일과 꼬리는 같은 쪽의 별도 덩어리다. 꼬리가 오른쪽 가장자리에 가까워 후속 정리 때 여백을 확인할 필요가 있다. 앞치마·치마의 큰 면은 유리하나 맞잡은 손, 포니테일 끝의 작은 갈래, 투명 경계 미세 픽셀은 정리가 필요하다. 얼굴 가독성과 어른스러운 긴 실루엣의 균형으로 1순위다.

최종 입력 참조: a-pixel, p6, p5 (이 순서).

생성 원본 파일명: exec-9be4a500-1363-4529-b162-7bd37c9fbf5c.png.

최종 프롬프트 전문:

```text
Input images: image 2 p6 is primary proportion/identity reference; image 1 a-pixel provides quiet colors and long skirt silhouette; image 3 p5 is secondary identity only. q3-p6-refined: keep p6's approximately 4-4.5-head proportions excluding ears and clearly readable large eyes. Refine toward a-pixel's muted gray-silver/navy palette, calm adult face and long clean skirt silhouette. Do not shrink to p5 proportions. Long skirt ends just above shoes. Simplify all hair and frills to broad coarse blocks.
Use case: stylized-concept. Create ONE original pixel-art standing character reference, not animation frames. Reference images show the same original character; preserve her identity and simple silhouette. Exactly one adult silver-haired wolf maid, full body, STRICT FRONT VIEW, with both shoes, ear tips, entire ponytail and tail comfortably inside canvas. Silver-gray high ponytail tied with navy ribbon flowing broadly to viewer's right; upright wolf ears; one separate silver-gray fluffy wolf tail flowing to that same side below. White maid head frill, modest high-collar long-sleeved dark NAVY classic long maid dress, white cuffs and broad white apron, small navy neck ribbon, simple hands together at waist, dark shoes. Warm peach skin clearly distinct from cool silver hair. Readable BLUE eyes with restrained muted blue irises, never neon/cyan/glowing; separate small dark warm-brown pixel mouth ON THE FACE. Leave visible peach chin and white collar between mouth and neck bow; neck bow must not resemble a second mouth.
Coarse pixel art: approximately 96 logical pixel rows from ears to soles, enlarged identical square blocks, sharp hard staircase outline, roughly 16 FLAT colors, large simple color clusters, two silver shadow tones, two navy tones, one apron shadow. NO antialiasing, gradients, blurry edges, texture, dithering, individual hair strands, delicate frills or tiny fingers. Calm restrained palette and composed adult expression. Transparent background; if transparency cannot be provided use uniform pure white. No cast shadow, glow, scenery, props, letters, labels, borders or other figures. No sexualization.
```

## q4-between-p6-p5

파일: [raw/q4-between-p6-p5.png](raw/q4-between-p6-p5.png)

직접 열어 본 판단 및 재시도: 1회 재시도. 첫 생성(exec-3d93d0e4-5aba-4c9c-b7ea-9d0dfc81a87b.png)은 몸이 길어 q3과 차이가 부족했다. a-pixel을 이미지 참조에서 빼고 p5를 첫 참조로 바꾸며 머리 29%, 턱 아래 2.5머리 길이, 짧은 몸통을 명시했다. 최종은 약 3.5등신 인상으로 큰 머리와 짧은 몸통이 분명하고, 긴 치마가 세로감을 남긴다. 색과 포니테일·꼬리의 큰 흐름은 기준 방향을 유지한다. 파란 눈과 갈색 미소가 잘 읽히며 흰 칼라가 목 리본을 얼굴에서 분리한다. 전신 정면과 발끝, 모든 필수 요소를 확인했다. 손과 프릴, 머리카락이 큰 블록으로 정리되어 q1–q3보다 격자 정리가 쉬울 것으로 본다. 미소의 비스듬한 끝과 면 안의 미세 음영은 남아 있으며, 키 큰 성인 인상은 q1–q3보다 약하다.

최종 입력 참조: p5, p6 (이 순서; 재시도에서 a-pixel 입력 제거).

생성 원본 파일명: exec-aa5dde10-477e-4b10-8e1b-97bbee999718.png.

최종 프롬프트 전문:

```text
Input images: image 1 p5 gives the LARGE head and simple chunky shapes; image 2 p6 gives only the slightly longer skirt. Make q4-between-p6-p5, a halfway proportion between these two. HEAD SIZE IS CRITICAL: from the top of hair excluding ears to bottom of chin is 29 percent of the height from top of hair to shoe sole; body BELOW CHIN is only 2.5 head-heights, total 3.5 heads. Large head, SHORT TORSO, long skirt relative to short torso. Do not produce a tall 4.5-5-head figure. Adult maid character in stylized proportions, poised and calm. Use muted gray-silver and navy, less saturated eyes than references. Flat broad color masses, no shaded texture. The entire tail must fit comfortably INSIDE the canvas with blank margin, never touch the edge.
Use case: stylized-concept. Create ONE original pixel-art standing character reference, not animation frames. Reference images show the same original character; preserve her identity and simple silhouette. Exactly one adult silver-haired wolf maid, full body, STRICT FRONT VIEW, with both shoes, ear tips, entire ponytail and tail comfortably inside canvas. Silver-gray high ponytail tied with navy ribbon flowing broadly to viewer's right; upright wolf ears; one separate silver-gray fluffy wolf tail flowing to that same side below. White maid head frill, modest high-collar long-sleeved dark NAVY classic long maid dress, white cuffs and broad white apron, small navy neck ribbon, simple hands together at waist, dark shoes. Warm peach skin clearly distinct from cool silver hair. Readable BLUE eyes with restrained muted blue irises, never neon/cyan/glowing; separate small dark warm-brown pixel mouth ON THE FACE. Leave visible peach chin and white collar between mouth and neck bow; neck bow must not resemble a second mouth.
Coarse pixel art: approximately 96 logical pixel rows from ears to soles, enlarged identical square blocks, sharp hard staircase outline, roughly 16 FLAT colors, large simple color clusters, two silver shadow tones, two navy tones, one apron shadow. NO antialiasing, gradients, blurry edges, texture, dithering, individual hair strands, delicate frills or tiny fingers. Calm restrained palette and composed adult expression. Transparent background; if transparency cannot be provided use uniform pure white. No cast shadow, glow, scenery, props, letters, labels, borders or other figures. No sexualization.
```

## q5-p5-refined

파일: [raw/q5-p5-refined.png](raw/q5-p5-refined.png)

직접 열어 본 판단 및 재시도: 1회 재시도. 첫 생성(exec-b7b606bd-e75a-4e01-8521-4645ae258235.png)은 큰 머리 비율은 맞았지만 눈이 선명한 왕청색이고 입이 열린 직사각형이었다. 그 결과를 편집 입력으로 사용해 저채도 steel blue 두 색, 짧은 닫힌 입, 평평한 색면과 오른쪽 여백을 요청했다. 최종은 큰 얼굴과 짧은 몸의 약 2.5–3등신 목표에 가장 가깝고, p5보다 치마가 조금 길게 읽힌다. 눈은 회청색으로 차분해졌고 입은 짧은 짙은 갈색 가로 블록이다. 입의 변화는 작지만 얼굴 위에서 분명히 읽히며 목 리본과 떨어져 있다. 전신 정면·발끝·귀·포니테일·꼬리·머리 프릴·남색 리본·긴 복장 모두 확인했다. 굵은 덩어리는 정리가 쉬운 편이며, 미세 음영과 경계 픽셀은 남아 있다. 가장 작은 체형 비교용으로 유용하나 키 큰 성인 인상은 가장 약하고 눈의 생동감도 q4보다 낮다.

최종 입력 참조: q5 첫 생성 exec-b7b606bd-e75a-4e01-8521-4645ae258235.png (편집 대상; 최초 생성은 p5 입력).

생성 원본 파일명: exec-e890aa9a-0700-43f1-9a01-0c578ed96b57.png.

최종 프롬프트 전문:

```text
EDIT the supplied original wolf maid reference. Preserve its big head, compact 2.5-3-head proportions, front-facing full body, slightly long skirt, all clothing and hair/tail shapes, transparent background and coarse hard pixel edges. Make ONLY these corrections: 1) Change saturated royal-blue eyes to calm low-saturation STEEL BLUE, medium #4E7093 and shadow #334C69, no cyan, bright electric blue or pale blue shine. Eyes remain large and clearly readable. 2) Replace the open dark rectangular mouth with a SHORT CLOSED warm-brown mouth line, about two coarse pixels wide and one pixel tall, with peach skin surrounding it. 3) Make silver hair and navy clothing flat opaque blocks with no smooth gradients, no highlights, no fine texture. 4) Leave a little more blank margin on the right around the entire tail and ponytail. Maintain all proportions; do not elongate body or shrink head. ONE figure only, no text or props.
Use case: stylized-concept. Create ONE original pixel-art standing character reference, not animation frames. Reference images show the same original character; preserve her identity and simple silhouette. Exactly one adult silver-haired wolf maid, full body, STRICT FRONT VIEW, with both shoes, ear tips, entire ponytail and tail comfortably inside canvas. Silver-gray high ponytail tied with navy ribbon flowing broadly to viewer's right; upright wolf ears; one separate silver-gray fluffy wolf tail flowing to that same side below. White maid head frill, modest high-collar long-sleeved dark NAVY classic long maid dress, white cuffs and broad white apron, small navy neck ribbon, simple hands together at waist, dark shoes. Warm peach skin clearly distinct from cool silver hair. Readable BLUE eyes with restrained muted blue irises, never neon/cyan/glowing; separate small dark warm-brown pixel mouth ON THE FACE. Leave visible peach chin and white collar between mouth and neck bow; neck bow must not resemble a second mouth.
Coarse pixel art: approximately 96 logical pixel rows from ears to soles, enlarged identical square blocks, sharp hard staircase outline, roughly 16 FLAT colors, large simple color clusters, two silver shadow tones, two navy tones, one apron shadow. NO antialiasing, gradients, blurry edges, texture, dithering, individual hair strands, delicate frills or tiny fingers. Calm restrained palette and composed adult expression. Transparent background; if transparency cannot be provided use uniform pure white. No cast shadow, glow, scenery, props, letters, labels, borders or other figures. No sexualization.
```

## 검증과 남은 작업

Get-ChildItem으로 PNG 5장의 존재와 바이트 크기를 확인하고, System.Drawing.Bitmap.FromFile로 모두 정상 디코딩되는지와 해상도를 확인했다. 모두 Format32bppArgb이며 좌상단 픽셀 알파는 0이다. 각 raw 파일과 image_gen 원본의 SHA256을 Get-FileHash로 비교해 5개 모두 일치했다. 읽기만 했으며 이미지를 다시 저장하거나 변환하지 않았다.

| 파일 | 해상도 | 바이트 |
| --- | --- | ---: |
| q1-a-eyes.png | 1254 × 1254 | 616,709 |
| q2-between-a-p6.png | 972 × 1618 | 823,237 |
| q3-p6-refined.png | 958 × 1642 | 854,820 |
| q4-between-p6-p5.png | 958 × 1642 | 801,031 |
| q5-p5-refined.png | 958 × 1642 | 881,806 |

코드 변경이 없어 task 지시대로 pnpm 명령은 실행하지 않았다. 저장소 변경 범위는 docs/art/concepts/2026-10-06-pixel/round2/의 PNG 5개와 이 NOTES.md뿐이다. image_gen 자체의 기본 생성 캐시에서 원본을 복사했고, 외부 이미지 다운로드·다른 이미지 서비스·새 의존성·앱 수정·main 병합·push는 하지 않았다.

남은 작업: 사용자 기준 이미지 선택, 별도 스크립트의 높이 96px·16색 정리와 실제 표시 비교. 이는 이번 원본 후보 제작의 후속 작업이다.

기여한 완료 기준 번호: 마일스톤 번호 해당 없음. ART-3 병행 아트 작업, 기획안 9장 캐릭터 기준 이미지 확정 자료. Task 자체 완료 조건 1(PNG 5장 및 NOTES), 2(각 PNG 직접 열기와 판단 기록), 3(현재 art-pixel-round2 브랜치 커밋)에 기여한다.
