import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SecretErrorCode = "E_PERMISSION" | "E_INVALID_ARGUMENT" | "E_UNAVAILABLE" | "E_RATE_LIMIT";

export class SecretStoreError extends Error {
  constructor(readonly code: SecretErrorCode, message: string) { super(message); }
}

export interface SecretCryptography {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface SecretFile { version: 1; entries: Record<string, Record<string, string>> }

const keyPattern = /^[A-Za-z0-9_.-]{1,64}$/;

export function validSecretKey(key: string): boolean { return keyPattern.test(key); }

export class SecretsStore {
  private writing: Promise<void> = Promise.resolve();
  private readonly warned = new Set<string>();

  constructor(private readonly userDataDir: string, private readonly crypto: SecretCryptography,
    private readonly warn: (message: string) => void = () => {}) {}

  private async filePath(): Promise<string> {
    const root = await realpath(this.userDataDir);
    const file = path.join(root, "plugin-secrets.json");
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file)
        throw new Error("secret file must be a regular file within user data");
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return file;
  }

  private async load(): Promise<SecretFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(await this.filePath(), "utf8"));
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
          "version" in raw && raw.version === 1 && "entries" in raw &&
          raw.entries !== null && typeof raw.entries === "object" && !Array.isArray(raw.entries)) {
        const entries: Record<string, Record<string, string>> = Object.create(null);
        for (const [pluginId, item] of Object.entries(raw.entries)) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) break;
          const secrets: Record<string, string> = Object.create(null);
          let valid = true;
          for (const [key, cipher] of Object.entries(item)) {
            if (typeof cipher !== "string") { valid = false; break; }
            secrets[key] = cipher;
          }
          if (!valid) break;
          entries[pluginId] = secrets;
        }
        if (Object.keys(entries).length === Object.keys(raw.entries).length)
          return { version: 1, entries };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError || error !== null && typeof error === "object" &&
          "code" in error && error.code === "ENOENT")) throw error;
    }
    return { version: 1, entries: Object.create(null) };
  }

  async get(pluginId: string, key: string): Promise<string | null> {
    if (!validSecretKey(key)) throw new SecretStoreError("E_INVALID_ARGUMENT", "잘못된 비밀 키입니다");
    await this.writing;
    const entries = (await this.load()).entries;
    const namespace = Object.hasOwn(entries, pluginId) ? entries[pluginId] : undefined;
    const encoded = namespace && Object.hasOwn(namespace, key) ? namespace[key] : undefined;
    if (encoded === undefined) return null;
    try {
      if (!this.crypto.isAvailable()) throw new Error("encryption unavailable");
      return this.crypto.decrypt(Buffer.from(encoded, "base64"));
    } catch {
      const identity = `${pluginId}:${key}`;
      if (!this.warned.has(identity)) {
        this.warned.add(identity);
        this.warn(`Could not decrypt secret for ${pluginId}`);
      }
      return null;
    }
  }

  /** Whether a value is stored, without decrypting it. */
  async has(pluginId: string, key: string): Promise<boolean> {
    if (!validSecretKey(key)) throw new SecretStoreError("E_INVALID_ARGUMENT", "잘못된 비밀 키입니다");
    await this.writing;
    const entries = (await this.load()).entries;
    return Object.hasOwn(entries, pluginId) && Object.hasOwn(entries[pluginId] ?? {}, key);
  }

  async delete(pluginId: string, key: string): Promise<void> {
    if (!validSecretKey(key)) throw new SecretStoreError("E_INVALID_ARGUMENT", "잘못된 비밀 키입니다");
    const operation = this.writing.then(async () => {
      const file = await this.load();
      const entries = Object.hasOwn(file.entries, pluginId) ? file.entries[pluginId] : undefined;
      if (!entries || !Object.hasOwn(entries, key)) return;
      Reflect.deleteProperty(entries, key);
      if (Object.keys(entries).length === 0) Reflect.deleteProperty(file.entries, pluginId);
      await this.write(file);
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  async set(pluginId: string, key: string, value: string): Promise<void> {
    if (!validSecretKey(key) || Buffer.byteLength(value, "utf8") > 8192)
      throw new SecretStoreError("E_INVALID_ARGUMENT", "비밀 키 또는 값이 허용 범위를 벗어났습니다");
    if (!this.crypto.isAvailable()) throw new SecretStoreError("E_UNAVAILABLE", "암호화를 사용할 수 없습니다");
    const operation = this.writing.then(async () => {
      const file = await this.load();
      const entries: Record<string, string> = file.entries[pluginId] ?? Object.create(null);
      if (!Object.hasOwn(entries, key) && Object.keys(entries).length >= 64)
        throw new SecretStoreError("E_RATE_LIMIT", "비밀은 64개까지 저장할 수 있습니다");
      entries[key] = this.crypto.encrypt(value).toString("base64");
      this.warned.delete(`${pluginId}:${key}`);
      file.entries[pluginId] = entries;
      await this.write(file);
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  private async write(file: SecretFile): Promise<void> {
    const target = await this.filePath();
    const temporary = path.join(path.dirname(target), `.plugin-secrets-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(file), { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
