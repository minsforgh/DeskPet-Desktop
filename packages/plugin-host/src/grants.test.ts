import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGrant, loadGrants, permissionsHash, recordGrant, saveGrants } from "./grants.js";
import type { GrantFile } from "./grants.js";

const now = () => new Date("2026-10-07T00:00:00.000Z");
const temporary: string[] = [];
const blank = (): GrantFile => ({ version: 1, grants: {} });

afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("plugin grants", () => {
  it("keeps the v1 hash and requires approval when socketMode is added", () => {
    const v1 = { network: ["slack.com"], secrets: true };
    expect(permissionsHash(v1)).toBe("sha256:609b487efe5727e4cb7d949e666acdb8b1c5b4fcb250283333518eaed2a93066");
    const file = blank();
    recordGrant(file, "slack", v1, "granted", now);
    expect(checkGrant(file, "slack", v1, now)).toBe("granted");
    const v2 = { ...v1, socketMode: ["slack.com"] };
    expect(permissionsHash(v2)).toBe("sha256:4a28c9fe9d2c40cb1b0acb81880a108845b7fe054dff5e5a14498ba01ac374f1");
    expect(permissionsHash(v2)).not.toBe(permissionsHash(v1));
    expect(checkGrant(file, "slack", v2, now)).toBe("needs-permission");
    recordGrant(file, "slack", v2, "granted", now);
    expect(checkGrant(file, "slack", v2, now)).toBe("granted");
    expect(checkGrant(file, "slack", v1, now)).toBe("updated");
  });

  it("requires approval for each Orca permission and preserves saved grants", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deskpet-grants-"));
    temporary.push(dir);
    const file = blank();
    const read = { orcaRead: true };
    recordGrant(file, "orca", read, "granted", now);
    for (const permission of ["orcaGateResolve", "orcaOpenTerminal"] as const) {
      const expanded = { ...read, [permission]: true };
      expect(checkGrant(file, "orca", expanded, now)).toBe("needs-permission");
      recordGrant(file, "orca", expanded, "granted", now);
      expect(checkGrant(file, "orca", expanded, now)).toBe("granted");
    }
    const all = { ...read, orcaGateResolve: true, orcaOpenTerminal: true };
    expect(checkGrant(file, "orca", all, now)).toBe("needs-permission");
    recordGrant(file, "orca", all, "granted", now);
    await saveGrants(dir, file);
    expect(await loadGrants(dir)).toEqual(file);
    const invalid = { orcaRead: "true" };
    const grant = { ...file.grants.orca, permissions: invalid,
      permissionsHash: `sha256:${createHash("sha256").update(JSON.stringify(invalid)).digest("hex")}` };
    await writeFile(path.join(dir, "plugin-grants.json"), JSON.stringify({ version: 1, grants: { orca: grant } }));
    expect(await loadGrants(dir)).toEqual(blank());
  });

  it("hashes sorted keys and arrays and asks when permissions grow", () => {
    expect(permissionsHash({ network: ["b.example", "a.example"], shell: true })).toBe(
      permissionsHash({ shell: true, network: ["a.example", "b.example"] }));
    const file = blank();
    expect(checkGrant(file, "example", { network: ["a.example"] }, now)).toBe("needs-permission");
    recordGrant(file, "example", { network: ["a.example"] }, "granted", now);
    expect(checkGrant(file, "example", { network: ["a.example"] }, now)).toBe("granted");
    expect(checkGrant(file, "example", { network: ["a.example", "b.example"] }, now)).toBe("needs-permission");
    expect(checkGrant(file, "example", { shell: true }, now)).toBe("needs-permission");
  });

  it("updates a granted subset, records empty permissions, and remembers denial", () => {
    const file = blank();
    recordGrant(file, "example", { network: ["a.example", "b.example"], shell: true }, "granted", now);
    expect(checkGrant(file, "example", { network: ["b.example"] }, now)).toBe("updated");
    expect(file.grants.example?.permissions).toEqual({ network: ["b.example"] });
    expect(checkGrant(file, "empty", {}, now)).toBe("updated");
    expect(file.grants.empty?.decision).toBe("granted");
    recordGrant(file, "denied", { secrets: true }, "denied", now);
    expect(checkGrant(file, "denied", { secrets: true }, now)).toBe("denied");
    expect(checkGrant(file, "denied", { shell: true }, now)).toBe("needs-permission");
  });

  it("loads corrupted files as ungranted and writes atomically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deskpet-grants-"));
    temporary.push(dir);
    const target = path.join(dir, "plugin-grants.json");
    await writeFile(target, "{");
    expect(await loadGrants(dir)).toEqual(blank());
    const file = blank();
    recordGrant(file, "example", { secrets: true }, "granted", now);
    await saveGrants(dir, file);
    expect(await loadGrants(dir)).toEqual(file);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(file);
    expect((await readdir(dir)).sort()).toEqual(["plugin-grants.json"]);
    await writeFile(target, JSON.stringify({ version: 1, grants: { example: { ...file.grants.example, permissionsHash: "bad" } } }));
    expect(await loadGrants(dir)).toEqual(blank());
  });

  it("loads approved socketMode grants and rejects invalid saved values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deskpet-grants-"));
    temporary.push(dir);
    const file = blank();
    recordGrant(file, "slack", { socketMode: ["slack.com"] }, "granted", now);
    await saveGrants(dir, file);
    expect(await loadGrants(dir)).toEqual(file);
    const permissions = { socketMode: ["other.com"] };
    const grant = { ...file.grants.slack, permissions, permissionsHash: permissionsHash(permissions) };
    await writeFile(path.join(dir, "plugin-grants.json"), JSON.stringify({ version: 1, grants: { slack: grant } }));
    expect(await loadGrants(dir)).toEqual(blank());
  });

  it("rejects a linked grant file", async (context) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deskpet-grants-"));
    temporary.push(dir);
    const outside = await mkdtemp(path.join(os.tmpdir(), "deskpet-grants-"));
    temporary.push(outside);
    const destination = path.join(outside, "other.json");
    await writeFile(destination, "{}");
    try {
      await symlink(destination, path.join(dir, "plugin-grants.json"), "file");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")) {
        console.warn(`Skipping link test: ${String(error.code)}`);
        context.skip();
        return;
      }
      throw error;
    }
    await expect(loadGrants(dir)).rejects.toThrow();
    await expect(saveGrants(dir, blank())).rejects.toThrow();
  });
});
