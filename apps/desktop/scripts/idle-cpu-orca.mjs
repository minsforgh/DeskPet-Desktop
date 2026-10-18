// orca-on setup for measure-idle-cpu.mjs: stage only the real Orca plugin in a temporary folder.
import { cp, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const orcaRoot = resolve(import.meta.dirname, "..", "..", "..", "plugins", "orca");

/** Copies the built plugins/orca into <pluginsDir>/orca without touching the original folder. */
export async function stageOrcaPlugin(pluginsDir) {
  const target = join(pluginsDir, "orca");
  await mkdir(target, { recursive: true });
  for (const name of ["manifest.json", "package.json", "lines.json", "dist"]) {
    try {
      await cp(join(orcaRoot, name), join(target, name), { recursive: true });
    } catch {
      throw new Error(`orca plugin build output is missing (${name}); run \`pnpm build\` from the repository root first.`);
    }
  }
  await symlink(join(orcaRoot, "node_modules"), join(target, "node_modules"), "junction");
  return 1;
}

/** Launches with the temporary plugin directory and auto-allows its read-only Orca permission. */
export function prepareOrcaLaunch(pluginsDir) {
  return ["--event-port=0", `--plugins-dir=${pluginsDir}`, "--permission-answer=allow"];
}
