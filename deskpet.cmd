@echo off
rem deskpet 명령 래퍼. 이 폴더를 PATH 에 넣으면 어느 위치에서나 `deskpet event ...` 로 실행한다.
set "DP_CLI=%~dp0packages\cli\dist\index.js"
if not exist "%DP_CLI%" (
  echo DeskPet CLI 가 빌드되어 있지 않습니다. 저장소 폴더에서 `pnpm --filter @deskpet/cli build` 를 먼저 실행하세요. 1>&2
  exit /b 1
)
node "%DP_CLI%" %*
exit /b %ERRORLEVEL%
