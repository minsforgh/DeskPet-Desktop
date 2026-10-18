import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

let root: string;
let app: DesktopApp | undefined;
const launched: DesktopApp[] = [];

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (root) await cleanupTemporaryPath(root, launched); }
}, 45_000);

test("legacy interactions move to a derived pack and stay in the menu after restart", async () => {
  root = await mkdtemp(join(tmpdir(), "deskpet-interactions-pack-e2e-"));
  const userData = join(root, "data");
  await mkdir(userData);
  const settingsPath = join(userData, "settings.json");
  const legacy = { characterId: "placeholder", interactions: [
    { id: "pat", label: "쓰다듬기", mood: "happy", speak: true, lines: ["바꾼 쓰다듬기 대사"], builtin: true },
    { id: "wave", label: "손 흔들기", mood: "happy", speak: true, lines: ["안녕!"], builtin: false },
  ] };
  await writeFile(settingsPath, JSON.stringify(legacy), "utf8");

  const checkMenu = async (desktop: DesktopApp): Promise<void> => {
    expect((await desktop.request({ cmd: "state" }) as { character: { id: string } }).character.id).toBe("placeholder-mine");
    const menu = await desktop.request({ cmd: "petMenuLabelsForTest" }) as { labels: string[] };
    expect(menu.labels).toContain("쓰다듬기");
    expect(menu.labels).toContain("손 흔들기");
    await desktop.request({ cmd: "petMenuClickForTest", label: "쓰다듬기" });
    await vi.waitFor(async () => {
      const state = await desktop.request({ cmd: "state" }) as { bubble: { text: string | null } };
      expect(state.bubble.text).toBe("바꾼 쓰다듬기 대사");
    }, { timeout: 10_000, interval: 50 });
  };

  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  await vi.waitFor(async () => {
    const state = await app?.request({ cmd: "state" }) as { bubble: { text: string | null } };
    expect(state.bubble.text).toContain("상호작용 설정을");
  }, { timeout: 10_000, interval: 50 });
  await app.request({ cmd: "bubbleDismiss" });
  await app.request({ cmd: "clock", pause: true });
  await app.request({ cmd: "clock", advanceMs: 5_000 });
  await checkMenu(app);
  const current = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  expect(current).toMatchObject({ characterId: "placeholder-mine", migrations: { interactionsToPack: true } });
  expect(current).not.toHaveProperty("interactions");
  expect(JSON.parse(await readFile(`${settingsPath}.bak`, "utf8"))).toMatchObject(legacy);
  expect((await stat(join(userData, "characters", "placeholder-mine", "interactions.json"))).isFile()).toBe(true);

  await app.quit();
  app = await DesktopApp.launch(userData, ["--event-port=0"]);
  launched.push(app);
  await checkMenu(app);
}, 90_000);
