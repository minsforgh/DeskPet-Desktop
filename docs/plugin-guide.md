# 플러그인 작성 가이드

DeskPet 에 붙는 플러그인을 처음부터 만들어 앱에 넣고, 권한 허용을 거쳐 동작시키고, 단위 테스트까지 통과시키는 방법이다. 이 파일 하나만 읽고 따라 할 수 있게 썼다.

- 기준: 2026-10-10 시점의 코드(커밋 `1c8ed0d`). 문서와 코드가 다르면 코드가 맞다. 이 가이드의 명령·API·필드 이름은 코드에서 확인한 것만 적었다.
- 규약의 원문은 `docs/adr/0001-pet-event.md`(이벤트), `0003-plugin-manifest-and-api-v1.md`(매니페스트·API), `0005-plugin-host.md`(호스트·권한). 규약 코드는 `packages/plugin-sdk/src/v1/`이고 **고치지 않는다**(바꾸려면 ADR 과 사용자 확인이 필요하다).
- 설치본(설치 파일로 깐 앱)에서 플러그인을 넣는 위치는 ADR-0010(`docs/adr/0010-packaging-and-distribution.md`)에서 정하고 있고 구현은 아직 없다. **설치본 경로는 ADR-0010 이후 갱신한다.** 아래는 저장소에서 개발 실행하는 방법이다.

## 목차

1. [준비물](#1-준비물)
2. [따라 하기: 스트레칭 알림 플러그인](#2-따라-하기-스트레칭-알림-플러그인)
3. [폴더 구조와 manifest.json](#3-폴더-구조와-manifestjson)
4. [권한과 사용자 허용](#4-권한과-사용자-허용)
5. [PluginContext API](#5-plugincontext-api)
6. [설정: configSchema](#6-설정-configschema)
7. [PetEvent와 알림 규칙](#7-petevent와-알림-규칙)
8. [빌드하고 앱에 넣기](#8-빌드하고-앱에-넣기)
9. [테스트: createTestContext](#9-테스트-createtestcontext)
10. [문제 해결](#10-문제-해결)
11. [부록: 테스트 하네스와 실제 호스트의 차이, 점검표](#11-부록)

## 1. 준비물

- Windows, Node.js 22 이상, pnpm(저장소는 `pnpm@12.9.1`).
- 저장소를 받은 뒤 루트에서 한 번:

```
pnpm install
pnpm build:host
```

`pnpm build:host` 는 `core`, `plugin-sdk`, `plugin-host` 와 `plugins/*` 를 빌드한다(`dist/` 가 생긴다). 앱을 실행하려면 추가로 `pnpm --filter @deskpet/cli build`(`deskpet` 명령)와 `pnpm --filter @deskpet/desktop build`(앱)가 필요하고, `node_modules\electron\dist\electron.exe` 가 있어야 한다. 없으면(`pnpm install` 뒤에 내려받기가 건너뛰어진 경우) `node node_modules/electron/install.js` 로 받는다.

## 2. 따라 하기: 스트레칭 알림 플러그인

일정 간격으로 "스트레칭할 시간" 말풍선을 띄우고, 버튼 두 개(했어요 / 방법 보기)와 트레이 메뉴 항목 하나를 가진 플러그인이다. 간격과 문구는 설정 창에서 바꾼다. 아래 파일 그대로 따라 하면 빌드·테스트·실행까지 된다(이 가이드를 쓸 때 같은 파일로 확인했다).

### 2.1 폴더 만들기

저장소 루트의 `plugins/` 아래에 **플러그인 id 와 같은 이름**의 폴더를 만든다.

```
plugins/stretch/
├─ manifest.json          앱이 읽는 매니페스트
├─ package.json           pnpm 워크스페이스 패키지 (빌드·테스트용)
├─ tsconfig.json          타입 검사용
├─ tsconfig.build.json    빌드용 (dist/ 로 내보냄)
└─ src/
   ├─ index.ts            플러그인 코드
   └─ index.test.ts       단위 테스트
```

`pnpm-workspace.yaml` 이 `plugins/*` 를 워크스페이스로 잡으므로 다른 설정은 필요 없다. `dist/` 는 `.gitignore` 에 있어 커밋되지 않는다.

**`plugins/` 밖(예: `docs/examples/<id>/`)에 두는 플러그인은 검증이 되지 않는다.** 워크스페이스는 `apps/*`, `packages/*`, `plugins/*`, `tools/*` 만 잡아서 그 밖의 폴더는 `pnpm --filter @deskpet/plugin-<id> typecheck` 가 `No projects matched the filters` 로 실패한다. 루트 vitest 설정도 `{apps,packages,plugins,tools}/*/src/**/*.test.ts` 만 찾으므로 `pnpm test docs/examples/<id>` 는 테스트를 찾지 못한다. `docs/examples/hello-demo` 는 코드가 없는 매니페스트뿐이라 빌드·테스트 대상이 아니고, `docs/examples/water` 는 소스와 테스트가 있지만 워크스페이스 밖이라 `pnpm install`·`pnpm build:host`·`pnpm test` 어디에도 잡히지 않는다. 권장 흐름:

1. 먼저 `plugins/<id>/` 에서 만들고 2.6 대로 타입 검사·빌드·테스트를 통과시킨다.
2. 예제로 두려면 `manifest.json`, `package.json`, `tsconfig*.json`, `src/` 를 `docs/examples/<id>/` 로 옮기고(`dist/` 는 제외) `tsconfig.json` 의 `extends` 를 **`../../../tsconfig.base.json`** 으로 고친다(`plugins/<id>` 는 두 단계, `docs/examples/<id>` 는 세 단계 아래다). `plugins/<id>/` 는 지운다.
3. 옮긴 뒤에는 자동 검증이 없다. 다시 확인하려면 `plugins/<id>/` 로 되돌려 복사하고(`extends` 도 `../../tsconfig.base.json` 으로 되돌린다) `pnpm install` 부터 2.6 을 돌린 다음 지운다. 이때 `pnpm-lock.yaml` 이 바뀌는 것은 2.6 에서 다룬다.

### 2.2 manifest.json

```json
{
  "id": "stretch",
  "name": "Stretch Reminder",
  "version": "0.1.0",
  "apiVersion": "1",
  "entry": "dist/index.js",
  "description": "일정 간격으로 스트레칭을 알려 주는 예제 플러그인",
  "permissions": {
    "openExternal": ["https://example.com/stretch"]
  },
  "contributes": {
    "actions": ["stretch.done", "stretch.help", "stretch.remind"],
    "trayItems": ["stretch.tray-remind"],
    "badges": ["stretch.count"]
  }
}
```

- 이 파일은 **BOM 없는 UTF-8** 로 저장한다. BOM 이 있으면 `manifest is not valid JSON` 으로 거부된다(Windows PowerShell 5.1 의 `Set-Content -Encoding utf8`, `>` 는 BOM 을 붙인다. 편집기로 만들거나 `[System.IO.File]::WriteAllText` 를 쓴다).
- `permissions.openExternal` 은 "방법 보기" 버튼이 열 주소다. 선언하지 않으면 `ctx.openExternal` 이 막힌다(4장).
- `contributes` 의 id 는 모두 `stretch.` 로 시작한다.

### 2.3 package.json, tsconfig

`package.json`:

```json
{
  "name": "@deskpet/plugin-stretch",
  "version": "0.1.0",
  "private": true,
  "description": "스트레칭 알림 플러그인",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@deskpet/core": "workspace:*",
    "@deskpet/plugin-sdk": "workspace:*"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": [
    "src"
  ]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "exclude": [
    "src/**/*.test.ts"
  ]
}
```

기존 `plugins/reminders/` 의 같은 파일과 이름만 다르다. `"type": "module"` 이 있어야 하고(소스는 ES 모듈), `build` 는 `src/` 를 `dist/` 로 내보낸다(`src/index.ts` → `dist/index.js`, 테스트 파일은 제외).

### 2.4 src/index.ts

```ts
import type { PetEvent } from "@deskpet/core";
import type { ConfigSchema, Disposable, PluginDefinition } from "@deskpet/plugin-sdk";

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    intervalMinutes: {
      type: "number",
      title: "알림 간격(분)",
      description: "1 이상. 바꾸면 바로 적용된다",
      default: 50,
    },
    message: { type: "string", title: "말풍선 문구", default: "일어나서 스트레칭할 시간이에요" },
  },
};

function remindEvent(message: string): PetEvent {
  return {
    source: "stretch",
    type: "notify",
    key: "stretch",
    text: message,
    mood: "sleepy",
    priority: "normal",
    ttlMs: 10 * 60 * 1000,
    actions: [
      { label: "했어요", action: "stretch.done" },
      { label: "방법 보기", action: "stretch.help" },
    ],
  };
}

const plugin: PluginDefinition = {
  configSchema,
  activate(ctx) {
    let done = 0;
    let timer: Disposable | undefined;

    const settings = (config: Readonly<Record<string, unknown>>) => {
      const minutes = typeof config.intervalMinutes === "number" && config.intervalMinutes >= 1 ? config.intervalMinutes : 50;
      const message = typeof config.message === "string" && config.message ? config.message : "일어나서 스트레칭할 시간이에요";
      return { ms: Math.round(minutes * 60_000), message };
    };

    let current = settings(ctx.config);
    const start = (): void => {
      timer?.dispose();
      timer = ctx.schedule.every(current.ms, async () => {
        ctx.emit(remindEvent(current.message));
      });
    };
    start();

    ctx.onConfigChange((next) => {
      current = settings(next);
      start();
    });

    ctx.registerAction("stretch.done", () => {
      done += 1;
      ctx.setBadge("stretch.count", { text: String(done), tone: "ok" });
      ctx.emit({ source: "stretch", type: "notify", key: "stretch-done", text: `잘했어요! 오늘 ${done}번째`, mood: "happy", ttlMs: 60_000 });
    });
    ctx.registerAction("stretch.help", async () => {
      await ctx.openExternal("https://example.com/stretch");
    });
    ctx.registerAction("stretch.remind", () => {
      ctx.emit(remindEvent(current.message));
    });
    ctx.addTrayItem({ id: "stretch.tray-remind", label: "지금 스트레칭 알림", action: "stretch.remind" });
    ctx.log.info("stretch: activated");
  },
};

export default plugin;
```

짚을 점:

- 기본 내보내기(`export default`)가 `activate(ctx)` 를 가진 객체여야 한다. 선택으로 `configSchema` 와 `deactivate()` 를 둔다.
- SDK 는 **`import type` 으로만** 가져왔다. 런타임에 `@deskpet/plugin-sdk` 를 import 하지 않아서, 빌드한 `dist/` 를 저장소 밖 폴더(8장)에 복사해도 그대로 돈다. (`definePlugin` 은 받은 객체를 그대로 돌려주는 함수라 `import { definePlugin } from "@deskpet/plugin-sdk"` 로 감싸도 된다. 저장소 안에서만 쓸 플러그인이면 상관없지만, `dist/index.js` 에 그 import 가 남는다.)
- `ctx.emit` 의 이벤트는 `source` 가 플러그인 id(`stretch`)여야 하고, 버튼의 `action` 은 `stretch.` 로 시작해야 한다(7장).
- 선택 필드를 `undefined` 로 두지 않는다(`priority: undefined` 는 검증에서 거부된다). 값이 없으면 필드를 아예 쓰지 않는다.

### 2.5 src/index.test.ts

```ts
import { describe, expect, it } from "vitest";
import { validatePetEvent } from "@deskpet/core";
import { validatePluginManifest } from "@deskpet/plugin-sdk";
import { createTestContext } from "@deskpet/plugin-sdk/testing";
import plugin from "./index.js";
import manifest from "../manifest.json" with { type: "json" };

function setup(config: Record<string, unknown> = {}) {
  const test = createTestContext({ manifest: { permissions: manifest.permissions, contributes: manifest.contributes }, config });
  plugin.activate(test.ctx);
  return test;
}

describe("stretch plugin", () => {
  it("has a valid manifest", () => {
    expect(validatePluginManifest(manifest)).toMatchObject({ ok: true });
  });

  it("registers a repeating timer from the default interval", () => {
    const test = setup({ intervalMinutes: 50 });
    expect(test.schedules.every.map((entry) => entry.ms)).toEqual([50 * 60_000]);
  });

  it("emits a notify event with two buttons when the timer fires", async () => {
    const test = setup({ intervalMinutes: 10, message: "스트레칭!" });
    await test.runEvery();
    expect(test.events).toHaveLength(1);
    expect(validatePetEvent(test.events[0]).ok).toBe(true);
    expect(test.events[0]).toMatchObject({ source: "stretch", type: "notify", key: "stretch", text: "스트레칭!" });
    expect(test.events[0]?.actions?.map((action) => action.action)).toEqual(["stretch.done", "stretch.help"]);
  });

  it("cheers and counts finished stretches", async () => {
    const test = setup();
    await test.runAction("stretch.done");
    await test.runAction("stretch.done");
    expect(test.badges.get("stretch.count")).toEqual({ text: "2", tone: "ok" });
    const last = test.events.at(-1);
    expect(validatePetEvent(last).ok).toBe(true);
    expect(last).toMatchObject({ type: "notify", mood: "happy", text: "잘했어요! 오늘 2번째" });
  });

  it("opens the help page only inside the declared pattern", async () => {
    const test = setup();
    await test.runAction("stretch.help");
    expect(test.openExternalCalls).toEqual(["https://example.com/stretch"]);
    await expect(test.ctx.openExternal("https://evil.example.org/")).rejects.toThrow("external URL is not allowed");
  });

  it("restarts the timer when the interval changes", () => {
    const test = setup({ intervalMinutes: 50 });
    test.changeConfig({ intervalMinutes: 5 });
    expect(test.schedules.every.map((entry) => entry.ms)).toEqual([5 * 60_000]);
  });

  it("adds a tray item that runs the remind action", async () => {
    const test = setup();
    expect(test.trayItems.get("stretch.tray-remind")?.action).toBe("stretch.remind");
    await test.runAction("stretch.remind");
    expect(test.events).toHaveLength(1);
  });
});
```

`createTestContext` 가 만든 가짜 `ctx` 로 `activate` 를 실행하고, 기록된 이벤트·타이머·배지를 확인한다(9장). `validatePetEvent`(`@deskpet/core`)로 보낸 이벤트가 실제 호스트 검증을 통과하는지도 본다. 하네스는 이벤트 모양을 검사하지 않기 때문이다.

### 2.6 설치, 타입 검사, 빌드, 테스트

저장소 루트에서:

```
pnpm install
pnpm --filter @deskpet/plugin-stretch typecheck
pnpm --filter @deskpet/plugin-stretch build
pnpm test plugins/stretch
```

- `pnpm install` 은 새 워크스페이스 패키지를 연결하고 `pnpm-lock.yaml` 에 항목을 더한다(새 `plugins/<id>` 는 lock 에 항목이 생기므로 피할 수 없다). **플러그인을 저장소에 남기는 경우** 바뀐 lock 파일을 플러그인과 함께 커밋한다. **확인만 하고 `plugins/<id>/` 를 지울 임시 검증**(예: 예제를 `plugins/` 로 복사해 돌려 본 경우)이면 폴더를 지운 뒤 `git checkout pnpm-lock.yaml` 로 lock 을 되돌려도 된다. 플러그인을 남긴 채 lock 만 되돌리면 다음 `pnpm install` 이 다시 바꾸므로 그때는 커밋한다.
- 빌드하면 `plugins/stretch/dist/index.js` 가 생긴다. **앱은 `dist/index.js` 를 읽으므로 빌드 전에는 `invalid`(`entry path is invalid`)다.**
- 테스트는 저장소 루트의 vitest 설정이 `@deskpet/plugin-sdk`, `@deskpet/plugin-sdk/testing`, `@deskpet/core` 를 소스로 연결하므로 빌드 없이도 돈다. 기대 결과: `index.test.ts` 의 테스트 7개가 모두 통과한다.

### 2.7 앱에서 실행하고 허용하기

이 플러그인은 `permissions` 가 비어 있지 않아 처음 켤 때 **허용 창**이 뜬다. 어떤 방식으로 앱을 띄우느냐에 따라 창이 뜨는지가 다르니 4.3 을 먼저 읽는다. **`permissions` 가 `{}` 인 플러그인은 허용 창 없이 바로 허용으로 기록되므로(4.3) 아래 `--permission-answer` 가 필요 없다**(주어도 영향이 없다). 허용 창 흐름(허용 뒤 `running`)을 보려면 이 예제처럼 권한을 하나라도 선언한 플러그인을 쓴다. 요약:

- 허용 창을 직접 보려면 개발 제어 없이 실행한다: `pnpm --filter @deskpet/desktop start` (사전 빌드 필요). 이미 DeskPet 이 떠 있으면 단일 인스턴스 잠금으로 곧바로 종료되니 먼저 끈다.
- `start-deskpet.cmd` 와 `pnpm desktop:start` 는 개발 제어(`--dev-control=default`)를 켜므로 **허용 창이 뜨지 않고 "허용 안 함"으로 기록된다.** 이때는 `start-deskpet.cmd --permission-answer=allow` 처럼 답을 미리 준다.
- 기존 앱과 섞이지 않게 격리해서 확인하려면 아래 "격리 실행"을 쓴다. 이 가이드의 예제는 이 방식으로 확인했다.

**격리 실행 (PowerShell, 저장소 루트에서)**

```powershell
# 1) 플러그인 폴더만 따로 모은다 (manifest.json 과 dist 만 있으면 된다)
#    대상을 먼저 지우고 복사하므로 다시 실행해도 dist\dist 로 겹치지 않는다
$dest = "$env:TEMP\dp-plugins\stretch"
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item plugins\stretch\manifest.json $dest
Copy-Item plugins\stretch\dist "$dest\dist" -Recurse

# 2) 앱 실행 (개발 제어 이름 guide, 사용자 데이터는 임시 폴더, 허용은 자동 허용)
$app = Start-Process -PassThru "node_modules\electron\dist\electron.exe" -ArgumentList `
  "apps\desktop","--dev-control=guide","--user-data-dir=$env:TEMP\dp-user",
  "--plugins-dir=$env:TEMP\dp-plugins","--permission-answer=allow","--event-port=0"

# 3) 상태 확인 (앱이 뜰 때까지 기다린 뒤). stretch 가 running 이면 성공
Start-Sleep 10
pnpm deskpet status --json --user-data-dir="$env:TEMP\dp-user"

# 4) 끝낼 때
Stop-Process -Id $app.Id
```

`--dev-control=<이름>`(소문자·숫자·하이픈 32자 이하)은 개발 실행에서만 동작한다. `--user-data-dir`(사용자 데이터 폴더를 바꿈)와 `--permission-answer`(허용 창 대신 자동 답)는 개발 제어가 켜져 있을 때만 쓰인다. `--plugins-dir` 은 단독으로 스캔 폴더를 바꾼다(8장). `--event-port=0` 은 이벤트 서버 포트를 아무 빈 포트로 잡아 실행 중인 다른 DeskPet 과 겹치지 않게 한다.

**버튼 눌러 보기 (선택)**: 위 앱이 떠 있는 동안, 이벤트를 하나 보내 말풍선을 띄우고 개발 제어로 버튼을 누른다. JSON 은 파일로 넘긴다(PowerShell 5.1 은 `--json '...'` 인자의 따옴표를 깎는다).

```powershell
[System.IO.File]::WriteAllText("$PWD\ev.json", '{"source":"http","type":"notify","text":"button test","actions":[{"label":"done","action":"stretch.done"}]}')
node packages/cli/dist/index.js event --user-data-dir="$env:TEMP\dp-user" --file ev.json
Start-Sleep 2
node -e "import('./apps/desktop/scripts/control.mjs').then(async m => { await m.sendRequest('guide', { cmd: 'bubbleAction', index: 0 }); await new Promise(r => setTimeout(r, 6500)); const s = await m.sendRequest('guide', { cmd: 'state' }); console.log(s.bubble?.text) })"
Remove-Item ev.json
```

`잘했어요! 오늘 1번째` 가 출력되면 버튼 → 액션 핸들러 → 이벤트까지 이어진 것이다. (`--file` 은 현재 폴더 안의 상대 경로만 읽는다.)

### 2.8 이제 무엇을 보나

- 트레이 [플러그인] 하위 메뉴에 `Stretch Reminder: 실행 중` 과 `지금 스트레칭 알림` 이 보인다(펫 우클릭 메뉴에도 같은 항목이 있다).
- 설정 창 [플러그인] 탭에 알림 간격·말풍선 문구 입력칸이 생긴다(자동 생성, 6장).
- 로그(`<userData>\logs\deskpet.log`)에 `[plugin:stretch] stretch: activated` 가 남는다(10장).
- 코드를 고치면 다시 빌드하고 **앱을 다시 켠다.** 핫 리로드는 없다.

## 3. 폴더 구조와 manifest.json

### 3.1 플러그인 폴더

- 스캔 루트 바로 아래의 폴더 하나가 플러그인 하나다. **폴더 이름 = 매니페스트 `id`** 여야 한다.
- 이름이 `.` 또는 `_` 로 시작하는 폴더와 `node_modules` 는 건너뛴다. 폴더가 심볼릭 링크·정션이면 `invalid` 다.
- 폴더 안에 `manifest.json` 이 있어야 한다(일반 파일, 64 KiB 이하, 링크 금지). 실행 파일은 `entry` 가 가리키는 빌드 결과다.
- 시작할 때 **한 번만** 스캔한다. 매니페스트·코드를 바꾸면 앱을 다시 켠다.

### 3.2 매니페스트 필드

`PluginManifest`(`packages/plugin-sdk/src/v1/contracts.ts`)와 검증기 `validatePluginManifest`(`@deskpet/plugin-sdk`) 기준이다. 아래 8개는 모두 필수다.

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | string | 소문자·숫자·하이픈만(`^[a-z0-9-]+$`). 폴더 이름과 같아야 한다 |
| `name` | string | 표시 이름. 허용 창, 트레이, 설정 창, "플러그인을 껐어요" 알림에 쓰인다 |
| `version` | string | 형식 검사는 없다. 표시용 |
| `apiVersion` | `"1"` | **문자열** `"1"` 만 받는다(숫자 `1` 은 거부). 호스트가 지원하는 값은 `["1"]` |
| `entry` | string | 빌드된 진입 파일의 상대 경로. 3.3 참고 |
| `description` | string | 한 줄 설명 |
| `permissions` | object | 필수. 아무 권한도 없으면 `{}` |
| `contributes` | object | 필수. 아무것도 없으면 `{}` |

`permissions`(모르는 키가 있으면 거부한다. 선언하지 않은 권한은 호스트가 막는다):

| 키 | 형식 | 규칙 |
|---|---|---|
| `network` | string[] | `ctx.fetch` 가 닿을 호스트 이름. 소문자 호스트만(예 `api.example.com`). 스킴·포트·경로·와일드카드 금지, **IP 주소 금지**(로드 거부) |
| `openExternal` | string[] | `ctx.openExternal` 이 열 주소 패턴. `https://호스트/경로` 꼴. 경로는 `/` 로 시작하고, 와일드카드는 맨 끝의 `/*` 하나만(`https://example.com/*`). 포트·사용자 정보·IP·호스트 와일드카드 금지. 패턴에 `?쿼리`·`#해시` 를 넣으면 어떤 주소와도 맞지 않는다 |
| `windows` | string[] | `ctx.windows.create` 로 열 창 id. 소문자·숫자·하이픈 |
| `secrets` | boolean | `ctx.secrets` 사용 |
| `shell` | boolean | `ctx.exec` 사용(임의 명령 실행, 허용 창에서 강조된다) |

`contributes`(모르는 필드는 무시한다):

| 키 | 형식 | 규칙 |
|---|---|---|
| `actions` | string[] | `registerAction` 으로 등록할 액션 id |
| `trayItems` | string[] | `addTrayItem` 의 `id` |
| `badges` | string[] | `setBadge` 의 `id` |

세 목록의 id 는 `<플러그인 id>.<이름>` 꼴이다. 접두가 매니페스트 `id` 와 같아야 하고(예: `stretch.done`), 이름 부분에는 점(`.`)이 없다. 매니페스트에 없는 id 를 코드에서 쓰면 `E_PERMISSION` 이다. 트레이 항목의 `action` 도 선언된 액션이어야 한다.

그 밖의 필드(`$schema` 등)는 있어도 무시한다. `docs/examples/hello-demo/manifest.json` 은 필드 모양을 보기에 좋지만 **코드가 없는 매니페스트뿐인 예제**라서 그대로 복사하면 `entry path is invalid` 로 거부된다.

### 3.3 entry 경로 규칙

`entry` 는 플러그인 폴더 기준의 상대 경로다(보통 `dist/index.js`).

- 구분자는 `/`. 비어 있지 않고 260자 이하. `\`, NUL, `:` 를 포함하거나 절대 경로(`/x`, `C:...`, `\\서버`)이거나 `..`·빈 구간이 있으면 거부한다.
- 확장자는 `.js`, `.mjs`, `.cjs` 만. 실제 파일이 있는 일반 파일이어야 하고, 경로 중간의 폴더나 파일이 심볼릭 링크·정션이면 거부한다(폴더 밖으로 나가는 것도 같다).
- 검사는 스캔 때와 실행 직전에 한다. 파일이 없으면(빌드 전) `entry path is invalid` 다.
- 진입 파일은 ES 모듈이어야 하고 `export default` 가 `activate` 함수를 가져야 한다. 아니면 시작 오류(`plugin entry has no default export with activate()`)로 3회 규칙에 걸린다. 플러그인 폴더에 `"type": "module"` 이 든 `package.json` 을 두면 `.js` 를 ES 모듈로 확실히 읽는다(저장소 안 플러그인은 이미 그렇다).
- 플러그인이 import 하는 의존성(`node_modules`)은 이 검사의 대상이 아니다.

### 3.4 매니페스트가 거부될 때

상태가 `invalid` 가 되고 `reason` 이 남는다(10장). 이유 문구는 고정이며 다음 중 하나다.

| reason | 뜻 |
|---|---|
| `plugin folder must be a directory` / `plugin folder leaves scan root` | 폴더가 아니거나 링크 |
| `manifest must be a regular file` / `manifest exceeds 64 KiB` / `plugin files could not be read` | 파일 문제 |
| `manifest is not valid JSON` | JSON 오류(BOM 포함) |
| `apiVersion must be "1"` | `apiVersion` 이 `"1"` 이 아님 |
| `manifest is invalid` | 그 밖의 검증 오류. **어느 필드인지는 알려 주지 않는다.** 테스트에서 `validatePluginManifest(manifest)` 를 호출하면 오류 목록(`errors`)이 나온다. 2.5 의 첫 테스트가 이 확인이다 |
| `manifest id differs from folder name` | 폴더 이름 ≠ `id` |
| `network IP literals are forbidden` | `permissions.network` 에 IP |
| `entry path is invalid` | 3.3 의 규칙 위반, 또는 빌드 전 |

한 플러그인이 `invalid` 여도 다른 플러그인은 정상으로 로드된다.

## 4. 권한과 사용자 허용

### 4.1 선언하지 않으면 막히는 것

권한 검사는 **앱 본체(main 프로세스)** 가 한다. 플러그인 쪽 코드를 우회해도 소용없다. 막히면 해당 `ctx` 호출이 거부되고, 던져진 오류의 `code` 속성이 아래 코드다.

| 쓰려는 것 | 필요한 선언 | 선언이 없거나 어기면 |
|---|---|---|
| `ctx.fetch` | `permissions.network` 에 그 호스트 | 호스트가 목록에 **정확히** 같아야 한다(서브도메인은 따로 선언). `https` 만, 포트·사용자 정보·끝 점·IP 금지. 어기면 `E_PERMISSION` |
| `ctx.openExternal` | `permissions.openExternal` 에 맞는 패턴 | 패턴 밖 주소는 `E_PERMISSION`. 쿼리·해시는 자유. 사용자 액션 안에서만(4.2) |
| `ctx.secrets.get/set` | `permissions.secrets: true` | `E_PERMISSION` |
| `ctx.exec` | `permissions.shell: true` | 선언이 없으면 **`ctx.exec` 속성 자체가 없다**(`undefined`). 있어도 사용자 액션 안에서만 |
| `ctx.windows.create` | `permissions.windows` 에 창 id, 시작 주소 호스트는 `network` 에도 | `E_PERMISSION` |
| `registerAction` / `addTrayItem` / `setBadge` | `contributes.actions` / `trayItems` / `badges` 에 id | `E_PERMISSION` |

그 밖에 `ctx.emit` 도 검사받는다(7장): `source` 는 자기 id 여야 하고, 버튼 `action` 은 `<자기 id>.` 로 시작해야 한다. 이 검사는 **플러그인이 `ctx.emit` 으로 보내는 이벤트에만** 걸리고, 외부 `http` 이벤트에는 걸리지 않는다(7.4).

오류 코드: `E_PERMISSION`(권한·선언 위반), `E_INVALID_ARGUMENT`(인자 모양), `E_NOT_SERIALIZABLE`(호스트로 보낼 수 없는 값. 함수·클래스 인스턴스 등), `E_TIMEOUT`, `E_RATE_LIMIT`(플러그인당 초당 100건, 등록 256개 등), `E_UNAVAILABLE`, `E_DISPOSED`(정리된 뒤의 호출).

### 4.2 GET 외의 fetch 와 exec 는 "사용자가 누른 버튼" 안에서만

규칙(D-009, ADR-0003·0005): 

- `ctx.fetch` 는 GET·HEAD 를 어디서나 쓸 수 있다(`activate`, 스케줄 콜백 포함).
- **POST 등 다른 메서드, `ctx.exec`, `ctx.openExternal`, 창을 `show: true` 로 여는 것은 사용자 액션 안에서만** 된다. 사용자 액션이란 사용자가 누른 말풍선 버튼, 트레이 메뉴 항목, 또는 `settings.json` 의 `httpActionAllowlist` 에 id 가 적힌 액션의 `POST /action/:id` 호출이다. 그 호출이 실행하는 **액션 핸들러가 끝나기 전까지**(최대 60초) 안에서만 열려 있다.
- `activate`, `schedule.every/at/onResume` 콜백, `onConfigChange` 에서는 허용되지 않는다(`E_PERMISSION`). 자동으로 도는 경로가 사용자 클릭 없이 외부에 쓰는 일을 막기 위한 규칙이다.
- 핸들러 안에서 쓰기 호출을 반드시 `await` 한다. 핸들러가 끝난 뒤에 이어 가는 `void ctx.fetch(...)` 는 거부된다.
- `/action/:id` 는 기본 허용 목록이 비어 있어(플러그인 액션은 `404`) 쓰려면 사용자가 `settings.json` 에 `"httpActionAllowlist": ["stretch.remind"]` 처럼 적어야 한다.

```ts
ctx.registerAction("net.approve", async (args) => {
  // 사용자 버튼이 부른 핸들러 안: POST 가능. 반드시 await.
  await ctx.fetch("https://api.example.com/approve", { method: "POST", body: JSON.stringify(args) });
});
ctx.schedule.every(60_000, async () => {
  await ctx.fetch("https://api.example.com/status");                         // GET: 가능
  // await ctx.fetch("https://api.example.com/x", { method: "POST" });        // 거부: 스케줄 콜백
});
```

`fetch` 의 그 밖의 규칙: 쿠키는 쓰지 않는다. 요청 본문은 문자열 또는 바이트만(`FormData`·`Blob`·스트림은 `E_NOT_SERIALIZABLE`), 응답 본문은 10 MiB 이하이고 스트리밍은 지원하지 않는다. 시간 제한 30초. 리다이렉트는 GET·HEAD 만 최대 5번 따라가며 매번 호스트 규칙을 다시 검사한다(다른 호스트로 가면 `Authorization`·`Cookie` 헤더를 지운다). `exec` 은 셸 없이 실행(`execFile`)하고, `.cmd`·`.bat` 은 실행할 수 없으며(`E_UNAVAILABLE`), 30초·출력 1 MiB 제한과 정리된 환경 변수(`PATH`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`)만 쓴다. 명령이 0 이 아닌 코드로 끝나면 던지지 않고 `{ stdout, code }` 로 돌려준다.

### 4.3 처음 켤 때 허용 창, 권한이 늘면 다시 묻기

- 플러그인 코드는 **허용되기 전에는 실행하지 않는다.** 설정 스키마를 읽으려는 import 도 마찬가지다.
- `permissions` 가 비어 있으면(`{}`, 또는 모두 `false`·빈 배열) 창 없이 바로 허용으로 기록한다.
- 비어 있지 않으면 앱 시작 때 허용 창이 뜬다. `"<name>" 플러그인이 아래 권한을 요청합니다` 아래에 권한을 한국어로 나열한다(`shell` 은 "임의 명령 실행"으로 강조). 버튼은 **허용 / 허용 안 함**이고 플러그인마다 하나씩 차례로 뜬다. 창이 떠 있는 동안 그 플러그인은 `needs-permission` 이고 다른 플러그인은 계속 로드된다.
- 결정은 `<userData>\plugin-grants.json` 에 `permissions` 의 해시와 함께 기록된다. 같은 권한이면 다음 실행부터 묻지 않는다. "허용 안 함"도 기록되어 다시 묻지 않고 상태가 `denied` 가 된다.
- **권한이 늘거나 바뀌면 다시 묻는다.** 새 `permissions` 가 이전에 허용한 것의 부분집합이면(권한을 줄인 경우) 묻지 않고 기록만 갱신한다. "허용 안 함"이었던 플러그인은 권한을 바꿔야 다시 묻는다. `contributes`·`version`·코드를 바꾼 것은 다시 묻지 않는다.
- 결정을 되돌려 다시 묻게 하려면 앱을 끈 뒤 `plugin-grants.json` 에서 그 플러그인 항목을 지우거나 파일을 지우고 다시 켠다.

**개발 실행의 함정.** 개발 제어(`--dev-control=...`)가 켜진 실행에서는 허용 창을 **띄우지 않는다.** `--permission-answer=allow|deny|hold` 를 주지 않으면 "허용 안 함"으로 처리하고 그 결정이 `plugin-grants.json` 에 기록된다(이후 같은 권한으로는 다시 묻지 않으므로 `denied` 가 남는다). `start-deskpet.cmd` 와 `pnpm desktop:start` 가 개발 제어를 켠다. 새 플러그인을 시험할 때는 `--permission-answer=allow` 를 같이 주거나, 개발 제어 없이 `pnpm --filter @deskpet/desktop start` 로 실행해 실제 허용 창을 쓴다. 이미 `denied` 로 기록되었다면 위처럼 항목을 지운다.

## 5. PluginContext API

`activate(ctx)` 에 받는 `ctx` 의 전체 표면이다(`PluginContext`, v1). 등록하는 API 는 `Disposable`(`dispose()`)을 돌려주고, 플러그인이 꺼질 때 호스트가 남은 등록을 모두 정리한다. `dispose()` 는 여러 번 불러도 안전하다. 등록은 플러그인당 256개까지다.

### 5.1 이벤트 보내기: `ctx.emit(event)`

```ts
ctx.emit({ source: "stretch", type: "notify", key: "stretch", text: "스트레칭할 시간이에요", priority: "normal" });
```

반환값이 없고 기다리지 않는다. 호스트가 `validatePetEvent` 로 검사하고, 틀리면 거부하고 로그에 `emit failed: E_INVALID_ARGUMENT` 를 남긴다(`activate` 도중이면 활성화가 실패한다). `source` 는 자기 플러그인 id, 버튼 `action` 은 `<자기 id>.` 로 시작해야 한다. 이벤트의 모양과 규칙은 7장.

### 5.2 액션: `ctx.registerAction(id, handler)`

```ts
ctx.registerAction("stretch.done", async (args) => { /* 사용자가 누른 버튼의 일 */ });
```

`id` 는 `contributes.actions` 에 선언되어 있어야 한다. 같은 id 를 살아 있는 상태로 두 번 등록하면 오류다. `handler(args?)` 의 `args` 는 말풍선 버튼의 `args`(또는 HTTP 액션 호출의 `args`)이고 구조화 복제 가능한 값이어야 한다. 핸들러는 30초 안에 끝나야 하고 던지면 오류 1회로 센다(10장). 핸들러 안에서는 쓰기 호출이 열린다(4.2).

### 5.3 트레이 항목: `ctx.addTrayItem({ id, label, action })`

```ts
ctx.addTrayItem({ id: "stretch.tray-remind", label: "지금 스트레칭 알림", action: "stretch.remind" });
```

`id` 는 `contributes.trayItems` 에, `action` 은 `contributes.actions` 에 선언되어야 한다. `label` 은 1~40자. 트레이의 [플러그인] 하위 메뉴와 펫 우클릭 메뉴에 나타나고, 누르면 그 액션이 사용자 액션으로 실행된다.

### 5.4 스케줄: `ctx.schedule`

```ts
ctx.schedule.every(5 * 60_000, async () => { /* 5분마다 */ });
ctx.schedule.at("30 9 * * 1-5", async () => { /* 평일 09:30 */ }, { tz: "Asia/Seoul" });
ctx.schedule.onResume(() => { /* 잠자기에서 돌아왔을 때 */ });
```

- 타이머는 플러그인이 아니라 앱 본체가 갖는다. 콜백에서는 쓰기 호출이 열리지 않는다(4.2).
- `every(ms, fn)`: `ms` 는 1000 이상의 정수(권장 60초 이상). 이전 실행이 끝나지 않았으면 이번 발생은 건너뛴다. 잠자기에서 돌아오면 그 시점부터 다시 센다. `fn` 은 `Promise<void>` 를 돌려주는 함수다(`async`).
- `at(cron, fn, { tz })`: 지원하는 꼴은 **`"M H * * D"`** 뿐이다. `M` 0–59, `H` 0–23, 일·월 자리는 `*`, `D` 는 `*` 또는 0–6(0 = 일요일)의 쉼표 목록·범위(`1,3,5`, `1-5`). 그 밖의 꼴(`*/5`, 이름, 7)은 등록할 때 `E_INVALID_ARGUMENT` 다. `tz` 는 IANA 시간대 이름이고 생략하면 PC 의 현지 시간대다. 늦게 깨면(잠자기 복귀) 놓친 발생을 한 번만 실행한다.
- `onResume(fn)`: 시스템이 잠자기에서 깨어날 때. `fn` 은 동기 함수다.
- 콜백이 던지거나 30초를 넘기면 오류 1회로 센다.

### 5.5 반응 규칙: `ctx.addReactionRule(rule)`

```ts
ctx.addReactionRule({ match: { source: "stretch", type: "notify" }, play: "happy", durationMs: 2000 });
```

이벤트가 어떤 캐릭터 동작을 재생할지 정한다. `match` 의 `source`·`type`·`mood`·`priority` 는 모두 선택이고, 조건을 더 많이 지정한 규칙이 이기며 같으면 나중 규칙이 이긴다. `play` 는 캐릭터 상태 이름(기본 팩에는 `idle blink walk sleep happy surprised worried talk drag`)이고 `durationMs`(1–60000), `repeat`(1–10), `sound` 는 선택이다. 규칙이 없으면 이벤트의 `mood` 와 같은 이름의 상태를 재생한다(`sleepy` 는 `sleep`, `neutral` 은 없음, `urgent` 는 3번 반복).

### 5.6 배지: `ctx.setBadge(id, badge | null)`

```ts
ctx.setBadge("stretch.count", { text: "3", tone: "ok" });   // tone: "neutral" | "warn" | "ok"
ctx.setBadge("stretch.count", null);                          // 지우기
```

`id` 는 `contributes.badges` 에 선언되어야 하고 `text` 는 1~40자다. **현재 앱은 배지를 저장만 하고 화면 어디에도 표시하지 않는다**(2026-10-10 코드). 호출 규칙은 지켜야 하지만 눈으로는 확인되지 않으니, 사용자에게 알릴 일은 `emit` 으로도 알린다.

### 5.7 설정: `ctx.config`, `ctx.onConfigChange(fn)`

```ts
const minutes = typeof ctx.config.intervalMinutes === "number" ? ctx.config.intervalMinutes : 50;
ctx.onConfigChange((next) => { /* 설정 창에서 저장한 새 값 */ });
```

`ctx.config` 는 읽기 전용(깊게 동결)이며 `activate` 시점의 값이다. 사용자가 설정 창에서 저장하면 `ctx.config` 가 새 값으로 바뀌고 `onConfigChange` 콜백이 `next` 로 불린다(짧은 시간에 여러 번 저장하면 마지막 값만). 손으로 `settings.json` 을 고친 것은 재시작 때 반영된다. 값이 없거나 형식이 틀린 항목이 어떻게 정리되는지는 6장. 콜백에서는 쓰기 호출이 열리지 않고, 던지면 오류 1회다.

### 5.8 비밀 값: `ctx.secrets`

```ts
await ctx.secrets.set("token", value);
const token = await ctx.secrets.get("token");   // 없으면 null
```

`permissions.secrets: true` 가 필요하다. 키는 영문·숫자·`_.-` 1~64자, 값은 8 KiB 이하, 플러그인당 64개. 값은 Windows 의 보호 저장소(Electron `safeStorage`)로 암호화되어 플러그인별로 따로 저장된다. 암호화를 쓸 수 없으면 `set` 이 `E_UNAVAILABLE` 이고 평문으로 저장하지 않는다. 로그에는 이 값을 넣지 않는다(호스트도 로그에서 한 번 더 가리지만 완전하지 않다).

### 5.8.1 상태 저장: 영속 저장소는 없다

`PluginContext`(`packages/plugin-sdk/src/v1/contracts.ts`)에는 일반 상태를 저장하는 API 가 없다. `activate` 안의 변수로 들고 있는 값(2.4 의 `done`, "오늘 마신 잔 수" 같은 것)은 **앱을 다시 켜거나 플러그인이 다시 시작하면(10.2) 사라지고** 처음 값으로 돌아간다. 현재 가능한 방법은 다음뿐이다.

- `ctx.config`: 사용자가 설정 창에서 넣은 값을 **읽기만** 한다. 플러그인이 쓸 수 없다.
- `ctx.secrets`: 코드상 문자열을 쓰고 읽을 수는 있지만(키 64개, 값 8 KiB) 비밀 값 전용이다. 쓰려면 `permissions.secrets: true` 가 필요하고, 그러면 허용 창에 "비밀 값(토큰, 비밀번호)을 저장하고 읽기"가 뜬다. 카운터 같은 일반 상태를 넣는 용도로 권하지 않는다.
- 파일·DB 같은 다른 저장 수단은 SDK 에 없다. 재시작 때 사라져도 되게 설계한다(예: 시작할 때 0 에서 센다).

### 5.9 외부 링크와 네트워크: `ctx.openExternal`, `ctx.fetch`

```ts
await ctx.openExternal("https://example.com/stretch");                 // 사용자 액션 안에서만
const res = await ctx.fetch("https://api.example.com/status");         // 표준 fetch 와 같은 모양
const data = (await res.json()) as { open: number };
```

규칙은 4.1·4.2. `ctx.fetch` 는 표준 `fetch` 와 같은 시그니처이고 `Response` 를 돌려준다.

### 5.10 창: `ctx.windows.create(id, opts)` (로그인이 필요한 조회용)

```ts
const win = await ctx.windows.create("login", { url: "https://lms.example.com/", show: false });
const { status, body } = await win.getJson("/api/me");      // GET 만, 창의 출처와 같은 곳, 로그인 쿠키 포함
win.show();                                                  // 사용자 액션 안에서만
win.dispose();
```

`id` 는 `permissions.windows` 에, 시작 주소 호스트는 `permissions.network` 에 있어야 한다(https). 옵션은 `url`, `show`, `width`, `height`(200–4096), `title`(80자 이하)뿐이다. 창은 Node 통합 없이 열리고 플러그인별 세션 저장소를 쓰며, 다른 호스트로의 이동·새 창은 막힌다. `getJson(path)` 는 `/` 로 시작하는 같은 출처의 경로만 받고 메서드·헤더·본문은 정할 수 없으며 20초 제한, 응답 1 MiB 이하, JSON 이 아니면 `body` 가 `null` 이다. 동시에 열 수 있는 창은 선언한 창 id 개수와 앱 전체 4개가 상한이다. 쿠키·응답 본문을 로그에 남기지 않는다.

### 5.11 로그: `ctx.log`

```ts
ctx.log.info("stretch: activated");   // debug | info | warn | error, 문자열만
```

한 줄 2048자까지. 로그 파일에 `[plugin:<id>] 메시지` 로 남는다(10장). 호스트가 토큰·`Authorization`/`Cookie` 줄·알려진 비밀 값을 `***` 로 가리지만 1차 책임은 플러그인에 있다. 비밀·메시지 본문·쿠키를 넣지 않는다. `console.log` 는 `info`, `console.error` 는 `warn` 으로 기록된다.

### 5.12 활성화와 정리

```ts
const plugin: PluginDefinition = {
  configSchema,            // 선택. 6장
  activate(ctx) { /* 등록은 여기서 */ },
  deactivate() { /* 선택. 5초 안에 끝낸다 */ },
};
export default plugin;
```

순서: 허용 확인 → 플러그인 프로세스 시작 → `configSchema` 보고 → 설정을 정리해 전달 → `activate`(30초 제한, 넘기면 프로세스를 죽인다). 꺼질 때: `deactivate`(5초) → 호스트가 등록(액션·트레이·배지·반응 규칙·타이머)을 모두 제거 → 종료. `activate` 가 던지거나, `activate` 동안 보낸 등록·`emit` 이 거부되면 활성화 실패로 오류 1회다.

## 6. 설정: configSchema

`configSchema` 를 선언하면 설정 창 [플러그인] 탭에 그 플러그인의 입력 폼이 **자동으로 만들어진다.** 폼은 플러그인이 `running` 일 때만 나온다(허용 전, 거부, `invalid`, `disabled`, 시작 중에는 상태 안내만 나온다).

```ts
import type { ConfigSchema } from "@deskpet/plugin-sdk";

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    intervalMinutes: { type: "number", title: "알림 간격(분)", description: "1 이상", default: 50 },
    message: { type: "string", title: "말풍선 문구", default: "일어나서 스트레칭할 시간이에요" },
    quiet: { type: "boolean", title: "조용히", default: false },
    mode: { type: "string", title: "모드", enum: ["a", "b"], default: "a" },
    token: { type: "string", title: "토큰", secret: true },
  },
  required: ["message"],
};
```

### 6.1 필드와 입력칸

| 필드 선언 | 입력칸 |
|---|---|
| `type: "string"` | 한 줄 텍스트 (1000자 이하) |
| `type: "number"` | 숫자 |
| `type: "boolean"` | 체크박스 |
| `enum: [...]` 를 가진 string·number | 선택 목록. `required` 가 아니면 "(선택 안 함)" 이 붙는다 |
| `type: "array"` | 항목을 추가·삭제하는 목록(100개 이하). `items` 로 모양을 정한다 |
| `secret: true` | 비밀번호 칸. 아래 6.3 |

공통 속성: `title`(칸 제목, 없으면 필드 이름), `description`(설명), `default`, `required`(스키마 최상위 `required: [...]` 에 이름을 넣으면 필수 표시와 저장 검사).

`type: "array"` 의 `items`:

- `{ type: "string" }`: 문자열 목록.
- `{ type: "object", properties: {...}, required?: [...] }`: 객체 목록(행 단위 편집). `properties` 의 값은 `string`·`number`·`boolean` 스칼라 또는 평평한 배열 `{ type: "array", items: { type: "string" | "number" }, enum? }` 이다. 이때 배열의 `enum` 은 배열이 아니라 **원소**의 허용값이고 체크박스로 보인다(요일 선택처럼). 중첩 배열·객체는 쓸 수 없다. 실제 예는 `plugins/reminders/src/index.ts` 의 `rules`.

스키마가 이 형태를 벗어나면(`type` 이 위 4가지가 아니거나, 배열이 아닌데 `items`, 불리언·배열·객체인 `items`, 배열 속성인데 `items` 없음 등) **`configSchema` 전체를 무시한다.** 폼이 나오지 않고 설정은 저장된 값 그대로(정리 없이) 전달된다.

### 6.2 `ctx.config` 에는 이렇게 들어온다

호스트가 활성화할 때와 설정이 바뀔 때, 저장된 값(`settings.json` 의 `plugins.<id>`)을 스키마로 정리해서 준다.

- 스키마에 **선언된 속성만** 전달한다(선언하지 않은 키는 버린다). `secret` 필드는 넣지 않는다.
- 값이 없으면 `default` 로 채운다. `default` 도 없으면 키가 없다(플러그인이 직접 처리한다).
- 타입이 틀리거나 `enum` 에 없는 값은 버리고 `default` 로 대체하며 로그에 경고를 남긴다.
- 객체 배열은 **틀린 원소만 버리고** 나머지는 유지한다(원소의 `required`·타입·`enum` 을 검사. 선언하지 않은 속성은 그대로 통과).
- `required` 는 설정 창에서 저장할 때의 검사다. 손으로 고친 파일이나 첫 실행에는 값이 없을 수 있으니 코드에서 방어한다.
- 타입과 `enum` 은 맞춰서 오지만 범위(예: 간격이 1 이상인지)는 검사하지 않는다. 코드에서 직접 검사한다(2.4 의 `settings()`).

### 6.3 비밀 필드

`secret: true` 인 필드는 `settings.json` 이 아니라 암호화된 비밀 저장소에 **필드 이름을 키로** 저장된다. `ctx.config` 에는 들어오지 않고, 플러그인은 `ctx.secrets.get("token")` 으로 읽는다. 그래서 `permissions.secrets: true` 가 필요하다(없으면 입력칸이 막히고 저장이 거부된다). 설정 창은 값을 다시 보여 주지 않고 "저장됨/없음"과 "지우기" 만 보여 준다.

## 7. PetEvent와 알림 규칙

플러그인이 펫에게 보내는 이벤트다(`PetEvent`, `docs/adr/0001-pet-event.md`). 모르는 필드는 무시한다.

| 필드 | 형식 | 필수 | 의미 |
|---|---|---|---|
| `source` | string | 예 | **플러그인 id** (다른 값이면 `E_PERMISSION`). 외부에서 오는 이벤트는 `http` |
| `type` | `"notify"` \| `"react"` \| `"status"` | 예 | 아래 7.1 |
| `key` | string | 아니요 | 같은 `source` 안에서 같은 `key` 의 대기 중 알림을 최신 것으로 바꾼다 |
| `text` | string | 아니요 | 말풍선 문구. 유니코드 코드 포인트 120개 이하 |
| `detail` | string | 아니요 | 보조 내용. **현재 화면에 표시되지 않는다** |
| `voice` | `{ kind, slots? }` | 아니요 | 캐릭터 어투 문구를 쓰게 한다. `kind` 는 `done waiting failed info deadline reminder alert`, `slots` 는 `task result folder message`(각 500자 이하, 제어 문자 금지). 어투 템플릿이 없으면 `text` 를 쓰므로 `text` 도 함께 준다 |
| `mood` | `happy` `surprised` `sleepy` `worried` `neutral` | 아니요 | 표정(같은 이름의 캐릭터 상태 재생) |
| `priority` | `low` `normal` `high` `urgent` | 아니요 | 7.2 |
| `actions` | `{ label, action, args? }[]` | 아니요 | 말풍선 버튼. **최대 3개** |
| `ttlMs` | 1 이상의 정수 | 아니요 | 큐에서 기다릴 수 있는 시간(받은 시각 기준) |
| `timestamp` | 정수(epoch ms) | 아니요 | 생략하면 앱이 받은 시각을 넣는다 |

선택 필드에 `undefined` 를 넣으면 검증이 실패한다. 쓰지 않을 필드는 객체에서 빼 둔다.

### 7.1 종류

- **`notify`**: 알림. 큐에 들어가 차례로 **말풍선**(`text` 가 있고 `priority` 가 `low` 가 아닐 때)과 표정으로 나온다. `text` 가 없으면 표정만 바뀐다.
- **`react`**: 동작만. 큐 없이 바로 `mood`(또는 반응 규칙)에 맞는 캐릭터 동작을 재생한다. 말풍선은 없고 `text` 는 쓰이지 않는다.
- **`status`**: 지속 상태를 위한 종류. **현재 앱은 받아서 기록만 하고 화면에는 아무것도 하지 않는다**(2026-10-10 코드).

### 7.2 우선순위, key, ttl, 큐 규칙

| 규칙 | 내용 |
|---|---|
| `priority` | `low`: 표정만, 말풍선 없음. `normal`: 6초, `high`: 10초, `urgent`: 15초 동안 말풍선. 생략하면 `normal` |
| 순서 | 대기 중인 알림은 우선순위가 높은 것부터, 같으면 먼저 온 것부터 나온다 |
| 간격 | 말풍선이 닫힌 뒤 **최소 5초**가 지나야 다음 말풍선이 나온다. `urgent` 도 이 간격을 지킨다 |
| 방해 금지 | 방해 금지 중에는 `urgent` 가 아닌 알림을 붙잡아 두었다가 끝나면 요약 하나로 보여 준다 |
| `key` | 대기 중에(아직 안 나온 것) 같은 `source`+`key` 가 또 오면 앞의 것을 최신 것으로 **바꾼다**. 다른 플러그인의 같은 `key` 는 별개다. 반복되는 상태 알림에는 `key` 를 준다 |
| 묶기 | 같은 `source` 의 알림이 30초 안에 **3개 이상** 대기하면 `"<source> 알림 N개"` 하나로 묶인다. 묶인 말풍선에는 **버튼이 없다.** 그래서 버튼이 있는 알림은 `key` 로 합치거나 간격을 둔다 |
| `ttlMs` | 큐에서 이 시간 넘게 기다린 알림은 버려진다(이미 나온 말풍선을 일찍 닫지는 않는다). 오래되면 의미 없는 알림에 준다 |
| 상한 | 대기열은 100개. 넘으면 우선순위가 낮고 오래된 것부터 버린다 |

### 7.3 말풍선 버튼

```ts
actions: [
  { label: "했어요", action: "stretch.done" },
  { label: "방법 보기", action: "stretch.help", args: { page: 1 } },
]
```

- 최대 3개. `label` 은 짧게 쓴다.
- `action` 은 **`<자기 플러그인 id>.<이름>`** 이어야 하고(다른 접두는 `emit` 이 거부된다), `contributes.actions` 에 선언하고 `registerAction` 으로 등록한 액션이어야 한다.
- `args` 는 핸들러의 인자로 전달된다. 구조화 복제 가능한 값만.
- 버튼은 말풍선이 떠 있는 동안(6/10/15초)만 누를 수 있다. 누르면 액션이 **사용자 액션으로** 실행되고(쓰기 호출 가능, 4.2) 말풍선이 닫힌다. 놓쳐도 되는 일이 아니면 트레이 항목(5.3)도 함께 둔다.

### 7.4 외부(`source: "http"`) 이벤트의 버튼 `action`

`<자기 id>.` 접두 규칙은 **플러그인이 `ctx.emit` 으로 보내는 이벤트**에만 적용된다(`packages/plugin-host/src/session.ts` 의 `emit` 처리: `source` 가 자기 id 가 아니거나 버튼 `action` 에 접두가 없으면 `E_PERMISSION`). 로컬 이벤트 서버의 `POST /event`(CLI `deskpet event` 포함)는 `validatePetEvent` 모양 검사만 하고(`apps/desktop/src/main/event-server.ts`) 버튼 `action` 의 접두를 보지 않는다. 그래서 `source: "http"` 이벤트의 버튼이 `water.today` 같은 플러그인 액션 id 를 가리켜도 이벤트는 받아들여진다. 실행 여부는 이렇다(`apps/desktop/src/main/index.ts` 의 `invokeBubbleAction`, `plugin-host-app.ts` 의 `invokeHttpAction`, `actions.ts` 의 `ActionRegistry`):

| 경로 | 결과 |
|---|---|
| 사용자가 말풍선 버튼을 누름 | 앱의 `ActionRegistry` 에 등록된 id 면 실행된다. **`httpActionAllowlist` 는 보지 않는다.** 등록되지 않은 id(플러그인이 꺼져 있거나 이름이 틀림)면 아무 일 없이 말풍선만 닫힌다 |
| `POST /action/:id` (ADR-0004 허용 목록 경로) | 플러그인이 등록한 액션은 `settings.json` 의 `httpActionAllowlist` 에 id 가 있어야 실행되고, 없으면 `404`. 플러그인이 아닌 앱 자체 액션(예: `deskpet.ping`)은 목록과 무관하게 실행된다 |
| 이벤트만 도착하고 누르는 사람이 없음 | 실행되지 않는다. 버튼 액션은 클릭 때만 돈다 |

실행된 플러그인 액션 핸들러는 사용자 액션으로 취급되어 쓰기 호출이 열린다(4.2). 그러므로 플러그인은 외부에서 온 버튼이 자기 액션을 `args` 와 함께 부를 수 있다고 가정하고, 액션 핸들러에서 `args` 값을 검사한다.

## 8. 빌드하고 앱에 넣기

### 8.1 빌드

TypeScript 를 `dist/index.js` 로 내보낸다. 2.3 의 `package.json`·`tsconfig.build.json` 이 그 설정이다.

```
pnpm --filter @deskpet/plugin-<이름> build      # 한 플러그인
pnpm build:host                                  # core·sdk·host·모든 plugins/*
```

앱이 읽는 것은 `manifest.json` 과 `entry` 의 파일(`dist/index.js`)이다. `src/` 는 필요 없다.

### 8.2 플러그인을 찾는 위치

시작할 때 스캔 루트의 **바로 아래 폴더**를 한 번 훑는다.

| 실행 방식 | 스캔 루트 |
|---|---|
| `--plugins-dir=<경로>` 를 준 실행 | 그 경로(상대 경로면 현재 폴더 기준으로 해석) |
| 저장소에서 개발 실행(`pnpm --filter @deskpet/desktop start`, `start-deskpet.cmd`, `pnpm desktop:start`) | 저장소의 `plugins/` (앱 폴더 `apps/desktop` 기준 `../../plugins`) |
| 설치본 | 앱 리소스 폴더의 `plugins` (현재 코드). **설치본 경로는 ADR-0010 이후 갱신한다.** ADR-0010 의 방향: 설치본은 `resources/plugins/<id>/{manifest.json, dist/index.js}` 를 읽고, 플러그인은 SDK 를 합친 단일 `dist/index.js` 로 번들하며, `--plugins-dir` 같은 개발 인자는 설치본에서 무시한다. 구현(M9 기준 3·5) 뒤에 이 절을 갱신한다 |

저장소 `plugins/` 에는 이미 `reminders`, `claude-code`, `codex`, `jungle`, `orca` 등이 들어 있어 개발 실행에서는 함께 로드된다(권한이 있는 것은 허용 창이 뜬다). 내 플러그인만 보고 싶으면 2.7 의 격리 실행처럼 `--plugins-dir` 로 따로 모은 폴더를 가리킨다. `userData\plugins` 폴더는 지금 스캔하지 않는다.

### 8.3 저장소 밖에서 쓰기

`--plugins-dir` 폴더 아래에 `<id>\manifest.json` 과 `<id>\dist\index.js`(`entry` 가 가리키는 파일)를 두면 된다(2.7). 이때 `dist/index.js` 가 런타임에 `@deskpet/plugin-sdk` 같은 워크스페이스 패키지를 import 하면 저장소 밖에서는 못 찾으므로, SDK 는 `import type` 으로만 쓴다(2.4). 다른 패키지가 필요하면 `dist/` 안에서 import 가 풀리도록 번들해 둔다. 플러그인 폴더에 `package.json`(`"type": "module"`)도 복사해 두면 `.js` 를 ES 모듈로 읽는 것이 확실하다.

### 8.4 반영

**핫 리로드는 없다.** 코드를 고치면 다시 빌드하고 앱을 다시 켠다. 꺼진 플러그인(`disabled`)은 트레이 [플러그인] 메뉴의 `다시 켜기 (<id>)` 로 다시 켠다(같은 코드로 다시 시작할 뿐이다).

## 9. 테스트: createTestContext

`@deskpet/plugin-sdk/testing` 의 `createTestContext(options)` 는 진짜 앱 없이 `activate` 를 실행해 볼 수 있는 가짜 `ctx` 와 기록을 돌려준다. 콜백(스케줄·액션)은 테스트가 부를 때만 실행된다.

```ts
import { createTestContext } from "@deskpet/plugin-sdk/testing";

const test = createTestContext({
  manifest: { permissions: { openExternal: ["https://example.com/stretch"] }, contributes: { actions: ["stretch.help"] } },
  config: { intervalMinutes: 10 },
});
plugin.activate(test.ctx);
await test.runAction("stretch.help");
expect(test.openExternalCalls).toEqual(["https://example.com/stretch"]);
```

### 9.1 옵션

| 옵션 | 뜻 |
|---|---|
| `manifest` | `Partial<PluginManifest>`. **`permissions` 와 `contributes` 만 쓴다.** 하네스가 이 선언대로 호출을 막는다 |
| `config` | `ctx.config` 의 초기값. 정리·기본값 채우기는 하지 않는다. 스키마에 맞춘 값을 직접 준다 |
| `secrets` | `ctx.secrets` 의 초기 내용 `{ 키: 값 }` |
| `fetch` | `ctx.fetch` 가 실제로 부를 대체 함수. **없으면 호출 시 `no test fetch substitute configured` 오류** (실제 네트워크는 쓰지 않는다) |
| `exec` | `ctx.exec` 의 대체 함수. 없으면 호출 시 `no test exec substitute configured` |
| `windowResponses` | `{ "/경로": { status, body } }`. `getJson` 의 가짜 응답. 없는 경로는 오류 |

### 9.2 돌려주는 것

| 이름 | 뜻 |
|---|---|
| `ctx` | `activate` 에 넘길 `PluginContext` |
| `events` | `ctx.emit` 으로 보낸 이벤트 배열 |
| `actions` | 등록된 액션 `Map<id, handler>` |
| `trayItems` | 등록된 트레이 항목 `Map<id, {id,label,action}>` |
| `reactionRules` | 등록된 반응 규칙 `Set` |
| `badges` | 현재 배지 `Map<id, {text,tone?}>` (`null` 로 지우면 빠진다) |
| `logs` | `{ level, message }[]` |
| `openExternalCalls` | `ctx.openExternal` 이 통과시킨 주소들 |
| `windows` | 만든 창들 `{ id, options, paths, visible }` (`paths` = `getJson` 으로 요청한 경로) |
| `schedules` | `{ every: {ms, fn}[], at: {cron, fn, opts?}[], onResume: fn[] }` (`dispose` 한 것은 빠진다) |
| `runAction(id, args?)` | 등록된 액션을 **사용자 액션으로** 실행(안에서 쓰기 호출이 열린다). 등록 안 된 id 면 오류 |
| `runEvery(i=0)` / `runAt(i=0)` / `runOnResume(i=0)` | 등록된 스케줄 콜백을 실행(쓰기 호출은 닫힌 상태) |
| `changeConfig(next)` | `ctx.config` 를 바꾸고 `onConfigChange` 콜백을 부른다 |

### 9.3 하네스가 막아 주는 것

선언하지 않은 호출을 실제 호스트처럼 거부한다(던지는 오류 메시지로 확인한다).

| 상황 | 오류 메시지(포함 문자열) |
|---|---|
| 선언하지 않은 액션·트레이·배지 | `action is not declared: ...`, `tray item is not declared: ...`, `badge is not declared: ...` |
| 목록에 없는 호스트로 `fetch` | `network host is not allowed: <호스트>` |
| `runAction` 밖(스케줄 콜백 등)에서 GET·HEAD 가 아닌 `fetch`, `exec` | `write operation requires a user-invoked action` |
| 선언하지 않은 `openExternal` 주소 | `external URL is not allowed: ...` |
| `secrets` 선언 없이 사용 | `secrets permission is not declared` |
| `shell` 선언 없이 `exec` | `ctx.exec` 가 `undefined` |
| 선언하지 않은 창 id | `window is not declared: ...` |

```ts
it("POST 는 버튼 핸들러 안에서만", async () => {
  const test = createTestContext({
    manifest: { permissions: { network: ["api.example.com"] }, contributes: { actions: ["net.approve"] } },
    fetch: async () => new Response("{}"),
  });
  plugin.activate(test.ctx);
  await test.runAction("net.approve");                                   // 통과
  await expect(test.ctx.fetch("https://api.example.com/x", { method: "POST" }))
    .rejects.toThrow("write operation requires a user-invoked action");  // 액션 밖
});
```

하네스에서 비동기 콜백을 실행하는 `runAction`·`runEvery`·`runAt` 은 `await` 한다. `activate` 가 `async` 면 `await plugin.activate(test.ctx)` 한다.

### 9.4 시간에 의존하는 코드

하네스에는 시계 대체가 없다. `Date`·`Date.now()` 를 쓰는 코드(예: 날짜가 바뀌면 카운터를 0 으로)는 vitest 의 가짜 타이머로 시각을 고정해 테스트한다. `vi.useFakeTimers()` 와 `vi.setSystemTime()` 이 `Date` 를 바꾼다.

```ts
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); });

it("날짜가 바뀌면 오늘 횟수를 0 으로 되돌린다", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T09:00:00+09:00"));
  const test = setup();                                        // 2.5 의 setup
  await test.runAction("water.drank");
  vi.setSystemTime(new Date("2026-10-11T09:00:00+09:00"));    // 다음 날
  await test.runAction("water.today");                         // 0 으로 보여야 한다
});
```

하네스의 스케줄과는 무관하다. `test.runEvery()`·`runAt()`·`runOnResume()` 은 등록된 콜백을 **직접 호출**할 뿐 시계를 보지 않으므로, 가짜 타이머로 시각을 앞으로 돌려도 콜백이 저절로 실행되지 않는다. 시각은 `vi.setSystemTime` 으로 정하고 콜백은 `runEvery()` 로 부른다. 끝나면 `vi.useRealTimers()` 로 되돌린다.

### 9.5 실행

저장소 루트에서 `pnpm test`(전체) 또는 `pnpm test plugins/stretch`(경로 필터). 테스트 파일은 `src/` 안의 `*.test.ts` 이며 `tsconfig.build.json` 이 빌드에서 제외한다. 하네스가 하지 않는 검사(이벤트 모양, `source` 접두 등)는 부록 11.1 이다. 이벤트는 `validatePetEvent`(`@deskpet/core`)로, 매니페스트는 `validatePluginManifest`(`@deskpet/plugin-sdk`)로 테스트에서 직접 확인한다.

## 10. 문제 해결

### 10.1 상태를 보는 곳

| 어디서 | 보이는 것 |
|---|---|
| 트레이 [플러그인] 하위 메뉴 | `이름: 상태 (이유)` 한 줄씩 |
| 설정 창 [플러그인] 탭 | 상태 문장과 설정 폼 |
| `pnpm deskpet status --json` | 앱의 `/status` 전체. `plugins` 배열에 `id`, `name`, `version`, `state`, `reason`, `consecutiveErrors` |
| `pnpm deskpet status` (옵션 없이) | 요약만 나오고 `플러그인: 개수` 만 보인다. **이유를 보려면 `--json`** |

`deskpet status` 는 앱이 떠 있어야 하고(`pnpm --filter @deskpet/cli build` 후), 개발 격리 실행이면 `--user-data-dir=<경로>` 를 맞춘다. 예(`invalid` 한 개와 정상 한 개):

```json
{"plugins":[
  {"id":"broken","state":"invalid","reason":"apiVersion must be \"1\"","consecutiveErrors":0},
  {"id":"stretch","name":"Stretch Reminder","version":"0.1.0","state":"running","consecutiveErrors":0}]}
```

`state`: `invalid`(매니페스트·파일 문제, `reason` 참고 3.4), `needs-permission`(허용 창 대기), `denied`(허용 안 함), `starting`, `running`, `restarting`(오류 뒤 다시 시작 대기), `disabled`(오류 3회 또는 사용자가 끔). `reason` 은 `invalid`·`disabled` 에만 있다.

### 10.2 오류가 3번 이어지면 꺼진다

- 오류로 세는 것: `activate`·액션 핸들러·스케줄 콜백·`onResume`·`onConfigChange` 콜백이 던지거나 거부하거나 시간 초과(30초), 요청하지 않은 프로세스 종료, 호스트 프로토콜 위반.
- 세지 않는 것: 플러그인이 `try/catch` 로 처리한 호출 실패(`E_PERMISSION`, 네트워크 오류 포함)와 `ctx.log.error`.
- **연속** 3회가 기준이다. 어떤 콜백이든 정상으로 끝나면 카운터가 0 으로 돌아간다.
- 3회가 되면 프로세스를 정리하고 `disabled`(`reason`: `오류가 3번 이어졌습니다`)로 두며 펫이 `"<name>" 플러그인을 껐어요. 오류가 3번 이어졌어요` 라고 알린다. 프로세스가 죽거나 `activate` 가 실패한 경우에는 첫 오류 뒤 1초, 두 번째 오류 뒤 5초에 다시 띄운다.
- 앱을 다시 켜면 한 번 더 시도한다(`disabled` 는 이번 실행 동안만 유지). 지금 다시 켜려면 트레이 [플러그인] 의 `다시 켜기 (<id>)`.
- 그래서 **오프라인 같은 외부 요인은 직접 `try/catch` 로 처리**한다. 폴링 콜백이 계속 던지면 3번 만에 꺼진다.

### 10.3 증상별 점검

| 증상 | 원인 |
|---|---|
| 목록에 아예 없다 | 스캔 루트 바로 아래 폴더가 아님, 이름이 `.`/`_` 로 시작, 폴더가 링크, 또는 `--plugins-dir` 이 다른 곳을 가리킴. 앱을 다시 켰는지 확인 |
| `invalid`, `entry path is invalid` | 빌드를 안 함(`dist/index.js` 없음), 경로 규칙 위반 |
| `invalid`, `manifest is invalid` | 필드 오류. 테스트에서 `validatePluginManifest` 의 `errors` 를 본다 |
| `invalid`, `manifest is not valid JSON` | JSON 문법 오류 또는 BOM |
| `needs-permission` 에서 멈춤 | 허용 창이 떠 있거나(다른 창 뒤), `--permission-answer=hold` |
| `denied` | 허용 안 함이 기록됨. 개발 제어 실행이면 4.3 의 함정. `plugin-grants.json` 항목을 지우거나 권한을 바꿔 다시 묻게 한다 |
| `running` 인데 말풍선이 안 뜬다 | `text` 없음, `priority: "low"`, 방해 금지 중, 전체 화면 앱이 떠 있음, 앞의 말풍선 뒤 5초 간격, 이벤트가 검증 실패(로그의 `emit failed: E_INVALID_ARGUMENT`), `type: "status"` |
| 버튼을 눌러도 아무 일 없다 | `action` 이 선언·등록되지 않았거나 `<id>.` 접두가 아님 |
| `E_PERMISSION` | 4.1 의 표. 선언 누락이거나, 사용자 액션 밖의 쓰기 호출(4.2) |
| 설정 폼이 안 나온다 | 플러그인이 `running` 이 아님, `configSchema` 없음, 6.1 의 모양 위반으로 스키마가 무시됨 |
| `disabled` | 10.2 |

### 10.4 로그

- 파일: `<userData>\logs\deskpet.log` (Windows 기본은 `%APPDATA%\deskpet\logs\deskpet.log`. 격리 실행이면 `--user-data-dir` 아래). 1 MiB 가 넘으면 `deskpet.1.log` … `deskpet.3.log` 로 돌려 이전 파일 3개를 남긴다. 트레이의 "로그 폴더 열기"로도 연다.
- 플러그인이 쓴 로그와 `console` 출력은 `[plugin:<id>] ...` 로, 호스트 자신의 메시지는 `[host] ...`(예: `[host] Invalid plugin broken: apiVersion must be "1"`)로 남는다.
- `ctx.emit` 등 기다리지 않는 호출이 거부되면 `[plugin:<id>] emit failed: E_INVALID_ARGUMENT` 처럼 `<메서드> failed: <코드>` 경고가 남는다.
- 로그는 한 줄 2 KiB 로 자르고 토큰·쿠키 줄을 가린다. 로그에 비밀·본문을 넣지 않는다.

## 11. 부록

### 11.1 테스트 하네스가 실제 호스트와 다른 점

하네스 테스트가 통과해도 앱에서는 거부될 수 있는 경우다. 아래는 테스트에서 직접 확인한다.

| 항목 | 하네스 | 실제 호스트 |
|---|---|---|
| `emit` 이벤트 | 아무거나 기록 | `validatePetEvent` 검사. `source` 가 플러그인 id 와 다르거나 버튼 `action` 에 `<id>.` 접두가 없으면 거부 |
| `fetch` 스킴 | `http:` 도 통과 | `https` 만. 포트·IP·끝 점도 거부 |
| `schedule.every` / `at` | 값 검사 없음 | `every` 는 1000ms 이상 정수, `at` 은 `M H * * D` 꼴만. 어기면 등록 시 `E_INVALID_ARGUMENT` |
| 트레이 `label`, 배지 `text` | 길이 검사 없음 | 1~40자 |
| `secrets` 키·값 | 형식·크기 검사 없음 | 키 `[A-Za-z0-9_.-]{1,64}`, 값 8 KiB, 64개 |
| `config` | 준 값 그대로 | 스키마로 정리(선언 안 한 키 제거, 기본값 채움, 타입 불일치 제거) |
| 직렬화 | 없음 | 함수·클래스 인스턴스가 든 `args`·이벤트는 `E_NOT_SERIALIZABLE` |
| 시간 제한·요청 빈도·등록 개수 | 없음 | 핸들러 30초, 초당 100건, 등록 256개 |
| 사용자 액션 맥락 | `runAction` 이 끝나면 닫힘 | 핸들러 Promise 가 끝나거나 60초가 지나면 닫힘 |
| 권한 허용 창 | 없음 | 4.3 |

### 11.2 만들기 전 점검표

- [ ] 폴더 이름 = 매니페스트 `id`, `apiVersion` 은 문자열 `"1"`, 파일은 BOM 없는 UTF-8.
- [ ] 쓰는 `ctx` 기능마다 권한(`permissions`)과 기여(`contributes`)를 선언했다. 모든 id 가 `<id>.` 로 시작한다.
- [ ] 이벤트의 `source` 는 내 id, 버튼 `action` 은 `<내 id>.` 로 시작하고 선언·등록되어 있다. 선택 필드에 `undefined` 를 넣지 않았다.
- [ ] GET 이 아닌 `fetch`, `exec`, `openExternal` 은 액션 핸들러 안에서 `await` 한다.
- [ ] 외부 요인으로 던질 수 있는 콜백은 `try/catch` 로 감쌌다(연속 3회 오류 = 꺼짐).
- [ ] `permissions.network` 는 https 호스트 이름만, 서브도메인은 따로.
- [ ] 빌드했고(`dist/index.js` 존재), 테스트가 통과하고, 앱을 다시 켰다.
- [ ] 비밀·쿠키·메시지 본문을 로그나 이벤트에 넣지 않았다.
