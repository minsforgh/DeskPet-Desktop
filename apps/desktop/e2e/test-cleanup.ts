import { rm } from "node:fs/promises";
import { cleanupExitedDescendants, type DesktopApp } from "./desktop-app.js";

const cleanupApps = (apps: readonly DesktopApp[] | undefined): readonly DesktopApp[] => apps ?? [];

/** Remove an e2e temporary path after all supplied app processes have exited. */
export async function cleanupTemporaryPath(path: string, apps?: readonly DesktopApp[]): Promise<void> {
  try { for (const app of cleanupApps(apps)) await app.waitForExit(); }
  finally { await cleanupExitedDescendants(); }
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`[e2e cleanup] Could not remove temporary path '${path}': ${String(error)}`);
  }
}
