; electron-builder NSIS include (ADR-0010 §6). 제거 때 setLoginItemSettings 가 쓴 Run 값을 지운다.
; 값 이름은 src/main/login-item.ts 의 LOGIN_ITEM_NAME 과 같아야 한다.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DeskPet"
!macroend
