// Weekly resource summary from read-only usage tools and Orca orchestration.
// Usage: node tools/usage/weekly-resources.mjs --from <ISO> --to <ISO> [--markdown]

import { execFile } from "node:child_process";
import console from "node:console";
import { access } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { collectCodexUsage } from "./codex-usage.mjs";

const exec = promisify(execFile);
const DEFAULT_AGENT_USAGE = "./external-tools/agent-usage.mjs";
const BASELINE = { coordinator: 63, opusOverall: 47, retry: 11 };

function timestamp(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.replace(" ", "T");
  const suffix = normalized.slice(-6);
  return Date.parse(normalized.endsWith("Z") || suffix.startsWith("+") || suffix.startsWith("-")
    ? normalized : `${normalized}Z`);
}

export function parseArguments(argv) {
  const options = { from: null, to: null, markdown: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--markdown") options.markdown = true;
    else if (argument === "--from" || argument === "--to") {
      const value = argv[++index];
      if (!value || !Number.isFinite(timestamp(value))) throw new Error(`${argument}에는 ISO 시각이 필요합니다.`);
      options[argument.slice(2)] = value;
    } else throw new Error(`알 수 없는 인자: ${argument}`);
  }
  if (!options.from || !options.to || timestamp(options.from) >= timestamp(options.to)) {
    throw new Error("--from과 --to에 순서대로 된 ISO 시각을 지정하세요.");
  }
  return options;
}

export function percentage(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? Math.round(100 * numerator / denominator)
    : null;
}

export function overlaps(start, end, from, to) {
  const first = timestamp(start);
  const last = end == null ? timestamp(to) : timestamp(end);
  return Number.isFinite(first) && Number.isFinite(last)
    && first < timestamp(to) && last > timestamp(from);
}

export function isDeskpetWorker(worker) {
  const path = worker?.resource?.worktreeId;
  return typeof path === "string" && path.replaceAll("\\", "/").toLowerCase().includes("/orca/workspaces/deskpet/");
}

export function selectDeskpetRuns(runsWithWorkers) {
  return runsWithWorkers.filter(({ workers }) => workers.some(isDeskpetWorker));
}

export function taskRates(tasks, dispatches, from, to) {
  const inPeriod = tasks.filter((task) => {
    const created = timestamp(task.created_at);
    return Number.isFinite(created) && created >= timestamp(from) && created < timestamp(to);
  });
  const followUps = inPeriod.filter((task) => {
    const title = String(task.task_title ?? "").toLowerCase();
    return ["fix", "수정", "보완", "재작업"].some((part) => title.includes(part));
  });
  const counts = new Map();
  for (const dispatch of dispatches) {
    if (!overlaps(dispatch.dispatchedAt, dispatch.completedAt, from, to)) continue;
    counts.set(dispatch.taskId, (counts.get(dispatch.taskId) ?? 0) + 1);
  }
  const workerTasks = [...counts.values()];
  return {
    retry: percentage(workerTasks.filter((count) => count >= 2).length, workerTasks.length),
    retried: workerTasks.filter((count) => count >= 2).length,
    workerTaskCount: workerTasks.length,
    followUp: percentage(followUps.length, inPeriod.length),
    followUpCount: followUps.length,
    taskCount: inPeriod.length,
  };
}

export function tokenShares(tsv) {
  const lines = tsv.trim().split("\n");
  if (lines[0]?.trim() !== "tool\trole\tmodel\tsessions\tcalls\tinput\tcacheRead\tcacheWrite\toutput\tinShare") return null;
  let total = 0;
  let coordinator = 0;
  let opus = 0;
  for (const line of lines.slice(1)) {
    const cells = line.trim().split("\t");
    if (cells.length !== 10) continue;
    const values = cells.slice(5, 8).map((cell) => cell.endsWith("M") ? Number(cell.slice(0, -1)) : NaN);
    if (values.some((value) => !Number.isFinite(value))) return null;
    const amount = values.reduce((sum, value) => sum + value, 0);
    total += amount;
    if (cells[1] === "coordinator") {
      coordinator += amount;
      if (cells[2].toLowerCase().includes("opus")) opus += amount;
    }
  }
  return { coordinator: percentage(coordinator, total), opusWithinCoordinator: percentage(opus, coordinator), opusOverall: percentage(opus, total) };
}

export function unknown(reason) {
  return `미확인(${reason})`;
}

export function formatPercent(value, reason) {
  return value == null ? unknown(reason) : `${value}%`;
}

function formatKst(iso) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

async function orcaJson(args) {
  const { stdout } = await exec("orca", ["orchestration", ...args, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "Orca 응답 오류");
  return envelope.result;
}

async function workerPages(runId) {
  const workers = [];
  let cursor;
  do {
    const args = ["worker-list", "--run", runId];
    if (cursor) args.push("--cursor", cursor);
    const result = await orcaJson(args);
    workers.push(...result.workers);
    cursor = result.page?.hasMore ? result.page.nextCursor : null;
  } while (cursor);
  return workers;
}

async function collectOrcaRates(from, to) {
  const runList = await orcaJson(["run-list"]);
  const relevant = runList.runs.filter((run) => overlaps(run.created_at, run.updated_at, from, to));
  const runsWithWorkers = await Promise.all(relevant.map(async (run) => ({ run, workers: await workerPages(run.id) })));
  const selected = selectDeskpetRuns(runsWithWorkers);
  const tasks = (await Promise.all(selected.map(async ({ run, workers: runWorkers }) => {
    const taskList = (await orcaJson(["task-list", "--run", run.id])).tasks;
    const deskpetTaskIds = new Set(runWorkers.filter(isDeskpetWorker).map((worker) => worker.taskId));
    const allDeskpet = runWorkers.every(isDeskpetWorker);
    return taskList.filter((task) => allDeskpet || deskpetTaskIds.has(task.id));
  }))).flat();
  const workers = selected.flatMap(({ workers: items }) => items.filter(isDeskpetWorker));
  const candidateTasks = new Set(tasks.filter((task) => overlaps(task.created_at, task.completed_at, from, to)).map((task) => task.id));
  const candidates = workers.filter((worker) => candidateTasks.has(worker.taskId));
  const dispatches = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = await Promise.all(candidates.slice(index, index + 8).map(async (worker) => {
      const result = await orcaJson(["worker-show", "--dispatch", worker.dispatchId]);
      return result.dispatch;
    }));
    dispatches.push(...batch);
  }
  return taskRates(tasks, dispatches, from, to);
}

export function renderMarkdown(data) {
  const rows = [
    ["coordinator 입력 비중", formatPercent(data.tokens?.coordinator, data.tokenReason), `${BASELINE.coordinator}%`],
    ["coordinator Opus 비중", formatPercent(data.tokens?.opusWithinCoordinator, data.tokenReason), `전체 입력 대비 ${formatPercent(data.tokens?.opusOverall, data.tokenReason)} · 기준선 전체 대비 ${BASELINE.opusOverall}%`],
    ["재시도율", formatPercent(data.rates?.retry, data.orcaReason), `${data.rates ? `${data.rates.retried}/${data.rates.workerTaskCount}` : unknown(data.orcaReason)} · 기준선 ${BASELINE.retry}%`],
    ["후속 수정 비율", formatPercent(data.rates?.followUp, data.orcaReason), data.rates ? `${data.rates.followUpCount}/${data.rates.taskCount} · 기준선 미측정` : "기준선 미측정"],
    ["Codex 주간", data.codex?.weekly ? `${data.codex.weekly.usedPercent}%` : unknown(data.codexReason), data.codex ? `기준 ${formatKst(data.codex.asOf)} KST · 기준선 미측정` : "기준선 미측정"],
    ["Codex 5시간", data.codex?.fiveHour ? `${data.codex.fiveHour.usedPercent}%` : unknown(data.codexReason), data.codex ? `기준 ${formatKst(data.codex.asOf)} KST · 기준선 미측정` : "기준선 미측정"],
  ];
  return ["| 항목 | 이번 기간 | 기준선 대비 |", "|---|---|---|", ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const data = { tokens: null, tokenReason: "토큰 도구 오류", rates: null, orcaReason: "Orca 읽기 오류", codex: null, codexReason: "Codex 기록 없음" };
  try {
    const agentUsage = process.env.DESKPET_AGENT_USAGE || DEFAULT_AGENT_USAGE;
    await access(agentUsage);
    const { stdout } = await exec(process.execPath, [agentUsage, "--match", "deskpet", "--coordinator", "Desktop-deskpet", "--from", options.from, "--to", options.to], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    data.tokens = tokenShares(stdout);
    if (!data.tokens) data.tokenReason = "토큰 결과 해석 실패";
  } catch (error) {
    data.tokenReason = error?.code === "ENOENT" ? "도구 없음" : "토큰 도구 오류";
  }
  try { data.rates = await collectOrcaRates(options.from, options.to); } catch { data.orcaReason = "Orca 읽기 오류"; }
  try { data.codex = await collectCodexUsage(); } catch { data.codexReason = "Codex 읽기 오류"; }
  console.log(renderMarkdown(data));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
