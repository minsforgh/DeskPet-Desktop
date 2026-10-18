import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { maskPluginLog } from "./log-mask.js";

type Level = "debug" | "info" | "warn" | "error";
export type FileLogger = Pick<Console, Level>;

export interface LogFileOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
  /** File name without extension; the default `deskpet` gives deskpet.log, deskpet.1.log, ... */
  baseName?: string;
  maxLineBytes?: number;
  /** Extra masking applied to each record's text before the standard rules. */
  redact?: (text: string) => string;
  /** Also print to the console (default true). */
  echo?: boolean;
}

const MAX_LINE_BYTES = 2048;
// maskPluginLog only masks headers at line start; these also appear after a "[plugin:id] " prefix.
const cookiePair = /\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\n\r]*/gi;

/** Console-shaped logger that also appends masked, single-line records to dir/deskpet.log. */
export function createLogFile(options: LogFileOptions): FileLogger {
  const { dir, maxBytes = 1_048_576, keep = 3, now = () => new Date(), baseName = "deskpet",
    maxLineBytes = MAX_LINE_BYTES, redact, echo = true } = options;
  const path = (index: number): string => join(dir, index === 0 ? `${baseName}.log` : `${baseName}.${index}.log`);
  let warned = false;

  const rotate = (): void => {
    rmSync(path(keep), { force: true });
    for (let index = keep - 1; index >= 0; index -= 1) {
      if (existsSync(path(index))) renameSync(path(index), path(index + 1));
    }
  };

  const write = (level: Level, args: unknown[]): void => {
    try {
      // Mask each physical line first (header rules anchor at line start), then join with spaces and cap the size.
      const text = redact ? redact(format(...args)) : format(...args);
      const perLine = text.split(/\r\n|\r|\n/).map((part) => maskPluginLog(part, new Set(), Number.MAX_SAFE_INTEGER));
      const message = maskPluginLog(perLine.join(" ").replace(cookiePair, "$1: ***"), new Set(), maxLineBytes);
      const record = `${now().toISOString()} ${level.toUpperCase()} ${message}`;
      mkdirSync(dir, { recursive: true });
      const size = existsSync(path(0)) ? statSync(path(0)).size : 0;
      if (size > 0 && size + Buffer.byteLength(record, "utf8") + 1 > maxBytes) rotate();
      appendFileSync(path(0), `${record}\n`, "utf8");
    } catch {
      if (!warned) { warned = true; console.warn("Log file write failed; continuing without file logging"); }
    }
  };

  const make = (level: Level) => (...args: unknown[]): void => {
    // eslint-disable-next-line no-console -- debug must pass through like the other levels
    if (echo) console[level](...args);
    write(level, args);
  };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}
