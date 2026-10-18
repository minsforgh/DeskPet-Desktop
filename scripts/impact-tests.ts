import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface Impact { file: string; reason: string }
export interface ImpactResult { unit: Impact[]; e2e: Impact[] }

const root = resolve(import.meta.dirname, "..");
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"];
const ignored = new Set(["const", "return", "string", "number", "undefined", "false", "true", "null", "this", "function", "import", "export", "from", "await", "async", "width", "height", "left", "right", "above", "below", "text", "value", "event", "state", "settings", "window", "document", "style", "classList", "toggle", "badge", "side", "gap", "content", "rect", "size", "scale",
  "Number", "ReturnType", "Promise", "PetEvent", "clearTimeout", "setTimeout", "immediately", "calls", "fits", "drops", "focus", "absolute", "cannot", "only", "Only"]);

export function safeRepoFile(input: string, repo = root): string {
  if (isAbsolute(input) || input.split(/[\\/]/u).includes("..")) throw new Error(`허용 범위 밖 경로: ${input}`);
  const base = realpathSync(repo);
  const target = resolve(base, input);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(`허용 범위 밖 경로: ${input}`);
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`링크 경로는 사용할 수 없습니다: ${input}`);
  }
  if (existsSync(target)) {
    const real = realpathSync(target);
    const inside = relative(base, real);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`허용 범위 밖 경로: ${input}`);
  }
  return target;
}

function git(args: string[], repo: string): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function paths(text: string): string[] { return text.split("\0").filter(Boolean).map((name) => name.replaceAll("\\", "/")); }

function changed(base: string, head: string | undefined, repo: string): string[] {
  git(["rev-parse", "--verify", `${base}^{commit}`], repo);
  if (head) git(["rev-parse", "--verify", `${head}^{commit}`], repo);
  const names = new Set(paths(git(["diff", "--name-only", "-z", base, head ?? "HEAD"], repo)));
  if (!head) {
    for (const path of paths(git(["diff", "--name-only", "-z", "HEAD"], repo))) names.add(path);
    for (const path of paths(git(["ls-files", "--others", "--exclude-standard", "-z"], repo))) names.add(path);
  }
  return [...names].sort();
}

function changedLines(base: string, head: string | undefined, repo: string): Map<string, string[]> {
  const output = git(["diff", "--unified=0", "--no-ext-diff", base, head ?? "HEAD", "--", "apps/desktop/src"], repo) +
    (head ? "" : git(["diff", "--unified=0", "--no-ext-diff", "HEAD", "--", "apps/desktop/src"], repo));
  const lines = new Map<string, string[]>();
  let path = "";
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("+++ b/")) path = line.slice(6);
    else if (/^[+-][^+-]/u.test(line) && path && !path.endsWith(".test.ts")) lines.set(path, [...(lines.get(path) ?? []), line]);
  }
  return lines;
}

function tracked(repo: string): string[] {
  return [...new Set([...paths(git(["ls-files", "-z"], repo)), ...paths(git(["ls-files", "--others", "--exclude-standard", "-z"], repo))])]
    .filter((path) => /\.(?:[cm]?[jt]sx?|css)$/u.test(path) && existsSync(safeRepoFile(path, repo)));
}

function packageAliases(repo: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const path of paths(git(["ls-files", "-z", "--", "apps/*/package.json", "packages/*/package.json", "plugins/*/package.json", "tools/*/package.json"], repo))) {
    const data: unknown = JSON.parse(readFileSync(safeRepoFile(path, repo), "utf8"));
    if (typeof data !== "object" || data === null || !("name" in data) || typeof data.name !== "string") continue;
    const folder = dirname(path).replaceAll("\\", "/");
    const source = `${folder}/src/index.ts`;
    if (existsSync(safeRepoFile(source, repo))) aliases.set(data.name, source);
    if ("exports" in data && typeof data.exports === "object" && data.exports !== null) {
      for (const [key, entry] of Object.entries(data.exports)) {
        if (!key.startsWith("./") || typeof entry !== "object" || entry === null || !("types" in entry) || typeof entry.types !== "string") continue;
        const target = `${folder}/${entry.types.startsWith("./") ? entry.types.slice(2) : entry.types}`;
        if (existsSync(safeRepoFile(target, repo))) aliases.set(`${data.name}/${key.slice(2)}`, target);
      }
    }
  }
  return aliases;
}

function resolveImport(specifier: string, from: string, files: Set<string>, aliases: Map<string, string>, repo: string): string | undefined {
  const candidate = aliases.get(specifier) ?? (specifier.startsWith(".") ? relative(repo, resolve(repo, dirname(from), specifier)).replaceAll("\\", "/") : undefined);
  if (!candidate) return undefined;
  const stem = candidate.replace(/\.[cm]?[jt]sx?$/u, "");
  return [candidate, ...extensions.map((ext) => stem + ext), ...extensions.map((ext) => `${stem}/index${ext}`)].find((path) => files.has(path));
}

function importGraph(files: string[], repo: string): Map<string, string[]> {
  const set = new Set(files);
  const aliases = packageAliases(repo);
  const reverse = new Map<string, string[]>();
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const source = readFileSync(safeRepoFile(file, repo), "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName);
    for (const specifier of imports) {
      const target = resolveImport(specifier, file, set, aliases, repo);
      if (target) reverse.set(target, [...(reverse.get(target) ?? []), file]);
    }
  }
  return reverse;
}

function unitImpacts(changes: string[], files: string[], repo: string): Impact[] {
  const reverse = importGraph(files, repo);
  const results = new Map<string, string>();
  const queue = changes.filter((file) => /\.[cm]?[jt]sx?$/u.test(file)).map((file) => ({ file, path: [file] }));
  const seen = new Set<string>();
  for (const item of queue) {
    if (seen.has(item.file)) continue;
    seen.add(item.file);
    if (item.file.endsWith(".test.ts") && !item.file.includes("/e2e/") && !item.file.endsWith(".contract.test.ts"))
      results.set(item.file, item.path.join(" ← "));
    for (const parent of reverse.get(item.file) ?? []) queue.push({ file: parent, path: [...item.path, parent] });
  }
  return [...results].map(([file, reason]) => ({ file, reason: `import: ${reason}` })).sort((a, b) => a.file.localeCompare(b.file));
}

function words(lines: string[]): Set<string> {
  const result = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/[A-Za-z_$][\w$-]{3,}|#[A-Za-z][\w-]{2,}/gu)) {
      const word = match[0];
      if (!ignored.has(word) && !/^\d/u.test(word)) result.add(word);
    }
  }
  return result;
}

function differingWords(lines: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  for (const changed of lines.values()) {
    const before = words(changed.filter((line) => line.startsWith("-")));
    const after = words(changed.filter((line) => line.startsWith("+")));
    for (const word of before) if (!after.has(word)) result.add(word);
    for (const word of after) if (!before.has(word)) result.add(word);
  }
  return result;
}

function e2eImpacts(lines: Map<string, string[]>, changes: string[], files: string[], repo: string): Impact[] {
  const e2e = files.filter((path) => path.startsWith("apps/desktop/e2e/") && path.endsWith(".e2e.test.ts"));
  const changedWords = differingWords(lines);
  const sources = new Map(e2e.map((file) => [file, readFileSync(safeRepoFile(file, repo), "utf8")]));
  for (const word of changedWords) {
    if ([...sources.values()].filter((source) => source.includes(word)).length > 3) changedWords.delete(word);
  }
  const found = changedWords.size ? spawnSync("rg", ["-F", "-l", ...[...changedWords].flatMap((word) => ["-e", word]), "--", "apps/desktop/e2e"],
    { cwd: repo, encoding: "utf8" }) : undefined;
  if (found?.error && "code" in found.error && found.error.code !== "ENOENT") throw found.error;
  if (found && found.status !== null && found.status > 1) throw new Error(found.stderr || "rg 검색에 실패했습니다");
  const foundFiles = found?.error ? new Set(e2e) : new Set((found?.stdout ?? "").split(/\r?\n/u).filter(Boolean).map((file) => file.replaceAll("\\", "/")));
  const geometry = [...lines.values()].flat().some((line) => /\b(?:windowSize|currentOffset|currentContentRect|footOffset|badgeTopMargin|BADGE_TOP_MARGIN|offsetTop|offsetLeft|position|bounds|screenshot)\b|\b(?:width|height|top|left|x|y)\s*[:+*/=-]/u.test(line));
  const output: Impact[] = [];
  for (const file of e2e) {
    const source = sources.get(file) ?? "";
    const matches = foundFiles.has(file) ? [...changedWords].filter((word) => source.includes(word)).sort((a, b) => b.length - a.length) : [];
    const petGeometry = geometry && /\b(?:contentRect|petWindowY|BADGE_TOP_MARGIN|rendererMetrics\.badge|decodePng)\b/u.test(source) &&
      /\b(?:bounds|screenshot|width|height|\.x|\.y)\b/u.test(source);
    const changedTest = changes.includes(file);
    if (matches.length || petGeometry || changedTest) output.push({ file, reason: matches.length ? `일치: ${matches.slice(0, 4).join(", ")}` :
      petGeometry ? "펫 창 크기·좌표 단언" : "변경된 e2e" });
  }
  return output.sort((a, b) => a.file.localeCompare(b.file));
}

export function findImpact(base = "main", head?: string, repo = root): ImpactResult {
  const changes = changed(base, head, repo);
  const files = tracked(repo);
  const lines = changedLines(base, head, repo);
  if (!head) {
    const untracked = new Set(paths(git(["ls-files", "--others", "--exclude-standard", "-z"], repo)));
    for (const file of changes) {
      if (untracked.has(file) && file.startsWith("apps/desktop/src/") && files.includes(file) && !file.endsWith(".test.ts"))
        lines.set(file, readFileSync(safeRepoFile(file, repo), "utf8").split(/\r?\n/u).map((line) => `+${line}`));
    }
  }
  return { unit: unitImpacts(changes, files, repo), e2e: e2eImpacts(lines, changes, files, repo) };
}

function argumentsFrom(argv: string[]): { base: string; head?: string; run: boolean; list: boolean } {
  let base = "main";
  let head: string | undefined;
  let run = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" || arg === "--head") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 뒤에 Git ref를 넣어 주세요`);
      if (arg === "--base") base = value; else head = value;
    } else if (arg === "--run") run = true;
    else if (arg === "--list") list = true;
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return { base, head, run, list };
}

function main(argv: string[]): void {
  const options = argumentsFrom(argv);
  const impacts = findImpact(options.base, options.head);
  for (const item of impacts.unit) console.info(`unit ${item.file} — ${item.reason}`);
  for (const item of impacts.e2e) console.info(`e2e  ${item.file} — ${item.reason}`);
  console.info(`선택: unit ${impacts.unit.length}개, e2e ${impacts.e2e.length}개`);
  if (!options.run) return;
  const commands = [
    ...(impacts.unit.length ? [["exec", "vitest", "run", ...impacts.unit.map((item) => item.file)]] : []),
    ...impacts.e2e.map((item) => ["test:e2e", item.file]),
  ];
  for (const args of commands) {
    console.info(`pnpm ${args.join(" ")}`);
    if (options.list) continue;
    const result = spawnSync(process.env.npm_execpath ?? (process.platform === "win32" ? "pnpm.exe" : "pnpm"), args,
      { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
