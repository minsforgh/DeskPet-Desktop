import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];
type Cell = { text: string; value: string | null; disabled: boolean | null };
const query = (selector: string): Promise<Cell[]> => app?.request({ cmd: "settingsQuery", selector }) as Promise<Cell[]>;
const click = (selector: string): Promise<unknown> => app?.request({ cmd: "settingsClick", selector }) as Promise<unknown>;
const set = (selector: string, value: string): Promise<unknown> => app?.request({ cmd: "settingsSet", selector, value }) as Promise<unknown>;
const ROW = ".line-reactions-plugin[data-lines-plugin='jungle'] .line-reaction-row[data-line-id='jungle.attendance-complete']";

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

async function openReactions(): Promise<void> {
  if (!app) throw new Error("app missing");
  await app.request({ cmd: "trayMenuClick", label: "설정…" });
  await vi.waitFor(async () => {
    expect((await app?.request({ cmd: "state" }) as { settings: { ready: boolean } }).settings.ready).toBe(true);
  }, { timeout: 10_000, interval: 50 });
  await click("#tab-character");
  await click("#character-tab-reactions");
  await vi.waitFor(async () => { expect(await query(ROW)).toHaveLength(1); }, { timeout: 10_000, interval: 50 });
}

async function sendCompletion(userData: string, withVoice = true): Promise<number> {
  if (!app) throw new Error("app missing");
  const auth = await app.eventServerAuth(userData);
  return new Promise((resolveStatus, rejectStatus) => {
    const call = httpRequest({ hostname: "127.0.0.1", port: auth.port, method: "POST", path: "/event",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    call.on("error", rejectStatus);
    call.end(JSON.stringify({ source: "jungle", type: "notify", text: "원문", line: { id: "jungle.attendance-complete", vars: {} },
      ...(withVoice ? { voice: { kind: "done" } } : {}) }));
  });
}

async function expectPlay(state: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await app?.request({ cmd: "state" })).toMatchObject({ character: { state }, bubble: { visible: true } });
  }, { timeout: 10_000, interval: 50 });
  await app?.request({ cmd: "bubbleDismiss" });
  await app?.request({ cmd: "clock", advanceMs: 11_000 });
}

async function saved(): Promise<void> {
  await vi.waitFor(async () => { expect((await query("#line-reactions-status"))[0]?.text).toBe("저장했어요"); },
    { timeout: 10_000, interval: 50 });
}

test("a Jungle line gets its own state, falls back to the kind mapping when cleared, and survives restart", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-plugin-lines-reactions-e2e-"));
  const userData = join(root, "data");
  app = await DesktopApp.launch(userData, ["--character=wolf-maid"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openReactions();
  await click(".line-reactions-plugin[data-lines-plugin='jungle'] summary");
  expect((await query(`${ROW} .line-reaction-source`))[0]?.text).toContain("종류별");

  // The shipped wolf-maid pack maps done to bow, so a different state proves the line choice won.
  expect(await sendCompletion(userData)).toBe(202);
  await expectPlay("bow");
  // A line-only event (no voice) still finds the kind mapping through the registered line list.
  expect(await sendCompletion(userData, false)).toBe(202);
  await expectPlay("bow");
  await set(`${ROW} select[aria-label$='재생 동작']`, "surprised");
  expect((await query("#line-reactions-dirty"))[0]?.text).toContain("저장하지 않은 변경");
  await click("#line-reactions-save");
  await saved();
  expect((await query(`${ROW} .line-reaction-source`))[0]?.text).toContain("내 지정");
  expect(await sendCompletion(userData)).toBe(202);
  await expectPlay("surprised");
  const stored = JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as
    { lineReactions: Record<string, Record<string, unknown>> };
  expect(stored.lineReactions["wolf-maid"]?.["jungle.attendance-complete"]).toEqual({ play: "surprised" });

  await app.dispose(); app = undefined;
  app = await DesktopApp.launch(userData, ["--character=wolf-maid"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openReactions();
  await click(".line-reactions-plugin[data-lines-plugin='jungle'] summary");
  expect((await query(`${ROW} select[aria-label$='재생 동작']`))[0]?.value).toBe("surprised");
  expect(await sendCompletion(userData)).toBe(202);
  await expectPlay("surprised");

  await click(`${ROW} .line-reaction-reset`);
  await click("#line-reactions-save");
  await saved();
  expect((await query(`${ROW} .line-reaction-source`))[0]?.text).toContain("종류별");
  expect(await sendCompletion(userData)).toBe(202);
  await expectPlay("bow");
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

test("the line's send button plays the line's own state, not the default", async () => {
  await app?.dispose(); app = undefined;
  const userData = join(root, "data-send");
  app = await DesktopApp.launch(userData, ["--character=wolf-maid", "--permission-answer=allow"]);
  launched.push(app);
  await app.request({ cmd: "clock", pause: true });
  await openReactions();
  await click(".line-reactions-plugin[data-lines-plugin='jungle'] summary");
  await vi.waitFor(async () => { expect((await query(`${ROW} .line-reaction-send`))[0]?.disabled).toBe(false); },
    { timeout: 10_000, interval: 50 });
  await clearBubbles();
  // Like the plugin's own event, the send carries only the line, so with no assignment it follows the kind mapping (done -> bow).
  await click(`${ROW} .line-reaction-send`);
  await expectPlay("bow");
  await set(`${ROW} select[aria-label$='재생 동작']`, "surprised");
  await click("#line-reactions-save");
  await saved();
  // The send button is rate limited to one per second on the real clock, so press again until it is accepted.
  await vi.waitFor(async () => {
    await click(`${ROW} .line-reaction-send`);
    expect((await query("#line-reactions-status"))[0]?.text).toBe("펫에게 보냈어요");
  }, { timeout: 10_000, interval: 300 });
  await expectPlay("surprised");
}, 120_000);
