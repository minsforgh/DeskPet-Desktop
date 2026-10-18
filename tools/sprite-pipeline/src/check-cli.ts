import { checkPack } from "./check.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const packs = args.filter((arg) => arg !== "--json");
if (packs.length === 0) {
  process.stderr.write("Usage: pnpm sprites:check [--json] <pack-folder> ...\n");
  process.exitCode = 2;
} else {
  const results = await Promise.all(packs.map(checkPack));
  if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else for (const result of results) {
    process.stdout.write(`${result.pack}: ${result.ok ? "OK" : "FAILED"}; upper decorations ${result.decorations}\n`);
    for (const issue of result.issues) {
      const frame = issue.frame === null ? "" : ` frame ${issue.frame}`;
      const measurement = issue.measured === undefined ? "" : `; measured ${issue.measured}`;
      const expected = issue.expected === undefined ? "" : `; expected ${issue.expected}`;
      process.stdout.write(`  ${issue.state}${frame}: ${issue.reason}${measurement}${expected}\n`);
    }
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
