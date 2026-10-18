const MAX_LINE_BYTES = 2 * 1024;
const sensitiveHeader = /^(Authorization|Cookie|Set-Cookie)\s*:/i;
const bearerToken = /\bBearer\s+[^\s]+/gi;
const querySecret = /([?&](?:token|key|secret|password|code)=)[^&#\s]*/gi;

export function maskPluginLog(message: string, secrets: ReadonlySet<string>, maxBytes = MAX_LINE_BYTES): string {
  const values = [...secrets].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length);
  let redacted = message;
  for (const value of values) redacted = redacted.replaceAll(value, "***");
  const lines = redacted.split(/\r\n|\r|\n/).map((line) => {
    const masked = sensitiveHeader.test(line) ? `${line.slice(0, line.indexOf(":"))}: ***` : line;
    return masked.replace(bearerToken, "Bearer ***").replace(querySecret, "$1***");
  });
  const escaped = lines.join("\\n");
  if (Buffer.byteLength(escaped, "utf8") <= maxBytes) return escaped;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of escaped) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join("");
}

// ADR-0010 §7: the event server token is 64 hex characters; any run that long (or longer) is hidden.
const hexToken = /[0-9a-fA-F]{64,}/g;

/** Hides 64+ hex runs and replaces the user's home folder prefix with `~` (case-insensitive, both separators). */
export function maskErrorText(text: string, home: string | undefined): string {
  let masked = text.replace(hexToken, "***");
  if (home !== undefined && home.length > 0) {
    const trimmed = home.replace(/[\\/]+$/, "");
    if (trimmed.length > 0) {
      // Stack traces and JSON show the same path with / or \ and with \ doubled; match all of them.
      const pattern = trimmed.split(/[\\/]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(?:\\\\{1,2}|/)");
      masked = masked.replace(new RegExp(pattern, "gi"), "~");
    }
  }
  return masked;
}
