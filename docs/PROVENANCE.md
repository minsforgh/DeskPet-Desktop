# 외부 프로젝트와 출처

## Jungle Bell

[Jungle Bell](https://github.com/YangSiJun528/jungle-bell)의 LMS 출석 확인 사용 방식을 참고했습니다.

비공개 개발 이력에서 한때 로직을 TypeScript로 포팅했고 당시 Apache-2.0 전문과 NOTICE를 함께 두었습니다. 이후 그 변경을 되돌리고 직접 설계하는 방향으로 전환했습니다(결정 D-026). 이 공개 사본은 변경을 되돌린 뒤의 현재 파일에서 만들었으며 과거 포팅 커밋과 `phase.ts`·`phase.test.ts`는 포함하지 않습니다.

과거 출처를 지우는 대신 [당시 라이선스 전문](../third-party/jungle-bell/LICENSE-Apache-2.0.txt)과 [고지](../third-party/jungle-bell/NOTICE)를 함께 보존했습니다. 비교한 범위와 결과는 [검증 상태](VALIDATION.md)에 기록합니다. 사용 방식 참고와 과거 포팅·되돌림을 구분해 설명합니다.

LMS 연동은 사용자가 로그인한 세션으로 상태를 조회합니다. 서비스 운영 주체가 승인하거나 공식 지원하는 앱이라는 뜻은 아닙니다. 일반 시연에는 LMS 로그인이나 계정 공유가 필요하지 않습니다.

## 기타 참고 프로젝트

Orca는 worktree·멀티 에이전트 실행 기반으로 사용했습니다. OpenPets 등 설계 참고 자료의 기존 목록은 [기획안](plan.md)에 남겼습니다. 참고 사실이 그 프로젝트의 코드·에셋을 포함한다는 뜻은 아닙니다.

사용한 npm 의존성은 `package.json`과 `pnpm-lock.yaml`에 고정되어 있습니다. 이 안내가 각 의존성 라이선스를 대체하지 않습니다. 설치본 배포 전에는 생성된 번들의 제3자 고지도 함께 확인해야 합니다.

## 캐릭터 아트

제작자가 AI로 생성하고 직접 수정한 아트입니다. 생성·편집 역할은 [CREDITS](../characters/wolf-maid/CREDITS.md)와 `docs/art/`에 기록합니다. 코드·에셋의 별도 재사용 라이선스는 아직 선택하지 않았습니다.
