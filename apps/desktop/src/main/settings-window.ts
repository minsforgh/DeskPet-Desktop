import { BrowserWindow, dialog, ipcMain } from "electron";
import { parseDirtyFlag } from "./settings-service.js";
import type { GeneralSettings, createSettingsService } from "./settings-service.js";
import type { createPackService } from "./pack-service.js";

type Service = ReturnType<typeof createSettingsService>;
const CHANNELS = ["settings:load", "settings:save-general", "settings:save-badge", "settings:save-bubble", "settings:save-developer-mode", "settings:save-launch-at-login", "settings:save-plugin", "settings:clear-secret", "settings:enable-reminder",
  "settings:voice-load", "settings:voice-preview", "settings:voice-send", "settings:line-send",
  "settings:line-settings-load", "settings:line-overrides-save", "settings:line-overrides-reset",
  "settings:line-reactions-save", "settings:line-reactions-reset",
  "settings:interactions-load", "settings:interactions-save", "settings:interactions-try",
  "settings:sequences-load", "settings:sequences-save", "settings:reactions-load", "settings:reactions-save",
  "settings:motions-load", "settings:motions-save",
  "settings:behavior-load", "settings:behavior-save", "settings:terrain-load", "settings:terrain-save",
  "settings:packs-list", "settings:pack-select", "settings:pack-delete", "settings:pack-save-voice",
  "settings:sheet-pick", "settings:sheet-apply", "settings:state-preview",
  "settings:pack-save-interactions", "settings:pack-interactions-load", "settings:pack-save-meta", "settings:pack-voice-load",
  "settings:confirm"] as const;

/** The settings window: an ordinary framed window, opened from the tray, never more than one. */
export class SettingsWindow {
  private window: BrowserWindow | undefined;
  private ready = false;
  private dirty = false;
  private reminderDirtyCount = 0;
  /** Set while a confirmed close is in flight so the second close event is not stopped again. */
  private closeConfirmed = false;
  private closeAnswerForTest: "close" | "edit" | undefined;
  private confirmAnswerForTest: boolean | undefined;
  private sheetFileAnswerForTest: string | undefined;
  private loading: Promise<void> = Promise.resolve();
  private finishLoading: (() => void) | undefined;

  constructor(private readonly options: { preload: string; page: string; service: Service;
    sheets: Pick<ReturnType<typeof createPackService>, "pickSheet" | "applySheet" | "statePreview">;
    behaviorLoad(packId: unknown): Promise<unknown>; behaviorSave(payload: unknown): Promise<unknown>;
    terrainLoad(): unknown; terrainSave(payload: unknown): Promise<unknown>;
    devControlActive: boolean; sheetFileTestMode: boolean; onUnexpectedDialog: (dialog: string) => void }) {
    const { service } = options;
    const handle = (channel: (typeof CHANNELS)[number], run: (payload: unknown) => unknown): void => {
      ipcMain.handle(channel, (event, payload: unknown) => {
        // Only this window's page may ask; anything else gets no answer at all.
        if (!this.window || event.sender !== this.window.webContents) throw new Error("Unexpected sender");
        return run(payload);
      });
    };
    handle("settings:load", () => service.load());
    handle("settings:save-general", (payload) => service.saveGeneral(payload));
    handle("settings:save-badge", (payload) => service.saveBadge(payload));
    handle("settings:save-bubble", (payload) => service.saveBubble(payload));
    handle("settings:save-developer-mode", (payload) => service.saveDeveloperMode(payload));
    handle("settings:save-launch-at-login", (payload) => service.saveLaunchAtLogin(payload));
    handle("settings:save-plugin", (payload) => service.savePlugin(payload));
    handle("settings:enable-reminder", () => service.enableReminder());
    handle("settings:clear-secret", (payload) => service.clearSecret(payload));
    handle("settings:voice-load", () => service.voiceLoad());
    handle("settings:voice-preview", (payload) => service.voicePreview(payload));
    handle("settings:voice-send", (payload) => service.voiceSend(payload));
    handle("settings:line-send", (payload) => service.lineSend(payload));
    handle("settings:line-settings-load", () => service.lineSettingsLoad());
    handle("settings:line-overrides-save", (payload) => service.lineOverridesSave(payload));
    handle("settings:line-overrides-reset", () => service.lineOverridesReset());
    handle("settings:line-reactions-save", (payload) => service.lineReactionsSave(payload));
    handle("settings:line-reactions-reset", () => service.lineReactionsReset());
    handle("settings:interactions-load", () => service.interactionsLoad());
    handle("settings:interactions-save", (payload) => service.interactionsSave(payload));
    handle("settings:interactions-try", (payload) => service.interactionsTry(payload));
    handle("settings:sequences-load", (payload) => service.sequencesLoad(payload));
    handle("settings:sequences-save", (payload) => service.sequencesSave(payload));
    handle("settings:reactions-load", (payload) => service.reactionsLoad(payload));
    handle("settings:reactions-save", (payload) => service.reactionsSave(payload));
    handle("settings:motions-load", (payload) => service.motionsLoad(payload));
    handle("settings:motions-save", (payload) => service.motionsSave(payload));
    handle("settings:behavior-load", (payload) => options.behaviorLoad(payload));
    handle("settings:behavior-save", (payload) => options.behaviorSave(payload));
    handle("settings:terrain-load", () => options.terrainLoad());
    handle("settings:terrain-save", (payload) => options.terrainSave(payload));
    handle("settings:packs-list", () => service.packsList());
    handle("settings:pack-select", (payload) => service.packSelect(payload));
    handle("settings:pack-delete", (payload) => service.packDelete(payload));
    handle("settings:pack-save-voice", (payload) => service.packSaveVoice(payload));
    handle("settings:pack-save-interactions", (payload) => service.packSaveInteractions(payload));
    handle("settings:pack-interactions-load", (payload) => service.packInteractionsLoad(payload));
    handle("settings:pack-save-meta", (payload) => service.packSaveMeta(payload));
    handle("settings:pack-voice-load", (payload) => service.packVoiceLoad(payload));
    handle("settings:sheet-pick", (payload) => options.sheets.pickSheet(payload));
    handle("settings:sheet-apply", (payload) => options.sheets.applySheet(payload));
    handle("settings:state-preview", (payload) => options.sheets.statePreview(payload));
    ipcMain.on("settings:confirm", (event, message: unknown) => {
      if (!this.window || event.sender !== this.window.webContents) { event.returnValue = false; return; }
      if (typeof message !== "string") { event.returnValue = false; return; }
      if (!this.options.devControlActive) { event.returnValue = null; return; }
      if (this.confirmAnswerForTest === undefined) this.options.onUnexpectedDialog(`settings confirm: ${message}`);
      event.returnValue = this.confirmAnswerForTest ?? false;
    });
    ipcMain.on("settings:ready", (event) => {
      if (this.window && event.sender === this.window.webContents) { this.ready = true; this.finishLoading?.(); }
    });
    ipcMain.on("settings:dirty", (event, payload: unknown) => {
      // Same sender rule as the ready ping; a non-boolean payload changes nothing.
      if (this.window && event.sender === this.window.webContents) {
        const dirty = parseDirtyFlag(payload);
        if (dirty !== undefined) this.dirty = dirty;
      }
    });
    ipcMain.on("settings:reminder-dirty", (event, payload: unknown) => {
      if (this.window && event.sender === this.window.webContents && typeof payload === "number" &&
          Number.isSafeInteger(payload) && payload >= 0) this.reminderDirtyCount = payload;
    });
  }

  /** Opens the window, or brings the one that is already open to the front. */
  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    this.ready = false;
    this.dirty = false;
    this.reminderDirtyCount = 0;
    this.closeConfirmed = false;
    this.loading = new Promise((resolveLoading) => { this.finishLoading = resolveLoading; });
    const window = new BrowserWindow({
      width: 780,
      height: 680,
      minWidth: 560,
      minHeight: 420,
      title: "DeskPet 설정",
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: this.options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.window = window;
    window.removeMenu();
    const contents = window.webContents;
    // The page is local and static: it never navigates and never opens windows.
    contents.on("will-navigate", (event) => { event.preventDefault(); });
    contents.on("will-redirect", (event) => { event.preventDefault(); });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => { window.show(); });
    contents.on("did-fail-load", (_event, code, description) => { console.error("Settings load:", code, description); this.finishLoading?.(); });
    contents.on("render-process-gone", () => { this.finishLoading?.(); });
    // Closing with unsaved changes asks first; a clean form closes at once.
    window.on("close", (event) => {
      if (!this.dirty || this.closeConfirmed) return;
      event.preventDefault();
      void (async () => {
        if (await this.confirmClose(window)) { this.closeConfirmed = true; window.close(); }
      })();
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined; this.ready = false; this.dirty = false; this.closeConfirmed = false;
        this.sheetFileAnswerForTest = undefined;
      }
      this.finishLoading?.();
    });
    void window.loadFile(this.options.page);
  }

  /** Resolves once the open window has loaded and drawn its first view (or closed before that). */
  settled(): Promise<void> { return this.loading; }

  /** The do-not-disturb switch changed elsewhere (the tray); the open window follows. */
  notifyGeneralChanged(general: GeneralSettings): void {
    if (this.window && !this.window.isDestroyed() && this.ready) this.window.webContents.send("settings:general-changed", general);
  }

  state(): { open: boolean; ready: boolean; loading: boolean; title: string | null; visible: boolean; focused: boolean; dirty: boolean } {
    const window = this.window && !this.window.isDestroyed() ? this.window : undefined;
    return { open: window !== undefined, ready: this.ready, loading: window !== undefined && !this.ready,
      title: window?.getTitle() ?? null, visible: window?.isVisible() ?? false, focused: window?.isFocused() ?? false,
      dirty: this.dirty };
  }

  /** Dev control: answer the close confirmation without a real dialog (close = confirm, edit = keep editing). */
  setCloseAnswerForTest(answer: "close" | "edit" | undefined): void { this.closeAnswerForTest = answer; }
  setConfirmAnswerForTest(answer: boolean | undefined): void { this.confirmAnswerForTest = answer; }
  setSheetFileAnswerForTest(path: string | undefined): void { this.sheetFileAnswerForTest = path; }

  async chooseSheetFile(): Promise<string | undefined> {
    if (!this.window || this.window.isDestroyed()) throw new Error("Settings window is not open");
    if (this.options.sheetFileTestMode) {
      const answer = this.sheetFileAnswerForTest;
      this.sheetFileAnswerForTest = undefined;
      if (answer === undefined) { this.options.onUnexpectedDialog("sheet file open"); return undefined; }
      return answer;
    }
    const result = await dialog.showOpenDialog(this.window, { properties: ["openFile"],
      filters: [{ name: "PNG", extensions: ["png"] }] });
    return result.canceled ? undefined : result.filePaths[0];
  }

  private async confirmClose(window: BrowserWindow): Promise<boolean> {
    if (this.closeAnswerForTest !== undefined) return this.closeAnswerForTest === "close";
    if (this.options.devControlActive) { this.options.onUnexpectedDialog("settings close"); return false; }
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: "DeskPet 설정",
      message: this.reminderDirtyCount > 0 ? `저장하지 않은 알림 ${this.reminderDirtyCount}개가 있어요. 닫을까요?` : "저장하지 않은 변경이 있어요. 닫을까요?",
      buttons: ["닫기", "계속 편집"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  }

  /** Dev control: click the first element matching the selector, as the user's click would. */
  async click(selector: string): Promise<boolean> {
    return await this.run(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`) === true;
  }

  /** Dev control: type into (or check) the first matching input the way the user would, firing the page's own handlers. */
  async setValue(selector: string, value: string | boolean): Promise<boolean> {
    return await this.run(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      if (typeof ${JSON.stringify(value)} === "boolean") { element.checked = ${JSON.stringify(value)}; element.dispatchEvent(new Event("change", { bubbles: true })); }
      else { element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }
      return true;
    })()`) === true;
  }

  /** Dev control: what every matching element shows. */
  async query(selector: string): Promise<unknown> {
    return this.run(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), (element) => ({
      text: element.textContent ?? "", value: "value" in element ? element.value : null,
      checked: "checked" in element ? element.checked : null, disabled: "disabled" in element ? element.disabled : null,
      width: element instanceof HTMLElement ? element.offsetWidth : null,
      height: element instanceof HTMLElement ? element.offsetHeight : null }))`);
  }

  /** Dev control: everything the page displays or holds in inputs, for checks that something is absent. */
  async dump(): Promise<unknown> {
    return this.run(`({ html: document.documentElement.outerHTML,
      values: Array.from(document.querySelectorAll("input, select, textarea"), (element) => element.value) })`);
  }

  /** Dev control: call the window's exposed pack API and wait for its result. */
  async invokePack(method: "packsList" | "packSelect" | "packDelete" | "packSaveVoice" |
    "packSaveInteractions" | "sequencesLoad" | "sequencesSave" | "reactionsLoad" | "reactionsSave" | "motionsLoad" | "motionsSave" | "packSaveMeta" | "packVoiceLoad" | "behaviorSave" | "saveDeveloperMode" |
    "terrainLoad" | "terrainSave" | "sheetPick" | "sheetApply", payload?: unknown): Promise<unknown> {
    return this.run(`window.settings[${JSON.stringify(method)}](${JSON.stringify(payload ?? null)})`);
  }

  /** Dev control: close the window as the title bar's close button does. */
  close(): void {
    if (!this.window || this.window.isDestroyed()) throw new Error("Settings window is not open");
    this.window.close();
  }

  destroy(): void {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners("settings:confirm");
    ipcMain.removeAllListeners("settings:ready");
    ipcMain.removeAllListeners("settings:dirty");
    ipcMain.removeAllListeners("settings:reminder-dirty");
    this.finishLoading?.();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
    this.sheetFileAnswerForTest = undefined;
  }

  private async run(script: string): Promise<unknown> {
    await this.loading;
    if (!this.window || this.window.isDestroyed() || !this.ready) throw new Error("Settings window is not open");
    return await this.window.webContents.executeJavaScript(script) as unknown;
  }
}
