import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ windows: [] as Array<{ handlers: Map<string, () => void> }> }));
vi.mock("electron", () => {
  class FakeWindow {
    handlers = new Map<string, () => void>();
    webContents = { on: () => undefined, setWindowOpenHandler: () => undefined };
    constructor() { fake.windows.push(this); }
    removeMenu(): void { /* no menu */ }
    once(event: string, handler: () => void): void { this.handlers.set(event, handler); }
    on(event: string, handler: () => void): void { this.handlers.set(event, handler); }
    loadFile(): Promise<void> { return Promise.resolve(); }
    isDestroyed(): boolean { return false; }
    destroy(): void { /* nothing to free */ }
  }
  return { BrowserWindow: FakeWindow, dialog: {}, ipcMain: { handle: () => undefined, on: () => undefined,
    removeHandler: () => undefined, removeAllListeners: () => undefined } };
});
import { SettingsWindow } from "./settings-window.js";

let unexpected: string[];
beforeEach(() => { fake.windows = []; unexpected = []; });

function settingsWindow(): SettingsWindow {
  return new SettingsWindow({ preload: "p", page: "q", service: {} as never, sheets: {} as never,
    behaviorLoad: async () => undefined, behaviorSave: async () => undefined,
    terrainLoad: () => undefined, terrainSave: async () => undefined,
    devControlActive: true, sheetFileTestMode: true, onUnexpectedDialog: (name) => { unexpected.push(name); } });
}

describe("sheet file test answer", () => {
  it("is used once while the window is open", async () => {
    const window = settingsWindow();
    window.open();
    window.setSheetFileAnswerForTest("a.png");
    expect(await window.chooseSheetFile()).toBe("a.png");
    expect(await window.chooseSheetFile()).toBeUndefined();
    expect(unexpected).toEqual(["sheet file open"]);
  });

  it("does not outlive the settings window it was set for", async () => {
    const window = settingsWindow();
    window.open();
    window.setSheetFileAnswerForTest("left-over.png");
    fake.windows[0]?.handlers.get("closed")?.();
    window.open();
    expect(await window.chooseSheetFile()).toBeUndefined();
    expect(unexpected).toEqual(["sheet file open"]);
  });
});
