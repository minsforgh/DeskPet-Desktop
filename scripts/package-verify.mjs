/* global console, process, Buffer */
// 패키징 뒤 단계: release/win-unpacked 의 내용을 확인하고 설치 파일의 SHA-256 을 release/SHA256SUMS.txt 에 쓴다 (ADR-0010 3·4·8장).
// 하나라도 어긋나면 실패(종료 코드 1)한다.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const releaseDir = resolve(repoRoot, "release");
const unpacked = resolve(releaseDir, "win-unpacked");
const resources = resolve(unpacked, "resources");

const expectedPlugins = ["claude-code", "codex", "jungle", "orca", "reminders", "slack"];
const expectedPacks = ["placeholder", "wolf-maid"];
const expectedHooks = ["codex-notify-wrapper.mjs", "hook-message.mjs", "send-claude-code-event.mjs"];
const forbiddenPlugins = ["discord"];
const forbiddenPacks = ["mochi"];

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};
const names = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** asar 헤더(JSON)를 읽어 파일 목록을 돌려준다. 앞 16바이트가 크기 정보다(Pickle). */
export function readAsar(path) {
  const buffer = readFileSync(path);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString("utf8"));
  const base = 8 + buffer.readUInt32LE(4);
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = `${prefix}${name}`;
      if (entry.files) walk(entry, `${full}/`);
      else files.set(full, { entry, base });
    }
  };
  walk(header, "");
  const read = (file) => {
    const found = files.get(file);
    if (!found || found.entry.unpacked) return undefined;
    const start = found.base + Number(found.entry.offset);
    return buffer.subarray(start, start + found.entry.size).toString("utf8");
  };
  return { files: [...files.keys()].sort(), read };
}

/** 번들 소스에서 워크스페이스 패키지나 node 밖 모듈의 bare import 가 남았는지 본다. node: 내장과 electron 은 허용한다. */
export function bareImports(source) {
  const found = new Set();
  const pattern = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) continue;
    if (specifier.startsWith("node:") || specifier === "electron") continue;
    found.add(specifier);
  }
  return [...found];
}

check(existsSync(unpacked), "release/win-unpacked 가 없습니다");

// 캐릭터 팩
const packs = names(join(resources, "characters"));
check(JSON.stringify(packs) === JSON.stringify(expectedPacks), `characters 목록이 ${expectedPacks} 가 아닙니다: ${packs}`);
for (const id of expectedPacks) check(existsSync(join(resources, "characters", id, "manifest.json")), `characters/${id}/manifest.json 이 없습니다`);
for (const id of forbiddenPacks) check(!existsSync(join(resources, "characters", id)), `characters/${id} 가 들어 있습니다`);

// 플러그인
const plugins = names(join(resources, "plugins"));
check(JSON.stringify(plugins) === JSON.stringify(expectedPlugins), `plugins 목록이 ${expectedPlugins} 가 아닙니다: ${plugins}`);
for (const id of forbiddenPlugins) check(!existsSync(join(resources, "plugins", id)), `plugins/${id} 가 들어 있습니다`);
for (const id of expectedPlugins) {
  const dir = join(resources, "plugins", id);
  check(existsSync(join(dir, "manifest.json")), `plugins/${id}/manifest.json 이 없습니다`);
  if (id === "claude-code" || id === "codex") check(existsSync(join(dir, "lines.json")), `plugins/${id}/lines.json 이 없습니다`);
  const entry = join(dir, "dist/index.js");
  if (!existsSync(entry)) {
    problems.push(`plugins/${id}/dist/index.js 가 없습니다`);
    continue;
  }
  const bare = bareImports(readFileSync(entry, "utf8"));
  check(bare.length === 0, `plugins/${id}/dist/index.js 에 bare import 가 남았습니다: ${bare}`);
}

// CLI, hook
const cli = join(resources, "cli/index.js");
if (existsSync(cli)) {
  const bare = bareImports(readFileSync(cli, "utf8"));
  check(bare.length === 0, `cli/index.js 에 bare import 가 남았습니다: ${bare}`);
} else problems.push("cli/index.js 가 없습니다");
const hooks = names(join(resources, "hooks"));
check(JSON.stringify(hooks) === JSON.stringify(expectedHooks), `hooks 목록이 ${expectedHooks} 가 아닙니다: ${hooks}`);

// asar: 앱 코드, 감시 스크립트 상수, 개발용 팩·플러그인이 없음
const asarPath = join(resources, "app.asar");
let asarFiles = [];
if (existsSync(asarPath)) {
  const asar = readAsar(asarPath);
  asarFiles = asar.files;
  for (const required of ["package.json", "out/main/index.js", "out/main/plugin-runner.js", "out/renderer/index.html", "out/preload/index.cjs"]) {
    check(asarFiles.includes(required), `app.asar 에 ${required} 가 없습니다`);
  }
  const main = asar.read("out/main/index.js") ?? "";
  check(main.includes("SHQueryUserNotificationState"), "out/main/index.js 에 전체 화면 감시 스크립트가 없습니다");
  check(main.includes("TerrainProbe"), "out/main/index.js 에 지형 감시 스크립트가 없습니다");
  for (const file of ["out/main/index.js", "out/main/plugin-runner.js"]) {
    const bare = bareImports(asar.read(file) ?? "");
    check(bare.length === 0, `${file} 에 bare import 가 남았습니다: ${bare}`);
  }
  const stray = asarFiles.filter((file) => !file.startsWith("out/") && file !== "package.json");
  check(stray.length === 0, `app.asar 에 앱 코드 밖 파일이 있습니다: ${stray.slice(0, 5)}`);
  const pkg = JSON.parse(asar.read("package.json") ?? "{}");
  check(pkg.version === "0.1.0", `app.asar package.json 의 version 이 0.1.0 이 아닙니다: ${pkg.version}`);
} else problems.push("resources/app.asar 가 없습니다");
const resourceDirs = names(resources);
for (const forbidden of ["plugins-dev", "docs", "tools"]) check(!resourceDirs.includes(forbidden), `resources/${forbidden} 가 들어 있습니다`);

// 설치 파일과 해시
const installers = names(releaseDir).filter((file) => /^DeskPet-Setup-.+\.exe$/.test(file));
check(installers.length === 1, `설치 파일이 정확히 1개여야 합니다: ${installers}`);
check(installers.every((file) => file === "DeskPet-Setup-0.1.0.exe"), `설치 파일 이름이 DeskPet-Setup-0.1.0.exe 가 아닙니다: ${installers}`);
check(existsSync(join(unpacked, "DeskPet.exe")), "win-unpacked/DeskPet.exe 가 없습니다");

if (problems.length > 0) {
  console.error(`패키지 내용 확인 실패 (${problems.length}건):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const lines = installers.map((file) => {
  const hash = createHash("sha256").update(readFileSync(join(releaseDir, file))).digest("hex");
  return `${hash}  ${file}`;
});
writeFileSync(join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
for (const file of installers) console.info(`${join(releaseDir, file)}  ${(statSync(join(releaseDir, file)).size / 1024 / 1024).toFixed(1)} MB`);
console.info(lines.join("\n"));
console.info(`확인 통과: 팩 ${packs.join(",")} / 플러그인 ${plugins.join(",")} / hooks ${hooks.join(",")} / cli / asar ${asarFiles.length}개 파일 (${Buffer.byteLength(asarFiles.join("\n"))}B 목록)`);
