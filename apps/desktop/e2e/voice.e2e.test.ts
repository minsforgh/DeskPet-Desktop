import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { builtinVoice, renderedVoice } from "./helpers/builtin-pack.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];
let tempDir: string;

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-voice-e2e-")); }, 30000);
afterEach(async () => { if (app) await app.dispose(); app = undefined; }, 15000);
afterAll(async () => { if (tempDir) await cleanupTemporaryPath(tempDir, launched); });

async function launch(character: string, extraArgs: string[] = [], storedSettings?: unknown): Promise<{
  send: (event: Record<string, unknown>) => Promise<number>; bubble: () => Promise<string | null> }> {
  const userDataDir = join(tempDir, `user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  if (storedSettings !== undefined) {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(join(userDataDir, "settings.json"), JSON.stringify(storedSettings));
  }
  app = await DesktopApp.launch(userDataDir, ["--event-port=0", `--character=${character}`, ...extraArgs]);
  launched.push(app);
  const auth = await app.eventServerAuth(userDataDir);
  await app.request({ cmd: "clock", pause: true });
  const send = (event: Record<string, unknown>): Promise<number> => new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ type: "notify", source: "e2e", ...event }));
  });
  const bubble = async (): Promise<string | null> =>
    ((await app?.request({ cmd: "state" })) as { bubble: { text: string | null } }).bubble.text;
  return { send, bubble };
}

const advance = (ms: number): Promise<unknown> => app?.request({ cmd: "clock", advanceMs: ms }) as Promise<unknown>;

test("line voice uses user, pack, catalog, then event text without kind templates", async () => {
  const pluginsDir = join(tempDir, "voice-line-plugins");
  const fixtureDir = join(pluginsDir, "fixture");
  await mkdir(join(fixtureDir, "dist"), { recursive: true });
  await writeFile(join(fixtureDir, "manifest.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1.0.0",
    apiVersion: "2", entry: "dist/index.js", description: "Voice fixture", permissions: { network: ["example.com"] },
    contributes: { lines: "lines.json" } }));
  await writeFile(join(fixtureDir, "dist", "index.js"), "export {};");
  await writeFile(join(fixtureDir, "lines.json"), JSON.stringify({ version: 1,
    lines: ["user", "pack", "catalog", "text"].map((name) => ({ id: `fixture.${name}`, label: name,
      kind: "done", variables: ["task"], variants: ["목록 {task}"] })) }));
  const characters = join(tempDir, "voice-line-characters");
  await cp(resolve(import.meta.dirname, "../../../characters/wolf-maid"), join(characters, "wolf-maid"), { recursive: true });
  await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), join(characters, "placeholder"), { recursive: true });
  const voicePath = join(characters, "wolf-maid", "voice.json");
  const voice = JSON.parse(await readFile(voicePath, "utf8")) as Record<string, unknown>;
  await writeFile(voicePath, JSON.stringify({ ...voice, lines: { "fixture.pack": ["팩 {task}"],
    "fixture.catalog": ["{missing}"], "fixture.text": ["{task}"] } }));
  const { send, bubble } = await launch("wolf-maid", [`--plugins-dir=${pluginsDir}`, `--characters-dir=${characters}`],
    { doNotDisturb: { enabled: false }, lineOverrides: { "wolf-maid": {
      "fixture.user": ["사용자 {task}"], "fixture.pack": ["{missing}"], "fixture.text": ["{task}"],
    } } });
  for (const [id, vars, expected] of [
    ["user", { task: "빌드" }, "사용자 빌드"], ["pack", { task: "빌드" }, "팩 빌드"],
    ["catalog", { task: "빌드" }, "목록 빌드"], ["text", {}, "원문"],
  ] as const) {
    expect(await send({ source: "fixture", text: "원문", line: { id: `fixture.${id}`, vars },
      voice: { kind: "done", slots: { task: "빌드" } } })).toBe(202);
    expect(await bubble()).toBe(expected);
    await advance(11000);
  }
});

test("wolf-maid renders voice events in her own tone and cycles variants", async () => {
  const { send, bubble } = await launch("wolf-maid");
  const voice = { kind: "done", slots: { task: "빌드", result: "테스트 통과" } };
  const templates = await builtinVoice("wolf-maid");
  expect(await send({ text: "기본 문구", voice })).toBe(202);
  expect(await bubble()).toBe(renderedVoice(templates, "done", voice.slots, 0));
  await advance(11000);
  expect(await send({ text: "기본 문구", voice })).toBe(202);
  expect(await bubble()).toBe(renderedVoice(templates, "done", voice.slots, 1));
  await advance(11000);
  // A variant needing an empty slot is skipped; when none is usable the sent text stays.
  expect(await send({ text: "기본 문구", voice: { kind: "waiting" } })).toBe(202);
  expect(await bubble()).toBe("기본 문구");
  await advance(11000);
  // An event without voice is untouched.
  expect(await send({ text: "그대로" })).toBe(202);
  expect(await bubble()).toBe("그대로");
}, 60000);

test("a pack without voice templates shows the sent text", async () => {
  const { send, bubble } = await launch("placeholder");
  expect(await send({ text: "보낸 문구", voice: { kind: "done", slots: { task: "빌드", result: "통과" } } })).toBe(202);
  expect(await bubble()).toBe("보낸 문구");
}, 60000);

test("wolf-maid renders the new kinds and keeps her tone when result is empty", async () => {
  const { send, bubble } = await launch("wolf-maid");
  const templates = await builtinVoice("wolf-maid");
  const deadlineSlots = { message: "보고서 제출" };
  expect(await send({ text: "기본 문구", voice: { kind: "deadline", slots: deadlineSlots } })).toBe(202);
  expect(await bubble()).toBe(renderedVoice(templates, "deadline", deadlineSlots, 0));
  await advance(11000);
  expect(await send({ text: "기본 문구", voice: { kind: "done", slots: { task: "빌드" } } })).toBe(202);
  expect(await bubble()).toBe(renderedVoice(templates, "done", { task: "빌드" }, 0));
}, 60000);
