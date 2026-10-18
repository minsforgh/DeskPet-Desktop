import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const patterns = [
  { label: "ctx.exec", regex: /\bctx\s*\.\s*exec\b/u, hit: "ctx.exec('orca')", miss: "ctx.orca.snapshot()" },
  { label: "child_process", regex: /\bchild_process\b/u, hit: "from 'child_process'", miss: "from '@deskpet/core'" },
  { label: "gate command", regex: /gate-resolve/u, hit: "gate-resolve", miss: "resolveGate" },
  { label: "terminal command", regex: /terminal\s+switch/u, hit: "terminal switch", miss: "openTerminal" },
  { label: "check command", regex: /\bcheck\s+--/u, hit: "check --peek", miss: "snapshot()" },
];

test("forbidden command patterns match their examples and miss safe APIs", () => {
  for (const { regex, hit, miss } of patterns) {
    expect(regex.test(hit)).toBe(true);
    expect(regex.test(miss)).toBe(false);
  }
});

test("Orca source has no direct CLI writes or mail checks", async () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files = (await readdir(root)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  expect(files).toContain("index.ts");
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    expect(patterns.filter(({ regex }) => regex.test(source)).map(({ label }) => label)).toEqual([]);
  }
});

test("Orca write-capable context methods appear only in registered action handlers", async () => {
  const source = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const gateStart = source.indexOf("ctx.registerAction(GATE_ACTION");
  const openStart = source.indexOf("ctx.registerAction(OPEN_ACTION");
  const scheduleStart = source.indexOf("ctx.schedule.every(POLL_MS");
  expect(gateStart).toBeGreaterThan(0);
  expect(openStart).toBeGreaterThan(gateStart);
  expect(scheduleStart).toBeGreaterThan(openStart);
  expect(source.match(/ctx\.orca\.resolveGate\(/gu)).toHaveLength(1);
  expect(source.match(/ctx\.orca\.openTerminal\(/gu)).toHaveLength(1);
  expect(source.match(/ctx\.orca\.muteGate\(/gu)).toHaveLength(1);
  expect(source.slice(gateStart, openStart)).toContain("ctx.orca.resolveGate(");
  expect(source.slice(openStart, scheduleStart)).toContain("ctx.orca.openTerminal(");
  expect(source.slice(openStart, scheduleStart)).toContain("ctx.orca.muteGate(");
});
