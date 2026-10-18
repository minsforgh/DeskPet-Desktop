# 실행과 짧은 시연

## 소스에서 실행

Windows 10/11 x64, Node.js 22 이상, `package.json`의 pnpm 버전을 준비하고 루트에서 실행합니다.

```powershell
pnpm install --frozen-lockfile
pnpm exec electron --version
.\start-deskpet.cmd
```

스크립트는 호스트·CLI·앱을 빌드하고 wolf-maid 팩으로 시작합니다. `pnpm desktop:start`의 기본 팩은 placeholder이며 wolf-maid는 위 스크립트 또는 `--character=wolf-maid`로 선택합니다. 트레이에서 종료할 수 있습니다.

`electron --version`에서 바이너리가 없으면 설치된 패키지가 다운로드를 시도합니다. 첫 실행에 네트워크가 필요할 수 있으며 실패하면 오류를 먼저 확인하세요. 외부 연동 없이 표시·드래그·상호작용·설정을 시연할 수 있습니다.

## 2–3분 시연 순서

| 순서 | 보일 것 | 설명 |
|---|---|---|
| 1 | 기본 펫·드래그·상호작용 | 실험의 실제 산출물 |
| 2 | 트레이 설정 화면 | 캐릭터·플러그인·알림 설정 |
| 3 | 로컬 이벤트 말풍선 | 계정 없이 앱의 알림 결과 확인 |
| 4 | README·실패 사례·기준선 | 작업 방식과 검증 개선 설명 |

앱 실행 중 다른 PowerShell에서 루트의 CLI를 호출합니다.

```powershell
pnpm deskpet event --text "오케스트레이션 시연: 작업 결과를 확인해 주세요" --mood happy
```

이는 수동 로컬 이벤트이며 실제 worker 완료나 Orca 게이트 감지를 재현한 것으로 설명하면 안 됩니다. 실제 연동 시연은 자신의 Orca 환경·에이전트 hook을 설정한 뒤 진행합니다. LMS·Slack은 선택 기능이며 시연용 계정·토큰을 저장소에 넣지 않습니다.

## 설치 파일

```powershell
pnpm package
pnpm package:check
```

`release/`에 exe와 SHA256SUMS가 만들어집니다. `package:check`는 별도 점검용 앱을 임시 설치·실행·제거합니다. [이번 검증 상태](VALIDATION.md)와 [설치 안내](install.md)를 함께 참고하세요.

설치본에는 코드 서명이 없어 PC 보안 정책에 따라 막힐 수 있습니다. 평가자에게 보안 기능 해제를 요구하기보다는 녹화·스크린샷이나 개발 환경 시연을 제공합니다. exe와 SHA-256 파일은 [Preview Release](https://github.com/minsforgh/DeskPet-Desktop/releases/tag/v0.1.0-preview.1)에서 받을 수 있습니다.
