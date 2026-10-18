import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPlugins } from "./discover.js";

const temporary: string[] = [];
const manifest = {
  id: "good", name: "Good", version: "1.0.0", apiVersion: "1", entry: "dist/index.js",
  description: "Good plugin", permissions: {}, contributes: {},
};

async function plugin(root: string, id: string, value: unknown): Promise<void> {
  const folder = path.join(root, id);
  await mkdir(path.join(folder, "dist"), { recursive: true });
  await writeFile(path.join(folder, "dist", "index.js"), "export {};");
  await writeFile(path.join(folder, "manifest.json"), JSON.stringify(value));
}

afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("plugin discovery", () => {
  it("loads valid v2 lines and rejects missing, escaping, linked, and invalid catalogs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deskpet-lines-discover-"));
    temporary.push(root);
    const catalog = { version: 1, lines: [{ id: "good.done", label: "Done", kind: "done",
      variables: [], variants: ["Done"] }] };
    const v2 = (id: string, lines: string) => ({ ...manifest, id, apiVersion: "2", contributes: { lines } });
    await plugin(root, "good", v2("good", "lines.json"));
    await writeFile(path.join(root, "good", "lines.json"), JSON.stringify(catalog));
    await plugin(root, "missing", v2("missing", "missing.json"));
    await plugin(root, "escape", v2("escape", "../good/lines.json"));
    await plugin(root, "absolute", v2("absolute", path.join(root, "good", "lines.json")));
    await plugin(root, "linked", v2("linked", "outside/lines.json"));
    await symlink(path.join(root, "good"), path.join(root, "linked", "outside"), "junction");
    await plugin(root, "broken", v2("broken", "lines.json"));
    await writeFile(path.join(root, "broken", "lines.json"), JSON.stringify({ ...catalog,
      lines: [{ ...catalog.lines[0], id: "other.done" }] }));
    const found = await discoverPlugins(root);
    const good = found.find((item) => item.id === "good");
    expect(good?.state).toBe("valid");
    if (good?.state === "valid") expect(good.lines).toEqual(catalog);
    for (const id of ["missing", "escape", "absolute", "linked", "broken"])
      expect(found.find((item) => item.id === id)?.state).toBe("invalid");
  });
  it("scans only immediate nonhidden folders and isolates invalid plugins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deskpet-discover-"));
    temporary.push(root);
    await plugin(root, "good", manifest);
    await plugin(root, "broken", { ...manifest, id: "broken", apiVersion: "3" });
    await plugin(root, "v2", { ...manifest, id: "v2", apiVersion: "2", permissions: { socketMode: ["slack.com"] } });
    await plugin(root, "v1socket", { ...manifest, id: "v1socket", permissions: { socketMode: ["slack.com"] } });
    await plugin(root, "missingversion", { ...manifest, id: "missingversion", apiVersion: undefined });
    await plugin(root, "mismatch", manifest);
    await plugin(root, "ip", { ...manifest, id: "ip", permissions: { network: ["127.0.0.1"] } });
    await plugin(root, "huge", { ...manifest, id: "huge", description: "x".repeat(65_536) });
    await plugin(root, "_private", { ...manifest, id: "_private" });
    await plugin(root, ".hidden", { ...manifest, id: ".hidden" });
    await plugin(root, "node_modules", { ...manifest, id: "node_modules" });
    const found = await discoverPlugins(root);
    expect(found.map((item) => item.id)).toEqual(["broken", "good", "huge", "ip", "mismatch", "missingversion", "v1socket", "v2"]);
    expect(found.find((item) => item.id === "good")?.state).toBe("valid");
    expect(found.find((item) => item.id === "v2")?.state).toBe("valid");
    expect(found.find((item) => item.id === "v1socket")?.state).toBe("invalid");
    for (const item of found.filter((candidate) => candidate.state === "invalid")) {
      expect(item.reason.length).toBeLessThanOrEqual(200);
      expect(item.reason).not.toContain(root);
      expect(item.reason).not.toContain("x".repeat(20));
    }
  });

  it("does not scan nested plugins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deskpet-discover-"));
    temporary.push(root);
    await plugin(root, "parent", { ...manifest, id: "parent" });
    await plugin(path.join(root, "parent"), "child", { ...manifest, id: "child" });
    expect((await discoverPlugins(root)).map((item) => item.id)).toEqual(["parent"]);
  });
});
