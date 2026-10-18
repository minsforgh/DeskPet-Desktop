/* global console, process, fetch, AbortSignal */
// 설치본 점검 (ADR-0010 2·5·9장, M9 기준 4·5). `pnpm package:check` 로 부른다. 먼저 `pnpm package` 가 끝나 있어야 한다(release/stage, apps/desktop/out).
// 점검용 appId(com.deskpet.app.check)·이름(DeskPetCheck)으로 설치 파일을 따로 빌드해 임시 폴더에 조용히 설치하고, 격리된 userData 로 실행해 확인한 뒤 제거한다.
// 사용자의 실제 %APPDATA%\deskpet 와 HKCU Run 값은 건드리지 않고, 실행 전후로 같은지 비교한다. 하나라도 어긋나면 종료 코드 1.
// 옵션: --no-build  이미 만든 release/check 의 설치 파일을 쓴다.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { delimiter, join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const checkOutput = join(repoRoot, "release", "check");
const APP_ID = "com.deskpet.app.check";
const PRODUCT = "DeskPetCheck";
const TEMP_PREFIX = "deskpet-check-";
const expectedPlugins = ["claude-code", "codex", "jungle", "orca", "reminders", "slack"];
const expectedLines = ["jungle", "orca", "reminders", "slack"];
const expectedPacks = ["placeholder", "wolf-maid"];
const loadedStates = ["needs-permission", "denied", "starting", "running", "restarting", "disabled"];
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

const problems = [];
const check = (ok, label) => {
  console.info(`${ok ? "통과" : "실패"}: ${label}`);
  if (!ok) problems.push(label);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(label, probe, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch { /* 아직 준비되지 않음 */ }
    await sleep(stepMs);
  }
  throw new Error(`${label} (${timeoutMs}ms 안에 되지 않음)`);
}

// --- 사용자 실제 상태 스냅샷 -------------------------------------------------
function regList(key) {
  const result = spawnSync("reg", ["query", key], { encoding: "utf8" });
  if (result.status !== 0) return []; // 키가 없으면 비어 있다
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}
function realSnapshot() {
  const dir = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "deskpet");
  const settings = join(dir, "settings.json");
  return {
    settings: existsSync(settings)
      ? { sha: createHash("sha256").update(readFileSync(settings)).digest("hex"), mtime: statSync(settings).mtimeMs }
      : null,
    entries: existsSync(dir) ? readdirSync(dir).sort() : null,
    run: regList(RUN_KEY),
    uninstall: regList(UNINSTALL_KEY),
  };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (a, b) => {
  const isEqual = equal(a, b);
  if (!isEqual) console.error(`  차이: 전 ${JSON.stringify(a)}
        후 ${JSON.stringify(b)}`);
  return isEqual;
};

// --- 점검용 설치 파일 --------------------------------------------------------
function buildInstaller() {
  for (const required of ["release/stage", "apps/desktop/out"]) {
    if (!existsSync(join(repoRoot, required))) throw new Error(`${required} 가 없습니다. 먼저 pnpm package 를 실행하세요`);
  }
  const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
  const args = [cli, "--config", "electron-builder.config.mjs", "--projectDir", "apps/desktop", "--win", "nsis", "--publish", "never",
    `--config.appId=${APP_ID}`, `--config.productName=${PRODUCT}`, `--config.executableName=${PRODUCT}`,
    "--config.nsis.createDesktopShortcut=false", "--config.nsis.createStartMenuShortcut=false", "--config.nsis.runAfterFinish=false",
    `--config.directories.output=${checkOutput}`];
  console.info("점검용 설치 파일을 만듭니다 (appId " + APP_ID + ")");
  const built = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
  if (built.status !== 0) throw new Error("점검용 설치 파일 빌드 실패");
}
function findInstaller() {
  const files = existsSync(checkOutput) ? readdirSync(checkOutput).filter((file) => /\.exe$/.test(file) && /Setup/.test(file) && !file.includes("__uninstaller")) : [];
  if (files.length !== 1) throw new Error(`release/check 에 설치 파일이 정확히 1개여야 합니다: ${files}`);
  return join(checkOutput, files[0]);
}

function pipeConnects(name) {
  return new Promise((done) => {
    const socket = connect(`\\\\.\\pipe\\deskpet-dev-${name}`);
    const timer = setTimeout(() => { socket.destroy(); done(false); }, 2000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); done(true); });
    socket.on("error", () => { clearTimeout(timer); done(false); });
  });
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows 에서만 실행합니다");
  if (!process.argv.includes("--no-build")) buildInstaller();
  const installer = findInstaller();
  console.info(`설치 파일: ${installer}`);

  const before = realSnapshot();
  console.info(`실제 데이터 스냅샷: settings.json ${before.settings ? "있음" : "없음"}, Run 값 ${before.run.length}줄, Uninstall 키 ${before.uninstall.length}줄`);

  const root = join(tmpdir(), `${TEMP_PREFIX}${randomBytes(4).toString("hex")}`);
  // 안전 검사: 이 접두를 가진 임시 폴더만 만들고 지운다.
  if (!root.startsWith(tmpdir() + sep) || !root.split(sep).at(-1).startsWith(TEMP_PREFIX)) throw new Error(`임시 폴더 이름이 이상합니다: ${root}`);
  const install = join(root, "install");
  const userdata = join(root, "userdata");
  const ignoredUserdata = join(root, "ignored-userdata");
  const fakePlugins = join(root, "fake-plugins");
  const fakeCharacters = join(root, "fake-characters");
  for (const dir of [root, userdata, ignoredUserdata, fakePlugins, fakeCharacters]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(fakePlugins, "evil"));
  writeFileSync(join(fakePlugins, "evil", "manifest.json"), "{}");

  let child;
  let installed = false;
  try {
    // (1) 조용한 설치. /D= 는 마지막 인자이고 따옴표를 쓰지 않는다.
    const setup = spawnSync(installer, ["/S", `/D=${install}`], { encoding: "utf8" });
    check(setup.status === 0, `조용한 설치 종료 코드 0 (${setup.status})`);
    const exe = join(install, `${PRODUCT}.exe`);
    await waitFor("설치 완료", () => existsSync(exe) && existsSync(join(install, `Uninstall ${PRODUCT}.exe`)), 60_000);
    installed = true;
    check(existsSync(join(install, "resources", "app.asar")), "설치 폴더에 resources/app.asar");
    for (const id of expectedLines) {
      const manifest = JSON.parse(readFileSync(join(install, "resources", "plugins", id, "manifest.json"), "utf8"));
      check(manifest.contributes?.lines === "lines.json" &&
        existsSync(join(install, "resources", "plugins", id, "lines.json")), `${id} 플러그인 대사 목록 포함`);
    }
    check(same(readdirSync(join(install, "resources", "characters")).sort(), expectedPacks), `설치된 내장 팩이 ${expectedPacks} (테스트용 placeholder-alt 없음)`);
    check(!existsSync(join(process.env.LOCALAPPDATA ?? "", "Programs", PRODUCT)), "기본 위치(LOCALAPPDATA\\Programs)에는 설치되지 않음");
    // 제거 정보 키는 파일 복사보다 늦게 써질 수 있어 기다린다.
    await waitFor("제거 정보 키 등록", () => regList(UNINSTALL_KEY).length > before.uninstall.length, 30_000).catch(() => undefined);
    const during = realSnapshot();
    check(during.uninstall.length > before.uninstall.length, "설치 중 점검용 제거 정보 키가 추가됨");
    check(same(during.run, before.run), "설치 중 Run 값 변화 없음");

    // (2) 격리 userData(환경 변수)와 포트 0 으로 실행. 개발 인자도 함께 줘서 설치본이 무시하는지 본다(5장).
    const controlName = `check-${randomBytes(3).toString("hex")}`;
    const childEnv = { ...process.env, DESKPET_USER_DATA_DIR: userdata };
    const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
    childEnv[pathKey] = (childEnv[pathKey] ?? "").split(delimiter)
      .filter((directory) => !existsSync(join(directory, "orca.exe"))).join(delimiter);
    check(!childEnv[pathKey].split(delimiter).some((directory) => existsSync(join(directory, "orca.exe"))),
      "점검용 앱의 PATH 에 Orca 실행 파일이 없음");
    let stderr = "";
    child = spawn(exe, [`--dev-control=${controlName}`, `--user-data-dir=${ignoredUserdata}`, `--plugins-dir=${fakePlugins}`,
      `--characters-dir=${fakeCharacters}`, "--character=nonexistent-pack", "--event-port=0"],
    { env: childEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: false });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((done) => child.once("exit", (code) => done(code)));
    let exitedEarly = false;
    void exited.then(() => { exitedEarly = true; });

    // (3) /status
    const auth = await waitFor("event-server.json 의 포트", () => {
      const data = JSON.parse(readFileSync(join(userdata, "event-server.json"), "utf8"));
      if (exitedEarly) throw new Error("앱이 먼저 끝남");
      return typeof data.port === "number" && data.port > 0 && data.pid === child.pid ? data : undefined;
    }, 60_000);
    check(auth.port !== 7777, `이벤트 포트를 OS 가 정함 (${auth.port})`);
    const status = await waitFor(`펫 창과 플러그인 ${expectedPlugins.length}종이 /status 에 나옴`, async () => {
      const response = await fetch(`http://127.0.0.1:${auth.port}/status`, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(3000) });
      if (response.status !== 200) return undefined;
      const body = await response.json();
      return body.visible === true && Array.isArray(body.plugins) && body.plugins.length >= expectedPlugins.length ? body : undefined;
    }, 60_000, 1000);
    check(status.visible === true, "펫 창이 보임 (visible)");
    const byId = new Map(status.plugins.map((plugin) => [plugin.id, plugin]));
    check(same([...byId.keys()].sort(), expectedPlugins), `상태의 플러그인이 정확히 ${expectedPlugins.length}종: ${[...byId.keys()].sort()}`);
    for (const id of expectedPlugins) {
      const state = byId.get(id)?.state;
      check(loadedStates.includes(state), `플러그인 ${id} 로드됨 (state ${state})`);
    }
    check(byId.get("orca")?.state === "needs-permission", "Orca 가 권한 허용 대기 중이어서 snapshot 호출 전임");
    check(!existsSync(join(userdata, "orca-notification-ledger.json")), "Orca snapshot 기록이 없음");
    check(status.character?.id === "wolf-maid", `처음 실행 기본 팩이 wolf-maid (${status.character?.id})`);
    check(status.version === "0.1.0", `버전 ${status.version}`);

    // (4) 개발 통로·개발 인자
    check(!(await pipeConnects(controlName)), `Slack 테스트 전송 설정을 포함한 개발 제어 통로(deskpet-dev-${controlName})가 열리지 않음`);
    check(readdirSync(ignoredUserdata).length === 0, "--user-data-dir 인자는 무시됨 (그 폴더에 아무것도 안 생김)");
    check(!byId.has("evil"), "--plugins-dir 인자는 무시됨 (가짜 플러그인이 목록에 없음)");
    check(status.character?.id !== "nonexistent-pack" && readdirSync(fakeCharacters).length === 0, "--characters-dir/--character 인자는 무시됨");
    check(!/Invalid dev control name/.test(stderr), "개발 제어 이름 오류 메시지도 없음 (인자를 읽지 않음)");

    // (5) 종료: 자기가 띄운 pid 와 그 하위 프로세스만 끈다.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    await Promise.race([exited, sleep(15_000)]);
    check(!isAlive(child.pid), "점검용 앱 종료");
    child = undefined;
  } catch (error) {
    check(false, `예외: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (child) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    // (5) 조용한 제거. 제거기는 임시 복사본을 띄우고 바로 돌아오므로 설치 폴더가 사라질 때까지 기다린다.
    if (installed) {
      const uninstaller = join(install, `Uninstall ${PRODUCT}.exe`);
      if (existsSync(uninstaller)) spawnSync(uninstaller, ["/S"], { encoding: "utf8" });
      try {
        await waitFor("설치 폴더 제거", () => !existsSync(install), 90_000);
        check(true, "조용한 제거 뒤 설치 폴더가 사라짐");
      } catch {
        check(false, "조용한 제거 뒤 설치 폴더가 사라짐 (시간 초과)");
      }
      check(existsSync(join(userdata, "event-server.json")) || readdirSync(userdata).length > 0, "임시 userData 는 제거 뒤에도 남음");
    }
    // 제거기는 폴더를 지운 뒤에 키를 지울 수 있어, 원래 목록으로 돌아올 때까지 잠시 기다린다.
    await waitFor("제거 정보 키 삭제", () => equal(regList(UNINSTALL_KEY), before.uninstall), 30_000).catch(() => undefined);
    // (6) 가드: 사용자의 실제 데이터와 레지스트리가 그대로인가.
    const after = realSnapshot();
    check(same(after.settings, before.settings), "실제 %APPDATA%\\deskpet\\settings.json 해시·수정 시각 그대로");
    check(same(after.run, before.run), "HKCU Run 값 그대로");
    check(same(after.uninstall, before.uninstall), "HKCU Uninstall 키 목록 그대로 (점검용 키가 남지 않음)");
    // 임시 폴더 정리 (접두 검사 통과 시만)
    if (root.split(sep).at(-1).startsWith(TEMP_PREFIX)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    check(!existsSync(root), "임시 폴더 정리");
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

try {
  await main();
} catch (error) {
  check(false, `예외: ${error instanceof Error ? error.message : error}`);
}
if (problems.length > 0) {
  console.error(`설치본 점검 실패 (${problems.length}건)`);
  process.exit(1);
}
console.info("설치본 점검 통과");
