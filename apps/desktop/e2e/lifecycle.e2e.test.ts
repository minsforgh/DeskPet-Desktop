import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

let tempDir: string;

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), "deskpet-lifecycle-e2e-")); });
afterAll(async () => { if (tempDir) await cleanupTemporaryPath(tempDir); });

test("20 consecutive tray quits exit cleanly", async () => {
  for (let index = 0; index < 20; index += 1) {
    const app = await DesktopApp.launch(join(tempDir, `user-data-${index}`));
    try {
      // reminders runs in its own process; quit() then checks that no plugin process is left behind.
      expect(app.livePluginPids.length).toBeGreaterThan(0);
      await app.quit();
    }
    finally { await app.forceStop(); }
  }
}, 60000);
