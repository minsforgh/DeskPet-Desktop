/* global fetch, AbortSignal */
import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { DEV_CONTROL_NAME_PATTERN, sendRequest } from "./control.mjs";
import {
  conditionsOf, descendantsOf, labelCheckerRenderers, labelPlugins, launchSettingsOf, memoryByRoleOf, memoryTotalOf, parseOptions, rendererPidsOf, roleAveragesOf, roleOfProcess, setAppExeName,
  sortRoles, summarizeBurst, summarizeRoles, summarizeSamples,
} from "./idle-cpu-lib.mjs";
import { pollCount, prepareJungleLaunch, sendCheckNow, stabilizeJungle, stageJunglePlugin, startFakeLms } from "./idle-cpu-jungle.mjs";
import { prepareOrcaLaunch, stageOrcaPlugin } from "./idle-cpu-orca.mjs";

const SAMPLE_INTERVAL_MS = 1000;
const PROCESS_QUERY_TIMEOUT_MS = 5000;
// Same readiness budget as the e2e helper (apps/desktop/e2e/desktop-app.ts polls
// state every 100 ms up to 150 times).
const READY_TIMEOUT_MS = 15000;
// Orca polls every 30 s and the CLI has a measured 5 s timeout; 45 s covers scheduler jitter.
const ORCA_SNAPSHOT_TIMEOUT_MS = 45000;
const ORCA_SNAPSHOT_POLL_MS = 100;
// Stabilization: STABILIZE_STABLE_POLLS consecutive identical PID sets at
// STABILIZE_POLL_MS polling. Measured on 2026-10-07 (i7-12700, 20 logical cores,
// Windows 10.0.26200, SSD, 4 trial launches, Electron 44.5.1): the pet became
// ready 0.4-0.9 s after spawn and the 5-process tree (main, renderer x2, gpu,
// utility) already showed identical PID sets on the first stabilization read
// (~0.6 s after readiness). 3 identical consecutive sets keeps margin for
// slower machines where renderer or utility processes appear late; the 15 s cap
// only guards pathological runs, which proceed with the last observed tree.
const STABILIZE_POLL_MS = 500;
const STABILIZE_STABLE_POLLS = 3;
const STABILIZE_TIMEOUT_MS = 15000;
// FIX-4 (apps/desktop/README.md): after the tray quit command every Electron
// process disappeared within 4,491 ms and the browser exit event arrived at
// 4,642 ms in the worst measured case; the e2e helper observes 12 s.
const EXIT_TIMEOUT_MS = 12000;
const INSTALLED_READY_TIMEOUT_MS = 60000;
const REMAINING_CHECK_TIMEOUT_MS = 8000;
const REMAINING_POLL_MS = 500;

// All processes, not only electron.exe: the app's PowerShell watchers (terrain, fullscreen) are descendants too.
// This also includes short-lived orca.exe children spawned by the Orca plugin when they overlap a sample.
// The tree is cut by ParentProcessId from the app's root pid, so this script's own query powershell (a child of
// node, outside the app tree) and other DeskPet sessions never count.
const PROCESS_QUERY = "Get-CimInstance Win32_Process"
  + " | Select-Object Name,ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function parseProcesses(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    cpuSeconds: (Number(row.UserModeTime) + Number(row.KernelModeTime)) / 1e7,
    workingSetMb: Number(row.WorkingSetSize) / 1024 ** 2,
    privateMb: Number(row.PrivatePageCount) / 1024 ** 2,
    commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
    name: typeof row.Name === "string" ? row.Name : "",
    role: roleOfProcess(row.Name, row.CommandLine),
  })).filter((proc) => Number.isInteger(proc.pid) && Number.isInteger(proc.ppid) && Number.isFinite(proc.cpuSeconds));
}

function listProcesses() {
  return new Promise((resolvePromise, rejectPromise) => {
    const query = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(rows);
    };
    const timer = setTimeout(() => {
      query.kill();
      finish(new Error("프로세스 조회 시간 초과"));
    }, PROCESS_QUERY_TIMEOUT_MS);
    query.stdout.on("data", (chunk) => { stdout += chunk; });
    query.stderr.on("data", (chunk) => { stderr += chunk; });
    query.on("error", (error) => finish(error));
    query.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`프로세스 조회 실패 (종료 코드 ${code}): ${stderr.trim()}`));
        return;
      }
      try {
        finish(undefined, parseProcesses(stdout));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

const treeOf = descendantsOf;

async function waitForOrcaSnapshot(name, rootPid, child, output) {
  const deadline = Date.now() + ORCA_SNAPSHOT_TIMEOUT_MS;
  let cliSeen = false;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Orca snapshot 전에 Electron이 시작 중 종료됐습니다 (코드 ${child.exitCode}).\n${output()}`);
    }
    const state = await sendRequest(name, { cmd: "state" });
    const status = state?.pluginHost?.plugins?.find((plugin) => plugin.id === "orca");
    const tree = treeOf(await listProcesses(), rootPid);
    const cliRunning = tree.some((proc) => proc.name.toLowerCase() === "orca.exe");
    if (status?.state === "running" && cliRunning) cliSeen = true;
    if (status?.state === "running" && cliSeen && !cliRunning) return state;
    if (Date.now() > deadline) throw new Error(`Orca plugin first snapshot did not finish within ${ORCA_SNAPSHOT_TIMEOUT_MS / 1000}s.\n${output()}`);
    await sleep(ORCA_SNAPSHOT_POLL_MS);
  }
}

function killTree(pid) {
  if (!Number.isInteger(pid)) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitForPet(name, child, output) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "";
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron이 시작 중 종료됐습니다 (코드 ${child.exitCode}).\n${output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`펫이 준비되지 않았습니다. 마지막 오류: ${lastError || "없음"}\n${output()}`);
    }
    try {
      const state = await sendRequest(name, { cmd: "state" });
      // M4: the plugin processes (ADR-0005) are part of what is measured, so wait until the plugin host is up.
      if (state?.ready === true && state?.visible === true && state?.pluginHost?.ready === true) return state;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
}

// Installed build: no dev control (ADR-0010 5장). Ready means event-server.json plus an authorized /status that shows the pet.
async function installedStatus(userDataDir, child) {
  const auth = JSON.parse(await readFile(join(userDataDir, "event-server.json"), "utf8"));
  if (!(auth.port > 0) || auth.pid !== child.pid) throw new Error("event-server.json 이 아직 이 프로세스의 것이 아님");
  const response = await fetch(`http://127.0.0.1:${auth.port}/status`, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(3000) });
  if (response.status !== 200) throw new Error(`/status ${response.status}`);
  return response.json();
}

async function waitForInstalledPet(userDataDir, child, output) {
  const deadline = Date.now() + INSTALLED_READY_TIMEOUT_MS;
  let lastError = "";
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`설치본이 시작 중 종료됐습니다 (코드 ${child.exitCode}).
${output()}`);
    if (Date.now() > deadline) throw new Error(`설치본 펫이 준비되지 않았습니다. 마지막 오류: ${lastError || "없음"}
${output()}`);
    try {
      const status = await installedStatus(userDataDir, child);
      if (status?.visible === true && Array.isArray(status.plugins) && status.plugins.length > 0) return { ready: true, visible: true, character: { ...status.character, loaded: status.character?.id !== undefined }, bubble: undefined };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
}

async function waitForStableTree(rootPid) {
  const startedAt = Date.now();
  let previousKey = "";
  let stablePolls = 0;
  let tree;
  for (;;) {
    const processes = await listProcesses();
    tree = treeOf(processes, rootPid);
    const key = tree.map((proc) => proc.pid).sort((left, right) => left - right).join(",");
    stablePolls = key === previousKey && tree.length >= 2 ? stablePolls + 1 : 0;
    previousKey = key;
    if (stablePolls >= STABILIZE_STABLE_POLLS) break;
    if (Date.now() - startedAt > STABILIZE_TIMEOUT_MS) break;
    await sleep(STABILIZE_POLL_MS);
  }
  return { tree, elapsedMs: Date.now() - startedAt };
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), EXIT_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function remainingAppProcesses(observedPids, rootPid) {
  const processes = await listProcesses();
  return processes.filter((proc) =>
    observedPids.has(proc.pid) || observedPids.has(proc.ppid) || proc.ppid === rootPid);
}

async function waitForZeroRemaining(observedPids, rootPid) {
  const deadline = Date.now() + REMAINING_CHECK_TIMEOUT_MS;
  for (;;) {
    const remaining = await remainingAppProcesses(observedPids, rootPid);
    if (remaining.length === 0) return { remaining, verified: true };
    if (Date.now() >= deadline) return { remaining, verified: false };
    await sleep(REMAINING_POLL_MS);
  }
}

function percent(value) {
  return `${value.toFixed(3)}%`;
}

function describeBubble(bubble) {
  if (bubble == null) return "없음";
  return bubble.visible === true ? `있음(text=${JSON.stringify(bubble.text ?? null)})` : "숨김(visible=false)";
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("이 스크립트는 Windows 전용입니다 (프로세스 조회에 PowerShell Win32_Process 사용).");
  }
  const options = parseOptions(process.argv.slice(2));
  const { seconds, withJungle, withOrca, terrainOff, pollBurst, burstSeconds, installedExe } = options;
  if (installedExe !== null) {
    await stat(installedExe).catch(() => { throw new Error(`설치된 exe 를 찾을 수 없습니다: ${installedExe}`); });
    setAppExeName(basename(installedExe));
  }
  const desktopRoot = resolve(import.meta.dirname, "..");
  try {
    if (installedExe === null) await stat(join(desktopRoot, "out", "main", "index.js"));
  } catch {
    throw new Error("빌드된 앱이 없습니다. 먼저 저장소 루트에서 `pnpm build`를 실행하세요.");
  }
  const require = createRequire(import.meta.url);
  const electronPath = require("electron");
  if (typeof electronPath !== "string") throw new Error("Electron 실행 파일을 찾을 수 없습니다.");
  let electronVersion = "unknown";
  try {
    electronVersion = require("electron/package.json").version;
  } catch {
    // Version is informational only.
  }

  const coreCount = cpus().length;
  const cpuModel = cpus()[0]?.model?.trim() ?? "unknown";
  console.log(`측정 환경: ${new Date().toISOString()}, Windows ${release()}, 논리 코어 ${coreCount}, CPU ${cpuModel}, RAM ${(totalmem() / 1024 ** 3).toFixed(0)}GB, Electron ${electronVersion}`);
  console.log(`측정 길이: ${seconds}초, 샘플 간격 ${SAMPLE_INTERVAL_MS / 1000}초, 코어 정규화 (논리 코어 ${coreCount}로 나눈 %)`);
  console.log(`측정 조건: jungle ${withJungle ? "켬(가짜 LMS, 숨김 체커 창 포함)" : "끔"}, 창 감시(terrain) ${terrainOff ? "끔(settings terrain.enabled=false)" : "켬(앱 기본값)"}, 조회 버스트 ${pollBurst ? `측정(처음 ${burstSeconds}초)` : "없음"}`);

  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-idle-cpu-"));
  const userDataDir = join(tempDir, "user-data");
  const name = randomUUID().replaceAll("-", "");
  if (!DEV_CONTROL_NAME_PATTERN.test(name)) throw new Error("Invalid dev control name");

  let child;
  let captured = "";
  let measurementError;
  const observedPids = new Set();
  const percents = [];
  let roleAverages = new Map();
  let memoryByRole = new Map();
  let excludedOthers = 0;
  let finalState = null;
  let lms;
  let pluginCount = 0;
  let burstPolled = null;
  let checkerRendererSeparated = null;
  let lastTree = [];
  try {
    let extraArguments = [];
    const launchSettings = launchSettingsOf(options);
    if (!withJungle && !withOrca && Object.keys(launchSettings).length > 0) {
      await mkdir(userDataDir, { recursive: true });
      await writeFile(join(userDataDir, "settings.json"), JSON.stringify(launchSettings));
    }
    if (withJungle) {
      lms = await startFakeLms();
      pluginCount = await stageJunglePlugin(join(tempDir, "plugins"));
      extraArguments = await prepareJungleLaunch(userDataDir, join(tempDir, "plugins"), lms.port, launchSettings);
      console.log(`가짜 LMS: 127.0.0.1:${lms.port} (jungle 플러그인 ${pluginCount}개 스테이징)`);
    }
    if (withOrca) {
      pluginCount = await stageOrcaPlugin(join(tempDir, "plugins"));
      extraArguments = prepareOrcaLaunch(join(tempDir, "plugins"));
      console.log("Orca plugin staged (real PATH orca.exe, read-only command)");
    }
    child = installedExe !== null
      ? spawn(installedExe, [], { env: { ...process.env, DESKPET_USER_DATA_DIR: userDataDir }, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(electronPath, [desktopRoot, `--dev-control=${name}`, `--user-data-dir=${userDataDir}`, ...extraArguments],
      { stdio: ["ignore", "pipe", "pipe"] });
    const rootPid = child.pid;
    observedPids.add(rootPid);
    const output = () => captured.slice(-8192);
    child.stdout?.on("data", (chunk) => { captured += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { captured += chunk.toString(); });
    let interruptHandled = false;
    process.once("SIGINT", () => {
      if (interruptHandled) process.exit(130);
      interruptHandled = true;
      console.error("중단 요청을 받았습니다. 측정 앱을 강제 종료합니다.");
      killTree(rootPid);
      process.exit(130);
    });
    console.log(`임시 user-data-dir: ${userDataDir} (제어 통로: ${name})`);

    const launchStartedAt = Date.now();
    let initialState = installedExe !== null ? await waitForInstalledPet(userDataDir, child, output) : await waitForPet(name, child, output);
    if (withOrca) {
      initialState = await waitForOrcaSnapshot(name, rootPid, child, output);
      console.log("Note: measurement starts after Orca's first snapshot; a short orca.exe may be missed by the 1 s sample interval.");
    }
    const readyMs = Date.now() - launchStartedAt;
    const initialCharacter = initialState?.character;
    const eventServer = initialState?.eventServer;
    const pluginPids = new Set(Object.values(initialState?.pluginHost?.pids ?? {}));
    // Renderers present now (pet, settings) are "renderer"; the one created later for jungle's hidden checker window is not.
    const readyTree = labelPlugins(treeOf(await listProcesses(), rootPid), pluginPids);
    const knownRenderers = rendererPidsOf(readyTree);
    const label = (tree) => labelCheckerRenderers(labelPlugins(tree, pluginPids), knownRenderers);
    if (withJungle) {
      const isAlive = () => child.exitCode === null && child.signalCode === null;
      await stabilizeJungle(name, userDataDir, lms, isAlive);
    }
    const stabilization = await waitForStableTree(rootPid);
    label(stabilization.tree);
    if (withJungle) {
      checkerRendererSeparated = stabilization.tree.some((proc) => proc.role === "checker-renderer");
      if (!checkerRendererSeparated) console.log("참고: 체커 창 렌더러를 기동 시점 렌더러와 구분하지 못했습니다(이미 만들어져 있었을 수 있음). 켠/끈 트리 차이로 보세요.");
    }
    for (const proc of stabilization.tree) observedPids.add(proc.pid);
    console.log(`기동: 펫 준비 ${(readyMs / 1000).toFixed(1)}초, 트리 안정화 ${(stabilization.elapsedMs / 1000).toFixed(1)}초 (프로세스 ${stabilization.tree.length}개: ${summarizeRoles(stabilization.tree) || "없음"})`);
    console.log(`상태: 펫 표시됨(visible=${initialState?.visible}, ready=${initialState?.ready}), 캐릭터 ${initialCharacter?.id ?? "?"} ${initialCharacter?.state ?? "?"}${initialCharacter?.loaded === true ? "" : " (로드 실패)"}, 말풍선 ${describeBubble(initialState?.bubble)}`);
    if (eventServer && eventServer.listening !== true) {
      console.log("참고: 이 앱의 이벤트 서버가 열리지 않았습니다 (다른 DeskPet 세션이 포트를 쓰고 있을 수 있음).");
    }

    const baselineProcesses = await listProcesses();
    const baselineTree = label(treeOf(baselineProcesses, rootPid));
    for (const proc of baselineTree) observedPids.add(proc.pid);
    let previous = new Map(baselineTree.map((proc) => [proc.pid, proc]));
    let previousWall = Date.now();
    const roleTotals = new Map();

    let pollsBefore = 0;
    if (pollBurst) {
      pollsBefore = await pollCount(userDataDir);
      await sendCheckNow(name, userDataDir);
    }
    for (let index = 1; index <= seconds; index += 1) {
      const wait = previousWall + SAMPLE_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const wall = Date.now();
      let processes;
      try {
        processes = await listProcesses();
      } catch (error) {
        console.error(`[${index}/${seconds}] 샘플 실패: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const tree = label(treeOf(processes, rootPid));
      lastTree = tree;
      if (tree.length === 0) throw new Error(`측정 중 Electron 프로세스 트리가 사라졌습니다.\n${output()}`);
      for (const proc of tree) observedPids.add(proc.pid);
      const appPids = new Set(tree.map((proc) => proc.pid));
      excludedOthers = Math.max(excludedOthers, processes.filter((proc) => proc.name.toLowerCase() === "electron.exe" && !appPids.has(proc.pid)).length);
      const current = new Map(tree.map((proc) => [proc.pid, proc]));
      const interval = (wall - previousWall) / 1000;
      if (interval >= 0.2) {
        let delta = 0;
        for (const [pid, proc] of current) {
          const before = previous.get(pid);
          if (!before) continue;
          const used = Math.max(0, proc.cpuSeconds - before.cpuSeconds);
          delta += used;
          roleTotals.set(proc.role, (roleTotals.get(proc.role) ?? 0) + (used / interval / coreCount) * 100);
        }
        const value = (delta / interval / coreCount) * 100;
        percents.push(value);
        console.log(`[${index}/${seconds}] ${percent(value)}`);
      }
      previous = current;
      previousWall = wall;
    }
    if (excludedOthers > 0) console.log(`다른 electron.exe 프로세스 ${excludedOthers}개가 실행 중이라 측정에서 제외했습니다.`);
    try {
      finalState = installedExe !== null ? await installedStatus(userDataDir, child) : await sendRequest(name, { cmd: "state" });
    } catch {
      finalState = null;
    }
    if (pollBurst) burstPolled = (await pollCount(userDataDir)) > pollsBefore;
    memoryByRole = memoryByRoleOf(lastTree);
    roleAverages = roleAveragesOf(roleTotals, percents.length);
  } catch (error) {
    measurementError = error;
  } finally {
    let quitMethod = "강제 종료";
    if (child && (child.exitCode === null && child.signalCode === null)) {
      try {
        if (installedExe !== null) killTree(child.pid);
        else await sendRequest(name, { cmd: "tray", action: "quit" });
        quitMethod = installedExe !== null ? "프로세스 트리 종료(taskkill)" : "트레이 종료 명령";
      } catch {
        killTree(child.pid);
      }
      if (!(await waitForChildExit(child))) killTree(child.pid);
    } else if (child) {
      quitMethod = "이미 종료됨";
    }
    let remainingNote = "";
    if (observedPids.size > 0) {
      const zero = await waitForZeroRemaining(observedPids, child?.pid);
      if (!zero.verified) {
        for (const proc of zero.remaining) killTree(proc.pid);
        await sleep(REMAINING_POLL_MS);
        const recheck = await remainingAppProcesses(observedPids, child?.pid);
        remainingNote = recheck.length === 0
          ? " (taskkill 후 0 확인)"
          : ` (taskkill 후에도 남음: ${recheck.map((proc) => `${proc.pid}(${proc.role})`).join(", ")})`;
        if (recheck.length !== 0) process.exitCode = 1;
      }
      console.log(`종료: ${quitMethod}, 남은 프로세스 0${remainingNote}`);
    }
    try {
      await lms?.close();
    } catch {
      // The server only lives for this run.
    }
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.error(`임시 폴더 삭제 실패: ${tempDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (measurementError) throw measurementError;
  const validSamples = percents.length;
  if (validSamples < Math.ceil(seconds / 2)) {
    throw new Error(`유효 샘플이 부족합니다 (${validSamples}/${seconds}).`);
  }
  const { average, max: maxPercent, maxIndex } = summarizeSamples(percents);
  console.log(`측정 완료: 유효 샘플 ${validSamples}/${seconds}`);
  console.log(`평균 CPU: ${percent(average)} (코어 정규화)`);
  console.log(`최대 CPU: ${percent(maxPercent)} (샘플 ${maxIndex}/${seconds})`);
  console.log(`1코어 환산 평균: ${percent(average * coreCount)} (초당 ${(average * coreCount * 10).toFixed(1)}ms CPU)`);
  console.log(`역할별 평균: ${sortRoles(roleAverages.entries()).map(([role, value]) => `${role} ${percent(value)}`).join(", ")}`);
  const memoryTotal = memoryTotalOf(memoryByRole);
  console.log(`메모리(마지막 샘플, 작업 집합 / 전용): 합계 ${memoryTotal.workingSetMb.toFixed(0)} / ${memoryTotal.privateMb.toFixed(0)} MB, ${sortRoles(memoryByRole.entries())
    .map(([role, entry]) => `${role} ${entry.count}개 ${entry.workingSetMb.toFixed(0)} / ${entry.privateMb.toFixed(0)} MB`).join(", ")}`);
  let burst = null;
  if (pollBurst) {
    burst = summarizeBurst(percents, burstSeconds);
    console.log(`조회 버스트(check-now 직후 ${burst.count}개 샘플): 평균 ${percent(burst.average)}, 최대 ${percent(burst.max)} (샘플 ${burst.maxIndex}), 조회 로그 ${burstPolled ? "확인" : "못 찾음"}`);
  }
  const finalCharacter = finalState?.character;
  if (finalCharacter) console.log(`측정 직후 캐릭터 상태: ${finalCharacter.state ?? "?"}, 말풍선 ${describeBubble(finalState?.bubble)}`);
  console.log(average < 1
    ? `판정: 평균 ${percent(average)} — 1% 미만 목표 충족`
    : `판정: 평균 ${percent(average)} — 1% 초과, 원인 후보를 기록해야 합니다.`);
  const toObject = (map) => Object.fromEntries(sortRoles(map.entries()));
  console.log(`JSON: ${JSON.stringify({
    conditions: conditionsOf(options, { sampleCount: validSamples, pluginCount, processCount: memoryTotal.count,
      checkerRendererSeparated, powershellCount: memoryByRole.get("powershell")?.count ?? 0, measuredAt: new Date().toISOString(), logicalCores: coreCount }),
    average, max: maxPercent, maxIndex, roleAverages: toObject(roleAverages),
    memory: { workingSetMb: memoryTotal.workingSetMb, privateMb: memoryTotal.privateMb, byRole: toObject(memoryByRole) },
    burst: burst === null ? null : { ...burst, polled: burstPolled },
  })}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
