import { homedir } from "node:os";
import { createLogFile } from "./log-file.js";
import { maskErrorText } from "./log-mask.js";

/** ADR-0010 §7: categories written to logs/errors.log. */
export type ErrorCategory = "main:uncaughtException" | "main:unhandledRejection" | "renderer:error" | "renderer:gone"
  | "child:gone" | "plugin:exit";

export interface ErrorLogOptions {
  dir: string;
  now?: () => Date;
  home?: string;
  maxBytes?: number;
  keep?: number;
  /** Lines allowed per window before the rest are only counted. */
  maxLinesPerWindow?: number;
  windowMs?: number;
}

export interface ErrorLog {
  /** Writes one record. Returns how many times this category+message was recorded in its current window (this one included). */
  record(category: ErrorCategory, message: string): number;
  /** Writes pending "repeated" and "dropped" summaries. */
  flush(): void;
}

const LINE_BYTES = 8 * 1024;

/** A message of any shape (Error, string, object) as one text; stacks are kept, they carry the useful part. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** Local-only error file with masking, repeat folding and a per-minute line cap. Nothing here touches the network. */
export function createErrorLog(options: ErrorLogOptions): ErrorLog {
  const { dir, now = () => new Date(), home = homedir(), maxBytes = 512 * 1024, keep = 3,
    maxLinesPerWindow = 60, windowMs = 60_000 } = options;
  const file = createLogFile({ dir, baseName: "errors", maxBytes, keep, maxLineBytes: LINE_BYTES, now, echo: false,
    redact: (text) => maskErrorText(text, home) });
  let timer: NodeJS.Timeout | undefined;

  // One open group: the last written key and how many identical records followed it inside the window.
  let group: { key: string; category: ErrorCategory; message: string; startedAt: number; repeats: number } | undefined;
  const seen = new Map<string, { startedAt: number; count: number }>();
  let windowStart = now().getTime();
  let linesInWindow = 0;
  let dropped = 0;

  const emit = (category: string, message: string): void => { file.error(`${category} ${message}`); };

  const closeGroup = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (group && group.repeats > 0) emit(group.category, `(×${group.repeats} 반복) ${group.message.split(/\r\n|\r|\n/)[0]?.slice(0, 120) ?? ""}`);
    group = undefined;
  };
  const rollWindow = (at: number): void => {
    if (at - windowStart < windowMs) return;
    if (dropped > 0) emit("errorlog", `(×${dropped} 생략: 분당 ${maxLinesPerWindow}줄 상한)`);
    windowStart = at;
    linesInWindow = 0;
    dropped = 0;
  };

  return {
    record(category, message) {
      const at = now().getTime();
      const key = `${category}\u0000${message}`;
      for (const [seenKey, entry] of seen) if (at - entry.startedAt >= windowMs) seen.delete(seenKey);
      const entry = seen.get(key) ?? { startedAt: at, count: 0 };
      entry.count += 1;
      seen.set(key, entry);

      if (group?.key === key && at - group.startedAt < windowMs) {
        group.repeats += 1;
        return entry.count;
      }
      closeGroup();
      rollWindow(at);
      if (linesInWindow >= maxLinesPerWindow) { dropped += 1; return entry.count; }
      linesInWindow += 1;
      emit(category, message);
      group = { key, category, message, startedAt: at, repeats: 0 };
      // A group left open when nothing else is recorded still gets its summary once the window ends.
      timer = setTimeout(closeGroup, windowMs);
      timer.unref();
      return entry.count;
    },
    flush() {
      closeGroup();
      if (dropped > 0) { emit("errorlog", `(×${dropped} 생략: 분당 ${maxLinesPerWindow}줄 상한)`); dropped = 0; }
    },
  };
}
