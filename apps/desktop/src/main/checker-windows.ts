import { BrowserWindow, net, session } from "electron";
import { allowedNetworkUrl, SessionError, type SessionHost } from "@deskpet/plugin-host";

type WindowPort = NonNullable<SessionHost["windows"]>;
type WindowEntry = { window: BrowserWindow; generation: number; home: URL; hosts: readonly string[];
  pluginId: string; id: string; aborts: Set<AbortController>; pending: number; gone: boolean;
  navigationBlocks: number; popupBlocks: number };

const MAX_BODY_BYTES = 1024 * 1024;
// Windows/Electron 44.5.1 prototype observed 20,105 ms maximum for a 20 s abort.
const FETCH_TIMEOUT_MS = 20_000;

export class CheckerWindows implements WindowPort {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly partitions = new Set<string>();
  private readonly partitionHosts = new Map<string, readonly string[]>();

  constructor(private readonly logger: Pick<Console, "info" | "warn">) {}

  private key(pluginId: string, id: string): string { return `${pluginId}\u0000${id}`; }

  private current(pluginId: string, id: string, generation: number): WindowEntry {
    const entry = this.entries.get(this.key(pluginId, id));
    if (!entry || entry.generation !== generation) throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
    if (entry.gone || entry.window.isDestroyed()) throw new SessionError("E_UNAVAILABLE", "창이 종료되었습니다");
    return entry;
  }

  private hostname(input: string): string {
    try { return new URL(input).hostname; }
    catch { return "invalid"; }
  }

  private block(entry: WindowEntry, input: string): boolean {
    if (allowedNetworkUrl(input, entry.hosts)) return false;
    entry.navigationBlocks++;
    this.logger.warn(`[window] ${entry.pluginId}/${entry.id} navigation blocked host=${this.hostname(input)}`);
    return true;
  }

  create(pluginId: string, id: string, generation: number, opts: Parameters<WindowPort["create"]>[3],
    onGone: () => void, approved: Parameters<WindowPort["create"]>[5]): void {
    const hosts = [...approved.hosts];
    const home = allowedNetworkUrl(opts.url, hosts);
    if (!approved.windows.includes(id) || !home)
      throw new SessionError("E_PERMISSION", "허용되지 않은 창 또는 주소입니다");
    if (this.entries.has(this.key(pluginId, id))) throw new SessionError("E_INVALID_ARGUMENT", "이미 열린 창입니다");
    if (this.entries.size >= 4) throw new SessionError("E_RATE_LIMIT", "창 개수를 초과했습니다");
    const partition = `persist:deskpet-plugin-${pluginId}`;
    const browserSession = session.fromPartition(partition);
    this.partitionHosts.set(partition, hosts);
    if (!this.partitions.has(partition)) {
      this.partitions.add(partition);
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.setDevicePermissionHandler(() => false);
      browserSession.on("will-download", (event) => { try { event.preventDefault(); } catch { /* Download denied. */ } });
      browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        try {
          if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") { callback({ cancel: false }); return; }
          // The partition belongs to one plugin; read the latest approved hosts on every request.
          callback({ cancel: allowedNetworkUrl(details.url, this.partitionHosts.get(partition) ?? []) === null });
        } catch { callback({ cancel: true }); }
      });
    }
    const window = new BrowserWindow({ width: opts.width ?? 480, height: opts.height ?? 720,
      show: false, skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, experimentalFeatures: false,
        enableBlinkFeatures: "", devTools: false, spellcheck: false, partition } });
    window.setMenuBarVisibility(false);
    window.webContents.setAudioMuted(true);
    const entry: WindowEntry = { window, generation, home, hosts, pluginId, id,
      aborts: new Set(), pending: 0, gone: false, navigationBlocks: 0, popupBlocks: 0 };
    this.entries.set(this.key(pluginId, id), entry);
    const title = (opts.title ?? approved.name).slice(0, 80);
    const updateTitle = (input: string): void => {
      if (!window.isDestroyed()) window.setTitle(`[${approved.name}] ${title} — ${this.hostname(input)}`);
    };
    updateTitle(home.href);
    window.on("close", (event) => { try { event.preventDefault(); window.hide(); } catch { /* Closing during shutdown. */ } });
    window.on("closed", () => { try { this.remove(entry); } catch { /* Window already closed. */ } });
    const wc = window.webContents;
    wc.on("page-title-updated", (event) => { try { event.preventDefault(); updateTitle(wc.getURL() || home.href); } catch { /* Page title ignored. */ } });
    const denyNavigation = (event: { preventDefault(): void; url: string }): void => {
      try { if (this.block(entry, event.url)) event.preventDefault(); }
      catch { event.preventDefault(); }
    };
    wc.on("will-navigate", denyNavigation);
    wc.on("will-frame-navigate", denyNavigation);
    wc.on("will-redirect", denyNavigation);
    wc.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      try {
        if (!isMainFrame) return;
        if (this.block(entry, url)) {
          setImmediate(() => {
            try {
              if (entry.gone || window.isDestroyed()) return;
              wc.stop();
              void wc.loadURL(home.href).catch(() => {});
            } catch { /* Navigation recovery is best effort. */ }
          });
        } else updateTitle(url);
      } catch { /* Navigation recovery is best effort. */ }
    });
    wc.setWindowOpenHandler((details) => {
      entry.popupBlocks++;
      try { this.logger.info(`[window] ${pluginId}/${id} popup denied host=${this.hostname(details.url)}`); }
      catch { /* Popup remains denied. */ }
      return { action: "deny" };
    });
    wc.on("render-process-gone", () => {
      try { entry.gone = true; for (const abort of entry.aborts) abort.abort(); onGone(); }
      catch { /* Renderer failure must not stop main. */ }
      finally { try { this.remove(entry); } catch { /* Renderer failure must not stop main. */ } }
    });
    wc.on("unresponsive", () => { try { this.logger.warn(`[window] ${pluginId}/${id} unresponsive`); } catch { /* Ignore logger failure. */ } });
    // Main-initiated loads do not consistently emit navigation guards in Electron 44.
    if (!allowedNetworkUrl(home.href, hosts)) { this.remove(entry); throw new SessionError("E_PERMISSION", "허용되지 않은 주소입니다"); }
    void wc.loadURL(home.href).catch(() => {
      this.logger.warn(`[window] ${pluginId}/${id} load error=E_UNAVAILABLE host=${home.hostname}`);
    });
    if (opts.show) { window.show(); window.focus(); }
  }

  show(pluginId: string, id: string, generation: number): void {
    const window = this.current(pluginId, id, generation).window;
    if (!window.isVisible()) window.show();
    window.focus();
  }

  hide(pluginId: string, id: string, generation: number): void {
    const window = this.current(pluginId, id, generation).window;
    if (window.isVisible()) window.hide();
  }

  private requestJson(entry: WindowEntry, url: URL, signal: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = net.request({ url: url.href, method: "GET", session: entry.window.webContents.session,
        redirect: "manual", useSessionCookies: true });
      request.setHeader("Accept", "application/json");
      let settled = false;
      const finish = (result: Response | Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const onAbort = (): void => { request.abort(); finish(new Error("Request aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      // Electron cancels manual redirects before emitting a response; retain their status without following.
      request.on("redirect", (status) => finish(new Response(null, { status })));
      request.on("response", (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BODY_BYTES) { request.abort(); finish(new SessionError("E_INVALID_ARGUMENT", "창 응답이 너무 큽니다")); }
          else chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (settled) return;
          const contentType = incoming.headers["content-type"];
          const body = [204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks);
          finish(new Response(body, { status: incoming.statusCode,
            headers: { "Content-Type": typeof contentType === "string" ? contentType : contentType?.[0] ?? "" } }));
        });
        incoming.on("error", (error) => finish(error));
      });
      request.on("error", (error) => finish(error));
      request.end();
    });
  }

  async getJson(pluginId: string, id: string, generation: number, path: string, signal: AbortSignal): Promise<Response> {
    const entry = this.current(pluginId, id, generation);
    if (entry.pending >= 2) throw new SessionError("E_RATE_LIMIT", "창 요청이 너무 많습니다");
    if (path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") ||
        [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      throw new SessionError("E_INVALID_ARGUMENT", "창 경로가 올바르지 않습니다");
    const url = new URL(path, entry.home.origin);
    if (url.origin !== entry.home.origin || !allowedNetworkUrl(url.href, entry.hosts))
      throw new SessionError("E_PERMISSION", "허용되지 않은 창 경로입니다");
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    entry.aborts.add(abort);
    entry.pending++;
    const timeout = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.requestJson(entry, url, abort.signal);
      if (entry.gone) throw new SessionError("E_UNAVAILABLE", "창이 종료되었습니다");
      if (this.entries.get(this.key(pluginId, id)) !== entry) throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); return response; }
      const reader = response.body?.getReader();
      if (!reader) return response;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BODY_BYTES) throw new SessionError("E_INVALID_ARGUMENT", "창 응답이 너무 큽니다");
          chunks.push(next.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      if (entry.gone) throw new SessionError("E_UNAVAILABLE", "창이 종료되었습니다");
      if (this.entries.get(this.key(pluginId, id)) !== entry) throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(body, { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type") ?? "" } });
    } catch (error) {
      if (entry.gone) throw new SessionError("E_UNAVAILABLE", "창이 종료되었습니다");
      if (this.entries.get(this.key(pluginId, id)) !== entry) throw new SessionError("E_DISPOSED", "창이 닫혔습니다");
      if (error instanceof SessionError) throw error;
      throw new SessionError(abort.signal.aborted ? "E_TIMEOUT" : "E_UNAVAILABLE", "창 요청을 처리할 수 없습니다");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      entry.aborts.delete(abort);
      entry.pending--;
    }
  }

  dispose(pluginId: string, id: string, generation: number): void {
    const entry = this.entries.get(this.key(pluginId, id));
    if (entry?.generation === generation) this.remove(entry);
  }

  destroyAll(): void { for (const entry of [...this.entries.values()]) this.remove(entry); }

  async flushStores(): Promise<void> {
    await Promise.all([...this.partitions].map((partition) => session.fromPartition(partition).cookies.flushStore()));
  }

  /** Dev control uses this to observe the same windows a person would see. */
  snapshotForTest(): Array<{ pluginId: string; id: string; url: string; visible: boolean; title: string;
    partition: string; navigationBlocks: number; popupBlocks: number }> {
    return [...this.entries.values()].map(({ pluginId, id, window, navigationBlocks, popupBlocks }) => ({ pluginId, id,
      url: window.webContents.getURL(), visible: window.isVisible(), title: window.getTitle(),
      partition: `persist:deskpet-plugin-${pluginId}`, navigationBlocks, popupBlocks }));
  }

  async executeForTest(pluginId: string, id: string, code: string): Promise<unknown> {
    const entry = this.entries.get(this.key(pluginId, id));
    if (!entry) throw new Error("Window is unavailable");
    if (entry.window.isDestroyed()) throw new Error("Window is unavailable");
    return entry.window.webContents.executeJavaScript(code);
  }

  crashForTest(pluginId: string, id: string): void {
    const entry = this.entries.get(this.key(pluginId, id));
    if (!entry) throw new Error("Window is unavailable");
    entry.window.webContents.forcefullyCrashRenderer();
  }

  closeForTest(pluginId: string, id: string): void {
    const entry = this.entries.get(this.key(pluginId, id));
    if (!entry) throw new Error("Window is unavailable");
    entry.window.close();
  }

  private remove(entry: WindowEntry): void {
    if (this.entries.get(this.key(entry.pluginId, entry.id)) !== entry) return;
    this.entries.delete(this.key(entry.pluginId, entry.id));
    for (const abort of entry.aborts) abort.abort();
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }
}
