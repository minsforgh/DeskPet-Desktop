# ADR 0010: 패키징과 배포

## 상태

승인 (2026-10-10, D-059), 구현 완료 (M9, 2026-10-12). 구현 결과로 확인한 추측과 바뀐 점은 끝의 "구현에서 확정·변경된 점"에 있다. 끝의 "사용자에게 물을 질문" 9개는 모두 추천안으로 정했다(사용자 결정). "추측"으로 표시한 항목은 2단계 첫 실험에서 확인하고 결과를 이 문서에 덧붙인다. 이 ADR 은 설계만 정하고 코드·`package.json`·`pnpm-lock.yaml` 은 바꾸지 않는다. 구현은 2단계(기준 3–7)가 이 문서를 따른다.

표기: "코드 확인"은 이 초안을 쓰며 저장소 파일을 직접 읽어 확인한 것이다(경로·줄 번호를 적는다). "관찰"은 이 PC 에서 읽기 전용으로 본 사실이다. "추측"은 확인하지 못한 것이고, 2단계의 첫 실험(기준 3 task)에서 확인한다. 줄 번호는 main `1c8ed0d` 기준이다.

## 배경

DeskPet 은 Electron 44.5.1 + electron-vite 5.0.0, pnpm 모노레포, Windows 전용(D-003)이다. 지금은 `start-deskpet.cmd` 가 저장소에서 빌드해 `node_modules\electron\dist\electron.exe apps\desktop --dev-control=default --character=wolf-maid` 를 띄운다(코드 확인: `start-deskpet.cmd` 끝줄). 설치 파일, Windows 시작 시 자동 실행, 처리되지 않은 오류의 기록이 없다. 마일스톤 목표는 "개발 환경 없이 설치 파일로 깔면 Windows 가 켜질 때 펫이 함께 뜨고, 문제가 생기면 기록이 남는다"이다.

코드에는 설치본을 염두에 둔 흔적이 이미 있다. `app.isPackaged` 가 개발 제어 통로·테스트 전용 명령·`--user-data-dir`·개발자 모드를 막고(`apps/desktop/src/main/index.ts:52,60,1805`, `pack-service.ts:131`), 플러그인 폴더는 설치본에서 `process.resourcesPath/plugins` 를 가리킨다(`index.ts:64–65`). 그러나 설치본을 실제로 만들어 본 적이 없어서 아래 3·5장의 구멍이 남아 있다. 이 ADR 은 그 구멍과 선택지를 정리한다.

범위 밖(D-058, `milestones.md` M9): 자동 업데이트, 코드 서명, 외부 오류 수집 전송, macOS·Linux, `slack`·`discord`, 플러그인 외부 배포.

## 요약

| 장 | 항목 | 추천 | 기준 |
|---|---|---|---|
| 1 | 패키저·설치 형식 | electron-builder `26.15.3` + NSIS, 사용자별 one-click, 관리자 권한 없음 | 3 |
| 2 | 설치·데이터 위치 | 설치 `%LOCALAPPDATA%\Programs\DeskPet`, 데이터 `%APPDATA%\deskpet`(지금과 같음), 제거해도 데이터 유지 | 4 |
| 3 | 리소스 배치 | 캐릭터 팩·플러그인·hook 스크립트는 `resources/` 의 asar 밖, 앱 코드는 asar. PowerShell 스크립트는 코드 안 문자열이라 따로 둘 파일이 없음. 플러그인은 번들이 필요 | 3 |
| 4 | 설치본 플러그인 | claude-code, codex, jungle, reminders. orca·slack·discord 는 뼈대라 제외 | 3 |
| 5 | 개발 통로 차단 | 인자 해석을 한 함수로 모으고 설치본에서는 개발 인자를 전부 무시. 자동 확인은 단위 테스트 + 설치본 실행 점검 | 5 |
| 6 | 자동 시작 | `app.setLoginItemSettings`, 설치본 첫 실행에서 한 번 켬(질문 2), 설정 [일반] 토글 | 6 |
| 7 | 오류 기록 | `logs/errors.log` 새 파일, 512 KiB × 4개, 기존 마스킹 재사용, `crashReporter` 끔 | 7 |
| 8 | SmartScreen·이름 | `docs/install.md` 안내, productName `DeskPet`, appId `com.deskpet.app`, 버전 `0.1.0` | 3 |
| 9 | 설치본 점검의 안전 | 점검용 별도 appId + 임시 설치 경로 + 별도 userData + 실제 레지스트리·데이터 전후 비교 | 4 |
| 10 | 2단계 task 분해 | 5개 task, 파일 겹침 순서 지정 | 3–7 |

## 결정

### 1. 패키저와 설치 형식 [기준 3]

| 안 | 장점 | 단점 |
|---|---|---|
| **electron-builder + NSIS 사용자별(추천)** | 사용자별 설치(`perMachine: false`)가 기본이라 관리자 권한이 필요 없다. 설치 폴더 지정 `/D=`, 조용한 설치 `/S`, 제거 시 사용자 데이터 유지(`deleteAppDataOnUninstall` 기본 `false`)가 옵션이다(electron-builder 문서의 `NsisOptions`). 기준 4 의 조용한 설치·제거 점검에 그대로 맞는다. 사용 예가 가장 많다 | 새 devDependency 하나. NSIS 템플릿의 세부 동작(제거 시 레지스트리 정리)은 직접 확인해야 한다 |
| electron-builder NSIS assisted(마법사) | 설치 폴더를 사용자가 고른다 | 마법사 화면이 늘고 점검 스크립트가 복잡하다. 이점이 이 앱에는 작다 |
| electron-forge (Squirrel.Windows / WiX MSI) | Electron 공식 도구 | Squirrel 은 자동 업데이트 전제의 구조로 이 마일스톤 범위 밖 기능에 맞춰져 있고, MSI 는 설정이 무겁다. 조용한 설치 점검은 가능하지만 얻는 것이 없다 |
| 압축 파일(portable) | 가장 단순 | 제거·자동 시작·시작 메뉴가 없다. 기준 4·6 과 맞지 않는다 |

**추천:** electron-builder NSIS, `oneClick: true`, `perMachine: false`(사용자별), `requestedExecutionLevel: asInvoker`(기본), `allowElevation` 은 건드리지 않는다. one-click 은 폴더를 고르는 화면이 없지만 `/D=` 는 one-click 에서도 동작한다(electron-builder `multiUser.nsh` 의 `GetDParameter`, 문서에서 확인). 설치 뒤 바로 실행(`runAfterFinish` 기본 `true`)은 기준 8 의 흐름과 맞다.

**새 devDependency(설치하지 않음):** 루트 `package.json` 의 `devDependencies` 에 `electron-builder` `26.15.3` 정확한 버전으로 넣는다(기존 `electron` 44.5.1, `electron-vite` 5.0.0 이 정확한 버전이라 같은 방식). 근거: 2026-10-10 `npm view electron-builder` 가 `latest` = 26.15.3 을 돌려주었다(관찰). 같은 조회에서 `v26` 태그가 26.17.0 이었다. `latest` 태그가 더 낮은 이유는 확인하지 못했다(추측: 후속 패치가 아직 `latest` 로 안 올라갔다). 2단계에서 설치할 때 두 버전을 다시 조회해 `latest` 를 쓰고, 다르면 사용자에게 알린다. Electron 44 와의 호환은 electron-builder 가 Electron 버전을 `electron` 패키지에서 읽으므로 별도 설정이 없다고 본다(추측, 기준 3 첫 빌드에서 확인). 네이티브 모듈이 없어 `@electron/rebuild` 는 필요 없다(코드 확인: 세 `package.json` 의 의존성은 모두 `@deskpet/*` 워크스페이스 패키지).

설정 위치: `apps/desktop/electron-builder.config.mjs`(파일로 둬서 `--config.appId=…` 로 점검용 값을 덮어쓸 수 있게 한다, 9장). `pnpm package` 는 루트 스크립트로 `build:host` → CLI 빌드 → 데스크톱 빌드 → 플러그인 번들(3장) → `electron-builder --win nsis --publish never` → 내용 확인 스크립트 순서를 부른다(기존 `desktop:start` 가 같은 앞부분을 쓴다: 루트 `package.json`). 결과물은 `release/` 에 두고 `.gitignore` 에 추가한다(지금은 `node_modules/ dist/ out/ *.tsbuildinfo` 만 있다: `.gitignore`).

**주의(코드 확인):** `apps/desktop/package.json` 의 `dependencies` 가 `workspace:*` 3개다. electron-builder 가 이것을 `node_modules` 로 수집하려 들면 워크스페이스 링크 때문에 실패하거나 소스 전체를 넣는다. 그런데 `electron.vite.config.ts` 의 `externalizeDeps.exclude` 가 세 패키지를 main 번들에 이미 합치므로 런타임 의존성이 없다. 그래서 세 항목을 `devDependencies` 로 옮기고 `files: ["out/**", "package.json"]` 만 넣는다. 이 옮김은 `apps/desktop/package.json` 수정이라 기준 3 task 에서 한다.

### 2. 설치 위치와 사용자 데이터 위치 [기준 4]

**설치 위치:** NSIS 사용자별 기본값 `%LOCALAPPDATA%\Programs\DeskPet\`(electron-builder 기본, 추측: 기준 3 에서 실제 경로 확인). 읽기 전용으로 두고 앱은 이 폴더에 쓰지 않는다(아래 표에서 확인).

**지금 앱이 쓰는 곳(코드 확인)**. 앱 이름을 `app.setName("deskpet")` 으로 고정하므로(`index.ts:49`) userData 는 `%APPDATA%\deskpet` 이다. 이 PC 에서도 그 폴더가 있다(관찰: `~/AppData/Roaming/deskpet`, 같은 PC 에 `Electron` 폴더도 있지만 앱은 쓰지 않는다). `productName` 을 무엇으로 정해도 userData 이름은 이 줄이 정한다(추측: `setName` 이 기본 userData 경로를 바꾸는지 Electron 문서로는 확정하지 못했다. 관찰된 경로가 `deskpet` 이므로 지금은 맞다. 설치본에서 `app.getPath("userData")` 를 기준 3 의 첫 실험으로 확인한다).

| 파일·폴더 (userData 아래) | 내용 | 코드 |
|---|---|---|
| `settings.json`, `settings.json.bak` | 방해 금지, 캐릭터, 행동 수치, 플러그인 설정, 개발자 모드 | `index.ts:67`, `settings.ts` |
| `pet-position.json` | 발 위치와 모니터 | `index.ts:66` |
| `event-server.json` | 이벤트 서버 포트·토큰·pid(`mode 0o600`) | `event-server.ts:8,48–52` |
| `plugin-grants.json` | 플러그인 권한 허용 기록 | `packages/plugin-host/src/grants.ts:94` |
| `plugin-secrets.json` | 플러그인 secret(`safeStorage` 로 암호화) | `packages/plugin-host/src/secrets-store.ts:32`, `index.ts` 의 `safeStorage` 전달 |
| `characters/` | 사용자 팩(만든 것·가져온 것) | `index.ts:907,1625` |
| `logs/deskpet.log` (+ `.1`–`.3`) | 앱·플러그인 호스트 로그 | `index.ts:1656`, `log-file.ts` |
| `Partitions/deskpet-plugin-*` | 체커 창(jungle)의 로그인 세션 | `checker-windows.ts:49` |
| `lockfile`, `Cache` 등 | Chromium 이 쓰는 것 | 관찰 |

설치 폴더에는 아무것도 쓰지 않는다. 내장 팩 쓰기는 개발자 모드에서만이고 설치본에서는 항상 막힌다(`pack-service.ts:131`, `index.ts:1703–1705`).

**설치본과 개발 실행이 같은 userData 를 공유해도 되는가.**

- **데이터는 공유하는 것이 맞다(추천).** 같은 사람이 개발 실행에서 쓰던 설정·팩·권한 허용·secret 을 설치본이 이어받는 것이 기준 8 의 사용자 경험이다. 형식도 같은 코드가 읽는다.
- **동시에 켜면 안 된다.** 세 가지가 부딪힌다.
  1. **단일 인스턴스 잠금**은 userData 범위다(`index.ts:57–58` 주석 "scoped to userData"). 둘째 인스턴스는 `app.exit(0)` 으로 조용히 끝난다. `second-instance` 처리가 없다(코드 확인: `second-instance` 검색 결과 없음). 설치본이 로그인 때 자동 시작된 뒤 개발 실행을 켜면 개발 실행이 아무 표시 없이 사라진다. 반대도 마찬가지다.
  2. **이벤트 포트**는 7777 이 기본이다(`index.ts:50–51`). 잠금 때문에 보통 둘째가 서버까지 가지 못하지만, userData 를 분리한 e2e 는 `--event-port=` 로 포트를 따로 준다.
  3. **토큰 파일** `event-server.json` 은 pid 로 주인을 가린다(`event-server.ts:61–66`). 한 userData 에 한 인스턴스일 때만 의미가 있다.
- **다른 userData 로 격리하는 길은 개발·테스트에서만 있다.** 지금 `--user-data-dir` 는 `!app.isPackaged` 일 때만 쓴다(`index.ts:52`). e2e 는 이것으로 격리한다.

**추천:** 데이터는 공유하고, 동시에 켤 때의 침묵 종료만 고친다. 둘째 인스턴스가 `second-instance` 로 첫 인스턴스에 알려 펫을 보이게 하고(숨겨 둔 상태면 보이게), 개발 실행에서는 stderr 에 이유를 남긴다. 이 변경은 `index.ts` 한 곳이다(10장 task A). 설치본 점검(기준 4)은 userData 를 격리해야 하므로 설치본에서도 쓸 수 있는 격리 수단이 필요하다. 이것은 9장에서 정한다.

**제거 시 사용자 데이터 유지(기준 4):** `nsis.deleteAppDataOnUninstall: false`(기본값이지만 명시한다)이고, 추가로 NSIS 가 `%APPDATA%\deskpet` 를 건드리지 않는다는 것을 점검 스크립트가 확인한다. electron-builder 문서는 이 옵션을 one-click 에만 적용되는 것으로 쓴다("one-click installer only"). 우리는 one-click 이므로 맞다. 제거 때 지워지는 것은 설치 폴더, 바로가기, 제거 정보 레지스트리, 그리고 자동 시작 항목이다(6장).

### 3. 리소스 배치 [기준 3]

지금 코드가 각 자원을 찾는 방식과, 설치본에서 바꿀 곳을 모았다.

| 자원 | 지금 찾는 방식(코드 확인) | 설치본에서 | 바꿀 곳 |
|---|---|---|---|
| 내장 캐릭터 팩 `characters/` | `--characters-dir=` 인자 ?? `resolve(app.getAppPath(), "../../characters")` (`index.ts:72–73`). `--characters-dir` 은 설치본에서도 먹는다(`isPackaged` 검사 없음). 설치본의 `getAppPath()` 는 `resources/app.asar` 이므로 `../../characters` 는 설치 폴더 바로 아래를 가리켜 틀린다 | `extraResources` 로 `resources/characters/` (asar 밖). 읽기 전용이고 폴더로 읽는다(`pack-store.ts` 가 폴더·`manifest.json`·시트 PNG 를 `fs` 로 읽는다) | `index.ts:72–73` 를 `app.isPackaged ? join(process.resourcesPath, "characters") : …` 로. `--characters-dir` 은 설치본에서 무시(5장) |
| 플러그인 `plugins/*/manifest.json` + `dist` | `--plugins-dir=` ?? `isPackaged ? join(process.resourcesPath, "plugins") : resolve(appPath, "../../plugins")` (`index.ts:63–65`). 이미 설치본 경로를 가정한다. 단 `--plugins-dir` 은 설치본에서도 먹는다 | `extraResources` 로 `resources/plugins/<id>/{manifest.json,dist/index.js}` | 경로는 그대로. `--plugins-dir` 만 설치본에서 무시(5장). **번들이 필요하다(아래)** |
| 플러그인 entry (utilityProcess) | `UtilityPluginChannel` 이 `utilityProcess.fork(join(__dirname, "plugin-runner.js"), …)` (`index.ts:1666`, `utility-channel.ts`). 러너가 받은 `entry` 를 `import(pathToFileURL(entryPath).href)` 한다(`apps/desktop/src/plugin-runner/index.ts:48`). `resolvePluginEntry` 가 폴더 안·링크 없음·`.js/.mjs/.cjs` 를 검사한다(`packages/plugin-host/src/entry-path.ts`) | 러너는 앱 코드와 같이 asar 안 `out/main/plugin-runner.js`. entry 는 asar 밖의 실제 파일 | 아래 "asar 안에서 utilityProcess" 확인 |
| PowerShell 감시 스크립트 (전체 화면·지형) | **별도 `.ps1` 파일이 없다.** 스크립트가 TS 안 문자열 상수다: `FULLSCREEN_WATCHER_SCRIPT`(`fullscreen-watcher.ts:11`), `TERRAIN_WATCHER_SCRIPT`(`terrain-watcher.ts:7`). `powershell.exe -NoProfile -NonInteractive -EncodedCommand` 로 넘긴다(`fullscreen-watcher.ts:185`, `terrain-watcher.ts:255–258`) | main 번들(`out/main/index.js`)에 문자열로 들어간다. asar 안이든 밖이든 파일을 읽지 않으므로 문제가 없다 | 없음. 기준 3 의 "감시 스크립트가 들어 있는지" 확인은 번들에서 두 상수의 시작 줄(`SHQueryUserNotificationState`, 지형 스크립트의 고유 식별 문자열)을 찾는 것으로 한다 |
| 렌더러·프리로드 | `join(__dirname, "../renderer/index.html")`, `"../preload/index.cjs"` 등 (`index.ts:1103,1120,1653–1654,1785–1786`) | asar 안. `BrowserWindow.loadFile` 은 asar 경로를 읽는다 | 없음 |
| hook 스크립트·CLI | `docs/hooks/*.mjs`(저장소). `send-claude-code-event.mjs:129` 가 CLI 를 `process.env.DESKPET_CLI ?? resolve(<이 파일>, "../../packages/cli/dist/index.js")` 로 찾는다. `deskpet.cmd` 는 `packages\cli\dist\index.js` 를 가정한다 | 4장 | 4장 |

**asar 밖에 둘 것(기준 1 의 질문에 대한 답):** 캐릭터 팩, 플러그인, hook 스크립트는 `extraResources`(asar 밖)로 둔다. 이유: ① 플러그인 `entry` 를 `lstat`·`realpath` 로 따라가며 링크를 거부하는 검사(`entry-path.ts`)는 실제 파일시스템을 전제로 쓰였고, asar 안의 가상 경로에서 같은 결과가 나온다는 확인이 없다(추측). ② 팩 편집·플러그인 교체가 사용자 데이터 쪽이 아니라 내장 쪽에서도 일어날 수 있으므로 파일 그대로가 단순하다. 앱 코드(`out/**`)는 asar 에 둔다.

**asar 안에서 utilityProcess 가 도는지(추측, 기준 3 첫 실험):** 러너 `plugin-runner.js` 는 `app.asar` 안이다. `utilityProcess.fork` 가 asar 안 경로의 스크립트를 실행하는지 이 초안에서는 확인하지 못했다(추측: Electron 의 asar 지원은 일반 Node 프로세스에서 켜져 있고 utility 프로세스도 같다고 알고 있지만 검증하지 않았다). 실험: 빌드한 `win-unpacked` 에서 플러그인 하나가 `running` 이 되는지 `/status` 로 본다. 실패하면 대안 순서: ① `asarUnpack: ["out/main/plugin-runner.js"]` 와 러너가 import 하는 청크, ② `asar: false`. 앱이 작아(렌더러 위주, 의존성 없음) `asar: false` 의 손해는 작다. 기준 3 task 가 판정하고 이 ADR 의 변경 이력에 적는다.

**플러그인은 번들해야 한다(코드 확인, 중요).** 플러그인 소스는 `import { definePlugin } from "@deskpet/plugin-sdk"` 로 런타임 import 를 한다(`plugins/claude-code/src/index.ts:1`, `codex`, `jungle`, `reminders` 모두). `tsc` 빌드는 이 bare import 를 그대로 둔다(`plugins/*/tsconfig.build.json`). 개발에서는 저장소 `node_modules` 의 워크스페이스 링크로 풀리지만, `resources/plugins/claude-code/dist/index.js` 위쪽에는 `node_modules` 가 없다. 그대로 넣으면 설치본의 모든 플러그인이 import 에서 실패한다. 해결: 패키징 단계에서 플러그인마다 `@deskpet/plugin-sdk`·`@deskpet/core` 를 합친 단일 `dist/index.js` 를 만든다. 도구는 이미 있는 `vite`(`^7.3.6`, 루트 devDependency)의 라이브러리 빌드(ESM, 외부 없음, `node:` 내장만 외부)를 쓴다. 새 의존성을 늘리지 않는 안이다. 대안은 `esbuild` 를 직접 devDependency 로 추가하는 것(더 빠르고 설정이 짧지만 의존성 하나 추가). 번들 결과는 `manifest.json` 과 같은 폴더에 `dist/index.js` 하나로 나와야 `entry` 검사를 통과한다. 이 번들은 `plugins/*/dist` 를 덮어쓰지 않고 `release/` 임시 폴더에 만들어 `extraResources` 가 거기서 가져간다.

**main 번들의 외부 의존성(코드 확인):** `electron.vite.config.ts` 의 `externalizeDeps.exclude` 가 `@deskpet/plugin-host`, `@deskpet/plugin-sdk`, `@deskpet/core` 를 main 에 합친다. 그래서 설치본의 `out/main/index.js`·`plugin-runner.js` 는 `node_modules` 가 필요 없다. 이것을 기준 3 의 확인 스크립트가 검사한다(번들에 `@deskpet/` bare import 가 남지 않았는지).

**기준 3 의 확인 스크립트가 볼 것:** 설치본 `resources/` 에 `characters/{placeholder,placeholder-alt,wolf-maid}/manifest.json`(`mochi` 는 `.gitkeep` 만 있는 빈 폴더라 제외: `git ls-files characters`), `plugins/<4개>/manifest.json`·`dist/index.js`, `hooks/*.mjs`, `cli/index.js` 가 있고, `out/main/index.js` 에 PowerShell 상수 두 개가 있다.

**PowerShell 관련 위험(추측):** 이 PC 는 Windows 11 Enterprise 라 `Add-Type`(P/Invoke 컴파일)이 제한된 언어 모드나 AppLocker 에서 막힐 수 있다. 두 감시기는 실패해도 앱이 살도록 만들어져 있다(`fullscreen-watcher.ts` 의 재시작 1회 뒤 포기, ADR-0009). 설치본에서 자동 확인할 방법은 없고 기준 8(H)에서 사람이 본다. 또 `spawn("powershell.exe", …)` 는 PATH 로 찾는다(`fullscreen-watcher.ts:97`, `terrain-watcher.ts:170`). 설치본에서 절대 경로(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`)로 고정하면 PATH 앞쪽의 가짜 실행 파일을 막는다. 같은 PC 사용자가 PATH 를 쓸 수 있는 환경이면 의미가 있는 작은 강화이고 이번 범위에서는 선택이다.

### 4. 설치본에 넣을 플러그인 [기준 3]

| 플러그인 | 현재 상태(코드 확인) | 제안 |
|---|---|---|
| `claude-code` | `manifest.json` 있음. `src/index.ts` 54줄에 반응 규칙 2개(`happy`·`worried`), 설정 `enabled`. 테스트 있음(`index.test.ts`, `hook.test.ts`). 권한 없음 | **넣는다** |
| `codex` | `manifest.json` 있음. 54줄, claude-code 와 같은 구조(출처만 `codex`). 테스트 있음. 권한 없음 | **넣는다** |
| `jungle` | `manifest.json` 있음(network 2개, windows `lms-checker`, secrets·shell 없음). `src` 2,313줄(테스트 포함), 읽기 전용 출석 확인, 테스트 많음(`no-write-requests.test.ts` 가 쓰기 요청이 없음을 검사). M5 에서 완료 | **넣는다**(질문 3). 첫 실행에서 권한 허용 대화상자를 거치므로 허용하지 않으면 동작하지 않는다 |
| `reminders` | `manifest.json` 있음. `src/index.ts` 94줄 + `schedule.ts` 103줄, 테스트 있음. 권한 없음. 기본 팩의 알림 반응에 쓰임(M6) | **넣는다** |
| `orca` | `manifest.json` 없음. `src/index.ts` 가 `export {};` 한 줄(뼈대) | 넣지 않는다 |
| `slack` | `manifest.json` 없음. 뼈대 한 줄. 범위 밖(D-058) | 넣지 않는다 |
| `discord` | `manifest.json` 없음. 뼈대 한 줄. 범위 밖(D-058) | 넣지 않는다 |

포함 기준은 "`manifest.json` 이 있고 `validatePluginManifest` 를 통과한다"이다. 이 규칙이면 뼈대 폴더는 자동으로 빠진다. 기준 3 의 확인 스크립트는 결과 목록이 정확히 위 4개인지 검사해서, 나중에 뼈대가 `manifest.json` 만 먼저 생겨 섞여 들어가는 것을 막는다. `discover.ts` 는 `manifest.json` 이 없는 폴더를 `invalid` 로 표시하므로(`plugins/orca` 처럼) 뼈대를 넣으면 설정 창에 오류 항목이 보인다. 이것도 제외하는 이유다.

**hooks 스크립트(`docs/hooks/`)를 설치본에서 어떻게 쓰게 하나(코드 확인):** hook 은 Claude Code·Codex 쪽 설정이 부르는 외부 프로그램이다. 현재 안내는 `node C:\Users\me\deskpet\docs\hooks\send-claude-code-event.mjs` 를 `settings.json` 에 적는 것이다(`docs/hooks/claude-code.md:92–114`). 이 스크립트는 `process.execPath`(= Node)로 CLI(`packages/cli/dist/index.js`)를 부르고(`send-claude-code-event.mjs:133`), CLI 는 `%APPDATA%\deskpet\event-server.json` 의 포트·토큰을 읽는다(`packages/cli/src/index.ts:41–50`, userData 경로가 4장 위의 표와 같은 `deskpet`).

설치본에서는 다음을 `resources/` 에 둔다.

- `resources/hooks/`: `send-claude-code-event.mjs`, `hook-message.mjs`, `codex-notify-wrapper.mjs`(`docs/hooks/` 에서 복사, 원본은 옮기지 않는다).
- `resources/cli/index.js`: CLI 단일 파일 번들(플러그인과 같은 방식, `@deskpet/core` 포함).
- 스크립트의 CLI 기본 경로를 `../cli/index.js`(`resources/hooks` 기준)로 찾도록 바꾼다. 저장소 실행의 `../../packages/cli/dist/index.js` 도 남겨 두 곳을 차례로 본다. `DESKPET_CLI` 환경 변수는 그대로 우선한다.
- `docs/hooks/claude-code.md` 에 설치본용 경로 예(`%LOCALAPPDATA%\Programs\DeskPet\resources\hooks\…`)를 더한다(문서 변경은 기준 3 task 의 일부).

**Node 필요 여부(질문 4):** hook 스크립트와 CLI 는 `node` 로 돈다. 사용자 PC 에 Node 가 있다는 전제는 Claude Code·Codex 를 쓰는 개발자에게는 흔하지만 보장되지 않는다(추측: Claude Code 가 단독 설치 프로그램으로 설치되면 Node 가 없을 수 있다). 대안은 설치된 `DeskPet.exe` 를 `ELECTRON_RUN_AS_NODE=1` 로 Node 처럼 실행하는 것인데, hook 명령줄에 환경 변수를 넣어야 해서 셸 따라 문법이 달라지고 Electron 퓨즈(`runAsNode`)를 켜 둬야 해서 보안 쪽 설정과 부딪힌다. 추천은 1단계 설치본에서는 Node 를 필요조건으로 안내하는 것이다. PATH 에 `node` 가 없을 때의 오류 메시지를 `docs/install.md` 에 적는다.

### 5. 개발 제어 통로와 개발 전용 인자가 설치본에서 막히는 방식 [기준 5]

**지금 막는 방식(코드 확인):**

| 항목 | 현재 조건 | 위치 |
|---|---|---|
| 개발 제어 통로(named pipe `\\.\pipe\deskpet-dev-<이름>`) 열기 | `!app.isPackaged && controlName !== undefined` + 이름 검사 | `index.ts:1805–1808` (`startControl` 은 `index.ts:1506`) |
| `devControlActive` (테스트 전용 명령 전부, 권한 대화상자 자동 응답, 플러그인 시계 고정, 지형 시험 입력, 펫 메뉴 시험 호출) | `!app.isPackaged && controlName !== undefined && 이름 정규식` | `index.ts:60`; 사용처 `:61,:62,:153,:1353,:1357,:1388,:1636,:1666,:1668,:1682,:1787` |
| `--user-data-dir` | 위 조건 + `userDataDir` 가 있을 때만 `app.setPath` | `index.ts:52–56` |
| `--plugin-clock=` | `pluginClockArgs(argv, devControlActive)` 가 `devControlActive` 아니면 빈 목록 | `plugin-clock-args.ts` |
| `--terrain-source=`, `--terrain-windows=` | `devControlActive` 일 때만 | `index.ts:61,166–167` |
| 개발자 모드(내장 팩 직접 쓰기) | `app.isPackaged` 이면 `available: false`, 저장 거부 | `index.ts:1703–1705`, `pack-service.ts:131` |
| 모든 개발 제어 명령 | 통로가 열릴 때만 닿음 | `runCommand` |

기준 5 의 "개발 제어 통로와 개발 전용 인자가 동작하지 않는다"에서 **구멍 4개**가 있다(코드 확인).

1. `--plugins-dir=` 는 `isPackaged` 와 무관하게 `pluginsDirArg` 가 `pluginsDir` 를 덮어쓴다(`index.ts:63–65`). 설치본에서 다른 폴더의 플러그인을 로드시킬 수 있다.
2. `--characters-dir=` 도 마찬가지다(`index.ts:72–73`).
3. `--character=` 는 팩 id 선택이라 위험은 작지만 개발용 인자다(`index.ts:74`).
4. `--event-port=` 는 포트만 바꾼다(`index.ts:50–51`). 위험은 작고 9장의 점검에 필요하다.

그 밖의 인자 해석이 `index.ts` 와 `plugin-clock-args.ts` 로 흩어져 있어 새 인자가 생기면 `isPackaged` 검사를 빠뜨리기 쉽다(위 1·2 가 그 사례다).

**제안:**

- `apps/desktop/src/main/launch-args.ts`(새 파일)에 `parseLaunchArgs(argv, { isPackaged, env })` 를 만들어 `process.argv` 해석을 모두 여기로 모은다. 반환값에 `devControl`, `userDataDir`, `pluginsDir`, `charactersDir`, `characterId`, `eventPort`, `terrainSource`, `terrainWindows`, `permissionAnswer`, `pluginClock` 이 있고, `isPackaged` 이면 `devControl`·`userDataDir`·`pluginsDir`·`charactersDir`·`terrainSource`·`terrainWindows`·`permissionAnswer`·`pluginClock` 을 항상 `undefined` 로 만든다. `characterId`·`eventPort` 는 설치본에서도 허용한다(질문 7).
- `index.ts` 의 다른 곳에서 `process.argv` 를 직접 읽지 않는다. `plugin-clock-args.ts` 는 이 함수로 흡수한다.

**막혔음을 자동으로 확인하는 방법:**

1. **단위 테스트 (A)**: `launch-args.test.ts` 가 `isPackaged: true` 로 모든 개발 인자를 넣고 허용 목록(`characterId`, `eventPort`) 외에는 전부 `undefined` 임을 검사한다. 그리고 `index.ts` 소스에서 `process.argv` 가 `launch-args.ts` 밖에 없다는 것을 검사하는 테스트를 둔다(`log-mask`처럼 소스 문자열을 읽는 기존 패턴이 있는지는 확인하지 못했다. 새로 짜도 되는 짧은 테스트다).
2. **설치본 실행 점검 (A, 기준 4 의 스크립트에 포함)**: 조용히 설치한 앱을 개발 인자와 함께 실행한다.
   `DeskPet.exe --dev-control=check --user-data-dir=<빈 임시 폴더 B> --plugins-dir=<가짜 플러그인 폴더> --characters-dir=<가짜 팩 폴더> --event-port=0` (userData 격리는 9장의 수단으로 따로 한다)
   확인 항목: ① `\\.\pipe\deskpet-dev-check` 에 연결할 수 없다(`net.connect` 가 `ENOENT`). ② 임시 폴더 B 가 비어 있다. ③ `/status` 의 `plugins` 가 번들된 4개이고 가짜 폴더의 플러그인이 없다. ④ 가짜 팩이 목록에 없다. 개발 통로가 열렸다면 ① 에서 연결되고, 인자가 먹었다면 ②–④ 에서 드러난다.
3. **리뷰 (R)**: `CLAUDE.md` 의 확인 필요 영역에 해당하므로(`apps/desktop/src/main/event-server` 외에도 개발 제어 변경은 M9 게이트: `milestones.md` M9 "게이트") 머지 전 gate 승인이 있다.

**관련 추측:** Chromium 은 `--user-data-dir` 스위치를 앱 코드와 상관없이 처리할 수 있다. 그렇다면 `isPackaged` 일 때 우리가 무시해도 Chromium 이 직접 userData 를 바꿀 수 있다(추측, 확인하지 못함). 위 점검 ②가 이것을 실제로 드러낸다. 막혀야 한다면 `app.setPath("userData", …)` 를 우리가 명시적으로 고정하는 방식으로 대응한다(기준 5 task 에서 판정).

### 6. 자동 시작 [기준 6]

| 안 | 장점 | 단점 |
|---|---|---|
| **`app.setLoginItemSettings({ openAtLogin })` (추천)** | 코드 한 줄로 켜고 끈다. 설정 창 토글이 곧바로 시스템 로그인 항목(레지스트리 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`)에 반영된다. `app.getLoginItemSettings()` 로 읽어 토글 표시를 항상 실제 값에서 가져온다. 관리자 권한이 필요 없다 | 설치 경로가 바뀌면 값이 낡는다. 제거 때 자동으로 지워지지 않는다(아래) |
| NSIS 가 설치 때 Run 키를 씀 | 첫 실행 전에도 적용 | 앱 토글과 이중 관리가 된다. 토글이 설치 때의 값과 어긋난다 |
| 시작 프로그램 폴더 바로가기 | 사용자가 보인다 | 토글 구현이 파일 조작이라 오류 처리가 늘어난다 |

**추천:** `setLoginItemSettings`. 값 이름은 명시한다(`name: "DeskPet"`, 추측: Electron 이 Windows 에서 기본으로 쓰는 값 이름이 실행 파일 이름인지 앱 이름인지 문서로 확정하지 못했다. 명시하면 제거 때 지울 이름을 알 수 있다). `args` 는 두지 않는다(자동 시작이라는 이유로 인자를 달리하면 동작이 둘로 갈린다).

**설치 제거와의 관계:** NSIS 제거는 `setLoginItemSettings` 가 쓴 Run 값을 모른다. 그대로 두면 제거한 앱을 가리키는 시작 항목이 남는다. `build/installer.nsh` 의 `customUnInstall` 매크로로 `DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DeskPet"` 를 한다(추측: electron-builder 의 NSIS 템플릿이 `customUnInstall` 확장 지점을 제공한다는 것은 알고 있지만 이 버전에서 확인하지 못했다). 점검 스크립트(9장)가 제거 뒤 Run 값이 없음을 확인한다. 점검용 appId 는 값 이름도 달라야 한다(9장).

**기본값(질문 2):** 마일스톤 데모가 "설치 → 재부팅 → 자동 시작"이고 기준 8 이 "재부팅하면 펫이 자동으로 뜬다"이므로, 설치 직후 사용자가 아무것도 하지 않아도 뜨려면 기본이 켬이어야 한다. 반대로 시스템 시작 항목을 사용자 모르게 추가하는 것은 거부감이 크다. **추천: 설치본의 첫 실행에서 한 번 켜고(`settings.json` 에 `launchAtLogin` 키가 없을 때만), 그 결과를 `launchAtLogin: true` 로 기록해 이후에는 사용자의 토글만 따른다.** 첫 실행 말풍선으로 "Windows 시작 시 자동 실행을 켰어요. 설정 [일반]에서 끌 수 있어요" 를 한 번 보여 준다. 사용자가 끈 뒤 앱을 다시 켜도 다시 켜지 않는다(키가 있으므로).

**제한:**

- 개발 실행(`!app.isPackaged`)에서는 토글을 보이지 않거나 비활성으로 두고, `setLoginItemSettings` 를 호출하지 않는다. 호출하면 `electron.exe` 경로가 사용자의 시작 항목에 들어간다. 이 패턴은 개발자 모드 토글(`DeveloperModeView.available`, `settings-service.ts:12–14`)과 같다.
- 첫 실행 자동 켬도 "userData 가 기본 위치일 때만" 한다. 9장의 점검 실행(별도 userData)이 실제 사용자의 시작 항목을 건드리지 않게 하는 안전장치다.

**설정 [일반] 탭 연결(코드 확인):** [일반] 탭은 `settings.html:12,18`(`#tab-general`, `<section id="general">`)이고, 값은 `settings-service.ts` 의 `GeneralSettings`(`{ enabled, schedule }`, 방해 금지)와 `DeveloperModeView` 가 `SettingsView` 로 묶여(`settings-service.ts:14`) 렌더러 `renderer/settings.ts` 에 간다. 같은 모양으로 `launchAtLogin: { available: boolean; enabled: boolean }` 을 `SettingsView` 에 더하고, 백엔드에 `launchAtLogin()`(읽기: `app.getLoginItemSettings().openAtLogin`)과 `saveLaunchAtLogin(payload)`(쓰기)를 둔다. 렌더러 값은 main 에서 다시 검증한다(기존 `saveDeveloperMode` 와 같은 규칙). `settings.json` 에는 `launchAtLogin?: boolean` 만 저장(첫 실행 표시 용도)하고, 켜져 있는지의 진실은 시스템 항목에서 읽는다. 사용자가 작업 관리자의 시작 앱에서 껐을 때도 토글이 실제를 보여 주기 위해서다.

**자동 확인(A):** 백엔드에 `setLoginItem(openAtLogin)`/`getLoginItem()` 함수를 주입하는 구조로 만들어(기존 `createSettingsService` 의 `backend` 주입 방식, `settings-service.test.ts:573` 참고) 단위 테스트가 가짜로 값을 확인한다. e2e 는 개발 실행에서 토글이 숨겨짐을 확인한다. 실제 레지스트리는 설치본 점검(기준 4 확장)이나 기준 8(H)에서만 본다. 테스트가 사용자의 시작 항목을 건드리면 안 된다.

### 7. 오류 기록 [기준 7]

**지금 있는 것(코드 확인):**

- `logs/deskpet.log`: `createLogFile({ dir })` (`log-file.ts`). 한 줄 `ISO시각 LEVEL 메시지`, 줄당 2,048 바이트 상한, `maxBytes` 1 MiB 에서 회전, 보관 3개(`deskpet.1.log`–`deskpet.3.log`, 총 4 MiB 상한). 마스킹은 `maskPluginLog`(`log-mask.ts`): `Authorization`·`Cookie`·`Set-Cookie` 헤더 줄, `Bearer …` 토큰, 쿼리의 `token|key|secret|password|code=` 값, 그리고 인자로 받은 secret 값 문자열. `createLogFile` 은 secret 집합을 비워서(`new Set()`) 부르므로 값 자체의 마스킹은 하지 않는다.
- 만드는 시점: 펫 창과 말풍선 창을 만든 뒤(`index.ts:1656–1657`)다. 그 앞에서 난 오류는 기록되지 않는다. 쓰는 곳: 지형 로그(`terrainLogger`), 체커 창(`CheckerWindows(logger)`), 플러그인 호스트(`createPluginHostApp({ logger })`, 플러그인 stdout/stderr 를 `info`/`warn` 으로: `plugin-host-app.ts:214`).
- 폴더 열기: 트레이와 펫 우클릭 메뉴에 "로그 폴더 열기"가 이미 있다(`tray.ts:77`, `pet-menu.ts:240`, 동작은 `index.ts:1802`).
- **없는 것:** `uncaughtException`/`unhandledRejection` 처리, `app.on("render-process-gone")`·`child-process-gone` 처리, `crashReporter`(검색 결과 없음). 창별 `render-process-gone` 는 있지만 기록은 하지 않고 상태만 되돌린다(`index.ts:1112`, `bubble-window.ts:52`, `settings-window.ts:133`, `checker-windows.ts:113`). 이 PC 의 userData 에 `Crashpad` 폴더가 없다(관찰). 즉 크래시 덤프는 지금 만들어지지 않는다.

**제안:**

| 항목 | 결정 |
|---|---|
| 위치 | `%APPDATA%\deskpet\logs\errors.log` (+ `errors.1.log`–`errors.3.log`). `deskpet.log` 와 같은 `logs/` 폴더이므로 기존 폴더 열기 동작을 그대로 쓴다 |
| 파일을 분리하는 이유 | `deskpet.log` 는 정보·경고를 많이 쓰고 1 MiB 에서 회전해 오류가 금방 밀려난다. 오류 파일이 따로 있으면 사용자가 보내 줄 때 "이 파일 하나"라고 말할 수 있다 |
| 만드는 시점 | `main/index.ts` 맨 위, `app.setPath("userData")` 직후(`index.ts:52–56` 뒤)에 만들어 잠금 요청과 창 생성보다 먼저 연다 |
| 형식 | 텍스트 한 줄 한 레코드, 기존과 같은 `ISO시각 LEVEL 분류 메시지`. 줄바꿈은 `\n` 으로 이스케이프(기존 `maskPluginLog` 방식). 분류: `main:uncaughtException`, `main:unhandledRejection`, `renderer:error`, `renderer:gone`, `child:gone`, `plugin:exit`. 필드 예: `plugin:exit id=jungle code=1 stderr="…"`. JSON 줄을 쓰지 않는 이유: 사용자가 메모장으로 열어 읽는 파일이고, 기존 로그와 같은 형식이 한 번 익히면 된다 |
| 줄 크기 | 8 KiB(스택을 담기 위해 기존 2 KiB 보다 크게). 넘으면 끝을 자른다 |
| 크기·회전 | 파일당 512 KiB, 보관 3개 → 총 최대 2 MiB. 기존 회전 코드(`rotate()`)를 재사용하려고 `createLogFile` 에 `fileName`, `maxLineBytes` 옵션을 더한다 |
| 폭주 방지 | 같은 분류+메시지가 60초 안에 반복되면 첫 줄만 쓰고 이후는 횟수를 세어 다음 다른 줄이나 60초 뒤에 `(×N 반복)` 한 줄로 남긴다. 전체 분당 60줄 상한. 오류가 오류를 낳는 것(렌더러 콘솔 오류 폭주)을 막는다 |
| 쓰기 실패 | 기존처럼 한 번 경고하고 계속 간다(`log-file.ts` 의 `warned`). 오류 기록이 앱을 죽이면 안 된다 |
| 외부 전송 | 없다. 어떤 네트워크 호출도 추가하지 않는다 |

**무엇을 잡나:**

1. **main**: `process.on("uncaughtException")`, `process.on("unhandledRejection")`. 핸들러를 달면 Electron 이 보여 주던 "JavaScript error occurred in the main process" 대화상자가 사라진다(추측: Electron 의 기본 동작으로 알고 있으나 44 에서 확인하지 못했다). 기록 뒤 **계속 실행**한다(질문 8: 펫이 죽는 것보다 계속 있는 편이 낫지만, 상태가 불확실할 수 있다). 같은 분류가 1분에 5번 넘으면 `quitApp()` 을 부른다.
2. **렌더러 프로세스**: `app.on("render-process-gone", (_e, webContents, details))`(모든 창). 기존 창별 핸들러는 그대로 두고 기록만 더한다. 필드: 창 종류(펫·말풍선·설정·체커), `details.reason`, `details.exitCode`.
3. **렌더러의 처리되지 않은 JS 오류**: 새 IPC 채널을 만들지 않고 `webContents.on("console-message")` 에서 오류 수준(error)만 기록한다. 이유: 렌더러가 main 에 쓰는 새 채널은 공격면이라(펫 창은 외부에 가까운 입력인 팩 데이터를 그린다) 만들지 않는 편이 낫다. 실제 `console-message` 이벤트의 인자 형태는 Electron 44 에서 확인하지 못했다(추측: 최근 버전에서 이벤트 객체 하나로 바뀌었다고 기억한다). 기준 7 task 가 확인한다. 파일 URL 에서 로컬 경로 접두를 가려서 쓴다.
4. **자식 프로세스**: `app.on("child-process-gone", (_e, details))` (GPU·Utility·네트워크 서비스 등). `details.type`, `details.name`(utilityProcess 는 `serviceName` 으로 `plugin-<id>` 를 줌: `index.ts:1666`), `reason`, `exitCode` 를 쓴다.
5. **플러그인 프로세스**: 비정상 종료는 `UtilityPluginChannel` 의 `onExit(code)` (`utility-channel.ts:35–38`)와 4번의 `child-process-gone` 둘로 들어온다. `code !== 0` 이거나 `reason` 이 `clean-exit` 이 아니면 `plugin:exit` 로 기록하고 마지막 stderr 20줄(마스킹)을 붙인다. 정상 종료(`shutdown`)는 기록하지 않는다. 플러그인 호스트의 오류 3회 정책(ADR-0005)과 겹치는 부분은 호스트가 이미 `logger.error` 로 `deskpet.log` 에 남기며, `errors.log` 에는 프로세스가 비정상으로 끝난 사실만 쓴다.

**토큰·secret 가림 규칙:** 모든 레코드는 쓰기 직전에 다음을 지나간다.

1. 기존 `maskPluginLog` 규칙 전부: 인증 헤더 줄, `Bearer`, 쿼리 비밀 값(`log-mask.ts`).
2. **새 규칙** 64자 16진수 문자열 → `***` (이벤트 서버 토큰은 64자 16진수: `event-server.ts:37–38`).
3. **새 규칙** 사용자 홈 경로 접두(`%USERPROFILE%` 의 실제 값, 대소문자 무시)를 `~` 로 바꿈. 사용자 이름이 파일을 보내는 순간 새어 나가는 것을 줄인다.
4. 플러그인 secret 값: 호스트가 아는 값(`secrets-store` 에 저장된 값)은 호스트가 이미 `maskPluginLog(…, secrets)` 로 가려 로그에 전달한다(`plugin-bridge.ts` 의 `formatPluginOutput`). 오류 기록의 플러그인 stderr 도 같은 경로를 지나게 해서 secret 목록을 쓴다.
5. 줄 크기 상한과 줄바꿈 이스케이프.

마스킹은 파일에 쓰기 직전의 마지막 관문이다. 오류 메시지에 값이 섞일 수 있는 곳(스택, URL, 플러그인 stderr)이 모두 이 관문을 지난다는 것은 단위 테스트 입력(토큰, 헤더, 쿼리 비밀, 홈 경로, 64자 16진수)과 기대 출력으로 확인한다. 기존 규칙에는 "허용·거부 예시 테스트를 함께 둔다"는 AGENTS.md 규칙이 적용된다.

**`crashReporter` (로컬 전용 여부):** Electron 의 `crashReporter` 는 `uploadToServer: false` 로 두면 외부로 보내지 않고 `app.getPath("crashDumps")` 에 미니덤프를 쓴다(추측: `submitURL` 이 업로드 끔일 때 필수인지는 44 문서로 확인하지 못했다). **추천은 시작하지 않는 것이다**(질문 6). 이유: 미니덤프는 프로세스 메모리 일부를 담아서 토큰·secret 이 들어갈 수 있고 마스킹할 방법이 없다. 이 PC 에는 지금도 `Crashpad` 폴더가 없다(관찰). 네이티브 충돌의 원인 파악은 `child-process-gone` 의 `reason`·`exitCode` 로 우선 대응하고, 부족하면 개발자 모드에서만 켜는 것을 후속으로 검토한다.

**트레이 항목:** 새 항목을 하나 더 만들지 않고 기존 "로그 폴더 열기"(`tray.ts:77`, `pet-menu.ts:240`)의 이름을 "오류 기록 폴더 열기"로 바꾼다(질문 5). 같은 폴더(`logs/`)를 열기 때문이다. 이름을 바꾸면 이 문자열을 확인하는 파일을 함께 고친다: `pet-menu.test.ts`, `apps/desktop/e2e/pet-menu.e2e.test.ts`, `apps/desktop/e2e/plugin-host.e2e.test.ts`, `docs/plan.md`. 두 항목을 따로 두는 안은 같은 폴더를 두 메뉴가 여는 중복이라 추천하지 않는다.

**자동 확인(A):** ① 단위: 형식, 크기 상한, 회전, 마스킹, 반복 접기. ② e2e(개발 제어 `…ForTest` 명령 추가): main 에서 예외를 던지게 하는 명령, 플러그인 프로세스를 강제로 죽이는 명령(기존 `runPluginForTest`·플러그인 e2e 의 방식 참고)으로 `errors.log` 에 줄이 생기고 토큰 모양 문자열이 `***` 임을 확인. 새 테스트 전용 명령은 `devControlActive` 아래에 둔다(5장). ③ 트레이 메뉴 항목 클릭이 `logs/` 를 연다.

### 8. 미서명 설치 파일, 이름·버전 표기 [기준 3]

**SmartScreen:** 코드 서명이 없으므로(D-058 범위 밖) 설치 파일을 처음 실행하면 Windows 가 "Windows의 PC 보호 — Microsoft Defender SmartScreen 이 인식할 수 없는 앱의 시작을 차단했습니다"를 보여 주고, 게시자는 "알 수 없는 게시자"로 나온다. 인터넷에서 받은 파일(Mark-of-the-Web)일 때 그렇다. 사용자는 "추가 정보" → "실행" 으로 계속한다.

- `docs/install.md`(새 문서, 기준 3 task 의 일부)에 한국어로 단계(화면 문구 포함), 파일의 SHA-256 해시를 확인하는 방법, "게시자 알 수 없음은 서명 인증서를 아직 사서 쓰지 않아서"라는 사실을 적는다. 질문 9 는 이 문서 위치다.
- 빌드 결과에 SHA-256 을 `release/SHA256SUMS.txt` 로 같이 만든다(스크립트가 한 줄 추가).
- **Smart App Control 위험(추측):** Windows 11 의 Smart App Control 이 "켜짐(강제)" 상태이면 서명되지 않은 실행 파일을 막고 사용자 우회 방법이 없다는 것으로 알고 있다(확인하지 못했다). 새로 설치한 PC 에서 이 모드가 기본으로 켜질 수 있어서, 기준 8(깨끗한 PC 설치)에서 막힐 수 있다. 대응: 기준 8 을 하기 전에 그 PC 의 설정(Windows 보안 → 앱 및 브라우저 컨트롤 → 스마트 앱 컨트롤)을 먼저 확인해 달라고 `docs/install.md` 에 적고, 켜져 있어 막히면 사용자가 서명 도입을 앞당길지 결정한다. 자체 서명 인증서는 SmartScreen 경고도, Smart App Control 도 해결하지 못한다(추측).
- 설치 파일 크기: Electron 런타임 때문에 대략 100 MB 안팎(추측, 측정 전).

**이름 표기(D-001: DeskPet 은 가칭):**

| 항목 | 값 | 이유 |
|---|---|---|
| `productName` | `DeskPet` | 시작 메뉴·앱 목록에 보이는 이름. 바꾸기 쉽다 |
| `appId` | `com.deskpet.app` | 설치 정보 레지스트리 키와 Windows 의 앱 식별(AUMID)의 기준이다. **나중에 바꾸면 새 앱으로 취급된다**(업그레이드가 아니라 나란히 설치). 이름이 바뀌어도 appId 는 중립적인 이 값으로 유지한다. 도메인이 없으므로 가짜 역도메인임을 안다 |
| `executableName` | `DeskPet` | `DeskPet.exe` |
| 설치 파일 이름 | `DeskPet-Setup-${version}.exe` (`artifactName`) | 버전이 이름에 보인다 |
| userData 이름 | `deskpet` (코드 고정: `index.ts:49`) | 이름이 바뀌어도 데이터 폴더는 유지된다. 이름을 바꾸는 날 이 줄과 CLI(`packages/cli/src/index.ts:44`) 와 문서를 함께 정한다 |
| 버전 | `0.1.0` (`apps/desktop/package.json` 한 곳) | 지금 모든 `package.json` 이 `0.0.0` 이다. 앱 버전은 `app.getVersion()` 으로 `/status` 에 나간다(`index.ts:1808`). 한 곳에서 정하면 설치 파일 이름과 `/status` 가 같다. 서명이 없고 자동 업데이트도 없으니 `0.x` 로 시작한다 |
| 게시자 표기 | 서명 없음. NSIS 의 `publisherName` 은 지정하지 않음 | 서명 없는 설치본에 게시자 이름을 쓰면 오해를 줄 수 있다. 질문 8 에 포함 |

가칭이 확정되는 날(D-001) 바꿀 곳 목록은 `productName`, `executableName`, 시작 항목 값 이름(6장), `docs/install.md`, 바로가기 이름이다. appId·userData 이름은 건드리지 않는다.

### 9. 설치본 점검 스크립트를 이 PC 에서 안전하게 돌리는 방법 [기준 4]

이 PC 에서는 지금 개발 실행이 돌고 있고(관찰: userData 의 `lockfile`·`event-server.json` 이 오늘 10:33) 실제 사용자 데이터(`%APPDATA%\deskpet\settings.json` 등)가 있다. 점검 스크립트가 이것을 건드리지 않는 것이 요구 조건이다. 위험은 네 가지다.

| 위험 | 막는 방법 |
|---|---|
| 같은 `appId` 면 NSIS 가 실제 설치를 같은 제품으로 보고 덮어쓰거나 제거할 수 있다(`/D=` 로 다른 폴더를 줘도 레지스트리의 같은 제거 키를 읽는다. 추측: electron-builder NSIS 는 같은 GUID 의 기존 설치를 찾아 먼저 제거하는 동작이 있다고 알고 있으나 확인하지 못했다) | 점검 전용 설치 파일을 따로 빌드한다. `--config.appId=com.deskpet.app.check --config.productName=DeskPetCheck` 로 appId·이름을 바꿔, 레지스트리 키·바로가기·AUMID 가 모두 다르게 한다. 바로가기는 만들지 않는다(`--config.nsis.createDesktopShortcut=false --config.nsis.createStartMenuShortcut=false`) |
| 실제 userData 를 쓴다(잠금·포트·토큰·설정 모두 공유: 2장) | 설치본에서도 먹는 격리 수단이 필요하다. 추천: 환경 변수 `DESKPET_USER_DATA_DIR` 를 설치본에서도 허용한다(질문 7). CLI 가 이미 같은 이름을 쓴다(`packages/cli/src/index.ts:42`: `options["user-data-dir"] ?? process.env.DESKPET_USER_DATA_DIR`). `app.setPath("userData", …)` 는 `requestSingleInstanceLock()` 앞에서 하므로(`index.ts:52–58`) 잠금도 임시 폴더 범위가 된다. 인자 `--user-data-dir` 를 설치본에서 열지 않는 이유: 5장에서 설치본이 개발 인자를 무시한다는 규칙과 충돌하기 때문이다 |
| 이벤트 포트 7777 충돌 | `--event-port=0`(OS 가 빈 포트를 준다: `index.ts:111` 이 0 을 허용). 실제 포트는 격리된 userData 의 `event-server.json` 에서 읽는다 |
| 자동 시작이 사용자 시작 항목에 들어감(6장의 첫 실행 켬) | 첫 실행 켬은 userData 가 기본 위치일 때만 한다(6장). 점검은 임시 userData 에 `settings.json` 을 미리 만들어 `launchAtLogin: false` 로 시작해 이중으로 막는다 |

**절차 (스크립트가 하는 일):**

1. 전후 비교용 스냅샷: 실제 `%APPDATA%\deskpet\settings.json` 의 해시와 수정 시각, `HKCU\…\Run` 의 값 목록, `HKCU\…\Uninstall` 의 키 목록.
2. 임시 작업 폴더 `%TEMP%\deskpet-check-<무작위>\{install,userdata}` 를 만든다. 이름이 이 접두가 아니면 이후 단계에서 지우지 않는다(안전 검사).
3. 점검용 설치 파일을 `<설치 파일> /S /D=%TEMP%\deskpet-check-<무작위>\install` 로 조용히 설치한다(`/D=` 는 마지막 인자이고 따옴표를 쓰지 않는다. NSIS 규칙).
4. 환경 변수 `DESKPET_USER_DATA_DIR=<임시>\userdata` 로 설치된 `DeskPetCheck.exe --event-port=0` 을 띄우고 5장의 개발 인자 점검을 더한다.
5. `<임시>\userdata\event-server.json` 의 포트·토큰으로 `/status` 를 부르고 펫 창 존재(`visible`)와 플러그인 4개가 `running` 인지 확인한다.
6. 앱 종료: **자기가 띄운 pid 로만** 종료한다(`taskkill /IM` 같은 이름 기준은 사용자의 실제 DeskPet 을 죽일 수 있어 쓰지 않는다).
7. 조용한 제거: `<설치폴더>\Uninstall DeskPetCheck.exe /S` — NSIS 의 조용한 제거는 임시 복사본을 띄우고 바로 반환하므로 설치 폴더가 사라질 때까지 기다린다(시간 제한을 둔다. 추측: 이 동작은 알려진 NSIS 특성이나 확인하지 못했다).
8. 확인: 설치 폴더가 없다. `<임시>\userdata` 의 `settings.json` 등은 남아 있다(기준 4 의 "사용자 데이터는 남는다"). 점검용 Run 값·제거 키가 없다.
9. 가드: 1 의 스냅샷과 같다(실제 설정 파일 해시, Run 값, 제거 키가 변하지 않았다).
10. 정리: 임시 폴더를 지운다(접두 검사 통과 시).

**추가 환경(선택):** 기준 8(깨끗한 PC)은 Windows 샌드박스(Windows 11 Enterprise 에 기능이 있다: 추측, 이 PC 에서 켜져 있는지 확인하지 못했다)나 새 Windows 사용자 계정에서 한다. 이 점검 스크립트의 격리 방식은 자동화용이고 기준 8 을 대신하지 않는다. 새 사용자 계정 방법은 `docs/install.md` 에 짧게 적는다.

**점검 스크립트 위치:** `scripts/check-installer.mjs`(새 파일). `pnpm package:check` 로 부른다(`package` 와 별도, 점검용 빌드가 따로 필요해서).

### 10. 2단계 구현 task 분해 제안

파일 겹침을 기준으로 정했다(`index.ts` 는 5·6·7 이 모두 건드린다). 병렬 worker 상한은 3(`CLAUDE.md`).

| task | 기준 | 주요 파일 | 선행 |
|---|---|---|---|
| **A. 시작 인자·경로 정리** | 5, 3 의 경로 고침 | 새 `launch-args.ts`(+테스트), `index.ts` 위쪽(`:45–74`, `:1805`), `plugin-clock-args.ts`, `second-instance` 처리, `DESKPET_USER_DATA_DIR`(설치본 허용), `characters` 설치본 경로 | 없음 |
| **B. 빌드 설정·패키징 스크립트** | 3 (+8 이름·버전) | `apps/desktop/electron-builder.config.mjs`, `apps/desktop/package.json`(`dependencies`→`devDependencies`, `version`), 루트 `package.json`(`electron-builder` 추가, `package` 스크립트), `pnpm-lock.yaml`, `scripts/package*.mjs`(플러그인·CLI 번들, 내용 확인), `.gitignore`, `docs/install.md`, `docs/hooks/send-claude-code-event.mjs`(CLI 경로 탐색), `docs/hooks/claude-code.md` | 없음(파일이 A 와 겹치지 않음). 설치본에서 실제로 도는 확인은 A 의 경로 수정 뒤 |
| **C. 오류 기록** | 7 | 새 `error-log.ts`(+테스트), `log-file.ts`(옵션), `log-mask.ts`(규칙 2·3), `index.ts` 맨 위와 `app.on(…)` 핸들러, `tray.ts`·`pet-menu.ts` 라벨과 그 테스트·e2e 3개, 개발 제어 시험 명령 | A 머지 뒤(`index.ts` 겹침) |
| **D. 자동 시작** | 6 | 새 `login-item.ts`(+테스트), `settings.ts`(`launchAtLogin`), `settings-service.ts`, `renderer/settings.ts`(일반 탭), `index.ts` 백엔드 연결, `build/installer.nsh`(제거 때 Run 값 삭제) | A 머지 뒤, C 와 `index.ts` 한 곳 겹침 |
| **E. 설치본 점검 스크립트** | 4 (+5 설치본 확인) | `scripts/check-installer.mjs`, `package.json` 스크립트 한 줄 | A, B 머지 뒤 |

순서: **1) A 와 B 를 병렬**(파일이 겹치지 않음) → **2) C 와 D**(A 가 머지된 뒤. 둘 다 `index.ts` 의 서로 다른 곳을 건드린다. 같은 줄을 건드릴 일은 없지만 병합 충돌을 줄이려면 C 를 먼저 머지하고 D 가 그 위에서 이어 받는 직렬이 안전하다) → **3) E**. 기준 8·9 는 3단계/사람 확인이다.

게이트: A 는 개발 제어 통로·인자 변경이라 `CLAUDE.md` 의 확인 필요 영역과 M9 게이트에 해당해 머지 전 사용자 gate 승인이 필요하다. B 의 새 의존성은 `pnpm-lock.yaml` 변경을 낳는다. `packages/plugin-sdk/src/v1/` 는 어떤 task 도 건드리지 않는다. `apps/desktop` 이 바뀌는 A·C·D 는 coordinator 의 전체 `pnpm test:e2e` 확인(`CLAUDE.md` D-050)을 거친다.

각 task 의 완료 기준 연결: A→5(단위+점검), B→3(`pnpm package`+내용 확인), C→7(단위+e2e), D→6(단위+e2e 토글 표시), E→4(설치·실행·제거 점검).

## 위험

| 위험 | 영향 | 대응 |
|---|---|---|
| asar 안 utilityProcess 러너가 안 뜸 | 설치본의 모든 플러그인이 동작 안 함 | 3장의 단계적 대안(`asarUnpack` → `asar: false`). 기준 3 첫 실험 |
| 플러그인 번들 누락 | 위와 같음 | 3장 번들 단계 + 확인 스크립트가 번들에 bare import 가 없음을 검사 |
| 같은 appId 로 점검해 실제 설치를 건드림 | 사용자 환경 파손 | 9장: 점검 전용 appId, 전후 스냅샷 비교 |
| 설치본이 개발 인자를 받음 | 임의 폴더의 플러그인 로드 | 5장 |
| 개발 실행과 설치본이 동시에 켜져 한쪽이 조용히 사라짐 | 사용자가 "안 켜진다"고 오해 | 2장의 `second-instance` 처리 |
| Smart App Control 이 미서명 설치를 막음 | 기준 8 불가 | 8장: 먼저 확인, 막히면 서명 도입 결정을 사용자에게 |
| 자동 시작 항목이 낡은 경로를 가리킴(제거 뒤) | 로그인마다 오류 | 6장: 제거 때 값 삭제, 점검 스크립트가 확인 |
| 오류 기록에 비밀이 남음 | 사용자가 파일을 공유할 때 유출 | 7장: 쓰기 직전 마스킹, 덤프 안 만듦 |
| hook 스크립트가 Node 에 의존 | Node 없는 PC 에서 알림 안 옴 | 4장·질문 4 |

## 사용자에게 물을 질문

각 질문은 추천과 이유를 한 줄로 적는다. **답(2026-10-10, D-059): 9개 모두 추천안.**

1. **설치 형식은 electron-builder NSIS 사용자별 one-click(폴더 선택 화면 없음)으로 갈까요?** 추천: 예. 이유: 관리자 권한이 필요 없고 `/S`·`/D=` 로 조용한 설치·제거 점검(기준 4)이 가장 단순합니다.
2. **자동 시작 기본값은?** 추천: 설치본 첫 실행에서 한 번 켜고(설정 [일반]에서 끌 수 있고, 끈 뒤에는 다시 켜지 않음) 첫 말풍선으로 알립니다. 이유: 기준 8·데모가 "재부팅하면 저절로 뜬다"이고, 사용자가 모르게 켜지는 점은 알림으로 보완합니다. 대안은 끔 기본(설치 뒤 직접 켜기).
3. **`jungle` 플러그인(출석 확인, 개인 LMS 용)도 설치본에 넣을까요?** 추천: 넣는다. 이유: 이 앱의 핵심 용도 중 하나이고 읽기 전용이며 권한 허용 대화상자를 거치므로 허용 전에는 동작하지 않습니다.
4. **설치본의 hook 스크립트와 CLI 는 Node 가 있다고 가정(안내만)해도 될까요?** 추천: 1단계에서는 예. 이유: 지금 hook 이 이미 `node` 를 부르고, Electron 을 Node 처럼 쓰는 방법은 환경 변수·보안 설정 부담이 큽니다. Node 가 없는 PC 는 후속 과제로 `backlog.md` 에 둡니다.
5. **트레이의 "로그 폴더 열기"를 "오류 기록 폴더 열기"로 이름만 바꿔 쓸까요(항목을 하나 더 만들지 않고)?** 추천: 예. 이유: 같은 폴더(`logs/`)를 여는 중복 항목을 피합니다. 라벨을 확인하는 테스트 3곳과 `docs/plan.md` 를 함께 고칩니다.
6. **`crashReporter`(네이티브 충돌 덤프)는 켜지 않을까요?** 추천: 끔. 이유: 덤프에 프로세스 메모리(토큰·secret)가 들어가고 가릴 방법이 없으며, 충돌 사실은 `child-process-gone` 기록으로 남습니다.
7. **설치본에서도 `DESKPET_USER_DATA_DIR` 환경 변수(데이터 폴더 지정)와 `--event-port` 인자를 허용할까요?** 추천: 허용(나머지 개발 인자는 모두 무시). 이유: 점검 스크립트가 실제 사용자 데이터와 분리해 돌려면 필요하고, 둘 다 위치·포트만 바꾸며 개발 통로나 쓰기 권한을 열지 않습니다.
8. **처리되지 않은 예외(`uncaughtException`) 뒤 앱을 계속 실행할까요?** 추천: 기록하고 계속 실행, 같은 오류가 1분에 5번을 넘으면 종료. 이유: 펫이 사라지는 것보다 계속 있는 편이 낫고, 반복되면 상태가 망가졌다고 보고 끕니다. 게시자 표기는 서명이 없으니 쓰지 않고, 앱 이름 표기는 `DeskPet`, appId `com.deskpet.app`, 버전 `0.1.0` 으로 갑니다(가칭 D-001 유지).
9. **미서명 SmartScreen 안내(`docs/install.md`)의 위치와 형태는?** 추천: `docs/install.md` 새 문서(설치본 받는 사람이 읽는 한국어 안내 + SHA-256 확인 + Smart App Control 확인). 이유: 기획안에 넣으면 개발자 문서와 섞이고, 설치 안내는 설치 파일 옆에 같이 줄 수 있어야 합니다.

## 구현에서 확정·변경된 점 (M9, 2026-10-12)

**확인된 추측**

- **electron-builder:** `26.15.3` 정확한 버전으로 넣었고 Electron 44.5.1 과 별도 설정 없이 빌드된다(`electronDist`·`electronVersion` 은 루트 `electron` 을 그대로 쓴다).
- **asar 안 utilityProcess:** `asar: true` 그대로 플러그인 4종이 설치본에서 running 이다(`pnpm package:check` 의 `/status`). 3장의 대안(`asarUnpack`, `asar: false`)은 필요 없었다.
- **Chromium 의 `--user-data-dir`:** 설치본에 이 인자를 줘도 그 폴더에 아무것도 생기지 않는다(`package:check` 실측). 따로 `setPath` 로 고정할 필요가 없었다.
- **렌더러 `console-message`:** Electron 44 에서 이벤트 객체 하나(`details`) 형태다. 기준 7 에서 그 형태로 구현했다.
- **제거와 자동 시작 값:** `installer.nsh` 의 `customUnInstall` 이 동작한다. 점검 스크립트가 제거 뒤 HKCU Run 값과 Uninstall 키가 설치 전과 같음을 확인한다.
- **설치 파일 크기:** 106.3 MB.
- **데이터 폴더:** 설치본도 `app.setName("deskpet")` 이 정한 `%APPDATA%deskpet` 을 쓴다. 자동 점검은 `DESKPET_USER_DATA_DIR` 로 분리해 돌리므로 직접 확인한 것은 아니다. 새 Windows 계정 설치에서 첫 실행 자동 시작 알림이 뜬 것(기본 데이터 폴더일 때만 켠다)이 간접 근거다. 기본 설치 경로 `%LOCALAPPDATA%ProgramsDeskPet` 도 자동으로는 확인하지 않았다(점검은 `/D=` 임시 경로).

**바뀌거나 더한 점**

- **설치본 기본 팩:** 이 ADR 은 정하지 않았던 기본 팩을 기준 9 에서 wolf-maid 로 했다(설정·명령줄 지정이 없을 때, 읽기 실패면 placeholder). 개발용 `placeholder-alt` 는 설치본에서 뺐다. 출처·권리 메모는 `characters/wolf-maid/CREDITS.md`(라이선스 미정, 공개 배포 전 권리 확인 필요).
- **빌드 해시:** 같은 코드여도 빌드마다 SHA-256 이 달라진다(재현 가능한 빌드가 아니다). 받는 사람에게는 그 빌드의 `SHA256SUMS.txt` 를 같이 준다.
- **하지 않은 것:** PowerShell 절대 경로 고정(4장, 선택 항목)은 하지 않았다. Node 가 없는 PC 의 hook 은 안내만 한다(질문 4).
- **같은 계정의 개발판과 설치본:** 데이터 폴더가 같아 한 번에 하나만 뜬다(2장 `second-instance`). 개발 계정에는 설치하지 않는 것으로 운용한다(`docs/plan.md` 14장).

## 변경 이력

- 2026-10-10 초안 작성.
- 2026-10-10 사용자 승인: 질문 1–9 모두 추천안 (D-059).
- 2026-10-12 구현 결과 반영(M9 종료 점검, 사용자 승인).
