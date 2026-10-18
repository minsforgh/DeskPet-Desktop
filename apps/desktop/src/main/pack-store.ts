import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const packIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const reservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const unsafePathCharacterPattern = /[\\:<>"|?*]/u;
export const generatedSheetPattern = /^sheets\/[a-z][a-z0-9-]{0,31}-[0-9a-f]{8}\.png$/u;
/** Leftover of atomicWrite for a manifest or a generated sheet: `.<name>.<uuid>.tmp`. */
export const generatedTempPattern =
  /^\.(?:manifest\.json|[a-z][a-z0-9-]{0,31}-[0-9a-f]{8}\.png)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

export interface PackFile {
  path: string;
  data: string | Uint8Array;
}

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function validatePackId(packId: string): void {
  if (!packIdPattern.test(packId) || reservedNamePattern.test(packId)) throw new Error("Invalid pack id");
}

function validateRelativePath(path: string): string[] {
  if (!path || isAbsolute(path) || path.startsWith("/") || unsafePathCharacterPattern.test(path)
    || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error("Invalid pack file path");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part)))
    throw new Error("Invalid pack file path");
  return parts;
}

function realPathOfExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) current = resolve(current, "..");
  return resolve(realpathSync(current), relative(current, path));
}

export function createPackStore({ userDataDir, builtinDir, allowBuiltinWrites = () => false }:
  { userDataDir: string; builtinDir: string; allowBuiltinWrites?: () => boolean }) {
  const userData = resolve(userDataDir);
  const characters = join(userData, "characters");
  const builtin = resolve(builtinDir);

  function checkRoot(): void {
    if (existsSync(userData) && lstatSync(userData).isSymbolicLink()) throw new Error("User data is a link");
    if (existsSync(characters) && lstatSync(characters).isSymbolicLink()) throw new Error("Pack root is a link");
    const userDataReal = realPathOfExistingAncestor(userData);
    const builtinReal = realPathOfExistingAncestor(builtin);
    const charactersReal = existsSync(characters) ? realpathSync(characters) : join(userDataReal, "characters");
    if (charactersReal === builtinReal || inside(builtinReal, charactersReal)) throw new Error("Cannot write built-in packs");
  }

  function ensureRoot(): void {
    checkRoot();
    mkdirSync(characters, { recursive: true });
    checkRoot();
  }

  function checkPath(root: string, parts: string[]): string {
    const target = resolve(root, ...parts);
    if (!inside(root, target)) throw new Error("Pack path escapes its directory");
    checkRoot();
    const targetReal = realPathOfExistingAncestor(target);
    const builtinReal = realPathOfExistingAncestor(builtin);
    if (targetReal === builtinReal || inside(builtinReal, targetReal)) throw new Error("Cannot write built-in packs");
    let current = characters;
    for (const part of relative(characters, target).split(sep)) {
      current = join(current, part);
      if (existsSync(current)) {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Pack path contains a link");
        const real = realpathSync(current);
        if (!inside(realpathSync(characters), real)) throw new Error("Pack path escapes its directory");
      }
    }
    return target;
  }

  /** checkPath's counterpart for a file inside an existing built-in pack folder: no links on the way, nothing outside builtinDir. */
  function checkBuiltinPath(packRoot: string, parts: string[]): string {
    const target = resolve(packRoot, ...parts);
    if (!inside(packRoot, target)) throw new Error("Pack path escapes its directory");
    const builtinReal = realpathSync(builtin);
    let current = builtin;
    for (const part of relative(builtin, target).split(sep)) {
      current = join(current, part);
      let entry;
      try { entry = lstatSync(current); }
      catch (error) {
        // Only a missing entry ends the walk; a dangling link still lstat-s and is refused below.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      if (entry.isSymbolicLink()) throw new Error("Pack path contains a link");
      if (!inside(builtinReal, realpathSync(current))) throw new Error("Pack path escapes its directory");
    }
    return target;
  }

  function atomicWrite(root: string, relPath: string, data: string | Uint8Array,
    check: (root: string, parts: string[]) => string = checkPath): void {
    const parts = validateRelativePath(relPath);
    const target = check(root, parts);
    mkdirSync(resolve(target, ".."), { recursive: true });
    check(root, parts);
    const temporary = join(resolve(target, ".."), `.${parts.at(-1)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, data, { flag: "wx" });
      check(root, parts);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  function packDirectory(packId: string): string {
    validatePackId(packId);
    ensureRoot();
    const directory = checkPath(characters, [packId]);
    if (existsSync(join(builtin, packId))) throw new Error("Pack id belongs to a built-in pack");
    return directory;
  }

  return {
    writePackFile(packId: string, relPath: string, data: string | Uint8Array): void {
      const directory = packDirectory(packId);
      mkdirSync(directory, { recursive: true });
      atomicWrite(directory, relPath, data);
    },
    /** Developer mode only (D-044): writes into the existing built-in folder builtinDir/<id>/ with the same path rules and atomic write. */
    writeBuiltinPackFile(packId: string, relPath: string, data: string | Uint8Array): void {
      if (!allowBuiltinWrites()) throw new Error("Built-in pack writes are not enabled");
      validatePackId(packId);
      const directory = resolve(builtin, packId);
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
        throw new Error("Built-in pack not found");
      atomicWrite(directory, relPath, data, checkBuiltinPath);
    },
    /** Developer mode only: remove one checked file, never a directory. */
    removeBuiltinPackFile(packId: string, relPath: string): void {
      if (!allowBuiltinWrites()) throw new Error("Built-in pack writes are not enabled");
      validatePackId(packId);
      if (!generatedSheetPattern.test(relPath)) throw new Error("Only generated sheets may be removed");
      const directory = resolve(builtin, packId);
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
        throw new Error("Built-in pack not found");
      const target = checkBuiltinPath(directory, validateRelativePath(relPath));
      if (existsSync(target)) {
        if (!lstatSync(target).isFile()) throw new Error("Built-in pack target is not a file");
        rmSync(target);
      }
    },
    /**
     * Developer mode only: delete app-generated sheets that `referenced` does not name, and leftover temp files of
     * the pack folder and its sheets folder. Anything else (original sheets included) is never touched.
     */
    cleanupBuiltinPack(packId: string, referenced: ReadonlySet<string>): string[] {
      if (!allowBuiltinWrites()) throw new Error("Built-in pack writes are not enabled");
      validatePackId(packId);
      const directory = resolve(builtin, packId);
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
        throw new Error("Built-in pack not found");
      const removed: string[] = [];
      for (const folder of ["", "sheets"]) {
        let names: string[];
        try {
          if (folder !== "") checkBuiltinPath(directory, [folder]);
          names = readdirSync(join(directory, folder), { withFileTypes: true })
            .filter((entry) => entry.isFile()).map((entry) => entry.name);
        } catch { continue; }
        for (const name of names) {
          const relPath = folder === "" ? name : `${folder}/${name}`;
          const orphan = generatedSheetPattern.test(relPath) && !referenced.has(relPath);
          if (!orphan && !generatedTempPattern.test(name)) continue;
          try {
            const target = checkBuiltinPath(directory, relPath.split("/"));
            if (!lstatSync(target).isFile()) continue;
            rmSync(target);
            removed.push(relPath);
          } catch (error) { console.warn("Cannot clean generated file:", error); }
        }
      }
      return removed;
    },
    removePack(packId: string): void {
      const directory = packDirectory(packId);
      if (existsSync(directory)) rmSync(directory, { recursive: true });
    },
    listUserPackIds(): string[] {
      ensureRoot();
      return readdirSync(characters, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && packIdPattern.test(entry.name) && !reservedNamePattern.test(entry.name))
        .map((entry) => entry.name).sort();
    },
    async stagePack(packId: string, files: readonly PackFile[],
      validate: (stagingRoot: string, id: string) => void | Promise<void>): Promise<void> {
      const target = packDirectory(packId);
      if (existsSync(target)) throw new Error("Pack already exists");
      const staging = join(characters, `.staging-${randomUUID()}`);
      mkdirSync(staging);
      const stagedPack = join(staging, packId);
      try {
        mkdirSync(stagedPack);
        for (const file of files) atomicWrite(stagedPack, file.path, file.data);
        await validate(staging, packId);
        if (existsSync(target)) throw new Error("Pack already exists");
        checkPath(characters, [packId]);
        renameSync(stagedPack, target);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      rmSync(staging, { recursive: true, force: true });
    },
    cleanupStaging(): void {
      ensureRoot();
      for (const entry of readdirSync(characters, { withFileTypes: true })) {
        if (entry.name.startsWith(".staging-") && entry.isDirectory())
          rmSync(join(characters, entry.name), { recursive: true });
      }
    },
  };
}
