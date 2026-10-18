/* global console, process */
// 패키징 앞 단계: 플러그인 4종·CLI 를 단일 파일로 번들하고 hook 스크립트를 release/stage 에 모은다 (ADR-0010 3·4장).
// plugins/*/dist 는 건드리지 않는다. 선행: pnpm build:host, pnpm --filter @deskpet/cli build.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

export const repoRoot = resolve(import.meta.dirname, "..");
export const stageDir = resolve(repoRoot, "release/stage");
/** 설치본에 들어가는 플러그인. discord 는 뼈대(manifest 없음)라 넣지 않는다. */
export const bundledPlugins = ["claude-code", "codex", "jungle", "orca", "reminders", "slack"];
export const hookFiles = ["send-claude-code-event.mjs", "hook-message.mjs", "codex-notify-wrapper.mjs"];

/** 워크스페이스 패키지를 합친 단일 ESM 파일. node: 내장만 밖에 남긴다. */
async function bundle(entry, outFile) {
  const dir = resolve(outFile, "..");
  await build({
    root: repoRoot,
    configFile: false,
    logLevel: "warn",
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: entry,
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: "node22",
      rollupOptions: { output: { format: "es", entryFileNames: outFile.slice(dir.length + 1) } },
    },
  });
}

export async function stagePackaging() {
  rmSync(stageDir, { recursive: true, force: true });
  for (const id of bundledPlugins) {
    const source = resolve(repoRoot, "plugins", id);
    const manifestPath = resolve(source, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`plugins/${id}/manifest.json 이 없습니다`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.entry !== "dist/index.js") throw new Error(`plugins/${id} entry 가 dist/index.js 가 아닙니다: ${manifest.entry}`);
    const target = resolve(stageDir, "plugins", id);
    mkdirSync(target, { recursive: true });
    cpSync(manifestPath, resolve(target, "manifest.json"));
    if (id === "claude-code" || id === "codex") {
      if (manifest.contributes?.lines !== "lines.json") throw new Error(`plugins/${id} lines 가 lines.json 이 아닙니다`);
      cpSync(resolve(source, "lines.json"), resolve(target, "lines.json"));
    }
    await bundle(resolve(source, "src/index.ts"), resolve(target, "dist/index.js"));
  }
  const cliSource = resolve(repoRoot, "packages/cli/src/index.ts");
  await bundle(cliSource, resolve(stageDir, "cli/index.js"));
  mkdirSync(resolve(stageDir, "hooks"), { recursive: true });
  for (const file of hookFiles) cpSync(resolve(repoRoot, "docs/hooks", file), resolve(stageDir, "hooks", file));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await stagePackaging();
  console.info(`staged: ${stageDir}`);
}
