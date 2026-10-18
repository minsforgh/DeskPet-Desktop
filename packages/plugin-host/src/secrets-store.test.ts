import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretsStore, validSecretKey } from "./secrets-store.js";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function store(available = true) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskpet-secrets-"));
  folders.push(folder);
  const warnings: string[] = [];
  const secrets = new SecretsStore(folder, {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${value}`),
    decrypt: (value) => {
      const decoded = value.toString();
      if (!decoded.startsWith("encrypted:")) throw new Error("bad cipher");
      return decoded.slice(10);
    },
  }, (warning) => warnings.push(warning));
  return { folder, secrets, warnings };
}

describe("secrets store", () => {
  it("checks the actual key pattern with accepted and rejected examples", () => {
    for (const key of ["a", "A_1.-", "x".repeat(64)]) expect(validSecretKey(key)).toBe(true);
    for (const key of ["", "x".repeat(65), "with space", "a/b", "é"]) expect(validSecretKey(key)).toBe(false);
  });

  it("encrypts values into separate plugin namespaces and returns null for failed decryption", async () => {
    const { folder, secrets, warnings } = await store();
    await secrets.set("one", "key", "value");
    expect(await secrets.get("one", "key")).toBe("value");
    expect(await secrets.get("two", "key")).toBeNull();
    const file = JSON.parse(await readFile(path.join(folder, "plugin-secrets.json"), "utf8"));
    expect(file.entries.one.key).toBe(Buffer.from("encrypted:value").toString("base64"));
    await writeFile(path.join(folder, "plugin-secrets.json"), JSON.stringify({ version: 1, entries: { one: { key: "bad" } } }));
    expect(await secrets.get("one", "key")).toBeNull();
    expect(await secrets.get("one", "key")).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("reports and deletes stored values without touching other keys or plugins", async () => {
    const { folder, secrets } = await store();
    await secrets.set("one", "a", "first");
    await secrets.set("one", "b", "second");
    await secrets.set("two", "a", "third");
    expect(await secrets.has("one", "a")).toBe(true);
    expect(await secrets.has("one", "missing")).toBe(false);
    await secrets.delete("one", "a");
    await secrets.delete("one", "never-stored");
    expect(await secrets.has("one", "a")).toBe(false);
    expect(await secrets.get("one", "b")).toBe("second");
    expect(await secrets.get("two", "a")).toBe("third");
    await secrets.delete("one", "b");
    const file = JSON.parse(await readFile(path.join(folder, "plugin-secrets.json"), "utf8"));
    expect(Object.keys(file.entries)).toEqual(["two"]);
    await expect(secrets.delete("one", "bad/key")).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(secrets.has("one", "bad/key")).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it("stores prototype-named namespaces and keys without changing Object built-ins", async () => {
    const { folder, secrets } = await store();
    for (const pluginId of ["constructor", "__proto__", "hasOwn"]) {
      for (const key of ["constructor", "__proto__", "hasOwn"])
        await secrets.set(pluginId, key, `${pluginId}:${key}`);
    }
    for (const pluginId of ["constructor", "__proto__", "hasOwn"]) {
      for (const key of ["constructor", "__proto__", "hasOwn"])
        expect(await secrets.get(pluginId, key)).toBe(`${pluginId}:${key}`);
    }
    expect(await secrets.get("toString", "hasOwn")).toBeNull();
    expect(Object.hasOwn).toBeTypeOf("function");
    const file = JSON.parse(await readFile(path.join(folder, "plugin-secrets.json"), "utf8"));
    expect(Object.hasOwn(file.entries, "__proto__")).toBe(true);
    expect(Object.hasOwn(file.entries.__proto__, "hasOwn")).toBe(true);
  });

  it("rejects unavailable encryption, oversized values, too many keys and linked storage", async () => {
    const unavailable = await store(false);
    await expect(unavailable.secrets.set("one", "key", "value")).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    const { folder, secrets } = await store();
    await expect(secrets.set("one", "bad/key", "value")).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(secrets.set("one", "key", "é".repeat(4097))).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    for (let index = 0; index < 64; index++) await secrets.set("one", `key${index}`, "x");
    await expect(secrets.set("one", "extra", "x")).rejects.toMatchObject({ code: "E_RATE_LIMIT" });
    await secrets.set("one", "key0", "updated");
    const other = await store();
    await rm(path.join(folder, "plugin-secrets.json"));
    try {
      await symlink(path.join(other.folder, "plugin-secrets.json"), path.join(folder, "plugin-secrets.json"));
      await expect(secrets.get("one", "key0")).rejects.toThrow();
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EPERM")) throw error;
    }
  });
});
