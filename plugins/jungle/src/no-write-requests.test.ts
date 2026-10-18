// M5 criterion 4: the jungle plugin must never issue write requests. The only
// network access is ctx.getJson (GET-only by contract), so this static check
// fails when any write-request surface appears in a non-test source file.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

interface ForbiddenPattern {
  name: string;
  regex: RegExp;
  // One line the checker must flag, and a benign lookalike it must pass,
  // so every pattern stays verified (AGENTS.md pattern rule).
  hit: string;
  miss: string;
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    name: "method option",
    regex: /\bmethod\b/i,
    hit: `{ method: "GET" }`,
    miss: `const methodNames: string[] = [];`,
  },
  {
    name: "POST verb",
    regex: /\bPOST\b/,
    hit: `const verb = "POST";`,
    miss: `const town = postalCode(name);`,
  },
  {
    name: "PUT verb",
    regex: /\bPUT\b/,
    hit: `const verbs = ["PUT"];`,
    miss: `const input = readLine();`,
  },
  {
    name: "PATCH verb",
    regex: /\bPATCH\b/,
    hit: `const verbs = ["PATCH"];`,
    miss: `dispatchEvent(event);`,
  },
  {
    name: "DELETE verb",
    regex: /\bDELETE\b/,
    hit: `const verbs = ["DELETE"];`,
    miss: `delete cache[key];`,
  },
  {
    name: "fetch call",
    regex: /\bfetch\s*\(/,
    hit: `await fetch(url);`,
    miss: `await prefetchUrls();`,
  },
  {
    name: "ctx.fetch",
    regex: /\bctx\s*\.\s*fetch\b/,
    hit: `const requester = ctx.fetch;`,
    miss: `await ctx.getJson(url);`,
  },
  {
    name: "XMLHttpRequest",
    regex: /\bXMLHttpRequest\b/,
    hit: `const xhr = new XMLHttpRequest();`,
    miss: `const req = new Request(url);`,
  },
  {
    name: "sendBeacon",
    regex: /\bsendBeacon\b/,
    hit: `navigator.sendBeacon(url, payload);`,
    miss: `const beaconId = "ok";`,
  },
  {
    name: "FormData",
    regex: /\bFormData\b/,
    hit: `const form = new FormData();`,
    miss: `formatDate(now);`,
  },
  {
    name: "WebSocket",
    regex: /\bWebSocket\b/,
    hit: `const ws = new WebSocket(url);`,
    miss: `const socketUrl = "wss://example.invalid";`,
  },
  {
    name: "body option",
    regex: /\bbody\s*:/,
    hit: `{ body: payload }`,
    miss: `const responseBody = await read();`,
  },
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
}

function formatViolation(violation: Violation): string {
  return `${violation.file}:${violation.line}: ${violation.pattern}`;
}

// Text-level checker shared by the pattern self-tests and the directory scan.
// Line-based on purpose: comments and string contents are not excluded
// (conservative — a "POST" in a comment still fails the check).
function findViolationsInText(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(line)) {
        violations.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  }
  return violations;
}

interface SourceScan {
  files: string[];
  violations: Violation[];
}

// Recursively collect non-test .ts files under dir and scan each one.
// Returns the file list too so callers can assert the scan is not vacuous.
async function scanSourceTree(dir: string): Promise<SourceScan> {
  const entries = await readdir(dir, { encoding: "utf8", recursive: true });
  const files = entries.filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts")).sort();
  const violations: Violation[] = [];
  for (const rel of files) {
    const text = await readFile(join(dir, rel), "utf8");
    violations.push(...findViolationsInText(rel, text));
  }
  return { files, violations };
}

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));

describe("forbidden write-request patterns", () => {
  it.each(FORBIDDEN_PATTERNS)(
    "pattern %s flags its hit sample and passes the benign lookalike",
    (pattern) => {
      expect(findViolationsInText("sample.ts", pattern.hit).map((v) => v.pattern)).toContain(
        pattern.name,
      );
      expect(findViolationsInText("sample.ts", pattern.miss)).toEqual([]);
    },
  );
});

describe("jungle plugin sources contain no write requests", () => {
  it("scans the real source tree (index.ts and attendance-phase.ts present)", async () => {
    const { files } = await scanSourceTree(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const names = new Set(files.map((file) => basename(file)));
    expect(names).toContain("index.ts");
    expect(names).toContain("attendance-phase.ts");
  });

  it("finds no forbidden pattern in any non-test .ts file under src", async () => {
    const { violations } = await scanSourceTree(SRC_DIR);
    expect(violations.map(formatViolation)).toEqual([]);
  });

  it("reports violations from fake sources in a temporary directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-jungle-no-write-"));
    try {
      await writeFile(join(dir, "index.ts"), 'export const reader = "getJson";\n');
      await writeFile(
        join(dir, "writer.ts"),
        'await ctx.fetch(url, { method: "POST", body: payload });\n',
      );
      await writeFile(join(dir, "writer.test.ts"), "await ctx.fetch(url);\n");
      await mkdir(join(dir, "lms"));
      await writeFile(join(dir, "lms", "patcher.ts"), "// TODO PATCH endpoint\n");

      const { files, violations } = await scanSourceTree(dir);
      const names = new Set(files.map((file) => basename(file)));
      // Recursion found the nested file, and .test.ts files are exempt.
      expect(names).toEqual(new Set(["index.ts", "writer.ts", "patcher.ts"]));
      expect(violations.map(formatViolation)).toContain("writer.ts:1: method option");
      expect(violations.map(formatViolation)).toContain("writer.ts:1: POST verb");
      expect(violations.map(formatViolation)).toContain("writer.ts:1: body option");
      expect(violations.map(formatViolation)).toContain(join("lms", "patcher.ts") + ":1: PATCH verb");
      // The clean file is not flagged.
      expect(violations.filter((v) => v.file === "index.ts")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
