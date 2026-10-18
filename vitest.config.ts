import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@deskpet/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@deskpet/plugin-sdk/testing": fileURLToPath(new URL("./packages/plugin-sdk/src/testing/index.ts", import.meta.url)),
      "@deskpet/plugin-sdk": fileURLToPath(new URL("./packages/plugin-sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // A parallel Windows run timed out at 8 s in character-review and 10 s in drag cleanup
    // while other Electron files launched; one worker removes that measured contention.
    ...(mode === "e2e" ? { maxWorkers: 1, minWorkers: 1, globalSetup: ["./apps/desktop/e2e/helpers/e2e-run-lock.ts"] } : {}),
    include: mode === "e2e"
      ? ["apps/desktop/e2e/**/*.e2e.test.ts"]
      : mode === "contract"
        ? ["{apps,packages,plugins,tools}/*/src/**/*.contract.test.ts"]
        : ["{apps,packages,plugins,tools}/*/src/**/*.test.ts", "apps/desktop/scripts/**/*.test.ts", "apps/desktop/e2e/helpers/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: mode === "contract" || mode === "e2e"
      ? []
      : ["**/*.contract.test.ts", "**/*.e2e.test.ts", "**/node_modules/**", "**/out/**"],
    passWithNoTests: mode !== "e2e",
  },
}));
