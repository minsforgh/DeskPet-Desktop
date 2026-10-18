import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: { createFromBuffer: (bytes: Buffer) => ({
  isEmpty: () => false,
  getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
  toBitmap: () => Buffer.alloc(bytes.readUInt32BE(16) * bytes.readUInt32BE(20) * 4),
}) } }));
const characterControl = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock("./character.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./character.js")>();
  // The next load reads its pack at once, then waits for the gate, so a test can interleave another request.
  return { ...actual, loadCharacter: async (...args: Parameters<typeof actual.loadCharacter>) => {
    const gate = characterControl.hold;
    characterControl.hold = undefined;
    const result = await actual.loadCharacter(...args);
    if (gate) await gate;
    return result;
  } };
});
const storeControl = vi.hoisted(() => ({ failManifestWrite: false, calls: [] as string[] }));
vi.mock("./pack-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pack-store.js")>();
  return { ...actual, createPackStore: (...args: Parameters<typeof actual.createPackStore>) => {
    const store = actual.createPackStore(...args);
    return { ...store, writeBuiltinPackFile: (...writeArgs: Parameters<typeof store.writeBuiltinPackFile>) => {
      storeControl.calls.push(`write:${writeArgs[1]}`);
      if (storeControl.failManifestWrite && writeArgs[1] === "manifest.json") throw new Error("commit failed");
      return store.writeBuiltinPackFile(...writeArgs);
    }, removeBuiltinPackFile: (...removeArgs: Parameters<typeof store.removeBuiltinPackFile>) => {
      storeControl.calls.push(`remove:${removeArgs[1]}`);
      return store.removeBuiltinPackFile(...removeArgs);
    } };
  } };
});

import { createPackService, type PackSelection } from "./pack-service.js";
import { migrateSettingsInteractions, createPackInteractionStore } from "./interaction-store.js";
import { writeSettings, type DeskpetSettings } from "./settings.js";
import { existsSync } from "node:fs";

let root: string;
let builtins: string;
let userData: string;
let settings: DeskpetSettings;
let applied: Array<PackSelection | { id: string }>;
let notices: string[];
let confirm: boolean;

const manifest = (id: string) => ({ id, name: id, apiVersion: "1", cellSize: [1, 1], anchor: [0, 0], scale: 1,
  states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true } }, fallbacks: {} });

async function builtin(id: string): Promise<void> {
  const directory = join(builtins, id);
  await mkdir(join(directory, "sheets"), { recursive: true });
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  await writeFile(join(directory, "sheets", "idle.png"), png);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(id)));
}

async function user(id: string, raw: unknown): Promise<void> {
  const directory = join(userData, "characters", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(raw));
}

function service(extra: { isPackaged?: boolean; apply?: (selection: PackSelection | { id: string }) => Promise<void>;
  chooseSheetFile?: () => Promise<string | undefined> } = {}) {
  return createPackService({ ...extra, builtinDir: builtins, userDataDir: userData, settingsPath: join(userData, "settings.json"),
    getSettings: () => settings, setSettings: (next) => { settings = next; },
    apply: extra.apply ?? (async (selection) => { applied.push(selection); }),
    refresh: async (selection) => { applied.push(selection); },
    notify: (message) => { notices.push(message); }, confirmDelete: async () => confirm });
}

async function selectedSheet(): Promise<string> {
  const path = join(root, "chosen.png");
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  await writeFile(path, bytes);
  return path;
}

beforeEach(async () => {
  storeControl.failManifestWrite = false;
  storeControl.calls = [];
  root = await mkdtemp(join(tmpdir(), "deskpet-pack-service-"));
  builtins = join(root, "builtins");
  userData = join(root, "data");
  await mkdir(builtins);
  await mkdir(userData);
  await builtin("placeholder");
  await builtin("wolf-maid");
  settings = { doNotDisturb: { enabled: false } };
  applied = [];
  notices = [];
  confirm = true;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("state preview data", () => {
  it("returns only a merged state's approved image and metadata without a path", async () => {
    await user("mine", { id: "mine", name: "Mine", apiVersion: "1", extends: "placeholder" });
    const result = await service().statePreview({ packId: "mine", state: "idle" });
    expect(result).toMatchObject({ frames: 1, fps: 8, loop: true, cellSize: [1, 1] });
    expect(result.sheet).toMatch(/^data:image\/png;base64,/u);
    expect(JSON.stringify(result)).not.toContain("sheets/idle.png");
    expect(Object.keys(result).sort()).toEqual(["cellSize", "fps", "frames", "loop", "sheet"]);
  });

  it("rejects missing states and invalid ids without disclosing filesystem paths", async () => {
    const packs = service();
    for (const payload of [{ packId: "placeholder", state: "missing" }, { packId: "../placeholder", state: "idle" },
      { packId: join(builtins, "placeholder"), state: "idle" }]) {
      await expect(packs.statePreview(payload)).rejects.toThrow(/미리보기|요청/u);
    }
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(builtins, "linked"), "junction");
    await expect(packs.statePreview({ packId: "linked", state: "idle" })).rejects.toThrow("상태 미리보기를 불러오지 못했어요");
  });
});

describe("pack list errors", () => {
  it("shows short messages without paths for a missing manifest, broken JSON and a missing original", async () => {
    await mkdir(join(userData, "characters", "nomanifest"), { recursive: true });
    await mkdir(join(builtins, "mochi"), { recursive: true });
    await mkdir(join(userData, "characters", "badjson"), { recursive: true });
    await writeFile(join(userData, "characters", "badjson", "manifest.json"), "{ nope");
    await user("orphan", { id: "orphan", name: "Orphan", apiVersion: "1", extends: "gone" });
    await user("wrongid", { id: "other", name: "Wrong", apiVersion: "1", extends: "wolf-maid" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = service().list();
    const error = (id: string) => items.find((item) => item.id === id)?.error;
    expect(error("mochi")).toBe("manifest.json 이 없어요");
    expect(error("nomanifest")).toBe("manifest.json 이 없어요");
    expect(error("badjson")).toBe("manifest.json 형식이 깨졌어요");
    expect(error("orphan")).toBe("원본 팩 gone 이 없어요");
    for (const item of items.filter(({ valid }) => !valid)) {
      for (const forbidden of ["ENOENT", "lstat", "realpath", ":/", String.fromCharCode(92), "manifest.json'"]) expect(item.error).not.toContain(forbidden);
      expect(item.error).not.toContain(root);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mochi"), expect.anything());
  });
});

describe("developer mode (D-044)", () => {
  const voice = { version: 1, templates: { info: ["직접 수정 {message}"] } };

  it("writes a built-in pack in place without deriving a pack when on", async () => {
    settings.developerMode = true;
    const packs = service();
    await packs.start("wolf-maid");
    const saved = await packs.saveVoice("wolf-maid", voice);
    expect(saved).toMatchObject({ packId: "wolf-maid", derived: false });
    expect(JSON.parse(await readFile(join(builtins, "wolf-maid", "voice.json"), "utf8"))).toEqual(voice);
    expect(JSON.parse(await readFile(join(builtins, "wolf-maid", "manifest.json"), "utf8")).voice).toBe("voice.json");
    expect(packs.current()?.id).toBe("wolf-maid");
    expect(packs.list().some(({ id }) => id.endsWith("-mine"))).toBe(false);
    expect(packs.list().find(({ id }) => id === "wolf-maid")?.directEdit).toBe(true);
    expect((await packs.voiceLoad("wolf-maid")).templates.info).toEqual(["직접 수정 {message}"]);
    const meta = await packs.saveMeta("wolf-maid", { name: "Renamed", meta: { author: "Me" } });
    expect(meta).toEqual({ packId: "wolf-maid", derived: false });
    expect(packs.list().find(({ id }) => id === "wolf-maid")).toMatchObject({ name: "Renamed", meta: { author: "Me" } });
    await expect(packs.deletePack("wolf-maid")).rejects.toThrow();
  });

  it("derives and leaves the built-in folder untouched when off", async () => {
    const before = await readFile(join(builtins, "wolf-maid", "manifest.json"));
    const packs = service();
    expect(await packs.saveVoice("wolf-maid", voice)).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect(await readFile(join(builtins, "wolf-maid", "manifest.json"))).toEqual(before);
    expect(packs.list().find(({ id }) => id === "wolf-maid")?.directEdit).toBeUndefined();
  });

  it("ignores the setting in a packaged build", async () => {
    settings.developerMode = true;
    const before = await readFile(join(builtins, "wolf-maid", "manifest.json"));
    const packs = service({ isPackaged: true });
    expect(await packs.saveVoice("wolf-maid", voice)).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect(await readFile(join(builtins, "wolf-maid", "manifest.json"))).toEqual(before);
  });
});

describe("pack file JSON format (M7)", () => {
  it("writes voice, interactions and manifest JSON with 2-space indentation and a trailing newline", async () => {
    settings.developerMode = true;
    const packs = service();
    await packs.start("wolf-maid");
    const voice = { version: 1, templates: { info: ["직접 수정 {message}"] } };
    await packs.saveVoice("wolf-maid", voice);
    expect(await readFile(join(builtins, "wolf-maid", "voice.json"), "utf8")).toBe(`${JSON.stringify(voice, null, 2)}\n`);
    const interactions = { version: 1, items: [{ id: "pat", label: "Pat", mood: "happy", bubble: true, lines: ["Hello"] }], hidden: [] };
    await packs.saveInteractions("wolf-maid", interactions);
    expect(await readFile(join(builtins, "wolf-maid", "interactions.json"), "utf8"))
      .toBe(`${JSON.stringify(interactions, null, 2)}\n`);
    const manifestText = await readFile(join(builtins, "wolf-maid", "manifest.json"), "utf8");
    expect(manifestText).toBe(`${JSON.stringify(JSON.parse(manifestText), null, 2)}\n`);
    expect(manifestText).toContain("\n  \"voice\": \"voice.json\"");
  });

  it("omits empty meta values and drops the meta field when every value is empty", async () => {
    settings.developerMode = true;
    const packs = service();
    await packs.start("wolf-maid");
    await packs.saveMeta("wolf-maid", { name: "Renamed", meta: { author: "Me", version: "", license: "" } });
    const partial = JSON.parse(await readFile(join(builtins, "wolf-maid", "manifest.json"), "utf8"));
    expect(partial.meta).toEqual({ author: "Me" });
    await packs.saveMeta("wolf-maid", { name: "Renamed Again", meta: { author: "", version: "" } });
    const emptied = JSON.parse(await readFile(join(builtins, "wolf-maid", "manifest.json"), "utf8"));
    expect(emptied).not.toHaveProperty("meta");
    expect(emptied.name).toBe("Renamed Again");
    expect(packs.list().find(({ id }) => id === "wolf-maid")).toMatchObject({ name: "Renamed Again", valid: true });
  });

  it("drops meta from a derived pack too and keeps its manifest pretty-printed", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const { packId } = await packs.saveMeta("wolf-maid", { name: "Mine", meta: { author: "" } });
    const saved = JSON.parse(await readFile(join(userData, "characters", packId, "manifest.json"), "utf8"));
    expect(saved).not.toHaveProperty("meta");
    expect(await readFile(join(userData, "characters", packId, "manifest.json"), "utf8"))
      .toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect(packs.list().find(({ id }) => id === packId)).toMatchObject({ valid: true, name: "Mine" });
  });

  it("still lists packs that already store empty meta values", async () => {
    await user("mine", { id: "mine", name: "Mine", apiVersion: "1", extends: "wolf-maid",
      meta: { author: "", version: "2" } });
    const items = service().list();
    expect(items.find(({ id }) => id === "mine")).toMatchObject({ valid: true, meta: { author: "", version: "2" } });
  });

  it("keeps the size limit on the compact form, not on the pretty file", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const frame = (filler: number) => ({ version: 1, templates: { info: ["x".repeat(filler)] } });
    const overhead = Buffer.byteLength(JSON.stringify(frame(0)), "utf8");
    const atLimit = frame(64 * 1024 - overhead);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(64 * 1024);
    const saved = await packs.saveVoice("wolf-maid", atLimit);
    const written = await readFile(join(userData, "characters", saved.packId, "voice.json"));
    expect(written.byteLength).toBeGreaterThan(64 * 1024);
    expect(written.toString("utf8")).toBe(`${JSON.stringify(atLimit, null, 2)}\n`);
    await expect(packs.saveVoice(saved.packId, frame(64 * 1024 - overhead + 1))).rejects.toThrow("입력 크기가 너무 큽니다");
  });
});

describe("pack service", () => {
  it("lists built-in, user and invalid packs, and hides a colliding user folder", async () => {
    await user("mine", { id: "mine", name: "Mine", apiVersion: "1", extends: "wolf-maid",
      meta: { author: "Mine", version: "2", license: "MIT", description: "Own text" } });
    await user("missing", { id: "missing", name: "Missing", apiVersion: "1", extends: "gone" });
    await user("broken", { id: "broken", name: "Broken" });
    await user("wolf-maid", { id: "wolf-maid", name: "Collision" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = service().list();
    expect(items.find(({ id }) => id === "mine")).toMatchObject({ name: "Mine", source: "user", extends: "wolf-maid", valid: true,
      meta: { author: "Mine", version: "2", license: "MIT", description: "Own text" } });
    expect(items.find(({ id }) => id === "missing")).toMatchObject({ valid: false, error: "원본 팩 gone 이 없어요" });
    expect(items.find(({ id }) => id === "broken")).toMatchObject({ valid: false, error: expect.stringMatching(/^팩 형식이 맞지 않아요/u) });
    expect(items.filter(({ id }) => id === "wolf-maid")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("collision"));
  });

  it("starts an installed app on wolf-maid without a saved choice, and on the placeholder when it cannot load", async () => {
    expect((await service({ isPackaged: true }).start())?.id).toBe("wolf-maid");
    expect((await service().start())?.id).toBe("placeholder");
    expect((await service({ isPackaged: true }).start("placeholder"))?.id).toBe("placeholder");
    await rm(join(builtins, "wolf-maid"), { recursive: true });
    expect((await service({ isPackaged: true }).start())?.id).toBe("placeholder");
    expect(notices).toHaveLength(1);
  });

  it("uses command line over persisted selection, then falls back once without erasing it", async () => {
    settings.characterId = "wolf-maid";
    const first = service();
    expect((await first.start())?.id).toBe("wolf-maid");
    expect((await service().start("placeholder"))?.id).toBe("placeholder");
    settings.characterId = "missing";
    expect((await service().start())?.id).toBe("placeholder");
    expect(notices).toHaveLength(1);
    expect(settings.characterId).toBe("missing");
    await user("broken", { id: "broken", name: "Broken" });
    settings.characterId = "broken";
    expect((await service().start())?.id).toBe("placeholder");
    expect(notices).toHaveLength(2);
    expect(settings.characterId).toBe("broken");
    await first.select("wolf-maid");
    expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8"))).toMatchObject({ characterId: "wolf-maid" });
  });

  it("never throws from start: a broken placeholder applies the empty selection", async () => {
    await writeFile(join(builtins, "placeholder", "manifest.json"), "{}");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const packs = service();
    expect(await packs.start("placeholder")).toBeUndefined();
    expect(packs.current()).toBeUndefined();
    expect(applied).toEqual([{ id: "placeholder" }]);
    settings.characterId = "missing";
    applied.length = 0;
    expect(await service().start()).toBeUndefined();
    expect(applied).toEqual([{ id: "placeholder" }]);
    expect(notices).toHaveLength(0);
    warn.mockRestore();
  });

  it("derives a numbered editable pack, switches the current pack, and leaves built-in files intact", async () => {
    const source = await readFile(join(builtins, "wolf-maid", "manifest.json"));
    await user("wolf-maid-mine", { id: "wolf-maid-mine", name: "Existing", apiVersion: "1", extends: "wolf-maid" });
    const packs = service();
    await packs.start("wolf-maid");
    const created = await packs.ensureEditable("wolf-maid");
    expect(created).toEqual({ packId: "wolf-maid-mine-2", derived: true });
    expect(packs.current()?.id).toBe("wolf-maid-mine-2");
    expect(JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine-2", "manifest.json"), "utf8")))
      .toMatchObject({ name: "wolf-maid (내 버전)", extends: "wolf-maid", meta: { createdWith: "deskpet-editor" } });
    expect(await readFile(join(builtins, "wolf-maid", "manifest.json"))).toEqual(source);
    expect(await packs.ensureEditable("wolf-maid-mine-2")).toEqual({ packId: "wolf-maid-mine-2", derived: false });
  });

  it("saves voice through a derived pack and rejects unsafe renderer values", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const before = await readFile(join(builtins, "wolf-maid", "manifest.json"));
    const saved = await packs.saveVoice("wolf-maid", { version: 1, templates: { info: ["새 어투 {message}"] } });
    expect(saved).toMatchObject({ packId: "wolf-maid-mine", derived: true, problems: [] });
    expect((await packs.voiceLoad("wolf-maid-mine")).templates.info).toEqual(["새 어투 {message}"]);
    const withProblems = await packs.saveVoice("wolf-maid-mine", { version: 1,
      templates: { info: ["유효한 문구", "{unknown}"] } });
    expect(withProblems.problems).toEqual([expect.stringContaining("unknown slot")]);
    expect(await readFile(join(builtins, "wolf-maid", "manifest.json"))).toEqual(before);
    for (const id of ["../wolf-maid", "C:/outside", "__proto__", "x".repeat(49)])
      await expect(packs.select(id)).rejects.toThrow();
    await expect(packs.saveVoice("wolf-maid-mine", JSON.parse('{"version":1,"templates":{"__proto__":["bad"]}}'))).rejects.toThrow();
    await expect(packs.saveMeta("wolf-maid-mine", { name: "x".repeat(81), meta: {} })).rejects.toThrow();
    await expect(packs.saveMeta("wolf-maid-mine", { name: "bad\u202Ename", meta: {} })).rejects.toThrow();
    await expect(packs.saveMeta("wolf-maid-mine", { name: "Name", meta: { author: "bad\u0001value" } })).rejects.toThrow();
    await expect(packs.saveMeta("wolf-maid-mine", { name: "Name", meta: { unknown: "value" } })).rejects.toThrow();
    const count = applied.length;
    await expect(packs.select("missing")).rejects.toThrow();
    expect(applied).toHaveLength(count);
    expect(settings.characterId).toBe("wolf-maid-mine");
  });

  it("keeps lines and other voice fields when saving built-in and derived templates", async () => {
    const original = { version: 1, templates: { done: [{ prefix: "Before", content: "{task}", suffix: "End" }] },
      lines: { "fixture.done": [{ prefix: "Line", content: "hello", suffix: "End" }] }, extra: { retained: true } };
    const path = join(builtins, "wolf-maid");
    await writeFile(join(path, "voice.json"), JSON.stringify(original));
    await writeFile(join(path, "manifest.json"), JSON.stringify({ ...manifest("wolf-maid"), voice: "voice.json" }));
    const edit = { version: 1, templates: { done: [{ prefix: "After", content: "{task}", suffix: "End" }] } };
    const derived = await service().saveVoice("wolf-maid", edit);
    const derivedVoice = JSON.parse(await readFile(join(userData, "characters", derived.packId, "voice.json"), "utf8"));
    expect(derivedVoice).toEqual({ ...original, templates: edit.templates });
    await service().saveVoice(derived.packId, { version: 1, templates: { info: ["Again"] } });
    expect(JSON.parse(await readFile(join(userData, "characters", derived.packId, "voice.json"), "utf8")))
      .toEqual({ ...original, templates: { info: ["Again"] } });
    expect(JSON.parse(await readFile(join(path, "voice.json"), "utf8"))).toEqual(original);
    settings.developerMode = true;
    await service().saveVoice("wolf-maid", edit);
    expect(JSON.parse(await readFile(join(path, "voice.json"), "utf8"))).toEqual({ ...original, templates: edit.templates });
  });

  it("keeps keys the editors do not know when saving interactions, sequences, reactions and motions", async () => {
    const path = join(builtins, "wolf-maid");
    const files = {
      "interactions.json": { version: 1, items: [{ id: "pat", label: "Old", mood: "happy", bubble: true, lines: ["Hi"], note: "kept" }], hidden: [], extra: { a: 1 } },
      "sequences.json": { version: 1, sequences: [{ id: "bow", steps: [{ play: "idle", tag: "step" }], note: "kept" }], extra: ["b"] },
      "reactions.json": { version: 1, kinds: { done: { play: "idle" } }, extra: true },
      "motions.json": { version: 1, motions: {}, landing: "soft", extra: "c" },
    };
    for (const [name, data] of Object.entries(files)) await writeFile(join(path, name), JSON.stringify(data));
    await writeFile(join(path, "manifest.json"), JSON.stringify({ ...manifest("wolf-maid"), interactions: "interactions.json",
      sequences: "sequences.json", reactions: "reactions.json", motions: "motions.json" }));
    settings.developerMode = true;
    const packs = service();
    await packs.start("wolf-maid");
    const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(path, name), "utf8"));
    await packs.saveInteractions("wolf-maid", { version: 1, items: [{ id: "pat", label: "New", mood: "happy", bubble: true, lines: ["Yo"] },
      { id: "fresh", label: "Fresh", mood: "happy", bubble: false, lines: [] }], hidden: [] });
    expect(await read("interactions.json")).toEqual({ version: 1, extra: { a: 1 }, hidden: [], items: [
      { id: "pat", label: "New", mood: "happy", bubble: true, lines: ["Yo"], note: "kept" },
      { id: "fresh", label: "Fresh", mood: "happy", bubble: false, lines: [] }] });
    await packs.saveSequences("wolf-maid", { version: 1, sequences: [{ id: "bow", label: "Bow", steps: [{ play: "idle" }] }] });
    expect(await read("sequences.json")).toEqual({ version: 1, extra: ["b"],
      sequences: [{ id: "bow", label: "Bow", steps: [{ play: "idle", tag: "step" }], note: "kept" }] });
    await packs.saveReactions("wolf-maid", { version: 1, kinds: { info: { play: "idle" } } });
    expect(await read("reactions.json")).toEqual({ version: 1, kinds: { info: { play: "idle" } }, extra: true });
    await packs.saveMotions("wolf-maid", { version: 1, motions: {} });
    expect(await read("motions.json")).toEqual({ version: 1, motions: {}, extra: "c" });
  });

  it("keeps manifest keys the editors do not know when saving voice and meta", async () => {
    const path = join(builtins, "wolf-maid");
    await writeFile(join(path, "manifest.json"), JSON.stringify({ ...manifest("wolf-maid"), futureKey: { kept: true } }));
    settings.developerMode = true;
    const packs = service();
    await packs.start("wolf-maid");
    await packs.saveVoice("wolf-maid", { version: 1, templates: { info: ["Hi"] } });
    await packs.saveMeta("wolf-maid", { name: "Renamed", meta: { author: "Me" } });
    expect(JSON.parse(await readFile(join(path, "manifest.json"), "utf8"))).toMatchObject({ futureKey: { kept: true }, name: "Renamed",
      voice: "voice.json", meta: { author: "Me" } });
  });

  it("refuses voice files outside the pack through parent paths, links, and absolute paths", async () => {
    const directory = join(builtins, "wolf-maid");
    const outside = join(builtins, "outside-voice.json");
    await writeFile(outside, JSON.stringify({ version: 1, templates: {}, lines: { kept: ["outside"] } }));
    const outsideDirectory = join(builtins, "outside-voice");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "voice.json"), JSON.stringify({ version: 1, templates: {} }));
    await symlink(outsideDirectory, join(directory, "voice-link"), "junction");
    const edit = { version: 1, templates: { info: ["safe"] } };
    for (const voice of ["../outside-voice.json", "voice-link/voice.json", outside]) {
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...manifest("wolf-maid"), voice }));
      await expect(service().saveVoice("wolf-maid", edit)).rejects.toThrow();
      expect(existsSync(join(userData, "characters", "wolf-maid-mine"))).toBe(false);
    }
  });

  it("loads another pack's interactions by id and rejects unsafe ids", async () => {
    const packs = service();
    await packs.start("placeholder");
    const loaded = await packs.loadInteractions("wolf-maid");
    expect(Array.isArray(loaded.interactions.items)).toBe(true);
    expect(packs.current()?.id).toBe("placeholder");
    for (const id of ["../wolf-maid", "missing", 7]) await expect(packs.loadInteractions(id)).rejects.toThrow();
  });

  it("writes interactions and reloads the selected pack", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const result = await packs.saveInteractions("wolf-maid", { version: 1, items: [
      { id: "pat", label: "Pat", mood: "happy", bubble: true, lines: ["Hello"] }], hidden: [] });
    expect(result).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect((await packs.loadInteractions(result.packId)).interactions.items[0]?.lines).toEqual(["Hello"]);
    expect(applied.at(-1)?.id).toBe(result.packId);
    await expect(packs.saveInteractions(result.packId, { version: 1, items: [
      { id: "__proto__", label: "Bad", mood: "happy", bubble: true, lines: ["Bad"] }] })).rejects.toThrow();
  });

  it("saves validated sequences through a derived pack and reloads the selected pack", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const sequences = { version: 1, sequences: [{ id: "greet", steps: [{ play: "idle", ms: 500, say: "안녕" }] }] };
    const result = await packs.saveSequences("wolf-maid", sequences);
    expect(result).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect((await packs.loadSequences(result.packId)).sequences.sequences).toEqual(sequences.sequences);
    expect(applied.at(-1)?.id).toBe(result.packId);
    expect(JSON.parse(await readFile(join(userData, "characters", result.packId, "manifest.json"), "utf8")))
      .toMatchObject({ sequences: "sequences.json" });
    await expect(packs.saveSequences(result.packId, { version: 1, sequences: [
      { id: "bad", steps: [{ play: "walk", ms: 500 }] }] })).rejects.toThrow();
    for (const id of ["../wolf-maid", "missing", 7]) await expect(packs.loadSequences(id)).rejects.toThrow();
  });

  it("saves reactions through the derived pack and rejects invalid mappings", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const reactions = { version: 1, kinds: { done: { play: "happy" } } };
    const result = await packs.saveReactions("wolf-maid", reactions);
    expect(result).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect((await packs.loadReactions(result.packId)).reactions.kinds).toEqual(reactions.kinds);
    expect(applied.at(-1)?.id).toBe(result.packId);
    expect(JSON.parse(await readFile(join(userData, "characters", result.packId, "manifest.json"), "utf8")))
      .toMatchObject({ reactions: "reactions.json" });
    await expect(packs.saveReactions(result.packId, { version: 1, kinds: { done: { play: "bad/name" } } })).rejects.toThrow();
    for (const id of ["../wolf-maid", "missing", 7]) await expect(packs.loadReactions(id)).rejects.toThrow();
  });

  it("saves motions through the derived pack and reports what each movement draws", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    const before = await packs.loadMotions("wolf-maid");
    expect(before).toMatchObject({ motions: {}, landing: "normal", states: ["idle"] });
    expect(before.resolved).toMatchObject({ land: "idle", jump: "idle", climb: "idle" });
    expect(Object.keys(before.resolved)).toHaveLength(9);
    const motions = { version: 1, motions: { land: { play: "idle" } }, landing: "soft", afterLand: { play: "idle" } };
    const result = await packs.saveMotions("wolf-maid", motions);
    expect(result).toMatchObject({ packId: "wolf-maid-mine", derived: true });
    expect(await packs.loadMotions(result.packId)).toMatchObject({ motions: motions.motions, landing: "soft",
      afterLand: motions.afterLand, nonLoopStates: [], problems: [] });
    expect(applied.at(-1)?.id).toBe(result.packId);
    expect(JSON.parse(await readFile(join(userData, "characters", result.packId, "manifest.json"), "utf8")))
      .toMatchObject({ motions: "motions.json" });
    expect(JSON.parse(await readFile(join(userData, "characters", result.packId, "motions.json"), "utf8"))).toEqual(motions);
    for (const bad of [{ version: 1, motions: { run: { play: "idle" } } }, { version: 1, motions: { land: { sequence: "x" } } },
      { version: 1, motions: { land: { play: "bad/name" } } }, { version: 1, landing: "hard" }, { version: 2 }, null])
      await expect(packs.saveMotions(result.packId, bad)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(userData, "characters", result.packId, "motions.json"), "utf8"))).toEqual(motions);
    for (const id of ["../wolf-maid", "missing", 7]) {
      await expect(packs.loadMotions(id)).rejects.toThrow();
      await expect(packs.saveMotions(id, motions)).rejects.toThrow();
    }
  });

  it("refuses to save motions into a pack that cannot be edited", async () => {
    await user("broken-mine", { id: "broken-mine", name: "Broken", apiVersion: "1", extends: "missing-base" });
    const packs = service();
    await expect(packs.saveMotions("broken-mine", { version: 1, motions: {}, landing: "soft" })).rejects.toThrow();
    expect(existsSync(join(userData, "characters", "broken-mine", "motions.json"))).toBe(false);
  });

  it("stores menu edits in a derived pack without changing the built-in", async () => {
    const packs = service();
    await packs.start("placeholder");
    const before = await readFile(join(builtins, "placeholder", "manifest.json"));
    const store = createPackInteractionStore(packs);
    await store.save([{ id: "pat", label: "Pat", mood: "happy", speak: true, lines: ["Edited"], builtin: true }]);
    expect(packs.current()?.id).toBe("placeholder-mine");
    expect((await store.load())[0]?.lines).toEqual(["Edited"]);
    expect(await readFile(join(builtins, "placeholder", "manifest.json"))).toEqual(before);
  });

  it("refuses deletion of built-ins and returns to placeholder when deleting the current user pack", async () => {
    const packs = service();
    await packs.start("wolf-maid");
    await expect(packs.deletePack("wolf-maid")).rejects.toThrow();
    const { packId } = await packs.ensureEditable("wolf-maid");
    expect(await packs.deletePack(packId)).toEqual({ deleted: true });
    expect(packs.current()?.id).toBe("placeholder");
    expect(settings.characterId).toBe("placeholder");
    expect(packs.list().some(({ id }) => id === packId)).toBe(false);
  });
});

describe("legacy interaction migration", () => {
  const legacy = [{ id: "pat", label: "쓰다듬기", mood: "happy" as const, speak: true,
    lines: ["새 대사"], builtin: true }];
  const path = () => join(userData, "settings.json");
  const migrate = (packs: ReturnType<typeof service>, extra: { backup?: (source: string, destination: string) => void;
    write?: typeof writeSettings } = {}) => migrateSettingsInteractions({ packs, path: path(), get: () => settings,
    set: (next) => { settings = next; }, notify: (message) => { notices.push(message); }, ...extra });

  it("moves legacy edits into a derived pack, backs up settings, and does not repeat", async () => {
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const before = await readFile(join(builtins, "placeholder", "manifest.json"));
    const packs = service();
    await packs.start("placeholder");
    expect(await migrate(packs)).toBe(true);
    expect(packs.current()?.id).toBe("placeholder-mine");
    expect((await createPackInteractionStore(packs).load())[0]?.lines).toEqual(["새 대사"]);
    expect(JSON.parse(await readFile(path(), "utf8"))).toMatchObject({ characterId: "placeholder-mine",
      migrations: { interactionsToPack: true } });
    expect(JSON.parse(await readFile(path(), "utf8"))).not.toHaveProperty("interactions");
    expect(JSON.parse(await readFile(`${path()}.bak`, "utf8"))).toMatchObject({ interactions: legacy });
    expect(await readFile(join(builtins, "placeholder", "manifest.json"))).toEqual(before);
    expect(notices).toEqual([expect.stringContaining("상호작용 설정을")]);
    expect(await migrate(packs)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it("keeps settings after failure and retries on the next attempt", async () => {
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const original = await readFile(path());
    const packs = service();
    await packs.start("placeholder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await migrate(packs, { backup: () => { throw new Error("disk full"); } })).toBe(false);
    expect(await readFile(path())).toEqual(original);
    expect(settings.interactions).toEqual(legacy);
    expect(warn).toHaveBeenCalled();
    expect(await migrate(packs)).toBe(true);
    expect(settings.interactions).toBeUndefined();
    expect(packs.list().filter(({ id }) => id.startsWith("placeholder-mine"))).toHaveLength(1);
  });

  it("reuses the marked migration pack after selection fails and the app restarts", async () => {
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const original = await readFile(path());
    const packs = service({ apply: async (selection) => {
      if (selection.id === "placeholder-mine") throw new Error("selection failed");
      applied.push(selection);
    } });
    await packs.start("placeholder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await migrate(packs)).toBe(false);
    expect(warn).toHaveBeenCalledWith("Cannot migrate settings interactions to character pack:", expect.any(Error));
    expect(await readFile(path())).toEqual(original);
    expect(settings.interactions).toEqual(legacy);
    expect(packs.list().filter(({ id }) => id.startsWith("placeholder-mine"))).toHaveLength(1);
    expect((await packs.loadInteractions("placeholder-mine")).interactions.items[0]?.lines).toEqual(["새 대사"]);

    settings = JSON.parse(await readFile(path(), "utf8")) as DeskpetSettings;
    const restarted = service();
    await restarted.start();
    expect(await migrate(restarted)).toBe(true);
    expect(restarted.current()?.id).toBe("placeholder-mine");
    expect(restarted.list().filter(({ id }) => id.startsWith("placeholder-mine"))).toHaveLength(1);
    expect((await createPackInteractionStore(restarted).load())[0]?.lines).toEqual(["새 대사"]);
  });

  it("preserves a user-created mine pack while migrating into a numbered pack", async () => {
    await user("placeholder-mine", { id: "placeholder-mine", name: "My pack", apiVersion: "1",
      extends: "placeholder", meta: { createdWith: "deskpet-editor" } });
    const userManifest = await readFile(join(userData, "characters", "placeholder-mine", "manifest.json"));
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const packs = service();
    await packs.start("placeholder");
    expect(await migrate(packs)).toBe(true);
    expect(packs.current()?.id).toBe("placeholder-mine-2");
    expect(await readFile(join(userData, "characters", "placeholder-mine", "manifest.json"))).toEqual(userManifest);
    expect(packs.hasOwnInteractions("placeholder-mine")).toBe(false);
    expect((await packs.loadInteractions("placeholder-mine-2")).interactions.items[0]?.lines).toEqual(["새 대사"]);
  });

  it("keeps legacy settings when the final write fails", async () => {
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const original = await readFile(path());
    const packs = service();
    await packs.start("placeholder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await migrate(packs, { write: () => { throw new Error("disk full"); } })).toBe(false);
    expect(await readFile(path())).toEqual(original);
    expect(settings.interactions).toEqual(legacy);
    expect(JSON.parse(await readFile(`${path()}.bak`, "utf8"))).toMatchObject({ interactions: legacy });
    expect(warn).toHaveBeenCalled();
  });

  it("does not migrate again when the marker is already present", async () => {
    settings = { doNotDisturb: { enabled: false }, interactions: legacy, migrations: { interactionsToPack: true } };
    writeSettings(path(), settings);
    const packs = service();
    await packs.start("placeholder");
    expect(await migrate(packs)).toBe(false);
    expect(packs.current()?.id).toBe("placeholder");
    expect(packs.list().some(({ id }) => id === "placeholder-mine")).toBe(false);
    expect(settings.interactions).toEqual(legacy);
  });

  it("does not overwrite a user's existing interactions file", async () => {
    await user("mine", { id: "mine", name: "Mine", apiVersion: "1", extends: "placeholder",
      interactions: "interactions.json" });
    await writeFile(join(userData, "characters", "mine", "interactions.json"), JSON.stringify({ version: 1,
      items: [{ id: "pat", label: "Pat", mood: "happy", bubble: true, lines: ["existing"] }], hidden: [] }));
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const packs = service();
    await packs.start("mine");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await migrate(packs)).toBe(false);
    expect((await packs.loadInteractions("mine")).interactions.items[0]?.lines).toEqual(["existing"]);
    expect(settings.interactions).toEqual(legacy);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("migration deferred"));
  });

  it("writes into an empty user pack without deriving another pack", async () => {
    await user("mine", { id: "mine", name: "Mine", apiVersion: "1", extends: "placeholder" });
    settings = { doNotDisturb: { enabled: false }, interactions: legacy };
    writeSettings(path(), settings);
    const packs = service();
    await packs.start("mine");
    expect(await migrate(packs)).toBe(true);
    expect(packs.current()?.id).toBe("mine");
    expect((await packs.loadInteractions("mine")).interactions.items[0]?.lines).toEqual(["새 대사"]);
  });
});

describe("developer sheet import", () => {
  it("rejects selection and apply with developer mode off or a packaged app", async () => {
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    await expect(packs.pickSheet({ packId: "placeholder", frames: 1 })).rejects.toThrow("개발자 모드");
    settings.developerMode = true;
    const packaged = service({ isPackaged: true, chooseSheetFile: async () => path });
    await expect(packaged.pickSheet({ packId: "placeholder", frames: 1 })).rejects.toThrow("개발자 모드");
    await expect(packaged.applySheet({ packId: "placeholder", token: "x" })).rejects.toThrow("개발자 모드");
  });

  it("adds and replaces a state, consumes each token and cleans only a superseded generated sheet", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    await packs.start("placeholder");
    const chosen = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string; preview: string };
    expect(chosen.preview).toMatch(/^data:image\/png;base64,/u);
    const payload = { packId: "placeholder", token: chosen.token, state: "bow", frames: 1,
      fps: 8, loop: false, overrideFootIssues: true };
    const first = await packs.applySheet(payload);
    expect(storeControl.calls.slice(0, 2)).toEqual([`write:${first.sheet}`, "write:manifest.json"]);
    expect(first.sheet).toMatch(/^sheets\/bow-[0-9a-f]{8}\.png$/u);
    expect(existsSync(join(builtins, "placeholder", first.sheet))).toBe(true);
    expect((JSON.parse(await readFile(join(builtins, "placeholder", "manifest.json"), "utf8")) as { states: { bow: { sheet: string } } }).states.bow.sheet)
      .toBe(first.sheet);
    expect(packs.current()?.pack.manifest.states.bow?.sheet).toBe(first.sheet);
    await expect(packs.applySheet(payload)).rejects.toThrow("만료");
    const next = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    const second = await packs.applySheet({ ...payload, token: next.token });
    expect(second.sheet).not.toBe(first.sheet);
    expect(existsSync(join(builtins, "placeholder", first.sheet))).toBe(false);
    expect(existsSync(join(builtins, "placeholder", "sheets", "idle.png"))).toBe(true);
  });

  it("keeps manifest keys the editors do not know when adding a state", async () => {
    settings.developerMode = true;
    const manifestPath = join(builtins, "placeholder", "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ ...manifest("placeholder"), futureKey: [1, 2] }));
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    await packs.start("placeholder");
    const chosen = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await packs.applySheet({ packId: "placeholder", token: chosen.token, state: "bow", frames: 1, fps: 8, loop: false, overrideFootIssues: true });
    const saved = JSON.parse(await readFile(manifestPath, "utf8")) as { futureKey: unknown; states: Record<string, unknown> };
    expect(saved.futureKey).toEqual([1, 2]);
    expect(Object.keys(saved.states)).toContain("bow");
  });

  it("rejects invalid state settings and foot issues unless acknowledged", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    for (const state of ["Bow", "../bow", "constructor"]) {
      const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
      await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state, frames: 1, fps: 8, loop: true }))
        .rejects.toThrow("상태 설정");
    }
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state: "bow", frames: 1, fps: 8, loop: true }))
      .rejects.toThrow("발 위치");
  });

  it("expires a selected token before writing", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    const clock = vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state: "bow", frames: 1,
        fps: 8, loop: true, overrideFootIssues: true })).rejects.toThrow("만료");
    } finally { clock.mockRestore(); }
    expect(storeControl.calls).toEqual([]);
  });

  it("removes the new PNG when the manifest commit fails", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    const folder = join(builtins, "placeholder");
    storeControl.failManifestWrite = true;
    await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state: "bow", frames: 1,
      fps: 8, loop: true, overrideFootIssues: true })).rejects.toThrow();
    expect(storeControl.calls).toEqual([expect.stringMatching(/^write:sheets\/bow-[0-9a-f]{8}\.png$/u),
      "write:manifest.json", expect.stringMatching(/^remove:sheets\/bow-[0-9a-f]{8}\.png$/u)]);
    const files = await readFile(join(folder, "manifest.json"), "utf8");
    expect(JSON.parse(files)).toMatchObject({ states: { idle: { sheet: "sheets/idle.png" } } });
    await expect((await import("node:fs/promises")).readdir(join(folder, "sheets"))).resolves.toEqual(["idle.png"]);
  });

  it("rejects a 33rd state", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const folder = join(builtins, "placeholder");
    const base = manifest("placeholder");
    const states: Record<string, unknown> = { ...base.states };
    for (let index = 0; index < 31; index += 1)
      states[`s${index}`] = { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true };
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...base, states }));
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state: "bow", frames: 1,
      fps: 8, loop: true, overrideFootIssues: true })).rejects.toThrow("32");
  });

  it("rejects a sheet total above 64 MiB", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const folder = join(builtins, "placeholder");
    const base = manifest("placeholder");
    const states: Record<string, unknown> = {};
    const large = Buffer.alloc(8 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(large);
    large.writeUInt32BE(13, 8);
    large.write("IHDR", 12, "ascii");
    large.writeUInt32BE(1, 16);
    large.writeUInt32BE(1, 20);
    for (let index = 0; index < 8; index += 1) {
      const name = index === 0 ? "idle" : `s${index}`;
      states[name] = { sheet: `sheets/${name}.png`, frames: 1, fps: 8, loop: true };
      await writeFile(join(folder, "sheets", `${name}.png`), large);
    }
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...base, states }));
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await expect(packs.applySheet({ packId: "placeholder", token: picked.token, state: "bow", frames: 1,
      fps: 8, loop: true, overrideFootIssues: true })).rejects.toThrow("64 MiB");
  }, 20_000);
});

describe("developer sheet hardening (M8 criterion 4)", () => {
  const apply = (token: string, state = "bow") => ({ packId: "placeholder", token, state, frames: 1, fps: 8, loop: true,
    overrideFootIssues: true });

  it("does not keep a token alive across a developer mode off/on switch", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    settings.developerMode = false;
    await expect(packs.applySheet(apply(picked.token))).rejects.toThrow("개발자 모드");
    settings.developerMode = true;
    await expect(packs.applySheet(apply(picked.token))).rejects.toThrow("만료");
    expect(storeControl.calls).toEqual([]);
  });

  it("clears pending tokens when a pick request arrives with developer mode off", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    settings.developerMode = false;
    await expect(packs.pickSheet({ packId: "placeholder", frames: 1 })).rejects.toThrow("개발자 모드");
    settings.developerMode = true;
    await expect(packs.applySheet(apply(picked.token))).rejects.toThrow("만료");
  });

  it("refuses a token whose cell size or anchor changed after the pick", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const folder = join(builtins, "placeholder");
    // A 1x1 cell only allows anchor [0, 0], so this pack uses 2x2 cells to have an anchor that can move.
    const wide = Buffer.from(await readFile(path));
    wide.writeUInt32BE(2, 16);
    wide.writeUInt32BE(2, 20);
    await writeFile(path, wide);
    await writeFile(join(folder, "sheets", "idle.png"), wide);
    const two = { ...manifest("placeholder"), cellSize: [2, 2] };
    await writeFile(join(folder, "manifest.json"), JSON.stringify(two));
    const packs = service({ chooseSheetFile: async () => path });
    const picked = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...two, anchor: [1, 1] }));
    await expect(packs.applySheet(apply(picked.token))).rejects.toThrow("시트를 다시 골라 주세요");
    expect(storeControl.calls).toEqual([]);
    const again = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    await expect(packs.applySheet(apply(again.token))).resolves.toMatchObject({ state: "bow" });
  });

  it("does not let two overlapping applies overwrite each other's manifest", async () => {
    settings.developerMode = true;
    const path = await selectedSheet();
    const packs = service({ chooseSheetFile: async () => path });
    const first = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    let release: () => void = () => undefined;
    characterControl.hold = new Promise<void>((resolve) => { release = resolve; });
    const a = packs.applySheet(apply(first.token, "bow"));
    // Let the first apply reach its gated load before the second pick runs.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await packs.pickSheet({ packId: "placeholder", frames: 1 }) as { token: string };
    const b = packs.applySheet(apply(second.token, "wave"));
    // Without the lock the second apply reads the old manifest while the first is held; give its read time to finish.
    for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([a, b]);
    const states = (JSON.parse(await readFile(join(builtins, "placeholder", "manifest.json"), "utf8")) as
      { states: Record<string, { sheet: string }> }).states;
    expect(Object.keys(states).sort()).toEqual(["bow", "idle", "wave"]);
    for (const name of ["bow", "wave"]) expect(existsSync(join(builtins, "placeholder", states[name]?.sheet ?? "missing"))).toBe(true);
  });

  describe("orphan cleanup", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    async function seed(): Promise<string> {
      const folder = join(builtins, "placeholder");
      await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...manifest("placeholder"), states: {
        idle: { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true },
        kept: { sheet: "sheets/kept-00000001.png", frames: 1, fps: 8, loop: true } } }));
      for (const name of ["kept-00000001.png", "orphan-1234abcd.png", "walk.png", "Wave-1234abcd.png", "bow-1234abcg.png",
        `.orphan-1234abcd.png.${uuid}.tmp`, "notes.tmp"])
        await writeFile(join(folder, "sheets", name), await readFile(join(folder, "sheets", "idle.png")));
      await writeFile(join(folder, `.manifest.json.${uuid}.tmp`), "{}");
      return folder;
    }

    it("removes only unreferenced generated sheets and leftover temp files when a built-in pack loads in developer mode", async () => {
      settings.developerMode = true;
      const folder = await seed();
      await service().start("placeholder");
      expect((await readdir(join(folder, "sheets"))).sort())
        .toEqual(["Wave-1234abcd.png", "bow-1234abcg.png", "idle.png", "kept-00000001.png", "notes.tmp", "walk.png"]);
      expect(existsSync(join(folder, `.manifest.json.${uuid}.tmp`))).toBe(false);
      expect(existsSync(join(folder, "manifest.json"))).toBe(true);
    });

    it("leaves everything alone with developer mode off or in a packaged build", async () => {
      const folder = await seed();
      await service().start("placeholder");
      settings.developerMode = true;
      await service({ isPackaged: true }).start("placeholder");
      expect(existsSync(join(folder, "sheets", "orphan-1234abcd.png"))).toBe(true);
      expect(existsSync(join(folder, `.manifest.json.${uuid}.tmp`))).toBe(true);
    });

    it("keeps every file when the manifest cannot be read", async () => {
      settings.developerMode = true;
      const folder = await seed();
      await writeFile(join(folder, "manifest.json"), "{ broken");
      await service().start("placeholder");
      expect(existsSync(join(folder, "sheets", "orphan-1234abcd.png"))).toBe(true);
    });
  });
});
