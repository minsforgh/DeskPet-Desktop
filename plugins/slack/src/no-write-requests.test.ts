import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const patterns = [
  { label: "chat.postMessage", regex: /\bchat\.postMessage\b/u, hit: "chat.postMessage", miss: "chat.get" },
  { label: "reactions", regex: /\breactions\./u, hit: "reactions.add", miss: "reactionRule" },
  { label: "conversations.mark", regex: /\bconversations\.mark\b/u, hit: "conversations.mark", miss: "conversations.info" },
  { label: "chat.update", regex: /\bchat\.update\b/u, hit: "chat.update", miss: "chat.info" },
  { label: "chat.delete", regex: /\bchat\.delete\b/u, hit: "chat.delete", miss: "chat.info" },
  { label: "files.upload", regex: /\bfiles\.upload\b/u, hit: "files.upload", miss: "files.info" },
  { label: "ctx.fetch", regex: /\bctx\s*\.\s*fetch\b/u, hit: "ctx.fetch(url)", miss: "ctx.slack.get(options)" },
  { label: "POST option", regex: /\bmethod\s*:\s*["']POST["']/u, hit: 'method: "POST"', miss: 'method: "GET"' },
];

describe("Slack source has no write requests", () => {
  test.each(patterns)("$label recognizes its hit and rejects its benign example", ({ regex, hit, miss }) => {
    expect(regex.test(hit)).toBe(true);
    expect(regex.test(miss)).toBe(false);
  });
  test("scans every non-test source file", async () => {
    const root = fileURLToPath(new URL("./", import.meta.url));
    const files = (await readdir(root)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(files).toContain("index.ts");
    for (const file of files) {
      const source = await readFile(join(root, file), "utf8");
      expect(patterns.filter(({ regex }) => regex.test(source)).map(({ label }) => label)).toEqual([]);
    }
  });
});
