import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinPackName, builtinVoice as readBuiltinVoice } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";
import { parseVoicePack, renderVoice, type LineVariant } from "@deskpet/core";

let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];
const builtinVoice = resolve(import.meta.dirname, "../../../characters/wolf-maid/voice.json");
const query = (selector: string): Promise<Array<{ text: string; value: string | null }>> =>
  app?.request({ cmd: "settingsQuery", selector }) as Promise<Array<{ text: string; value: string | null }>>;

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("editing a done variant derives wolf-maid and the saved text appears in the pet bubble", async () => {
  const builtinName = await builtinPackName("wolf-maid");
  const builtinDone = (await readBuiltinVoice("wolf-maid")).done;
  const firstDone = builtinDone?.[0];
  if (!firstDone || typeof firstDone === "string") throw new Error("wolf-maid needs a structured done variant");
  root = await mkdtemp(join(tmpdir(), "deskpet-voice-editor-e2e-"));
  const userData = join(root, "data");
  const before = await readFile(builtinVoice);
  app = await DesktopApp.launch(userData, ["--event-port=0", "--character=wolf-maid"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  const state = await app.request({ cmd: "state" }) as { trayMenu: string[] };
  await app.request({ cmd: "trayMenuClick", label: state.trayMenu[3] });
  await vi.waitFor(async () => {
    const current = await app?.request({ cmd: "state" }) as { settings: { ready: boolean; visible: boolean } };
    expect(current.settings).toMatchObject({ ready: true, visible: true });
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsClick", selector: "#tab-character" });
  await vi.waitFor(async () => {
    expect((await query(".voice-kind[data-kind='done'] .voice-variant-input"))[0]?.value).toBeTruthy();
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsSet", selector: ".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-content",
    value: "새 어투: {task} / {result}" });
  expect((await query(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-row-preview"))[0]?.text)
    .toContain(`${firstDone.prefix}\n새 어투: 빌드 정리 / 테스트 통과`);
  expect((await query("#voice-dirty"))[0]?.text).toContain("변경 있음");
  await app.request({ cmd: "settingsClick", selector: ".pack-list-item[data-pack-id='placeholder']" });
  await vi.waitFor(async () => {
    expect((await query("#voice-leave-prompt button")).map(({ text }) => text))
      .toEqual(["저장", "버리기", "계속 편집"]);
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsClick", selector: "#voice-leave-prompt button:last-child" });
  expect((await query(".pack-list-item[aria-selected='true']"))[0]?.text).toContain(builtinName);
  await app.request({ cmd: "settingsClick", selector: "#voice-editor-save" });
  await vi.waitFor(async () => {
    const current = await app?.request({ cmd: "state" }) as { character: { id: string }; settings: { dirty: boolean } };
    expect(current.character.id).toBe("wolf-maid-mine");
    expect(current.settings.dirty).toBe(false);
    expect((await query(".pack-list-item[aria-selected='true']"))[0]?.text).toContain(`${builtinName} (내 버전)`);
    expect((await query("#voice-editor-status"))[0]?.text).toContain("내장 팩은 바꿀 수 없어");
  }, { timeout: 10_000, interval: 50 });
  const savedPath = join(userData, "characters", "wolf-maid-mine", "voice.json");
  const original = JSON.parse(before.toString("utf8")) as { templates: Record<string, LineVariant[]>; lines: unknown };
  const saved = JSON.parse(await readFile(savedPath, "utf8")) as typeof original;
  expect(saved.lines).toEqual(original.lines);
  expect(saved.templates.done?.[0]).toEqual({ ...firstDone, content: "새 어투: {task} / {result}" });
  for (const [kind, variants] of Object.entries(original.templates)) {
    expect(kind === "done" ? saved.templates[kind]?.slice(1) : saved.templates[kind])
      .toEqual(kind === "done" ? variants.slice(1) : variants);
  }
  expect(await readFile(builtinVoice)).toEqual(before);
  const auth = await app.eventServerAuth(userData);
  const status = await new Promise<number>((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "e2e", type: "notify", text: "원문", voice: { kind: "done",
      slots: { task: "빌드 정리", result: "테스트 통과" } } }));
  });
  expect(status).toBe(202);
  await vi.waitFor(async () => {
    const current = await app?.request({ cmd: "state" }) as { bubble: { visible: boolean; text: string } };
    expect(current.bubble).toMatchObject({ visible: true, text: renderVoice(parseVoicePack(saved).templates,
      { kind: "done", slots: { task: "빌드 정리", result: "테스트 통과" } }, 0) });
  }, { timeout: 10_000, interval: 50 });

  await app.request({ cmd: "settingsSet", selector: ".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-prefix",
    value: "새 앞말," });
  expect((await query(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-row-preview"))[0]?.text)
    .toContain("새 앞말,\n새 어투: 빌드 정리 / 테스트 통과");
  await app.request({ cmd: "settingsClick", selector: "#voice-editor-save" });
  await vi.waitFor(async () => { expect((await query("#voice-dirty"))[0]?.text).toBe(""); }, { timeout: 10_000, interval: 50 });
  const withPrefix = JSON.parse(await readFile(savedPath, "utf8")) as typeof original;
  expect(withPrefix.lines).toEqual(original.lines);
  expect(withPrefix.templates.done?.[0]).toEqual({ ...firstDone, prefix: "새 앞말,",
    content: "새 어투: {task} / {result}" });

  // An invalid variant asks before saving; both answers keep the native dialog closed in e2e.
  await app.request({ cmd: "settingsSet", selector: ".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-content", value: "" });
  expect((await query(".voice-kind[data-kind='done'] .voice-row-preview"))[0]?.text).toContain("저장 때 버려져요");
  await app.request({ cmd: "setSettingsConfirmAnswerForTest", answer: false });
  await app.request({ cmd: "settingsClick", selector: "#voice-editor-save" });
  expect((await query("#voice-dirty"))[0]?.text).toContain("변경 있음");
  expect((JSON.parse(await readFile(join(userData, "characters", "wolf-maid-mine", "voice.json"), "utf8")) as
    { templates: { done: LineVariant[] } }).templates.done[0]).toEqual(withPrefix.templates.done?.[0]);
  await app.request({ cmd: "setSettingsConfirmAnswerForTest", answer: true });
  await app.request({ cmd: "settingsClick", selector: "#voice-editor-save" });
  await vi.waitFor(async () => { expect((await query("#voice-dirty"))[0]?.text).toBe(""); }, { timeout: 10_000, interval: 50 });
  const secondDone = builtinDone[1];
  if (!secondDone || typeof secondDone === "string") throw new Error("wolf-maid needs a second structured done variant");
  expect((await query(".voice-kind[data-kind='done'] .voice-variant[data-index='0'] .voice-prefix"))[0]?.value)
    .toBe(secondDone.prefix);
}, 90_000);
