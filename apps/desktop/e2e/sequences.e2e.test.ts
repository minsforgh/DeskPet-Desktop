import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type State = { character: { id: string; state: string }; bubble: { visible: boolean; text: string | null };
  bounds: { x: number; y: number }; visible: boolean; queue: { pending: number } };

function notify(port: number, token: string, text: string, priority = "normal"): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "sequences-e2e", type: "notify", text, mood: "surprised", priority }));
  });
}

test("right-click sequences show each step, external notices interrupt, and dragging stops playback", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-sequences-e2e-"));
  const charactersDir = join(root, "characters");
  const userData = join(root, "data");
  let app: DesktopApp | undefined;
  try {
    const packDir = join(charactersDir, "placeholder");
    await cp(resolve(import.meta.dirname, "../../../characters/placeholder"), packDir, { recursive: true });
    await cp(resolve(import.meta.dirname, "../../../characters/placeholder-alt"),
      join(charactersDir, "placeholder-alt"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(packDir, "manifest.json"), JSON.stringify({ ...manifest,
      interactions: "interactions.json", sequences: "sequences.json",
      fallbacks: { celebrate: "happy", "pretend-walk": "walk" } }));
    const sequences = { version: 1, sequences: [{ id: "greet", steps: [
      { play: "happy", ms: 1_000, say: "첫 단계" },
      { play: "talk", ms: 1_000, say: "둘째 단계" },
      { play: "worried", ms: 1_000, say: "셋째 단계" },
    ] }, { id: "still", steps: [{ play: "pretend-walk", ms: 1_000, say: "제자리" }] }] };
    await writeFile(join(packDir, "sequences.json"), JSON.stringify(sequences));
    await writeFile(join(packDir, "interactions.json"), JSON.stringify({ version: 1, items: [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => ({ id: `sequence-${number}`, label: `시퀀스 ${number}`,
        mood: "happy", bubble: true, lines: ["이 대사는 보이지 않아요"], sequence: "greet" })),
      { id: "silent", label: "말풍선 없음", mood: "happy", bubble: false, lines: [], sequence: "still" },
      { id: "missing", label: "없는 시퀀스", mood: "worried", bubble: true, lines: ["대체 대사"], sequence: "missing" },
      { id: "ordinary", label: "일반 동작", mood: "happy", bubble: true, lines: ["일반 대사"] },
    ], hidden: [] }));
    app = await DesktopApp.launch(userData, [`--characters-dir=${charactersDir}`]);
    const running = app;
    const state = (): Promise<State> => running.request({ cmd: "state" }) as Promise<State>;
    const advance = (advanceMs: number): Promise<unknown> => running.request({ cmd: "clock", advanceMs });
    await running.request({ cmd: "clock", pause: true });
    const labels = (await running.request({ cmd: "petMenuLabelsForTest" }) as { labels: string[] }).labels;
    expect(labels).toContain("시퀀스 1");
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 1" });
    await vi.waitFor(async () => expect(await state()).toMatchObject({ character: { state: "happy" },
      bubble: { visible: true, text: "첫 단계" } }), { timeout: 10_000, interval: 50 });
    await advance(1_000);
    expect(await state()).toMatchObject({ character: { state: "talk" }, bubble: { text: "둘째 단계" } });
    await advance(1_000);
    expect(await state()).toMatchObject({ character: { state: "worried" }, bubble: { text: "셋째 단계" } });
    await advance(1_000);
    expect(await state()).toMatchObject({ character: { state: "idle" }, bubble: { visible: false } });

    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 2" });
    expect((await state()).character.state).toBe("happy");
    const { port, token } = await running.eventServerAuth(userData);
    expect(await notify(port, token, "외부 알림")).toBe(202);
    expect(await state()).toMatchObject({ character: { state: "surprised" }, bubble: { text: "외부 알림" } });
    await advance(3_000);
    expect((await state()).bubble.text).toBe("외부 알림");

    await running.request({ cmd: "bubbleDismiss" });
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 3" });
    const bounds = (await state()).bounds;
    await running.request({ cmd: "dragStart", cursor: { x: bounds.x + 50, y: bounds.y + 50 } });
    expect(await state()).toMatchObject({ character: { state: "drag" }, bubble: { visible: false } });
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 4" });
    await advance(1_000);
    expect((await state()).character.state).toBe("drag");
    await running.request({ cmd: "dragEnd" });
    expect((await state()).character.state).toBe("idle");

    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 5" });
    await running.request({ cmd: "petMenuClickForTest", label: "일반 동작" });
    expect((await state()).bubble.text).toBe("일반 대사");
    await advance(3_000);
    expect((await state()).bubble.text).toBe("일반 대사");

    await running.request({ cmd: "bubbleDismiss" });
    await advance(5_000);
    await running.request({ cmd: "petMenuClickForTest", label: "없는 시퀀스" });
    expect((await state()).bubble.text).toBe("대체 대사");
    await running.request({ cmd: "bubbleDismiss" });
    const beforeStill = (await state()).bounds;
    await running.request({ cmd: "petMenuClickForTest", label: "말풍선 없음" });
    expect((await state()).bubble.visible).toBe(false);
    expect((await state()).bounds).toMatchObject({ x: beforeStill.x, y: beforeStill.y });
    await advance(1_000);
    expect((await state()).bounds).toMatchObject({ x: beforeStill.x, y: beforeStill.y });
    expect((await state()).character.state).toBe("idle");

    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 6" });
    await running.request({ cmd: "trayMenuClick", label: "방해 금지" });
    expect(await notify(port, token, "보류된 알림")).toBe(202);
    expect((await state()).bubble.text).toBe("첫 단계");
    expect((await state()).queue.pending).toBe(1);
    await advance(1_000);
    expect((await state()).bubble.text).toBe("둘째 단계");
    expect(await notify(port, token, "긴급 알림", "urgent")).toBe(202);
    expect((await state()).bubble.text).toBe("긴급 알림");
    await advance(2_000);
    expect((await state()).bubble.text).toBe("긴급 알림");
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 7" });
    expect((await state()).bubble.text).toBe("첫 단계");
    await running.request({ cmd: "tray", action: "hide" });
    expect((await state()).visible).toBe(false);
    await running.request({ cmd: "tray", action: "show" });
    expect((await state()).character.state).toBe("idle");

    await running.request({ cmd: "trayMenuClick", label: "설정…" });
    await vi.waitFor(async () => expect(await running.request({ cmd: "state" })).toMatchObject({
      settings: { open: true, ready: true } }), { timeout: 10_000, interval: 50 });
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 8" });
    expect(await running.request({ cmd: "settingsPackCall", method: "packSelect",
      payload: { packId: "placeholder-alt" } })).toMatchObject({ ok: true, packId: "placeholder-alt" });
    expect(await state()).toMatchObject({ character: { id: "placeholder-alt", state: "idle" } });
    expect(await running.request({ cmd: "settingsPackCall", method: "packSelect",
      payload: { packId: "placeholder" } })).toMatchObject({ ok: true, packId: "placeholder" });
    const loaded = await running.request({ cmd: "settingsPackCall", method: "sequencesLoad", payload: { packId: "placeholder" } });
    expect(loaded).toMatchObject({ ok: true, sequences: { sequences: sequences.sequences } });
    await running.request({ cmd: "petMenuClickForTest", label: "시퀀스 9" });
    const saved = await running.request({ cmd: "settingsPackCall", method: "sequencesSave",
      payload: { packId: "placeholder", sequences } });
    expect(saved).toMatchObject({ ok: true, packId: "placeholder-mine", derived: true });
    expect(await state()).toMatchObject({ character: { id: "placeholder-mine", state: "idle" } });
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(root, app ? [app] : []);
  }
}, 90_000);
