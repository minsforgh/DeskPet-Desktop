// electron-builder 설정 (ADR-0010). `pnpm package` 가 부른다. 점검용 빌드는 --config.appId 등으로 값을 덮어쓴다.
// 앱 코드(out/**)만 asar 에 넣고, 캐릭터 팩·플러그인·CLI·hook 스크립트는 asar 밖 resources/ 에 둔다.
// 플러그인·CLI·hook 은 scripts/package-bundle.mjs 가 release/stage 에 미리 만든다.
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const stage = resolve(repoRoot, "release/stage");

// 설치본에 넣는 내장 팩. mochi 는 빈 폴더(.gitkeep 뿐)라 제외한다.
const characterPacks = ["placeholder", "wolf-maid"];

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "com.deskpet.app",
  productName: "DeskPet",
  executableName: "DeskPet",
  artifactName: "DeskPet-Setup-${version}.${ext}",
  directories: { output: resolve(repoRoot, "release") },
  // 런타임 의존성이 없다(main 번들이 워크스페이스 패키지를 합친다: electron.vite.config.ts).
  files: ["out/**", "package.json"],
  extraResources: [
    { from: resolve(repoRoot, "characters"), to: "characters", filter: characterPacks.map((id) => `${id}/**`) },
    { from: resolve(stage, "plugins"), to: "plugins" },
    ...["jungle", "orca", "reminders", "slack"].map((id) => ({
      from: resolve(repoRoot, "plugins", id, "lines.json"), to: `plugins/${id}/lines.json`,
    })),
    { from: resolve(stage, "hooks"), to: "hooks" },
    { from: resolve(stage, "cli"), to: "cli" },
  ],
  asar: true,
  npmRebuild: false,
  // 루트 devDependency 의 electron 을 그대로 쓴다(다운로드 없음, 버전도 여기서 읽는다).
  electronDist: resolve(repoRoot, "node_modules/electron/dist"),
  electronVersion: "44.5.1",
  win: { target: [{ target: "nsis", arch: ["x64"] }], forceCodeSigning: false },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    // 제거 때 자동 시작 Run 값을 지운다 (ADR-0010 §6).
    include: resolve(import.meta.dirname, "build/installer.nsh"),
  },
};
