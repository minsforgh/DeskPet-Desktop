# DeskPet 설치 안내

Windows 10/11 64비트용 설치 파일(`DeskPet-Setup-0.1.0.exe`)을 받는 사람이 읽는 안내입니다. 관리자 권한은 필요 없고, 현재 사용자 계정에만 설치됩니다(`%LOCALAPPDATA%\Programs\DeskPet`).

DeskPet 은 가칭입니다. 이름은 바뀔 수 있어도 사용자 데이터 폴더(`%APPDATA%\deskpet`)는 그대로 유지됩니다.

## 1. 파일이 맞는지 확인하기 (SHA-256)

설치 파일과 같이 받은 `SHA256SUMS.txt` 의 값과 내려받은 파일의 해시가 같은지 확인합니다. PowerShell 에서:

```powershell
Get-FileHash .\DeskPet-Setup-0.1.0.exe -Algorithm SHA256
```

출력의 `Hash` 가 `SHA256SUMS.txt` 의 해당 줄 앞쪽 값과 (대소문자 무시하고) 같아야 합니다. 다르면 설치하지 말고 파일을 보낸 사람에게 다시 받으세요.

## 2. SmartScreen 경고

설치 파일에는 코드 서명이 없습니다(서명 인증서를 아직 사서 쓰지 않아서입니다). 그래서 인터넷에서 받은 파일을 처음 실행하면 Windows 가 다음 화면을 보여 줍니다.

> **Windows의 PC 보호**
> Microsoft Defender SmartScreen이 인식할 수 없는 앱의 시작을 차단했습니다.

게시자도 "알 수 없는 게시자"로 표시됩니다. 위 1번의 해시가 맞는 것을 확인했다면:

1. **추가 정보** 를 누릅니다.
2. 나타나는 **실행** 버튼을 누릅니다.

설치는 폴더를 고르는 화면 없이 바로 진행되고, 끝나면 DeskPet 이 자동으로 실행됩니다.

## 3. Smart App Control 이 켜져 있는 PC

Windows 11 의 **스마트 앱 컨트롤**이 **켜짐**이면 서명되지 않은 프로그램을 아예 막고, SmartScreen 처럼 "실행"으로 넘어가는 방법이 없습니다. 새로 설치한 Windows 11 에서 기본으로 켜져 있을 수 있습니다.

설치 전에 확인하세요: **Windows 보안 → 앱 및 브라우저 컨트롤 → 스마트 앱 컨트롤 설정**.

- **끔** 또는 **평가 중**: 위 2번대로 설치할 수 있습니다.
- **켜짐**: 설치가 막힙니다. 한 번 끄면 다시 켜려면 Windows 를 초기화해야 하므로, 이 PC 에서 꼭 써야 하는지 먼저 판단하세요. 막힌 PC 는 서명 도입 여부를 정한 뒤에 설치하는 것이 안전합니다.

## 4. Claude Code·Codex 연결에는 Node.js 가 필요합니다

에이전트가 끝났을 때 알려 주는 hook 스크립트와 CLI 는 `node` 로 실행됩니다. PowerShell 에서 `node --version` 이 버전을 출력하는지 확인하세요. 

```text
node : 'node' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.
```

이런 메시지가 나오면 Node.js 22 이상을 설치하거나(<https://nodejs.org>) 이 연결 기능을 쓰지 않으면 됩니다. DeskPet 자체와 다른 플러그인은 Node.js 없이 동작합니다.

설치본의 hook 스크립트는 설치 폴더 아래 `resources\hooks\` 에 있습니다. 설정 예는 [`docs/hooks/claude-code.md`](./hooks/claude-code.md) 를 보세요.

## 5. Slack 알림 설정

Slack 메시지를 DeskPet 알림으로 받으려면 Slack 앱을 만들고 앱 토큰과 사용자 토큰을 설정해야 합니다. 필요한 권한과 DeskPet 설정 순서는 [Slack 연결 안내](./slack-setup.md)를 보세요.

## 6. Orca 알림

Orca 가 설치돼 있으면 DeskPet 이 진행 중인 작업을 알려 줍니다. 확인이 필요한 게이트는 알림의 버튼으로 승인할 수 있습니다. Orca 가 없으면 상태 배지에 "확인 불가"가 표시됩니다.

## 7. 제거

Windows 설정 → 앱 → 설치된 앱에서 DeskPet 을 제거합니다. 사용자 데이터(`%APPDATA%\deskpet`: 설정, 로그, 권한 허용 기록)는 지워지지 않습니다. 완전히 지우려면 그 폴더를 직접 삭제하세요.
