# 체커 창 Electron 프로토타입

저장소 루트에서 한 줄로 실행합니다(기존 의존성을 `pnpm install --offline --frozen-lockfile`로 설치한 상태):

```powershell
pnpm exec electron tools/checker-prototype/probe.mjs
```

Electron 44.5.1에서 `127.0.0.1`의 임의 포트 두 개만 열고, 별도 임시 `userData`와 persist 파티션을 사용합니다. 실제 사이트에 접속하지 않습니다. JSON 관찰 결과를 출력하고 핵심 결과가 달라지면 실패 코드로 종료합니다. 20초 `AbortController` 시험 때문에 전체 실행은 약 30초 걸립니다. 임시 데이터는 종료 시 삭제합니다. 비밀번호 저장 제안 UI는 숨김 창과 자동 실행만으로 판별할 수 없어 확인 대상에서 제외했습니다.
