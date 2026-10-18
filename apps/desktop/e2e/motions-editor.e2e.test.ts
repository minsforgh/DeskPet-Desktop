import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { parseMotions, type CharacterManifest } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Query = Array<{ text: string; value: string | null; disabled: boolean | null; checked?: boolean | null }>;

test("the 이동 tab saves a landing style and one motion's picture, keeps them after reopening, and refuses an uneditable pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-motions-editor-e2e-"));
  const characters = join(root, "characters");
  const data = join(root, "data");
  const launched: DesktopApp[] = [];
  let app: DesktopApp | undefined;
  try {
    const source = resolve(import.meta.dirname, "../../../characters");
    await cp(join(source, "wolf-maid"), join(characters, "wolf-maid"), { recursive: true });
    await cp(join(source, "placeholder"), join(characters, "placeholder"), { recursive: true });
    await cp(join(source, "placeholder"), join(characters, "broken"), { recursive: true });
    const brokenManifest = JSON.parse(await readFile(join(characters, "broken", "manifest.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(characters, "broken", "manifest.json"),
      JSON.stringify({ ...brokenManifest, id: "broken", name: "깨진 팩", motions: "motions.json" }));
    await writeFile(join(characters, "broken", "motions.json"), JSON.stringify({ version: 2 }));

    const original = JSON.parse(await readFile(join(characters, "wolf-maid", "manifest.json"), "utf8")) as CharacterManifest;
    const originalMotions = parseMotions(JSON.parse(await readFile(join(characters, "wolf-maid", original.motions ?? ""), "utf8"))).motions;
    const nextLanding = originalMotions.landing === "soft" ? "normal" : "soft";
    const states = Object.keys(original.states);
    const nextAfterLand = Object.entries(original.states).find(([name, value]) => !value.loop && name !== originalMotions.afterLand?.play)?.[0];
    expect(nextAfterLand).toBeDefined();

    app = await DesktopApp.launch(data, [`--characters-dir=${characters}`, "--character=wolf-maid"]);
    launched.push(app);
    const running = (): DesktopApp => { if (!app) throw new Error("App closed"); return app; };
    const state = (): Promise<{ character: { id: string }; settings: { ready: boolean; dirty: boolean } | null; trayMenu?: string[] }> =>
      running().request({ cmd: "state" }) as never;
    const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
    const set = (selector: string, value: string): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
    const query = (selector: string): Promise<Query> => running().request({ cmd: "settingsQuery", selector }) as Promise<Query>;
    const openTab = async (): Promise<void> => {
      await click("#tab-character");
      await click("#character-tab-motions");
      await vi.waitFor(async () => expect(await query(".motions-row")).toHaveLength(9), { timeout: 10_000, interval: 50 });
    };

    await running().request({ cmd: "clock", pause: true });
    const tray = (await running().request({ cmd: "state" })) as { trayMenu: string[] };
    await running().request({ cmd: "trayMenuClick", label: tray.trayMenu[3] });
    await vi.waitFor(async () => expect((await state()).settings?.ready).toBe(true), { timeout: 10_000, interval: 50 });
    await openTab();

    const jumpSelect = ".motions-row[data-motion='jump'] select";
    const afterLandSelect = ".motions-after-land select";
    const afterLandOptions = await query(`${afterLandSelect} option`);
    expect(afterLandOptions.map(({ value }) => value)).toEqual(["", ...Object.entries(original.states)
      .filter(([, value]) => !value.loop).map(([name]) => name)]);
    const options = await query(`${jumpSelect} option`);
    const target = options.map(({ value }) => value ?? "").find((value) => value !== "" && value !== originalMotions.motions.jump?.play);
    expect(target).toBeDefined();
    expect(states).toContain(target);
    await set(jumpSelect, target ?? "");
    await set(afterLandSelect, nextAfterLand ?? "");
    await click(`input[name='motions-landing'][value='${nextLanding}']`);
    expect((await state()).settings?.dirty).toBe(true);
    await click("#mo-save");
    await vi.waitFor(async () => {
      expect((await state()).character.id).toBe("wolf-maid-mine");
      expect((await state()).settings?.dirty).toBe(false);
    }, { timeout: 10_000, interval: 50 });

    const savedFile = JSON.parse(await readFile(join(data, "characters", "wolf-maid-mine", "motions.json"), "utf8"));
    const saved = parseMotions(savedFile);
    expect(saved.problems).toEqual([]);
    expect(saved.motions.landing).toBe(nextLanding);
    expect(saved.motions.motions.jump).toEqual({ play: target });
    expect(saved.motions.afterLand).toEqual({ play: nextAfterLand });

    // Reopening the tab, and then the whole app, reads the same choice back.
    await click("#character-tab-voice");
    await click("#character-tab-motions");
    await vi.waitFor(async () => expect((await query(jumpSelect))[0]?.value).toBe(target), { timeout: 10_000, interval: 50 });
    expect(await query(".motions-row[data-motion='jump'] .motions-actual")).toMatchObject([{ text: `재생될 그림: ${target}` }]);
    expect((await query(`input[name='motions-landing'][value='${nextLanding}']`))[0]?.checked).toBe(true);
    expect((await query(afterLandSelect))[0]?.value).toBe(nextAfterLand);

    const finished = running(); app = undefined; await finished.dispose();
    app = await DesktopApp.launch(data, [`--characters-dir=${characters}`]); launched.push(app);
    await running().request({ cmd: "clock", pause: true });
    expect((await state()).character.id).toBe("wolf-maid-mine");
    const restartTray = (await running().request({ cmd: "state" })) as { trayMenu: string[] };
    await running().request({ cmd: "trayMenuClick", label: restartTray.trayMenu[3] });
    await vi.waitFor(async () => expect((await state()).settings?.ready).toBe(true), { timeout: 10_000, interval: 50 });
    await openTab();
    expect((await query(jumpSelect))[0]?.value).toBe(target);
    expect((await query(afterLandSelect))[0]?.value).toBe(nextAfterLand);
    expect((await query(`input[name='motions-landing'][value='${nextLanding}']`))[0]?.checked).toBe(true);

    // A pack whose motions file cannot be read is shown but not saved.
    await click(".pack-list-item[data-pack-id='broken']");
    await vi.waitFor(async () => expect((await query("#mo-save"))[0]?.disabled).toBe(true), { timeout: 10_000, interval: 50 });
    expect((await query(jumpSelect))[0]?.disabled).toBe(true);
    expect((await query(".motions-editor .status.error"))[0]?.text).toContain("저장할 수 없어요");
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(root, launched);
  }
}, 180_000);
