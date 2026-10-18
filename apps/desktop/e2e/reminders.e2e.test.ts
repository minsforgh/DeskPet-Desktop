import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLines, parseVoicePack, renderLine } from "@deskpet/core";
import { expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type State = { bubble: { visible: boolean; text: string | null }; queue: { pending: number } };

const RULE_TEXT = "회의 시작이에요";
// wolf-maid supplies her own sentence for the reminder line; the expected bubble text is
// rendered from the pack file the same way the app renders it (M12 criterion 9).
const ruleLine = parseLines(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../plugins/reminders/lines.json"), "utf8")), "reminders")
  .catalog.lines.find(({ id }) => id === "reminders.rule");
const packVariants = parseVoicePack(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../characters/wolf-maid/voice.json"), "utf8"))).lines["reminders.rule"];
if (!ruleLine || !packVariants) throw new Error("reminders.rule line or wolf-maid pack variants missing");
const packText = renderLine({ version: 1, lines: [{ ...ruleLine, variants: packVariants }] }, ruleLine.id, { message: RULE_TEXT });
if (!packText) throw new Error("wolf-maid reminder pack variants render nothing");
const expectedText = (character: string): string => character === "wolf-maid" ? packText : RULE_TEXT;

test.each(["wolf-maid", "placeholder"])("settings reminder uses its catalog line in the app bubble with %s", async (character) => {
  const tempDir = await mkdtemp(join(tmpdir(), "deskpet-reminders-e2e-"));
  let app: DesktopApp | undefined;
  try {
    await writeFile(join(tempDir, "settings.json"), JSON.stringify({
      doNotDisturb: { enabled: false },
      plugins: { reminders: { rules: [{ id: "meeting", time: "09:00", text: RULE_TEXT }] } },
    }), "utf8");
    app = await DesktopApp.launch(tempDir, ["--event-port=0", `--character=${character}`]);
    const atMs = new Date(2026, 9, 7, 8, 59).getTime();
    await app.request({ cmd: "setReminderClockForTest", atMs });
    expect((await app.requestRaw({ cmd: "advanceReminderClockForTest", advanceMs: -1 })).ok).toBe(false);
    await app.request({ cmd: "advanceReminderClockForTest", advanceMs: 60_000 });
    const state = await app.request({ cmd: "state" }) as State;
    expect(state.bubble).toMatchObject({ visible: true, text: expectedText(character) });
    expect(state.queue.pending).toBe(0);
    await app.quit();
  } finally {
    if (app) await app.dispose();
    await cleanupTemporaryPath(tempDir, app ? [app] : []);
  }
}, 30_000);
