@echo off
rem Double-click to build and launch DeskPet. The console window closes once the pet is up.
chcp 65001 >nul
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm 을 찾을 수 없습니다. Node.js 와 pnpm 설치를 확인하세요.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo 처음 실행이라 의존성을 설치합니다...
  call pnpm install
  if errorlevel 1 (
    echo 설치에 실패했습니다.
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron 실행 파일을 찾을 수 없습니다. pnpm install 결과를 확인하세요.
  pause
  exit /b 1
)

echo DeskPet 을 빌드합니다...
call pnpm --silent build:host && call pnpm --silent --filter @deskpet/cli build && call pnpm --silent --filter @deskpet/desktop build
if errorlevel 1 (
  echo 빌드에 실패했습니다. 위 오류를 확인하세요.
  pause
  exit /b 1
)

rem Launch detached so closing this window does not close the pet.
rem --dev-control=default keeps pnpm desktop:screenshot / desktop:event working.
start "" "node_modules\electron\dist\electron.exe" "apps\desktop" --dev-control=default --character=wolf-maid %*
exit /b 0
