import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Rect = { x: number; y: number; width: number; height: number };
type Metrics = { textContent: string; parts: { prefix: string; content: string; suffix: string } | null;
  partBoxes: Record<string, Rect>; truncated: boolean; expanded: boolean; lines: number };
type State = { bubble: { visible: boolean; text: string | null; renderer: Metrics } };

let root: string;
let app: DesktopApp | undefined;
let auth: { port: number; token: string };
const state = (): Promise<State> => app?.request({ cmd: "state" }) as Promise<State>;
const next = async (): Promise<void> => {
  await app?.request({ cmd: "bubbleDismiss" });
  await app?.request({ cmd: "clock", advanceMs: 5_000 });
};
const post = async (event: Record<string, unknown>): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:${auth.port}/event`, { method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "notify", source: "parts", ...event }) });
  expect(response.status).toBe(202);
};
const ordered = (metrics: Metrics): void => {
  const { prefix, content, suffix } = metrics.partBoxes;
  if (!prefix || !content || !suffix) throw new Error("Three painted blocks are required");
  expect(prefix.y + prefix.height).toBeLessThanOrEqual(content.y);
  expect(content.y + content.height).toBeLessThanOrEqual(suffix.y);
};

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, app ? [app] : []); }
}, 30_000);

test("structured voice and line events paint ordered blocks while plain events stay flat", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-line-parts-e2e-"));
  const characters = join(root, "characters");
  const pack = join(characters, "wolf-maid");
  await cp(resolve(import.meta.dirname, "../../../characters/wolf-maid"), pack, { recursive: true });
  await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), join(characters, "placeholder"), { recursive: true });
  const voicePath = join(pack, "voice.json");
  const voice = JSON.parse(await readFile(voicePath, "utf8")) as Record<string, unknown>;
  const long = "긴 내용이 줄 수 제한 때문에 줄어드는지 확인합니다. ".repeat(6).trim();
  await writeFile(voicePath, JSON.stringify({ ...voice, templates: { done: [
    { prefix: "앞말", content: "{task}", suffix: "끝말" },
    "문자열 {task}",
  ], info: [{ prefix: "앞말", content: "{task}", suffix: "끝말" }],
  alert: [{ prefix: "앞말".repeat(18), content: "{task}", suffix: "끝말".repeat(18) }] } }));
  const plugins = join(root, "plugins");
  const lines = join(plugins, "parts");
  await mkdir(join(lines, "dist"), { recursive: true });
  await writeFile(join(lines, "manifest.json"), JSON.stringify({ id: "parts", name: "Parts", version: "1.0.0",
    apiVersion: "2", entry: "dist/index.js", description: "e2e lines", permissions: {}, contributes: { lines: "lines.json" } }));
  await writeFile(join(lines, "dist", "index.js"), "export default { activate() {} };\n");
  await writeFile(join(lines, "lines.json"), JSON.stringify({ version: 1, lines: [
    { id: "parts.ordered", label: "Ordered", kind: "done", variables: ["task"],
      variants: [{ prefix: "시작", content: "{task}", suffix: "마침" },
        { prefix: "다음", content: "{task}", suffix: "완료" }] },
  ] }));
  const legacy = join(plugins, "legacy");
  await mkdir(legacy);
  await writeFile(join(legacy, "manifest.json"), JSON.stringify({ id: "legacy", name: "Legacy", version: "1.0.0",
    apiVersion: "1", entry: "index.mjs", description: "e2e legacy", permissions: {},
    contributes: { actions: ["legacy.plain", "legacy.voice"], trayItems: ["legacy.plain-item", "legacy.voice-item"] } }));
  await writeFile(join(legacy, "index.mjs"), `export default { activate(ctx) {
    ctx.registerAction("legacy.plain", () => ctx.emit({ source: "legacy", type: "notify", text: "외부 평문" }));
    ctx.registerAction("legacy.voice", () => ctx.emit({ source: "legacy", type: "notify", text: "대체 문구",
      voice: { kind: "info", slots: { task: "플러그인 작업" } } }));
    ctx.addTrayItem({ id: "legacy.plain-item", label: "외부 평문 보내기", action: "legacy.plain" });
    ctx.addTrayItem({ id: "legacy.voice-item", label: "외부 어투 보내기", action: "legacy.voice" });
  } };`);
  const userData = join(root, "data");
  await mkdir(userData);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false },
    display: { bubble: { maxWidthDip: 180, maxLines: 3 } } }));
  app = await DesktopApp.launch(userData, [`--characters-dir=${characters}`, "--character=wolf-maid", `--plugins-dir=${plugins}`]);
  auth = await app.eventServerAuth(userData);
  await app.request({ cmd: "clock", pause: true });

  await post({ text: "대체 문구", voice: { kind: "done", slots: { task: "짧은 작업" } } });
  let bubble = (await state()).bubble;
  expect(bubble.renderer.parts).toEqual({ prefix: "앞말", content: "짧은 작업", suffix: "끝말" });
  ordered(bubble.renderer);
  expect(bubble.renderer.lines).toBe(3);
  await next();

  await post({ text: "대체 문구", voice: { kind: "done", slots: { task: "짧은 작업" } } });
  bubble = (await state()).bubble;
  expect(bubble.renderer.parts).toBeNull();
  expect(bubble.renderer.textContent).toBe("문자열 짧은 작업");
  await next();

  await post({ text: "대체 문구", voice: { kind: "done", slots: { task: long } } });
  bubble = (await state()).bubble;
  expect(bubble.renderer.parts?.prefix).toBe("앞말");
  expect(bubble.renderer.parts?.suffix).toBe("끝말");
  expect(bubble.renderer.parts?.content.endsWith("…")).toBe(true);
  expect(bubble.renderer.truncated).toBe(true);
  ordered(bubble.renderer);
  await app.request({ cmd: "bubbleTextClick" });
  bubble = (await state()).bubble;
  expect(bubble.renderer.expanded).toBe(true);
  expect(bubble.renderer.parts).toEqual({ prefix: "앞말", content: long, suffix: "끝말" });
  ordered(bubble.renderer);
  await next();

  await post({ text: "대체 문구", voice: { kind: "alert", slots: { task: "핵심" } } });
  bubble = (await state()).bubble;
  expect(bubble.renderer.parts?.prefix).toBe("앞말".repeat(18));
  expect(bubble.renderer.parts?.suffix).toBe("끝말".repeat(18));
  expect(bubble.renderer.lines).toBeGreaterThan(3);
  ordered(bubble.renderer);
  await next();

  await post({ text: "대체 문구", line: { id: "parts.ordered", vars: { task: "작업 내용" } } });
  bubble = (await state()).bubble;
  expect(bubble.renderer.parts).toEqual({ prefix: "시작", content: "작업 내용", suffix: "마침" });
  ordered(bubble.renderer);
  await next();

  await post({ text: "HTTP 평문" });
  bubble = (await state()).bubble;
  expect(bubble.renderer).toMatchObject({ textContent: "HTTP 평문", parts: null });
  await next();

  await app.request({ cmd: "trayMenuClick", label: "외부 평문 보내기" });
  await vi.waitFor(async () => { expect((await state()).bubble.renderer.parts).toBeNull();
    expect((await state()).bubble.renderer.textContent).toBe("외부 평문"); }, { timeout: 10_000, interval: 50 });
  await next();
  await app.request({ cmd: "trayMenuClick", label: "외부 어투 보내기" });
  await vi.waitFor(async () => { expect((await state()).bubble.renderer.parts).toEqual({
    prefix: "앞말", content: "플러그인 작업", suffix: "끝말" }); }, { timeout: 10_000, interval: 50 });
  ordered((await state()).bubble.renderer);
  await next();

  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => {
    expect((await app?.request({ cmd: "state" }) as { settings: { ready: boolean } }).settings.ready).toBe(true);
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsClick", selector: "#tab-character" });
  await app.request({ cmd: "settingsClick", selector: "#character-tab-voice" });
  const row = ".plugin-lines-plugin[data-lines-plugin='parts'] .line-row[data-line-id='parts.ordered']";
  await vi.waitFor(async () => {
    expect(await app?.request({ cmd: "settingsQuery", selector: `${row} .plugin-line-send` })).toHaveLength(1);
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "settingsClick", selector: `${row} .plugin-line-send` });
  await vi.waitFor(async () => { const current = (await state()).bubble;
    expect({ parts: current.renderer.parts, text: current.text, painted: current.renderer.textContent }).toEqual({
      parts: { prefix: "시작", content: "예시", suffix: "마침" }, text: "시작 예시 마침", painted: "시작예시마침" });
  }, { timeout: 10_000, interval: 50 });
  ordered((await state()).bubble.renderer);
  await next();
  await app.request({ cmd: "settingsClick", selector: `${row} > button:nth-of-type(3)` });
  await vi.waitFor(async () => {
    await app?.request({ cmd: "settingsClick", selector: `${row} .plugin-line-send` });
    const current = (await state()).bubble;
    expect({ parts: current.renderer.parts, text: current.text, painted: current.renderer.textContent }).toEqual({
      parts: { prefix: "다음", content: "예시", suffix: "완료" }, text: "다음 예시 완료", painted: "다음예시완료" });
  }, { timeout: 10_000, interval: 100 });
  ordered((await state()).bubble.renderer);
}, 90_000);
