import { pathToFileURL } from "node:url";
import type { PluginDefinition } from "@deskpet/plugin-sdk";
import { runPlugin, type Envelope, type PluginChannel } from "@deskpet/plugin-host";

/**
 * Entry of the plugin process (utilityProcess). Plugin code is not imported until main sends the
 * start message, which it does only after the permission decision (ADR-0005 §1).
 */
const parentPort = process.parentPort;

function isStart(message: unknown): message is { kind: "start"; entry: string } {
  return message !== null && typeof message === "object" && "kind" in message && message.kind === "start" &&
    "entry" in message && typeof message.entry === "string";
}

function isDefinition(value: unknown): value is PluginDefinition {
  return value !== null && typeof value === "object" && "activate" in value && typeof value.activate === "function";
}

/** The first message is the start message; every later message goes to the channel listeners. */
function startChannel(): { channel: PluginChannel; entry: Promise<string> } {
  const listeners = new Set<(message: unknown) => void>();
  let resolveEntry: (entry: string) => void = () => {};
  const entry = new Promise<string>((resolve) => { resolveEntry = resolve; });
  let started = false;
  parentPort.on("message", (event) => {
    const message: unknown = event.data;
    if (!started) {
      if (isStart(message)) { started = true; resolveEntry(message.entry); }
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const channel: PluginChannel = {
    post(message: Envelope) { parentPort.postMessage(message); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // The parent port has no close event; main killing this process is the only way the channel ends.
    onExit() { return () => {}; },
    kill() { process.exit(0); },
  };
  return { channel, entry };
}

async function main(): Promise<void> {
  const { channel, entry } = startChannel();
  const entryPath = await entry;
  await runPlugin(channel, async () => {
    const loaded: unknown = await import(pathToFileURL(entryPath).href);
    const definition = loaded !== null && typeof loaded === "object" && "default" in loaded ? loaded.default : undefined;
    if (!isDefinition(definition)) throw new Error("plugin entry has no default export with activate()");
    return definition;
  });
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
