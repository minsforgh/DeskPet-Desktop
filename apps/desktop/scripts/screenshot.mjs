import console from "node:console";
import process from "node:process";
import { DEV_CONTROL_NAME_PATTERN, sendRequest } from "./control.mjs";

async function main() {
  const arguments_ = process.argv.slice(2);
  let name = "default";
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--name") name = arguments_[++index];
    else if (argument?.startsWith("--name=")) name = argument.slice(7);
    else if (!output) output = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!output || typeof name !== "string" || !DEV_CONTROL_NAME_PATTERN.test(name)) {
    throw new Error("Usage: pnpm desktop:screenshot <png path> [--name <name>]");
  }
  const result = await sendRequest(name, { cmd: "screenshot", path: output });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
