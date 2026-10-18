import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPack } from "./check.js";
import { makePackFiles, parseFrameMetadata, parsePackSpec } from "./pack.js";
import { resolveWorkspacePath } from "./pixelize-cli.js";

function options(args: string[]): { spec: string; out: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag !== "--spec" && flag !== "--out") throw new Error(`Unexpected argument: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--") || flags.has(flag)) throw new Error(`${flag} requires exactly one value`);
    flags.set(flag, value);
  }
  const spec = flags.get("--spec"), out = flags.get("--out");
  if (!spec || !out) throw new Error("Usage: pnpm sprites:pack --spec <pack.json> --out <pack folder>");
  if (parse(spec).ext.toLowerCase() !== ".json") throw new Error("Spec must be a JSON file");
  return { spec, out };
}

export async function packCli(args: string[], root = process.cwd()): Promise<void> {
  const flags = options(args);
  const specPath = await resolveWorkspacePath(root, flags.spec);
  const outPath = await resolveWorkspacePath(root, flags.out);
  const spec = parsePackSpec(JSON.parse(await readFile(specPath, "utf8")) as unknown);
  const relativeToRoot = (absolute: string): string => relative(root, absolute) || ".";
  const inputs: Record<string, { fps: number; frames: Uint8Array[] }> = {};
  const sources = new Set([specPath]);
  for (const [name, config] of Object.entries(spec.states)) {
    if (isAbsolute(config.frames)) throw new Error(`Path must stay inside the workspace: ${config.frames}`);
    const folder = await resolveWorkspacePath(root, relativeToRoot(resolve(dirname(specPath), config.frames)));
    const metadataPath = await resolveWorkspacePath(root, relativeToRoot(join(dirname(folder), "frames.json")));
    sources.add(metadataPath);
    const metadata = parseFrameMetadata(JSON.parse(await readFile(metadataPath, "utf8")) as unknown, name);
    const frames: Uint8Array[] = [];
    for (let i = 1; i <= metadata.frames; i += 1) {
      const filename = `frame-${String(i).padStart(2, "0")}.png`;
      const path = await resolveWorkspacePath(root, relativeToRoot(join(folder, filename)));
      sources.add(path);
      frames.push(await readFile(path));
    }
    inputs[name] = { fps: metadata.fps, frames };
  }
  const files = makePackFiles(spec, inputs);
  const targets = await Promise.all(files.map(([file]) => resolveWorkspacePath(root, relativeToRoot(join(outPath, file)))));
  if (targets.some((target) => sources.has(target))) throw new Error("Output must not overwrite the spec or source frames");
  await mkdir(join(outPath, "sheets"), { recursive: true });
  for (let i = 0; i < files.length; i += 1) await writeFile(targets[i] ?? "", files[i]?.[1] ?? "");
  const result = await checkPack(outPath);
  if (!result.ok) throw new Error(`Pack failed sprites:check: ${JSON.stringify(result.issues)}`);
  process.stdout.write(`${spec.id}: ${Object.keys(spec.states).length} states, ${result.decorations} decorations; sprites:check passed\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  packCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
