import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

const source = (path: string): string => resolve(import.meta.dirname, "src", path);

export default defineConfig({
  main: {
    build: {
      // The runner runs in a utilityProcess outside the app's module tree, so it carries its own copy of these.
      externalizeDeps: { exclude: ["@deskpet/plugin-host", "@deskpet/plugin-sdk", "@deskpet/core"] },
      rollupOptions: {
        input: { index: source("main/index.ts"), "plugin-runner": source("plugin-runner/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: source("preload/index.ts"), bubble: source("preload/bubble.ts"), settings: source("preload/settings.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: { index: source("renderer/index.html"), bubble: source("renderer/bubble.html"), settings: source("renderer/settings.html") },
      },
    },
  },
});
