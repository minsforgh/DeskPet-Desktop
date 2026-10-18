import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createPackStore, generatedTempPattern } from "./pack-store.js";

let base: string;
let userDataDir: string;
let builtinDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deskpet-pack-store-"));
  userDataDir = join(base, "user");
  builtinDir = join(base, "builtin");
  mkdirSync(builtinDir);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function store() { return createPackStore({ userDataDir, builtinDir }); }
function packPath(...parts: string[]) { return join(userDataDir, "characters", ...parts); }

describe("pack store paths", () => {
  test("accepts valid ids and paths and lists only user pack directories", () => {
    const packs = store();
    packs.writePackFile("a-0", "sheets/idle.png", "image");
    packs.writePackFile("z", "manifest.json", "{}");
    mkdirSync(packPath(".staging-old"));
    expect(readFileSync(packPath("a-0", "sheets", "idle.png"), "utf8")).toBe("image");
    expect(packs.listUserPackIds()).toEqual(["a-0", "z"]);
    packs.removePack("a-0");
    expect(existsSync(packPath("a-0"))).toBe(false);
  });

  test("rejects invalid ids using the actual id pattern", () => {
    const packs = store();
    for (const id of ["A", "Wolf", "", "-a", "a_1", "a".repeat(49), "con", "nul", "prn", "aux", "com1", "com9", "lpt1", "lpt9", "../evil"]) {
      expect(() => packs.writePackFile(id, "manifest.json", "bad"), id).toThrow();
    }
    for (const id of ["a", "0", "wolf-maid", "a".repeat(48), "com0", "lpt0"]) {
      expect(() => packs.writePackFile(id, "manifest.json", "good"), id).not.toThrow();
    }
  });

  test("rejects traversal, absolute paths, Windows syntax and unsafe components", () => {
    const packs = store();
    for (const path of ["../escape", "a/../escape", "a/./file", "/absolute", "C:/drive", "a\\file", "a:stream", "a//file", "a/", "a. /file", "name.", "name ", "a\u0000b", "a\u007fb"]) {
      expect(() => packs.writePackFile("safe", path, "bad"), path).toThrow();
    }
    expect(existsSync(join(userDataDir, "escape"))).toBe(false);
    expect(readdirSync(packPath("safe"))).toEqual([]);
  });

  test("rejects the built-in directory and built-in ids", () => {
    const nested = createPackStore({ userDataDir: builtinDir, builtinDir });
    expect(() => nested.writePackFile("own", "manifest.json", "bad")).toThrow();
    const exact = createPackStore({ userDataDir, builtinDir: packPath() });
    expect(() => exact.writePackFile("own", "manifest.json", "bad")).toThrow();
    const nestedInside = createPackStore({ userDataDir, builtinDir: packPath("own", "sheets") });
    expect(() => nestedInside.writePackFile("own", "sheets/idle.png", "bad")).toThrow();
    mkdirSync(join(builtinDir, "shipped"));
    expect(() => store().writePackFile("shipped", "manifest.json", "bad")).toThrow();
    expect(existsSync(join(builtinDir, "characters"))).toBe(false);
    expect(readdirSync(join(builtinDir, "shipped"))).toEqual([]);
  });

  test("rejects a link in the pack or parent path", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    const packs = store();
    packs.writePackFile("safe", "manifest.json", "{}");
    try {
      symlinkSync(outside, packPath("safe", "linked"), "junction");
    } catch (error) {
      console.warn(`Skipping link test: ${String(error)}`);
      return;
    }
    expect(() => packs.writePackFile("safe", "linked/escape", "bad")).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("atomic writes and staging", () => {
  test("replaces an existing file and leaves no temporary files", () => {
    const packs = store();
    packs.writePackFile("own", "manifest.json", "old");
    packs.writePackFile("own", "manifest.json", "new");
    expect(readFileSync(packPath("own", "manifest.json"), "utf8")).toBe("new");
    expect(readdirSync(packPath("own"))).toEqual(["manifest.json"]);
  });

  test("cleans up a temporary file when rename fails", () => {
    const packs = store();
    packs.writePackFile("own", "manifest.json", "old");
    mkdirSync(packPath("own", "blocked"));
    expect(() => packs.writePackFile("own", "blocked", "new")).toThrow();
    expect(readFileSync(packPath("own", "manifest.json"), "utf8")).toBe("old");
    expect(readdirSync(packPath("own"))).toEqual(["blocked", "manifest.json"]);
  });

  test("commits a validated staging directory and removes failed staging", async () => {
    const packs = store();
    await packs.stagePack("good", [{ path: "manifest.json", data: "{}" }], async (directory, id) => {
      expect(readFileSync(join(directory, id, "manifest.json"), "utf8")).toBe("{}");
    });
    expect(readFileSync(packPath("good", "manifest.json"), "utf8")).toBe("{}");
    await expect(packs.stagePack("bad", [{ path: "manifest.json", data: "bad" }], async () => { throw new Error("invalid"); }))
      .rejects.toThrow("invalid");
    await expect(packs.stagePack("partial", [
      { path: "manifest.json", data: "{}" },
      { path: "../escape", data: "bad" },
    ], () => {})).rejects.toThrow();
    await expect(packs.stagePack("good", [{ path: "manifest.json", data: "new" }], () => {})).rejects.toThrow();
    expect(readFileSync(packPath("good", "manifest.json"), "utf8")).toBe("{}");
    expect(readdirSync(packPath()).sort()).toEqual(["good"]);
  });

  test("does not expose a pack until asynchronous validation finishes", async () => {
    const packs = store();
    let release: (() => void) | undefined;
    let signalEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const entered = new Promise<void>((resolveEntered) => { signalEntered = resolveEntered; });
    const installation = packs.stagePack("delayed", [{ path: "manifest.json", data: "{}" }], async () => {
      signalEntered?.();
      await gate;
    });
    await entered;
    expect(packs.listUserPackIds()).not.toContain("delayed");
    release?.();
    await installation;
    expect(packs.listUserPackIds()).toContain("delayed");
  });

  test("cleans abandoned staging directories without touching packs", () => {
    const packs = store();
    packs.writePackFile("own", "manifest.json", "{}");
    mkdirSync(packPath(".staging-orphan"));
    writeFileSync(packPath(".staging-orphan", "partial"), "bad");
    packs.cleanupStaging();
    expect(readdirSync(packPath())).toEqual(["own"]);
  });
});

describe("built-in writes (D-044)", () => {
  const enabled = () => createPackStore({ userDataDir, builtinDir, allowBuiltinWrites: () => true });

  test("refuses unless enabled, and the normal entry point still refuses built-in ids", () => {
    mkdirSync(join(builtinDir, "wolf"));
    expect(() => store().writeBuiltinPackFile("wolf", "voice.json", "{}")).toThrow();
    expect(() => enabled().writePackFile("wolf", "voice.json", "{}")).toThrow();
    expect(existsSync(join(builtinDir, "wolf", "voice.json"))).toBe(false);
  });

  test("writes atomically into an existing built-in folder", () => {
    mkdirSync(join(builtinDir, "wolf"));
    enabled().writeBuiltinPackFile("wolf", "sub/voice.json", "{\"a\":1}");
    expect(readFileSync(join(builtinDir, "wolf", "sub", "voice.json"), "utf8")).toBe("{\"a\":1}");
    expect(readdirSync(join(builtinDir, "wolf", "sub"))).toEqual(["voice.json"]);
  });

  test("rejects unknown packs, bad ids, traversal and unsafe paths", () => {
    mkdirSync(join(builtinDir, "wolf"));
    const packs = enabled();
    expect(() => packs.writeBuiltinPackFile("missing", "voice.json", "x")).toThrow();
    for (const id of ["../wolf", "A", "", "con"]) expect(() => packs.writeBuiltinPackFile(id, "voice.json", "x"), id).toThrow();
    for (const path of ["../escape", "a/../../escape", "/abs", "C:/drive", "a\b", "a//b"])
      expect(() => packs.writeBuiltinPackFile("wolf", path, "x"), path).toThrow();
    expect(existsSync(join(builtinDir, "escape"))).toBe(false);
  });

  test("rejects links inside the pack or as the pack folder", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(builtinDir, "wolf"));
    try {
      symlinkSync(outside, join(builtinDir, "wolf", "link"), "junction");
      symlinkSync(outside, join(builtinDir, "linked"), "junction");
    } catch { return; }
    const packs = enabled();
    expect(() => packs.writeBuiltinPackFile("wolf", "link/voice.json", "x")).toThrow();
    expect(() => packs.writeBuiltinPackFile("linked", "voice.json", "x")).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  test("developer removal accepts only an app-generated sheet in a checked built-in pack", () => {
    mkdirSync(join(builtinDir, "wolf", "sheets"), { recursive: true });
    const generated = join(builtinDir, "wolf", "sheets", "bow-1234abcd.png");
    const original = join(builtinDir, "wolf", "sheets", "bow.png");
    writeFileSync(generated, "new");
    writeFileSync(original, "original");
    expect(() => store().removeBuiltinPackFile("wolf", "sheets/bow-1234abcd.png")).toThrow();
    const enabled = createPackStore({ userDataDir, builtinDir, allowBuiltinWrites: () => true });
    for (const path of ["sheets/bow.png", "manifest.json", "../outside.png", "sheets/../../outside.png",
      "C:/outside.png", "sheets/bow-1234abcg.png"])
      expect(() => enabled.removeBuiltinPackFile("wolf", path), path).toThrow();
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(builtinDir, "fox"));
    writeFileSync(join(outside, "bow-1234abcd.png"), "outside");
    try {
      symlinkSync(outside, join(builtinDir, "fox", "sheets"), "junction");
      expect(() => enabled.removeBuiltinPackFile("fox", "sheets/bow-1234abcd.png")).toThrow();
      expect(readFileSync(join(outside, "bow-1234abcd.png"), "utf8")).toBe("outside");
    } catch { /* Windows without link privilege still tests the normal path. */ }
    enabled.removeBuiltinPackFile("wolf", "sheets/bow-1234abcd.png");
    expect(existsSync(generated)).toBe(false);
    expect(readFileSync(original, "utf8")).toBe("original");
  });
});

describe("built-in sheet hardening (M8 criterion 4)", () => {
  const enabled = () => createPackStore({ userDataDir, builtinDir, allowBuiltinWrites: () => true });

  test("a dangling link at the target is refused, not treated as missing", () => {
    mkdirSync(join(builtinDir, "wolf", "sheets"), { recursive: true });
    const link = join(builtinDir, "wolf", "sheets", "bow-1234abcd.png");
    try { symlinkSync(join(base, "nowhere.png"), link, "file"); }
    catch { try { symlinkSync(join(base, "nowhere"), link, "junction"); } catch { return; } }
    const packs = enabled();
    expect(() => packs.writeBuiltinPackFile("wolf", "sheets/bow-1234abcd.png", "x")).toThrow("link");
    expect(() => packs.removeBuiltinPackFile("wolf", "sheets/bow-1234abcd.png")).toThrow("link");
    expect(existsSync(join(base, "nowhere.png"))).toBe(false);
  });

  test("cleanup removes unreferenced generated sheets and temp files only", () => {
    const sheets = join(builtinDir, "wolf", "sheets");
    mkdirSync(sheets, { recursive: true });
    const temp = ".manifest.json.123e4567-e89b-12d3-a456-426614174000.tmp";
    for (const name of ["bow-1234abcd.png", "kept-1234abcd.png", "walk.png", "Wave-1234abcd.png"]) writeFileSync(join(sheets, name), "x");
    writeFileSync(join(builtinDir, "wolf", temp), "x");
    writeFileSync(join(builtinDir, "wolf", ".manifest.json.not-a-uuid.tmp"), "x");
    expect(() => store().cleanupBuiltinPack("wolf", new Set())).toThrow();
    const removed = enabled().cleanupBuiltinPack("wolf", new Set(["sheets/kept-1234abcd.png"]));
    expect(removed.sort()).toEqual([temp, "sheets/bow-1234abcd.png"].sort());
    expect(readdirSync(sheets).sort()).toEqual(["Wave-1234abcd.png", "kept-1234abcd.png", "walk.png"]);
    expect(existsSync(join(builtinDir, "wolf", ".manifest.json.not-a-uuid.tmp"))).toBe(true);
  });

  test("temp pattern accepts atomicWrite leftovers and rejects look-alikes", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    for (const name of [`.manifest.json.${uuid}.tmp`, `.bow-1234abcd.png.${uuid}.tmp`]) expect(generatedTempPattern.test(name), name).toBe(true);
    for (const name of [`manifest.json.${uuid}.tmp`, `.voice.json.${uuid}.tmp`, ".manifest.json.x.tmp", `.idle.png.${uuid}.tmp`, `.manifest.json.${uuid}.tmp2`])
      expect(generatedTempPattern.test(name), name).toBe(false);
  });
});
