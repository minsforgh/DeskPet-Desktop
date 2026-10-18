import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type State = { character: { id: string; state: string }; bubble: { visible: boolean; text: string | null };
  queue: { pending: number }; settings: { ready: boolean; dirty: boolean } | null };

test("HTTP line reactions follow user, pack, kind, then mood choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-line-reactions-e2e-"));
  const characters = join(root, "characters");
  const pluginsDir = join(root, "plugins");
  const fixtureDir = join(pluginsDir, "fixture");
  const data = join(root, "data");
  let app: DesktopApp | undefined;
  try {
    await cp(resolve(import.meta.dirname, "../../../characters/wolf-maid"), join(characters, "wolf-maid"), { recursive: true });
    await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), join(characters, "placeholder"), { recursive: true });
    await writeFile(join(characters, "wolf-maid", "reactions.json"), JSON.stringify({ version: 1,
      kinds: { done: { play: "surprised" } }, lines: { "fixture.pack": { play: "worried" } } }));
    await mkdir(join(fixtureDir, "dist"), { recursive: true });
    await writeFile(join(fixtureDir, "manifest.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1.0.0",
      apiVersion: "2", entry: "dist/index.js", description: "Reaction fixture", permissions: { network: ["example.com"] },
      contributes: { lines: "lines.json" } }));
    await writeFile(join(fixtureDir, "dist", "index.js"), "export {};");
    await writeFile(join(fixtureDir, "lines.json"), JSON.stringify({ version: 1,
      lines: ["user", "pack", "kind", "mood"].map((name) => ({ id: `fixture.${name}`, label: name,
        kind: name === "mood" ? "info" : "done", variables: [], variants: ["시험 알림"] })) }));
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "settings.json"), JSON.stringify({ doNotDisturb: { enabled: false },
      lineReactions: { "wolf-maid": { "fixture.user": { play: "happy" } } } }));
    app = await DesktopApp.launch(data, [`--characters-dir=${characters}`, `--plugins-dir=${pluginsDir}`, "--character=wolf-maid"]);
    const auth = await app.eventServerAuth(data);
    await app.request({ cmd: "clock", pause: true });
    for (const [id, expected] of [["user", "happy"], ["pack", "worried"], ["kind", "surprised"], ["mood", "happy"]] as const) {
      const body = JSON.stringify({ source: "fixture", type: "notify", mood: "happy", line: { id: `fixture.${id}` },
        ...(id === "kind" ? { voice: { kind: "done" } } : {}) });
      const status = await new Promise<number>((done, fail) => {
        const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
          headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
          response.resume(); response.on("end", () => done(response.statusCode ?? 0));
        });
        call.on("error", fail);
        call.end(body);
      });
      expect(status).toBe(202);
      await vi.waitFor(async () => expect(await app?.request({ cmd: "state" })).toMatchObject({
        character: { state: expected }, bubble: { visible: true, text: "시험 알림" },
      }), { timeout: 10_000, interval: 50 });
      await app.request({ cmd: "bubbleDismiss" });
      await app.request({ cmd: "clock", advanceMs: 5_000 });
    }
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(root, app ? [app] : []);
  }
}, 120_000);

function notify(port: number, token: string, kind: string, text: string, mood = "happy"): Promise<number> {
  return new Promise((done, fail) => {
    const call = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => done(response.statusCode ?? 0));
    });
    call.on("error", fail);
    call.end(JSON.stringify({ source: "reactions-e2e", type: "notify", text, mood,
      voice: { kind, slots: { task: "작업", result: "결과" } } }));
  });
}

function react(port: number, token: string, kind: string, mood: string): Promise<number> {
  return new Promise((done, fail) => {
    const call = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => done(response.statusCode ?? 0));
    });
    call.on("error", fail);
    call.end(JSON.stringify({ source: "reactions-e2e", type: "react", mood, voice: { kind } }));
  });
}

test("saved reaction kinds play silent sequence steps, ordinary states, and persist after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-reactions-e2e-"));
  const characters = join(root, "characters");
  const data = join(root, "data");
  const launched: DesktopApp[] = [];
  let app: DesktopApp | undefined;
  try {
    const packDir = join(characters, "wolf-maid");
    await cp(resolve(import.meta.dirname, "../../../characters/wolf-maid"), packDir, { recursive: true });
    await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), join(characters, "placeholder"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(packDir, "manifest.json"), JSON.stringify({ ...manifest, voice: undefined, sequences: "sequences.json" }));
    await writeFile(join(packDir, "sequences.json"), JSON.stringify({ version: 1, sequences: [
      { id: "notice", label: "알림 동작", steps: [
        { play: "happy", ms: 1_000, say: "숨긴 첫 대사" },
        { play: "worried", ms: 1_000, say: "숨긴 둘째 대사" },
      ] },
    ] }));
    app = await DesktopApp.launch(data, [`--characters-dir=${characters}`, "--character=wolf-maid"]);
    launched.push(app);
    const running = (): DesktopApp => { if (!app) throw new Error("App closed"); return app; };
    const state = (): Promise<State> => running().request({ cmd: "state" }) as Promise<State>;
    const clock = (advanceMs: number): Promise<unknown> => running().request({ cmd: "clock", advanceMs });
    const click = (selector: string): Promise<unknown> => running().request({ cmd: "settingsClick", selector });
    const set = (selector: string, value: string): Promise<unknown> => running().request({ cmd: "settingsSet", selector, value });
    const query = (selector: string): Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>> =>
      running().request({ cmd: "settingsQuery", selector }) as Promise<Array<{ text: string; value: string | null; disabled: boolean | null }>>;
    await running().request({ cmd: "clock", pause: true });
    const tray = (await state()) as State & { trayMenu: string[] };
    await running().request({ cmd: "trayMenuClick", label: tray.trayMenu[3] });
    await vi.waitFor(async () => expect((await state()).settings?.ready).toBe(true), { timeout: 10_000, interval: 50 });
    await click("#tab-character");
    await click("#character-tab-reactions");
    await vi.waitFor(async () => expect(await query(".reactions-row")).toHaveLength(7), { timeout: 10_000, interval: 50 });
    expect((await query(".reactions-row[data-kind='done'] .reactions-title"))[0]?.text).toContain("완료");
    await set(".reactions-row[data-kind='done'] select[aria-label$='동작(시퀀스)']", "notice");
    await set(".reactions-row[data-kind='failed'] select[aria-label$='재생 동작']", "worried");
    expect((await state()).settings?.dirty).toBe(true);
    expect((await query(".reactions-row[data-kind='done'] button"))[0]?.disabled).toBe(true);
    await running().request({ cmd: "setSettingsConfirmAnswerForTest", answer: false });
    await click("#character-tab-sequences");
    expect(await query("#reactions:not([hidden])")).toHaveLength(1);
    expect((await state()).settings?.dirty).toBe(true);
    await click("#rx-save");
    await vi.waitFor(async () => {
      expect((await state()).character.id).toBe("wolf-maid-mine");
      expect((await state()).settings?.dirty).toBe(false);
    }, { timeout: 10_000, interval: 50 });
    expect(JSON.parse(await readFile(join(data, "characters", "wolf-maid-mine", "reactions.json"), "utf8")))
      .toEqual({ version: 1, kinds: { done: { sequence: "notice" }, failed: { play: "worried" } } });
    expect((await query(".reactions-row[data-kind='done'] select[aria-label$='동작(시퀀스)']"))[0]?.value).toBe("notice");
    expect((await query(".reactions-row[data-kind='done'] button"))[0]?.disabled).toBe(false);

    await click(".reactions-row[data-kind='done'] button");
    await vi.waitFor(async () => expect(await state()).toMatchObject({ character: { state: "happy" },
      bubble: { visible: true } }), { timeout: 10_000, interval: 50 });
    await running().request({ cmd: "bubbleDismiss" });
    await clock(5_000);

    const auth = await running().eventServerAuth(data);
    expect(await notify(auth.port, auth.token, "done", "알림 본문")).toBe(202);
    await vi.waitFor(async () => expect(await state()).toMatchObject({ character: { state: "happy" },
      bubble: { visible: true, text: "알림 본문" } }), { timeout: 10_000, interval: 50 });
    await clock(1_000);
    expect(await state()).toMatchObject({ character: { state: "worried" }, bubble: { text: "알림 본문" } });
    await clock(1_000);
    expect(await state()).toMatchObject({ character: { state: "idle" }, bubble: { visible: true, text: "알림 본문" } });
    await running().request({ cmd: "bubbleDismiss" });
    await clock(5_000);
    expect(await notify(auth.port, auth.token, "failed", "실패 알림")).toBe(202);
    await vi.waitFor(async () => expect(await state()).toMatchObject({ character: { state: "worried" },
      bubble: { text: "실패 알림" } }), { timeout: 10_000, interval: 50 });
    await clock(1_000);
    expect(await state()).toMatchObject({ character: { state: "worried" }, bubble: { visible: true } });
    await running().request({ cmd: "bubbleDismiss" });
    await clock(5_000);
    expect(await react(auth.port, auth.token, "failed", "happy")).toBe(202);
    expect(await state()).toMatchObject({ character: { state: "worried" }, bubble: { visible: false } });
    await clock(1_000);
    expect(await react(auth.port, auth.token, "done", "surprised")).toBe(202);
    expect(await state()).toMatchObject({ character: { state: "surprised" }, bubble: { visible: false } });
    await clock(1_000);
    expect(await notify(auth.port, auth.token, "info", "기본 반응", "surprised")).toBe(202);
    await vi.waitFor(async () => expect((await state()).character.state).toBe("surprised"), { timeout: 10_000, interval: 50 });
    await running().request({ cmd: "bubbleDismiss" });
    await clock(5_000);
    await running().request({ cmd: "trayMenuClick", label: tray.trayMenu.find((item) => item.includes("방해 금지")) });
    expect(await notify(auth.port, auth.token, "done", "보류 알림")).toBe(202);
    expect((await state()).character.state).not.toBe("happy");
    expect((await state()).bubble.visible).toBe(false);
    expect((await state()).queue.pending).toBe(1);
    await running().request({ cmd: "trayMenuClick", label: tray.trayMenu.find((item) => item.includes("방해 금지")) });

    const finished = running(); app = undefined; await finished.dispose();
    app = await DesktopApp.launch(data, [`--characters-dir=${characters}`]); launched.push(app);
    await running().request({ cmd: "clock", pause: true });
    expect((await state()).character.id).toBe("wolf-maid-mine");
    const restartedAuth = await running().eventServerAuth(data);
    expect(await notify(restartedAuth.port, restartedAuth.token, "done", "재시작 알림")).toBe(202);
    await vi.waitFor(async () => expect(await state()).toMatchObject({ character: { state: "happy" },
      bubble: { text: "재시작 알림" } }), { timeout: 10_000, interval: 50 });
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(root, launched);
  }
}, 120_000);
