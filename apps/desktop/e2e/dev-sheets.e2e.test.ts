import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

const repoCharacters = resolve(import.meta.dirname, "../../../characters");
let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

afterEach(async () => { if (app) { const finished = app; app = undefined; await finished.dispose(); } }, 20_000);
afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally {
    for (const dir of [...(root ? [root] : []), ...launchedRoots]) await cleanupTemporaryPath(dir, launched);
  }
}, 45_000);

test("developer imports bow into a temporary built-in pack and the pet plays it", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-dev-sheets-e2e-"));
  const userData = join(root, "data");
  const characters = join(root, "characters");
  await mkdir(userData);
  await mkdir(characters);
  await cp(join(repoCharacters, "placeholder"), join(characters, "placeholder"), { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false }, developerMode: true }));
  app = await DesktopApp.launch(userData, ["--event-port=0", `--characters-dir=${characters}`]);
  launched.push(app);
  const state = await app.request({ cmd: "state" }) as { trayMenu: string[] };
  await app.request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await app?.request({ cmd: "state" }) as { settings: { visible: boolean; ready: boolean } }).settings)
      .toMatchObject({ visible: true, ready: true });
  }, { timeout: 5_000, interval: 50 });
  const original = join(characters, "placeholder", "sheets", "idle.png");
  await app.request({ cmd: "setSheetFileAnswerForTest", path: original });
  const chosen = await app.request({ cmd: "settingsPackCall", method: "sheetPick",
    payload: { packId: "placeholder", frames: 8 } }) as { token: string; preview: string; footCheck: { issueFrames: number } };
  expect(chosen.preview).toMatch(/^data:image\/png;base64,/u);
  const applied = await app.request({ cmd: "settingsPackCall", method: "sheetApply", payload: {
    packId: "placeholder", token: chosen.token, state: "bow", frames: 8, fps: 8, loop: false,
    overrideFootIssues: chosen.footCheck.issueFrames > 0,
  } }) as { state: string; sheet: string };
  expect(applied.state).toBe("bow");
  expect(applied.sheet).toMatch(/^sheets\/bow-[0-9a-f]{8}\.png$/u);
  const manifest = JSON.parse(await readFile(join(characters, "placeholder", "manifest.json"), "utf8")) as
    { states: { bow: { sheet: string } } };
  expect(manifest.states.bow.sheet).toBe(applied.sheet);
  expect(await readFile(join(characters, "placeholder", applied.sheet))).toEqual(await readFile(original));
  expect(await readdir(join(characters, "placeholder", "sheets"))).toContain(applied.sheet.slice(7));
  expect((await app.request({ cmd: "setState", state: "bow" }) as { state: string }).state).toBe("bow");
  expect((await app.request({ cmd: "state" }) as { state: string }).state).toBe("bow");
  expect(await app.request({ cmd: "settingsPackCall", method: "saveDeveloperMode", payload: { enabled: false } }))
    .toEqual({ ok: true });
  await expect(app.request({ cmd: "settingsPackCall", method: "sheetPick",
    payload: { packId: "placeholder", frames: 1 } })).rejects.toThrow();
}, 90_000);

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** A sheet of opaque squares whose feet are far above the placeholder's anchor, so the foot check reports every frame. */
function floatingSheet(frames: number, cell: number): Buffer {
  const width = cell * frames;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(cell, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * cell);
  for (let y = 20; y < 80; y += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      for (let x = 100; x < 156; x += 1) rows.set([40, 40, 40, 255], y * (width * 4 + 1) + 1 + (frame * cell + x) * 4);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const query = (target: DesktopApp, selector: string): Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>> =>
  target.request({ cmd: "settingsQuery", selector }) as Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>>;
const click = (target: DesktopApp, selector: string): Promise<unknown> => target.request({ cmd: "settingsClick", selector });
const set = (target: DesktopApp, selector: string, value: string | boolean): Promise<unknown> =>
  target.request({ cmd: "settingsSet", selector, value });
const tabHidden = async (target: DesktopApp): Promise<boolean> =>
  /id="character-tab-sheets"[^>]*\shidden/u.test((await target.request({ cmd: "settingsDump" }) as { html: string }).html);

async function openSettings(target: DesktopApp): Promise<void> {
  const state = await target.request({ cmd: "state" }) as { trayMenu: string[] };
  await target.request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    expect((await target.request({ cmd: "state" }) as { settings: { visible: boolean; ready: boolean } }).settings)
      .toMatchObject({ visible: true, ready: true });
  }, { timeout: 5_000, interval: 50 });
  await click(target, "#tab-character");
}

async function launchWithPlaceholder(name: string, developerMode: boolean): Promise<{ characters: string }> {
  const dir = await mkdtemp(join(tmpdir(), `deskpet-dev-sheets-${name}-e2e-`));
  launchedRoots.push(dir);
  const userData = join(dir, "data");
  const characters = join(dir, "characters");
  await mkdir(userData);
  await mkdir(characters);
  await cp(join(repoCharacters, "placeholder"), join(characters, "placeholder"), { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false }, developerMode }));
  app = await DesktopApp.launch(userData, ["--event-port=0", `--characters-dir=${characters}`]);
  launched.push(app);
  return { characters };
}
const launchedRoots: string[] = [];

test("the 애니메이션 tab adds bow with a foot-issue sheet only after 그래도 사용, lists it, and the pet plays it", async () => {
  const { characters } = await launchWithPlaceholder("screen", true);
  const target = app as DesktopApp;
  await openSettings(target);
  expect(await tabHidden(target)).toBe(false);
  await click(target, "#character-tab-sheets");
  await vi.waitFor(async () => { expect(await query(target, "#sh-add")).toHaveLength(1); }, { timeout: 10_000, interval: 50 });
  expect((await query(target, ".sheet-state[data-state='idle']")).length).toBe(1);
  await vi.waitFor(async () => { expect(await query(target, ".sheet-state[data-state='idle'] canvas[data-frame]"))
    .toHaveLength(1); }, { timeout: 10_000, interval: 50 });
  const firstFrame = (await target.request({ cmd: "settingsDump" }) as { html: string }).html.match(/class="anim-preview-canvas"[^>]*data-frame="(\d+)"/u)?.[1];
  await vi.waitFor(async () => {
    const frame = (await target.request({ cmd: "settingsDump" }) as { html: string }).html.match(/class="anim-preview-canvas"[^>]*data-frame="(\d+)"/u)?.[1];
    expect(frame).toBeDefined();
    expect(frame).not.toBe(firstFrame);
  }, { timeout: 10_000, interval: 50 });
  // Every state row shows a preview box of the same size, whether or not its replay button is showing.
  await vi.waitFor(async () => {
    const rows = await query(target, ".sheet-state");
    const boxes = await target.request({ cmd: "settingsQuery", selector: ".sheet-state .anim-preview" }) as
      Array<{ width: number | null; height: number | null }>;
    expect(rows.length).toBeGreaterThan(1);
    expect(boxes).toHaveLength(rows.length);
    expect(boxes[0]?.width).toBeGreaterThan(0);
    expect(new Set(boxes.map((box) => `${box.width}x${box.height}`)).size).toBe(1);
    // A one-shot state has finished by now, so its replay button is part of the measured box.
    expect((await target.request({ cmd: "settingsDump" }) as { html: string }).html).toMatch(/<button type="button">▶ 다시 재생<\/button>/u);
  }, { timeout: 10_000, interval: 100 });
  expect(await query(target, ".sheet-state[data-state='bow']")).toHaveLength(0);

  const sheet = join(launchedRoots[0] ?? "", "floating.png");
  await writeFile(sheet, floatingSheet(2, 256));
  await target.request({ cmd: "setSheetFileAnswerForTest", path: sheet });
  await click(target, "#sh-add");
  await set(target, "#sh-name", "bow");
  await set(target, "#sh-frames", "2");
  await set(target, "#sh-fps", "6");
  await set(target, "#sh-loop", false);
  await click(target, "#sh-pick");
  await vi.waitFor(async () => { expect((await query(target, "#sh-foot-summary"))[0]?.text).toBe("발 위치 이상 2프레임"); },
    { timeout: 10_000, interval: 50 });
  expect((await query(target, "#sh-foot-issues li"))[0]?.text).toMatch(/^1번 프레임: 발 높이가 기준에서 벗어남 · 측정 \d+ · 기대 240$/u);
  expect(await query(target, "#sh-preview")).toHaveLength(1);
  expect(await query(target, "#sh-preview canvas")).toHaveLength(1);
  expect((await query(target, "#sh-apply"))[0]?.disabled).toBe(true);
  await click(target, "#sh-apply");
  expect(await query(target, ".sheet-state[data-state='bow']")).toHaveLength(0);
  await click(target, "#sh-override");
  expect((await query(target, "#sh-apply"))[0]?.disabled).toBe(false);
  await click(target, "#sh-apply");
  await vi.waitFor(async () => { expect(await query(target, ".sheet-state[data-state='bow']")).toHaveLength(1); },
    { timeout: 10_000, interval: 50 });
  expect((await query(target, "#sh-status"))[0]?.text).toBe("bow 상태를 추가했어요");
  expect((await query(target, ".sheet-state[data-state='bow']"))[0]?.text).toContain("2프레임 · 6fps · 한 번");

  const manifest = JSON.parse(await readFile(join(characters, "placeholder", "manifest.json"), "utf8")) as
    { states: { bow: { frames: number; fps: number; loop: boolean } } };
  expect(manifest.states.bow).toMatchObject({ frames: 2, fps: 6, loop: false });
  expect((await target.request({ cmd: "setState", state: "bow" }) as { state: string }).state).toBe("bow");
}, 90_000);

test("the 애니메이션 tab is absent without developer mode and appears when the switch is turned on", async () => {
  await launchWithPlaceholder("off", false);
  const target = app as DesktopApp;
  await openSettings(target);
  await vi.waitFor(async () => { expect((await query(target, ".pack-list-item")).length).toBeGreaterThan(0); }, { timeout: 10_000, interval: 50 });
  expect(await tabHidden(target)).toBe(true);
  expect(await query(target, "#sh-add")).toHaveLength(0);
  await click(target, "#tab-general");
  await set(target, "#developer-mode", true);
  await vi.waitFor(async () => { expect(await tabHidden(target)).toBe(false); }, { timeout: 10_000, interval: 50 });
  await set(target, "#developer-mode", false);
  await vi.waitFor(async () => { expect(await tabHidden(target)).toBe(true); }, { timeout: 10_000, interval: 50 });
}, 90_000);

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const u32 = (...values: number[]): Buffer => { const out = Buffer.alloc(values.length * 4); values.forEach((value, index) => out.writeUInt32BE(value, index * 4)); return out; };
const ihdr = (width: number, height: number): Buffer => chunk("IHDR", Buffer.concat([u32(width, height), Buffer.from([8, 6, 0, 0, 0])]));
const pixels = (width: number, height: number): Buffer => deflateSync(Buffer.alloc((width * 4 + 1) * height));
/** fcTL: sequence, width, height, x, y, then delay 1/10 s, dispose none, blend source. */
const fcTL = (sequence: number, width: number, height: number): Buffer =>
  chunk("fcTL", Buffer.concat([u32(sequence, width, height, 0, 0), Buffer.from([0, 1, 0, 10, 0, 0])]));

/** Same 256x256 first image, with a second IHDR (here claiming far more pixels than the 4096x4096 ceiling) before the image data. */
function multiIhdrSheet(secondWidth: number, secondHeight: number): Buffer {
  return Buffer.concat([pngSignature, ihdr(256, 256), ihdr(secondWidth, secondHeight),
    chunk("IDAT", pixels(256, 256)), chunk("IEND", Buffer.alloc(0))]);
}

/** A 2-frame animated PNG: the default image is 256x256, the second frame covers 128x128 only. */
function apngSheet(): Buffer {
  return Buffer.concat([pngSignature, ihdr(256, 256), chunk("acTL", u32(2, 0)), fcTL(0, 256, 256),
    chunk("IDAT", pixels(256, 256)), fcTL(1, 128, 128),
    chunk("fdAT", Buffer.concat([u32(2), pixels(128, 128)])), chunk("IEND", Buffer.alloc(0))]);
}

async function pickFile(target: DesktopApp, name: string, bytes: Buffer): Promise<unknown> {
  const file = join(launchedRoots[0] ?? "", `${name}.png`);
  await writeFile(file, bytes);
  await target.request({ cmd: "setSheetFileAnswerForTest", path: file });
  return target.request({ cmd: "settingsPackCall", method: "sheetPick", payload: { packId: "placeholder", frames: 1 } });
}

// Observed with Electron's nativeImage on 2026-10-09: libpng refuses an IHDR that is not the first chunk, so the decode check rejects it.
test("a PNG with a second IHDR is refused at decode, whatever size the second header claims", async () => {
  await launchWithPlaceholder("multi-ihdr", true);
  const target = app as DesktopApp;
  await openSettings(target);
  for (const [name, width, height] of [["multi-same", 256, 256], ["multi-huge", 65_535, 65_535]] as const)
    await expect(pickFile(target, name, multiIhdrSheet(width, height))).rejects.toThrow("PNG를 디코드할 수 없습니다");
  // The refused picks leave the dialog and the app usable: a plain sheet is still accepted afterwards.
  await expect(pickFile(target, "plain", Buffer.concat([pngSignature, ihdr(256, 256), chunk("IDAT", pixels(256, 256)),
    chunk("IEND", Buffer.alloc(0))]))).resolves.toMatchObject({ canceled: false });
}, 90_000);

// Observed: the decoder takes the default image, whose size is the IHDR size; later frames are never measured, and the file is kept as chosen.
test("an APNG is accepted by its default image size and kept byte for byte", async () => {
  await launchWithPlaceholder("apng", true);
  const target = app as DesktopApp;
  await openSettings(target);
  const bytes = apngSheet();
  const picked = await pickFile(target, "apng", bytes) as { canceled: boolean; preview: string; footCheck: { skipped: boolean } };
  expect(picked.canceled).toBe(false);
  expect(picked.preview).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(picked.footCheck.skipped).toBe(false);
  // A default image of another size is still refused before decode, so a bigger second frame cannot change what is checked.
  const wrong = apngSheet();
  wrong.writeUInt32BE(512, 16);
  await expect(pickFile(target, "apng-wrong", wrong)).rejects.toThrow();
}, 90_000);
