// Pure helpers of measure-idle-cpu.mjs (option parsing, sample summaries, process labelling).
// No I/O here so vitest can cover them (idle-cpu-lib.test.ts).

export const DEFAULT_SECONDS = 30;
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 600;
export const DEFAULT_BURST_SECONDS = 10;

const USAGE = "사용법: node apps/desktop/scripts/measure-idle-cpu.mjs [--seconds <초>] [--with-jungle] [--with-orca] [--terrain-off] [--poll-burst] [--burst-seconds <초>] [--installed-exe <설치된 exe>]"
  + ` (기본 ${DEFAULT_SECONDS}초, --poll-burst 는 --with-jungle 과 함께만 쓴다)`;

const toNumber = (text) => (text === undefined || text === "" ? Number.NaN : Number(text));

/** Parses argv (without node and script). Throws a Korean message on any unknown or invalid option. */
export function parseOptions(arguments_) {
  const options = { seconds: DEFAULT_SECONDS, withJungle: false, withOrca: false, terrainOff: false, pollBurst: false, burstSeconds: DEFAULT_BURST_SECONDS, installedExe: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--seconds") options.seconds = toNumber(arguments_[++index]);
    else if (argument?.startsWith("--seconds=")) options.seconds = toNumber(argument.slice(10));
    else if (argument === "--with-jungle") options.withJungle = true;
    else if (argument === "--with-orca") options.withOrca = true;
    else if (argument === "--terrain-off") options.terrainOff = true;
    else if (argument === "--poll-burst") options.pollBurst = true;
    else if (argument === "--burst-seconds") options.burstSeconds = toNumber(arguments_[++index]);
    else if (argument === "--installed-exe") options.installedExe = arguments_[++index] ?? "";
    else if (argument?.startsWith("--installed-exe=")) options.installedExe = argument.slice(16);
    else if (argument?.startsWith("--burst-seconds=")) options.burstSeconds = toNumber(argument.slice(16));
    else throw new Error(`인식할 수 없는 인자입니다: ${argument}\n${USAGE}`);
  }
  if (options.withJungle && options.withOrca) throw new Error("--with-jungle와 --with-orca는 함께 쓸 수 없습니다.");
  if (options.installedExe !== null && options.withOrca) throw new Error("--installed-exe는 --with-orca와 함께 쓸 수 없습니다.");
  if (!Number.isInteger(options.seconds) || options.seconds < MIN_SECONDS || options.seconds > MAX_SECONDS) {
    throw new Error(`--seconds 는 ${MIN_SECONDS} 이상 ${MAX_SECONDS} 이하 정수여야 합니다.`);
  }
  if (options.installedExe !== null && options.installedExe === "") throw new Error("--installed-exe 에는 설치된 앱의 exe 경로가 필요합니다.");
  if (options.installedExe !== null && (options.withJungle || options.withOrca || options.pollBurst)) throw new Error("--installed-exe 는 --with-jungle·--with-orca·--poll-burst 와 함께 쓸 수 없습니다.");
  if (options.pollBurst && !options.withJungle) throw new Error("--poll-burst 는 --with-jungle 과 함께 써야 합니다.");
  if (!Number.isInteger(options.burstSeconds) || options.burstSeconds < 1 || options.burstSeconds > options.seconds) {
    throw new Error(`--burst-seconds 는 1 이상 --seconds(${options.seconds}) 이하 정수여야 합니다.`);
  }
  return options;
}

/** Electron process role from its command line ("main" when it has no --type). */
export function roleOf(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return "unknown";
  const match = /--type=([a-z-]+)/.exec(commandLine);
  if (!match) return "main";
  if (match[1] === "gpu-process") return "gpu";
  return match[1];
}

/**
 * Role of any process in the app tree. electron.exe processes use their --type; PowerShell children (the terrain and
 * fullscreen watchers) are "powershell"; other descendants are named after their executable.
 */
let appExeName = "electron.exe";
/** The executable name of the measured app (an installed build is not electron.exe). */
export function setAppExeName(name) { appExeName = String(name).toLowerCase(); }

export function roleOfProcess(name, commandLine) {
  const exe = typeof name === "string" ? name.toLowerCase() : "";
  if (exe === "" || exe === "electron.exe" || exe === appExeName) return roleOf(commandLine);
  if (exe === "powershell.exe" || exe === "pwsh.exe") return "powershell";
  return exe.replace(/.exe$/, "");
}

/** `rootPid`'s process and every descendant, following ParentProcessId; each pid is visited once (cycle-safe). */
export function descendantsOf(processes, rootPid) {
  const tree = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = processes.find((candidate) => candidate.pid === pid);
    if (proc) tree.push(proc);
    for (const candidate of processes) {
      if (candidate.ppid === pid && !seen.has(candidate.pid)) queue.push(candidate.pid);
    }
  }
  return tree;
}

/** settings.json content the run needs before launch (the app's parser defaults terrain.enabled to true). */
export function launchSettingsOf(options) {
  return options.terrainOff ? { terrain: { enabled: false } } : {};
}

/** Plugin processes are utilityProcesses too; the app reports their pids, so label them apart from the other utilities. */
export function labelPlugins(tree, pluginPids) {
  for (const proc of tree) if (pluginPids.has(proc.pid)) proc.role = "plugin";
  return tree;
}

/**
 * Renderers that were not there when the pet and plugin host became ready belong to the checker window
 * (jungle creates it lazily at its first poll, about 5 s after activation). The window is hidden, so its
 * renderer cannot be told apart by title or type.
 */
export function labelCheckerRenderers(tree, knownRendererPids) {
  for (const proc of tree) if (proc.role === "renderer" && !knownRendererPids.has(proc.pid)) proc.role = "checker-renderer";
  return tree;
}

export function rendererPidsOf(tree) {
  return new Set(tree.filter((proc) => proc.role === "renderer").map((proc) => proc.pid));
}

/** Mean, max (1-based sample index) of CPU percent samples; zeros for an empty list. */
export function summarizeSamples(percents) {
  if (percents.length === 0) return { count: 0, average: 0, max: 0, maxIndex: 0 };
  const average = percents.reduce((sum, value) => sum + value, 0) / percents.length;
  const max = Math.max(...percents);
  return { count: percents.length, average, max, maxIndex: percents.indexOf(max) + 1 };
}

/** Summary of the first `burstSeconds` samples (the window right after jungle.check-now). */
export function summarizeBurst(percents, burstSeconds) {
  return summarizeSamples(percents.slice(0, burstSeconds));
}

/** Per-role averages from per-role summed percent totals over `sampleCount` samples. */
export function roleAveragesOf(roleTotals, sampleCount) {
  return new Map([...roleTotals.entries()].map(([role, total]) => [role, total / Math.max(1, sampleCount)]));
}

export function memoryByRoleOf(tree) {
  const memory = new Map();
  for (const proc of tree) {
    const entry = memory.get(proc.role) ?? { count: 0, workingSetMb: 0, privateMb: 0 };
    memory.set(proc.role, { count: entry.count + 1, workingSetMb: entry.workingSetMb + proc.workingSetMb,
      privateMb: entry.privateMb + proc.privateMb });
  }
  return memory;
}

export function memoryTotalOf(memory) {
  return [...memory.values()].reduce((sum, entry) => ({ count: sum.count + entry.count,
    workingSetMb: sum.workingSetMb + entry.workingSetMb, privateMb: sum.privateMb + entry.privateMb }),
  { count: 0, workingSetMb: 0, privateMb: 0 });
}

const ROLE_ORDER = ["main", "renderer", "checker-renderer", "gpu", "utility", "plugin", "powershell", "crashpad-handler"];

export function sortRoles(entries) {
  return [...entries].sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left[0]);
    const rightIndex = ROLE_ORDER.indexOf(right[0]);
    return (leftIndex < 0 ? ROLE_ORDER.length : leftIndex) - (rightIndex < 0 ? ROLE_ORDER.length : rightIndex);
  });
}

export function summarizeRoles(tree) {
  const counts = new Map();
  for (const proc of tree) counts.set(proc.role, (counts.get(proc.role) ?? 0) + 1);
  return sortRoles(counts.entries()).map(([role, count]) => `${role} ${count}`).join(", ");
}

/** Measurement conditions recorded in the result JSON so a jungle run can be compared with a baseline run. */
export function conditionsOf(options, extra) {
  return { withJungle: options.withJungle, withOrca: options.withOrca, terrain: options.terrainOff ? "off" : "on", pollBurst: options.pollBurst, burstSeconds: options.pollBurst ? options.burstSeconds : null,
    seconds: options.seconds, ...(options.installedExe !== null ? { installed: true } : {}), ...extra };
}
