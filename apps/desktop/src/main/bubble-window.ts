import { BrowserWindow, ipcMain } from "electron";
import type { LineParts, PetEvent } from "@deskpet/core";
import { placeBubble, type BubbleSide } from "./bubble-position.js";
import { displayForPoint, type DisplayArea, type Point, type Rectangle } from "./position.js";
import type { BubbleDisplay } from "./settings.js";

export interface BubbleContent { sequence: number; text: string; detail?: string; fullText?: string; parts?: LineParts;
  priority: string; actions?: PetEvent["actions"] }
/** Where the pet is; undefined while the pet is hidden or not ready, which hides the bubble too. */
export type BubbleAnchor = { content: Rectangle; foot: Point; displays: readonly DisplayArea[] };
type Size = { width: number; height: number };

/** The speech bubble: a separate small window that follows the pet and never takes focus. */
export class BubbleWindow {
  private readonly window: BrowserWindow;
  private ready = false;
  private content: BubbleContent | undefined;
  private version = 0;
  /** What the renderer has laid out: the content version it shows and how. */
  private rendered: { version: number; size: Size; side: BubbleSide; tailX: number } | undefined;
  private work: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly waiters = new Map<number, (size: Size | undefined) => void>();
  private ignoreMouseEvents = true;
  private actionInFlight = false;

  constructor(private readonly options: { preload: string; page: string; anchor: () => BubbleAnchor | undefined;
    display: () => BubbleDisplay;
    onDismiss: () => void; onAction: (index: number) => Promise<void>;
    onExpanded: (sequence: number, expanded: boolean) => void }) {
    this.window = new BrowserWindow({
      width: options.display().maxWidthDip,
      height: 80,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    const contents = this.window.webContents;
    const gone = (): void => {
      this.ready = false;
      this.rendered = undefined;
      for (const resolveSize of this.waiters.values()) resolveSize(undefined);
      this.waiters.clear();
      this.hide();
    };
    contents.on("render-process-gone", gone);
    contents.on("did-fail-load", (_event, code, description) => { console.error("Bubble load:", code, description); gone(); });
    ipcMain.on("bubble:ready", (event) => {
      if (event.sender !== contents || this.ready) return;
      this.ready = true;
      this.refresh();
    });
    ipcMain.on("bubble:rendered", (event, payload: unknown) => {
      if (event.sender !== contents || typeof payload !== "object" || payload === null ||
          !("sequence" in payload) || typeof payload.sequence !== "number" ||
          !("width" in payload) || typeof payload.width !== "number" || !Number.isFinite(payload.width) ||
          !("height" in payload) || typeof payload.height !== "number" || !Number.isFinite(payload.height)) return;
      this.waiters.get(payload.sequence)?.({
        width: Math.max(1, Math.min(this.options.display().maxWidthDip, Math.ceil(payload.width))), height: Math.max(1, Math.ceil(payload.height)) });
      this.waiters.delete(payload.sequence);
    });
    ipcMain.handle("bubble:resized", async (event, payload: unknown) => {
      if (event.sender !== contents || !this.window.isVisible() || typeof payload !== "object" || payload === null ||
          !("sequence" in payload) || payload.sequence !== this.sequence ||
          !("width" in payload) || typeof payload.width !== "number" || !Number.isFinite(payload.width) ||
          !("height" in payload) || typeof payload.height !== "number" || !Number.isFinite(payload.height) ||
          !("expanded" in payload) || typeof payload.expanded !== "boolean" ||
          this.rendered?.version !== this.version) return;
      const anchor = this.options.anchor();
      if (!anchor || !this.rendered) return;
      this.rendered.size = { width: Math.max(1, Math.min(this.options.display().maxWidthDip, Math.ceil(payload.width))),
        height: Math.max(1, Math.ceil(payload.height)) };
      this.place(anchor);
      if (this.content) this.options.onExpanded(this.content.sequence, payload.expanded);
      await this.settled();
    });
    ipcMain.on("bubble:set-mouse-pass-through", (event, ignore: unknown) => {
      if (event.sender === contents && typeof ignore === "boolean" && this.window.isVisible()) this.setMousePassThrough(ignore);
    });
    ipcMain.on("bubble:dismiss", (event) => {
      if (event.sender === contents && this.window.isVisible()) options.onDismiss();
    });
    ipcMain.on("bubble:action", (event, index: unknown) => {
      if (event.sender !== contents || !this.window.isVisible() || this.actionInFlight || !Number.isInteger(index) ||
          typeof index !== "number" || index < 0 || index >= (this.content?.actions?.length ?? 0)) return;
      this.actionInFlight = true;
      void options.onAction(index).catch((error: unknown) => { console.error("Bubble action:", error); })
        .finally(() => { this.actionInFlight = false; });
    });
    void this.window.loadFile(options.page);
  }

  /** Show this content, replacing whatever is showing; undefined closes the bubble. */
  set(content: BubbleContent | undefined): void {
    this.content = content;
    this.version += 1;
    if (!content && this.ready && !this.window.isDestroyed()) this.window.webContents.send("bubble:clear");
    this.refresh();
  }

  /** The pet moved, changed size, or was shown or hidden: follow it. */
  refresh(): void {
    if (this.window.isDestroyed()) return;
    const anchor = this.content ? this.options.anchor() : undefined;
    if (!anchor) { this.hide(); return; }
    if (this.rendered?.version === this.version) this.place(anchor);
    else this.work = this.work.then(() => this.render()).catch((error: unknown) => { console.error("Bubble render:", error); });
  }

  /** Resolves once every requested change has reached the window. */
  async settled(): Promise<void> {
    for (let work: Promise<void> | undefined; work !== this.work;) { work = this.work; await work; }
  }

  async state(): Promise<unknown> {
    await this.settled();
    const visible = !this.window.isDestroyed() && this.window.isVisible();
    return {
      visible,
      text: this.content?.text ?? null,
      priority: this.content?.priority ?? null,
      bounds: visible ? this.window.getBounds() : null,
      side: visible ? this.rendered?.side ?? null : null,
      focusable: !this.window.isDestroyed() && this.window.isFocusable(),
      focused: !this.window.isDestroyed() && this.window.isFocused(),
      alwaysOnTop: !this.window.isDestroyed() && this.window.isAlwaysOnTop(),
      resizable: !this.window.isDestroyed() && this.window.isResizable(),
      ignoreMouseEvents: this.ignoreMouseEvents,
      renderer: this.ready ? await this.window.webContents.executeJavaScript("window.bubbleMetrics()") as unknown : null,
    };
  }

  async hitTest(x: number, y: number): Promise<boolean> {
    if (!this.ready) throw new Error("Bubble is not ready");
    return await this.window.webContents.executeJavaScript(`window.bubbleHitTest(${x}, ${y})`) === true;
  }

  /** Click the bubble in its renderer, exactly as a mouse click on the text would. */
  async click(): Promise<void> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    await this.window.webContents.executeJavaScript("document.querySelector('#tail').click()");
  }

  async clickText(): Promise<boolean> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    const expanded = await this.window.webContents.executeJavaScript("window.bubbleClickText()") === true;
    await this.settled();
    return expanded;
  }

  /** Send a real wheel event over the scrolling body, for e2e. */
  async wheel(deltaY: number): Promise<void> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    const point = await this.window.webContents.executeJavaScript(
      "(() => { const r = document.querySelector('#content').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()") as { x: number; y: number };
    this.window.webContents.sendInputEvent({ type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
    await new Promise((resolveWheel) => setTimeout(resolveWheel, 150));
  }

  async clickHint(): Promise<void> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    await this.window.webContents.executeJavaScript("window.bubbleClickHint()");
    await this.settled();
  }

  async clickClose(): Promise<void> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    await this.window.webContents.executeJavaScript("document.querySelector('#close').click()");
  }

  async containsRenderedText(value: string): Promise<boolean> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    return await this.window.webContents.executeJavaScript(`window.bubbleContainsText(${JSON.stringify(value)})`) === true;
  }

  /** Click a rendered action button through the same path as a user click. */
  async clickAction(index: number): Promise<void> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    await this.window.webContents.executeJavaScript(`document.querySelectorAll('#actions button')[${index}]?.click()`);
  }

  async capture(): Promise<Electron.NativeImage> {
    await this.settled();
    if (!this.ready || !this.window.isVisible()) throw new Error("Bubble is not showing");
    await this.window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    return this.window.webContents.capturePage();
  }

  destroy(): void {
    for (const resolveSize of this.waiters.values()) resolveSize(undefined);
    this.waiters.clear();
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private async render(): Promise<void> {
    const { content, version } = this;
    if (!this.ready || this.window.isDestroyed() || !content || this.rendered?.version === version) return;
    const anchor = this.options.anchor();
    if (!anchor) return;
    // Measure first: the size decides the side and where the tail points, which are then laid out.
    const measured = await this.send(content, "above", 0, anchor);
    if (!measured) return;
    const { side, tailX } = placeBubble(measured, anchor.content, anchor.foot, anchor.displays);
    const size = await this.send(content, side, tailX, anchor);
    // A newer request has its own render queued behind this one.
    if (!size || this.version !== version) return;
    this.rendered = { version, size, side, tailX };
    this.refresh();
  }

  private send(content: BubbleContent, side: BubbleSide, tailX: number, anchor: BubbleAnchor): Promise<Size | undefined> {
    const sequence = ++this.sequence;
    const display = this.options.display();
    const maxWidthDip = Math.min(display.maxWidthDip, Math.max(1, Math.floor(displayForPoint(anchor.foot, anchor.displays).workArea.width)));
    return new Promise((resolveSize) => {
      this.waiters.set(sequence, resolveSize);
      this.window.webContents.send("bubble:render", { sequence, version: this.version, text: content.text, detail: content.detail,
        fullText: content.fullText, parts: content.parts,
        labels: content.actions?.slice(0, 3).map(({ label }) => label) ?? [], side, tailX,
        maxWidthDip, maxHeightDip: displayForPoint(anchor.foot, anchor.displays).workArea.height,
        maxLines: display.maxLines });
    });
  }

  private place(anchor: BubbleAnchor): void {
    const { rendered, content } = this;
    if (!rendered || !content) return;
    const { bounds, side, tailX } = placeBubble(rendered.size, anchor.content, anchor.foot, anchor.displays);
    if (side !== rendered.side || tailX !== rendered.tailX) {
      rendered.side = side;
      rendered.tailX = tailX;
      const laidOut = this.send(content, side, tailX, anchor);
      this.work = this.work.then(async () => { await laidOut; });
    }
    const current = this.window.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
      this.window.setBounds(bounds, false);
    }
    if (!this.window.isVisible()) {
      this.window.showInactive();
      this.window.setAlwaysOnTop(true, "screen-saver");
    }
  }

  private hide(): void {
    if (this.window.isDestroyed()) return;
    this.setMousePassThrough(true);
    if (this.window.isVisible()) this.window.hide();
  }

  private setMousePassThrough(ignore: boolean): void {
    if (this.ignoreMouseEvents === ignore) return;
    this.window.setIgnoreMouseEvents(ignore, { forward: true });
    this.ignoreMouseEvents = ignore;
  }
}
