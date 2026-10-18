import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("electron", () => ({ nativeImage: { createFromBuffer: (bytes: Buffer) => ({
  getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
  toBitmap: () => Buffer.alloc(bytes.readUInt32BE(16) * bytes.readUInt32BE(20) * 4),
}) } }));

import { loadCharacter, loadInteractions, loadMotions, loadReactions, loadSequences, loadVoiceTemplates, selectPackReaction, validCharacterId } from "./character.js";

const roots: string[] = [];
const base = { id: "base", name: "Base", apiVersion: "1", cellSize: [1, 1], anchor: [0, 0], scale: 1,
  states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true } }, fallbacks: {},
  interactions: "interactions.json", voice: "voice.json" };
const derived = { id: "mine", name: "Mine", apiVersion: "1", extends: "base" };

async function fixture(): Promise<{ root: string; builtins: string; users: string }> {
  const root = await mkdtemp(join(tmpdir(), "deskpet-pack-loader-"));
  roots.push(root);
  const builtins = join(root, "builtins");
  const users = join(root, "users");
  await mkdir(join(builtins, "base", "sheets"), { recursive: true });
  await mkdir(join(users, "mine"), { recursive: true });
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  await writeFile(join(builtins, "base", "sheets", "idle.png"), png);
  await writeFile(join(builtins, "base", "manifest.json"), JSON.stringify(base));
  await writeFile(join(builtins, "base", "interactions.json"), JSON.stringify({ version: 1, items: [
    { id: "pat", label: "Pat", mood: "happy", bubble: true, lines: ["Hi"] }], hidden: [] }));
  await writeFile(join(builtins, "base", "voice.json"), JSON.stringify({ version: 1, templates: { done: ["Done"] } }));
  await writeFile(join(users, "mine", "manifest.json"), JSON.stringify(derived));
  return { root, builtins, users };
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("character pack loader", () => {
  it("chooses line overrides, line pack targets, kinds, rules, then mood", () => {
    const event = { source: "fixture", type: "notify" as const, text: "Hi", mood: "happy" as const,
      line: { id: "fixture.done" }, voice: { kind: "done" as const } };
    const reactions = { kinds: { done: { play: "worried" } }, lines: { "fixture.done": { play: "sleepy" } } };
    const rules = [{ match: { source: "fixture" }, play: "idle" }];
    expect(selectPackReaction(event, reactions, rules, { "fixture.done": { play: "happy" } }).selected?.play).toBe("happy");
    expect(selectPackReaction(event, reactions, rules).selected?.play).toBe("sleepy");
    expect(selectPackReaction(event, { kinds: reactions.kinds }, rules).selected?.play).toBe("worried");
    expect(selectPackReaction({ ...event, voice: undefined }, { kinds: {} }, rules).selected?.play).toBe("idle");
    expect(selectPackReaction({ ...event, source: "other", voice: undefined }, { kinds: {} }, rules).selected?.play).toBe("happy");
    expect(selectPackReaction(event, reactions, rules, { "fixture.done": { play: "happy" } }, new Map())
      .selected?.play).toBe("worried");
    expect(selectPackReaction({ ...event, text: undefined, type: "react" },
      { kinds: { done: { play: "surprised" } }, lines: { "fixture.done": { sequence: "notice" } }, }, rules)
      .selected?.play).toBe("surprised");
    expect(selectPackReaction(event, { kinds: { done: { play: "surprised" } },
      lines: { "fixture.done": { sequence: "missing" } } }, rules, {}, undefined, new Set(["notice"]))
      .selected?.play).toBe("surprised");
  });
  it("finds the kind mapping from the registered line list when the event has no voice", () => {
    const event = { source: "fixture", type: "notify" as const, text: "Hi", mood: "happy" as const, line: { id: "fixture.done" } };
    const reactions = { kinds: { done: { play: "bow" } } };
    const lines = new Map([["fixture.done", "done" as const]]);
    expect(selectPackReaction(event, reactions, [], {}, lines)).toEqual({ selected: { play: "bow" }, mapped: true });
    expect(selectPackReaction(event, reactions, [], {}, new Map()).mapped).toBe(false);
    expect(selectPackReaction(event, { kinds: reactions.kinds, lines: { "fixture.done": { play: "sleepy" } } }, [], {}, lines)
      .selected?.play).toBe("sleepy");
  });
  it("gives pack play and sequence choices precedence over plugin and mood rules", () => {
    const reactions = { kinds: { done: { sequence: "notice" }, failed: { play: "worried" } } };
    const rules = [{ match: { source: "sample" }, play: "sleep" }];
    const notify = { source: "sample", type: "notify" as const, text: "Notice", mood: "happy" as const,
      voice: { kind: "failed" as const } };
    expect(selectPackReaction(notify, reactions, rules)).toEqual({ selected: { play: "worried" }, mapped: true });
    expect(selectPackReaction({ ...notify, voice: { kind: "done" } }, reactions, rules))
      .toEqual({ sequence: "notice", mapped: true });
    expect(selectPackReaction({ ...notify, voice: { kind: "info" } }, reactions, rules))
      .toEqual({ selected: { play: "sleep" }, mapped: false });
    expect(selectPackReaction({ ...notify, source: "other", voice: { kind: "info" } }, reactions, rules))
      .toEqual({ selected: { play: "happy" }, mapped: false });
    expect(selectPackReaction({ ...notify, type: "react", voice: { kind: "done" } }, reactions, rules))
      .toEqual({ selected: { play: "sleep" }, mapped: false });
    expect(selectPackReaction({ ...notify, type: "react", voice: { kind: "failed" } }, reactions, rules))
      .toEqual({ selected: { play: "worried" }, mapped: true });
  });
  it("inherits and replaces reaction files and removes mappings to missing sequences", async () => {
    const { builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    const mineRoot = join(users, "mine");
    await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, reactions: "reactions.json" }));
    await writeFile(join(baseRoot, "reactions.json"), JSON.stringify({ version: 1,
      kinds: { done: { sequence: "greet" }, failed: { play: "worried" } } }));
    let pack = await loadCharacter(users, "mine", builtins);
    expect((await loadReactions(pack, new Set(["greet"]))).reactions.kinds).toEqual({
      done: { sequence: "greet" }, failed: { play: "worried" },
    });
    const missing = await loadReactions(pack, new Set());
    expect(missing.reactions.kinds).toEqual({ failed: { play: "worried" } });
    expect(missing.problems).toContain("reactions done references missing sequence greet");
    await writeFile(join(mineRoot, "manifest.json"), JSON.stringify({ ...derived, reactions: "mine.json" }));
    await writeFile(join(mineRoot, "mine.json"), JSON.stringify({ version: 1, kinds: { info: { play: "happy" } } }));
    pack = await loadCharacter(users, "mine", builtins);
    expect((await loadReactions(pack)).reactions.kinds).toEqual({ info: { play: "happy" } });
  });

  it("inherits and replaces motions files and falls back to defaults for broken ones", async () => {
    const { builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    const mineRoot = join(users, "mine");
    await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, motions: "motions.json" }));
    await writeFile(join(baseRoot, "motions.json"), JSON.stringify({ version: 1, motions: { land: { play: "idle" } }, landing: "soft" }));
    let pack = await loadCharacter(users, "mine", builtins);
    expect((await loadMotions(pack)).motions).toEqual({ motions: { land: { play: "idle" } }, landing: "soft" });
    await writeFile(join(mineRoot, "manifest.json"), JSON.stringify({ ...derived, motions: "mine.json" }));
    await writeFile(join(mineRoot, "mine.json"), JSON.stringify({ version: 1, motions: { fall: { play: "idle" } } }));
    pack = await loadCharacter(users, "mine", builtins);
    expect((await loadMotions(pack)).motions).toEqual({ motions: { fall: { play: "idle" } }, landing: "normal" });
    await writeFile(join(mineRoot, "mine.json"), "{ not json");
    const broken = await loadMotions(await loadCharacter(users, "mine", builtins));
    expect(broken.motions).toEqual({ motions: {}, landing: "normal" });
    expect(broken.problems).toEqual(["motions file could not be read"]);
    await writeFile(join(mineRoot, "manifest.json"), JSON.stringify(derived));
    pack = await loadCharacter(users, "mine", builtins);
    expect((await loadMotions({ ...pack, manifest: { ...pack.manifest, motions: undefined } })).motions)
      .toEqual({ motions: {}, landing: "normal" });
  });

  it("rejects reaction paths that escape through traversal, absolute paths, or links", async () => {
    const { root, builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "reactions.json"), JSON.stringify({ version: 1, kinds: {} }));
    await symlink(join(root, "outside"), join(baseRoot, "linked"), "junction");
    for (const path of ["../reactions.json", resolve(root, "outside", "reactions.json"), "linked/reactions.json"]) {
      await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, reactions: path }));
      try {
        const pack = await loadCharacter(users, "mine", builtins);
        expect((await loadReactions(pack)).problems).toContain("reactions file could not be read");
      } catch (error) { expect(String(error)).toMatch(/Invalid manifest/u); }
    }
  });
  it("inherits sequences as one file, replaces them in a derived pack, and reports missing references", async () => {
    const { builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    const mineRoot = join(users, "mine");
    const file = { version: 1, sequences: [{ id: "greet", steps: [{ play: "idle", ms: 500 }] }] };
    await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, sequences: "sequences.json" }));
    await writeFile(join(baseRoot, "sequences.json"), JSON.stringify(file));
    await writeFile(join(mineRoot, "manifest.json"), JSON.stringify({ ...derived, interactions: "mine.json" }));
    await writeFile(join(mineRoot, "mine.json"), JSON.stringify({ version: 1, items: [
      { id: "pat", label: "Pat", mood: "happy", bubble: true, lines: ["Hi"], sequence: "greet" },
      { id: "wave", label: "Wave", mood: "happy", bubble: true, lines: ["Fallback"], sequence: "missing" }], hidden: [] }));
    let pack = await loadCharacter(users, "mine", builtins);
    expect((await loadSequences(pack)).sequences).toEqual({ sequences: file.sequences });
    const loaded = await loadInteractions(pack, new Set(["greet"]));
    expect(loaded.interactions.items).toHaveLength(2);
    expect(loaded.problems).toContain("interactions wave references missing sequence missing");
    await writeFile(join(mineRoot, "manifest.json"), JSON.stringify({ ...derived, sequences: "mine-sequences.json" }));
    await writeFile(join(mineRoot, "mine-sequences.json"), JSON.stringify({ version: 1, sequences: [
      { id: "other", steps: [{ play: "idle", ms: 500 }] }] }));
    pack = await loadCharacter(users, "mine", builtins);
    expect((await loadSequences(pack)).sequences.sequences.map((item) => item.id)).toEqual(["other"]);
  });

  it("rejects sequence paths that escape the approved pack root", async () => {
    const { root, builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "sequences.json"), JSON.stringify({ version: 1, sequences: [] }));
    await symlink(join(root, "outside"), join(baseRoot, "linked"), "junction");
    for (const path of ["../sequences.json", resolve(root, "outside", "sequences.json"), "linked/sequences.json"]) {
      await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, sequences: path }));
      try {
        const pack = await loadCharacter(users, "mine", builtins);
        expect((await loadSequences(pack)).problems).toContain("sequences file could not be read");
      } catch (error) {
        expect(String(error)).toMatch(/Invalid manifest/u);
      }
    }
  });
  it("loads inherited art from a built-in folder and inherited interactions", async () => {
    const { builtins, users } = await fixture();
    const pack = await loadCharacter(users, "mine", builtins);
    expect(pack.manifest).toMatchObject({ id: "mine", extends: "base", states: base.states });
    expect(pack.sheets["sheets/idle.png"]).toMatch(/^data:image\/png;base64,/u);
    expect((await loadInteractions(pack)).interactions.items.map((item) => item.id)).toEqual(["pat"]);
    expect((await loadVoiceTemplates(users, pack.manifest, pack, builtins)).templates.done).toEqual(["Done"]);
    expect(JSON.parse(await readFile(join(users, "mine", "manifest.json"), "utf8"))).toEqual(derived);
  });

  it("reads a derived interaction file when explicitly overridden", async () => {
    const { builtins, users } = await fixture();
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify({ ...derived, interactions: "mine.json", voice: "mine-voice.json" }));
    await writeFile(join(users, "mine", "mine.json"), JSON.stringify({ version: 1, items: [], hidden: ["pat"] }));
    await writeFile(join(users, "mine", "mine-voice.json"), JSON.stringify({ version: 1, templates: { done: ["Mine"] } }));
    const pack = await loadCharacter(users, "mine", builtins);
    const result = await loadInteractions(pack);
    expect(result.interactions).toEqual({ items: [], hidden: ["pat"] });
    expect((await loadVoiceTemplates(users, pack.manifest, pack, builtins)).templates.done).toEqual(["Mine"]);
    await writeFile(join(users, "mine", "mine.json"), "{");
    expect((await loadInteractions(await loadCharacter(users, "mine", builtins))).problems).toContain("interactions file could not be read");
    await writeFile(join(users, "mine", "mine.json"), " ".repeat(256 * 1024 + 1));
    expect((await loadInteractions(await loadCharacter(users, "mine", builtins))).problems).toContain("interactions file could not be read");
  });

  it("checks preview size, dimensions, and real path", async () => {
    const { root, builtins, users } = await fixture();
    const baseRoot = join(builtins, "base");
    await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, preview: "preview.png" }));
    const png = await readFile(join(baseRoot, "sheets", "idle.png"));
    await writeFile(join(baseRoot, "preview.png"), png);
    await expect(loadCharacter(users, "mine", builtins)).resolves.toMatchObject({ manifest: { preview: "preview.png" } });
    await writeFile(join(baseRoot, "preview.png"), Buffer.alloc(512 * 1024 + 1));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/512 KiB/);
    png.writeUInt32BE(257, 16);
    await writeFile(join(baseRoot, "preview.png"), png);
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/preview dimensions/);
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "preview.png"), png);
    await writeFile(join(baseRoot, "manifest.json"), JSON.stringify({ ...base, preview: "linked/preview.png" }));
    await symlink(join(root, "outside"), join(baseRoot, "linked"), "junction");
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/Preview outside/);
  });

  it("rejects a manifest above the JSON file limit", async () => {
    const { builtins, users } = await fixture();
    await writeFile(join(users, "mine", "manifest.json"), " ".repeat(256 * 1024 + 1));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/Manifest exceeds 256 KiB/);
  });

  it("reports missing and chained bases and circular extends", async () => {
    const { builtins, users } = await fixture();
    await expect(loadCharacter(users, "mine")).rejects.toThrow(/built-in pack root is required/);
    await expect(loadCharacter(users, "mine", users)).rejects.toThrow(/separate built-in folder/);
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify({ ...derived, extends: "missing" }));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/base pack missing/);
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify(derived));
    await writeFile(join(builtins, "base", "manifest.json"), JSON.stringify({ ...base, extends: "other" }));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/base pack must not extend/);
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify({ ...derived, extends: "mine" }));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/cannot extend itself/);
  });

  it("rejects pack, base, sheet, and interaction paths that resolve outside their roots", async () => {
    const { root, builtins, users } = await fixture();
    await expect(loadCharacter(users, "../mine", builtins)).rejects.toThrow(/Invalid character id/);
    await expect(loadCharacter(users, join(users, "mine"), builtins)).rejects.toThrow(/Invalid character id/);
    await symlink(join(builtins, "base"), join(users, "linked"), "junction");
    await expect(loadCharacter(users, "linked", builtins)).rejects.toThrow(/outside character folder/);
    await symlink(join(users, "mine"), join(builtins, "linked-base"), "junction");
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify({ ...derived, extends: "linked-base" }));
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/outside built-in folder/);
    await writeFile(join(users, "mine", "manifest.json"), JSON.stringify(derived));
    const originalSheet = await readFile(join(builtins, "base", "sheets", "idle.png"));
    await rm(join(builtins, "base", "sheets"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "idle.png"), originalSheet);
    await symlink(join(root, "outside"), join(builtins, "base", "sheets"), "junction");
    await expect(loadCharacter(users, "mine", builtins)).rejects.toThrow(/Sheet outside/);
    await rm(join(builtins, "base", "sheets"), { recursive: true });
    await mkdir(join(builtins, "base", "sheets"));
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    await writeFile(join(builtins, "base", "sheets", "idle.png"), png);
    await writeFile(join(root, "outside", "interactions.json"), "{}");
    await writeFile(join(builtins, "base", "manifest.json"), JSON.stringify({ ...base, interactions: "linked/interactions.json" }));
    await symlink(join(root, "outside"), join(builtins, "base", "linked"), "junction");
    const parsed = await loadInteractions(await loadCharacter(users, "mine", builtins));
    expect(parsed.problems).toContain("interactions file could not be read");
  });

  it("keeps the legacy built-in id check and loads existing packs without editing them", async () => {
    expect(validCharacterId("Wolf-Maid")).toBe(true);
    const directory = resolve("characters");
    for (const id of ["placeholder", "placeholder-alt", "wolf-maid"]) {
      const pack = await loadCharacter(directory, id);
      expect(pack.manifest.id).toBe(id);
      expect(Object.keys(pack.sheets).length).toBeGreaterThan(0);
    }
    await expect(loadCharacter(directory, "mochi")).rejects.toThrow();
  });
});
