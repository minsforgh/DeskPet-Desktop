import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { lineVariantText, parseLines, parseVoicePack, renderLine, type LineParts, type LineVariant } from "@deskpet/core";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

// wolf-maid ships her own sentence for the Jungle attendance line, so the editor's current
// value and the post-reset bubble come from her voice.json, not the catalog default (M12 9).
const catalog = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../plugins/jungle/lines.json"), "utf8")) as
  { lines: Array<{ id: string; label: string; kind: string; variables: string[]; variants: LineVariant[] }> };
const attendance = parseLines(catalog, "jungle").catalog.lines
  .find(({ id }) => id === "jungle.attendance-complete");
const packSentence = parseVoicePack(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../characters/wolf-maid/voice.json"), "utf8")))
  .lines["jungle.attendance-complete"]?.[0];
if (!attendance || !packSentence) throw new Error("Jungle completion line or wolf-maid pack sentence missing");
const original = attendance.variants[0];
if (!original) throw new Error("Jungle completion line missing");
const packText = renderLine({ version: 1, lines: [{ ...attendance, variants: [packSentence] }] }, attendance.id);
if (!packText) throw new Error("wolf-maid attendance pack sentence renders nothing");
if (typeof packSentence === "string") throw new Error("wolf-maid attendance line must be structured");
const editedPrefix = "집사님,";
const editedParts: LineParts = { ...packSentence, prefix: editedPrefix };
const editedText = lineVariantText(editedParts);

let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];
const query = (selector: string): Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>> =>
  app?.request({ cmd: "settingsQuery", selector }) as Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>>;
const click = (selector: string): Promise<unknown> => app?.request({ cmd: "settingsClick", selector }) as Promise<unknown>;
const set = (selector: string, value: string): Promise<unknown> => app?.request({ cmd: "settingsSet", selector, value }) as Promise<unknown>;

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

async function openVoice(): Promise<void> {
  if (!app) throw new Error("app missing");
  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => {
    expect((await app?.request({ cmd: "state" }) as { settings: { ready: boolean } }).settings.ready).toBe(true);
  }, { timeout: 10_000, interval: 50 });
  await click("#tab-character");
  await click("#character-tab-voice");
  await vi.waitFor(async () => { expect(await query("#plugin-lines-editor")).toHaveLength(1); },
    { timeout: 10_000, interval: 50 });
}

async function sendCompletion(userData: string): Promise<number> {
  if (!app) throw new Error("app missing");
  const auth = await app.eventServerAuth(userData);
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "jungle", type: "notify", text: "원문", line: { id: "jungle.attendance-complete", vars: {} },
      voice: { kind: "done" } }));
  });
}

async function expectBubble(text: string): Promise<void> {
  await vi.waitFor(async () => {
    const state = await app?.request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } };
    expect(state.bubble).toMatchObject({ visible: true, text });
  }, { timeout: 10_000, interval: 50 });
}

test("Jungle attendance line saves, survives restart, resets, and follows the selected character", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-plugin-lines-editor-e2e-"));
  const userData = join(root, "data");
  app = await DesktopApp.launch(userData, ["--character=wolf-maid"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openVoice();
  const plugin = ".plugin-lines-plugin[data-lines-plugin='jungle']";
  const row = `${plugin} .line-row[data-line-id='jungle.attendance-complete']`;
  expect((await query(`${plugin} .plugin-lines-title`))[0]?.text).toContain("Jungle");
  expect((await query(`${row} .plugin-line-title`))[0]?.text).toContain(lineVariantText(packSentence));
  expect((await query(`${row} .plugin-line-title`))[0]?.text).toContain("캐릭터 팩");
  expect((await query(`${row} .plugin-line-send-reason`))[0]?.text).toContain("보낼 수 없어요");
  await click(`${plugin} summary`);
  await click(`${row} summary`);
  expect((await query(`${row} .plugin-line-mode`))[0]?.value).toBe("parts");
  expect(await query(`${row} .plugin-line-prefix`)).toHaveLength(1);
  expect(await query(`${row} .plugin-line-content`)).toHaveLength(1);
  expect(await query(`${row} .plugin-line-suffix`)).toHaveLength(1);
  await set(`${row} .plugin-line-prefix`, editedPrefix);
  expect((await query(`${row} .plugin-line-preview`))[0]?.text).toBe(editedText);
  expect((await query("#plugin-lines-dirty"))[0]?.text).toContain("변경 있음");
  await click("#plugin-lines-save");
  await vi.waitFor(async () => {
    expect((await query("#plugin-lines-status"))[0]?.text).toBe("저장했어요");
  }, { timeout: 10_000, interval: 50 });
  expect(await sendCompletion(userData)).toBe(202);
  await expectBubble(editedText);
  const painted = (await app?.request({ cmd: "state" }) as { bubble: { renderer: { parts: LineParts | null } } }).bubble.renderer.parts;
  expect(painted?.prefix).toBe(editedPrefix);
  const stored = JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as
    { lineOverrides: Record<string, Record<string, LineVariant[]>> };
  expect(stored.lineOverrides["wolf-maid"]?.["jungle.attendance-complete"]).toEqual([editedParts]);

  await app.dispose(); app = undefined;
  app = await DesktopApp.launch(userData, ["--character=wolf-maid"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openVoice();
  expect((await query(`${row} .plugin-line-prefix`))[0]?.value).toBe(editedPrefix);
  expect(await sendCompletion(userData)).toBe(202);
  await expectBubble(editedText);

  await click(`${row} .voice-reset`);
  await click("#plugin-lines-save");
  await vi.waitFor(async () => { expect((await query("#plugin-lines-status"))[0]?.text).toBe("저장했어요"); },
    { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "clock", advanceMs: 11_000 });
  expect(await sendCompletion(userData)).toBe(202);
  // The override is gone, so the current pack's own sentence is back (D-071 order).
  await expectBubble(packText);
  await click(".pack-list-item[data-pack-id='placeholder']");
  await click("#pack-use");
  await vi.waitFor(async () => {
    expect((await query(`${row} .plugin-line-mode`))[0]?.value).toBe(typeof original === "string" ? "sentence" : "parts");
    expect((await query(`${row} .plugin-line-preview`))[0]?.text).toBe(lineVariantText(original));
  },
    { timeout: 10_000, interval: 50 });
  expect((await query(`${row} .plugin-line-title`))[0]?.text).toContain("기본");
}, 120_000);

/** Other plugins started by allow-all (Slack's token notice) may hold the bubble; clear them before sending. */
async function clearBubbles(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shown = (await app?.request({ cmd: "state" }) as { bubble: { visible: boolean } }).bubble.visible;
    if (shown) await app?.request({ cmd: "bubbleDismiss" });
    await app?.request({ cmd: "clock", advanceMs: 11_000 });
  }
  await vi.waitFor(async () => {
    expect((await app?.request({ cmd: "state" }) as { bubble: { visible: boolean } }).bubble.visible).toBe(false);
  }, { timeout: 10_000, interval: 50 });
}

test("sending an unsaved edit shows that sentence and leaves the saved value alone", async () => {
  await app?.dispose(); app = undefined;
  const userData = join(root, "data-send");
  app = await DesktopApp.launch(userData, ["--character=wolf-maid", "--permission-answer=allow"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openVoice();
  const plugin = ".plugin-lines-plugin[data-lines-plugin='jungle']";
  const row = `${plugin} .line-row[data-line-id='jungle.attendance-complete']`;
  await click(`${plugin} summary`);
  await click(`${row} summary`);
  await vi.waitFor(async () => { expect((await query(`${row} .plugin-line-send`))[0]?.disabled).toBe(false); },
    { timeout: 10_000, interval: 50 });
  await clearBubbles();
  await set(`${row} .plugin-line-mode`, "sentence");
  expect((await query(`${row} .plugin-line-conversion`))[0]?.text).toContain("전:");
  expect((await query(`${row} .plugin-line-mode`))[0]?.value).toBe("sentence");
  await set(`${row} .voice-variant-input`, "저장 전 문장");
  await set(`${row} .plugin-line-mode`, "parts");
  expect((await query(`${row} .plugin-line-content`))[0]?.value).toBe("저장 전 문장");
  expect((await query(`${row} .plugin-line-conversion`))[0]?.text).toContain("후: 저장 전 문장");
  await click(`${row} .plugin-line-send`);
  await expectBubble("저장 전 문장");
  expect((await query("#plugin-lines-dirty"))[0]?.text).toContain("변경 있음");
  const stored = await readFile(join(userData, "settings.json"), "utf8").catch(() => "{}");
  expect(stored).not.toContain("저장 전 문장");
}, 120_000);
