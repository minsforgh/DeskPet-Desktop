import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";

const results = {};
const requests = [];
const servers = [];
const dataDir = await mkdtemp(join(tmpdir(), "checker-prototype-"));
app.setPath("userData", dataDir);
app.commandLine.appendSwitch("disable-background-networking");

async function serve(name) {
  const server = createServer((request, response) => {
    requests.push({ server: name, path: request.url, cookie: request.headers.cookie ?? null });
    if (request.url === "/home") {
      if (name === "A") response.setHeader("Set-Cookie", "probe=session-a; Path=/; SameSite=Lax");
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Probe</title><input type=password autocomplete=current-password><a id=link href=/page>link</a><a id=blank target=_blank href=/page>blank</a><iframe id=frame src=/page></iframe>");
    } else if (request.url === "/redirect-b") {
      response.writeHead(302, { Location: originB + "/page" });
      response.end();
    } else if (request.url === "/redirect-a") {
      response.writeHead(302, { Location: originA + "/page" });
      response.end();
    } else if (request.url === "/large") {
      response.setHeader("Content-Type", "application/json");
      response.end("x".repeat(1024 * 1024 + 1));
    } else if (request.url === "/slow") {
      // This endpoint waits for the client's abort instead of using an uncontrolled timer.
      request.on("close", () => response.end());
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ server: name, cookie: request.headers.cookie ?? null }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function createWindow(partition) {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

async function settleNavigation() {
  // A blocked location navigation produced no will-navigate event over 30 s in the first run.
  // This 1 s observation window is for recording absent events, not an application deadline.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function get(windowSession, url, { limit = 1024 * 1024, timeout = 20_000 } = {}) {
  const controller = new globalThis.AbortController();
  // ADR-0006 sets 20 s / 1 MiB; local Windows/Electron 44.5.1 /slow aborts took at most 20,105 ms across full runs.
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await windowSession.fetch(url, { method: "GET", credentials: "include", signal: controller.signal });
    const reader = response.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { kind: "ok", status: response.status, size };
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { kind: "too-large", size };
      }
    }
  } catch (error) {
    return { kind: controller.signal.aborted ? "timeout" : "error", name: error.name };
  } finally {
    clearTimeout(timer);
  }
}

let originA;
let originB;
let window;
async function run() {
  try {
    await app.whenReady();
    originA = await serve("A");
    originB = await serve("B");
    results.electron = process.versions.electron;
    const partition = `persist:checker-probe-${process.pid}`;
    window = createWindow(partition);
    const wc = window.webContents;
    const events = [];
    let blockEvents = new Set(["will-navigate", "will-frame-navigate", "will-redirect"]);
    let preventAfterRedirect = false;
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect", "did-redirect-navigation"]) {
      wc.on(name, (event) => {
        const url = event.url;
        const entry = { name, target: url?.startsWith(originA) ? "A" : url?.startsWith(originB) ? "B" : url, main: event.isMainFrame ?? null, blocked: false };
        if (blockEvents.has(name) && !url?.startsWith(originA)) {
          event.preventDefault();
          entry.blocked = true;
        }
        if (preventAfterRedirect && name === "did-redirect-navigation") {
          event.preventDefault();
          entry.blocked = true;
        }
        events.push(entry);
      });
    }
    const popups = [];
    wc.setWindowOpenHandler((details) => {
      popups.push({ target: details.url.startsWith(originA) ? "A" : details.url.startsWith(originB) ? "B" : details.url, disposition: details.disposition, userGesture: details.userGesture ?? null });
      return { action: "deny" };
    });
    await wc.loadURL(originA + "/home");
    results.initial = { events: [...events], url: wc.getURL().startsWith(originA), hidden: !window.isVisible(), preferences: {
      sandbox: wc.getLastWebPreferences().sandbox,
      contextIsolation: wc.getLastWebPreferences().contextIsolation,
      nodeIntegration: wc.getLastWebPreferences().nodeIntegration,
      preload: wc.getLastWebPreferences().preload ?? null,
    }, cookieCount: (await wc.session.cookies.get({ url: originA })).length };
    events.length = 0;

    const linkEvent = once(wc, "will-navigate");
    await Promise.all([linkEvent, wc.executeJavaScript("document.querySelector('#link').click()")]);
    await once(wc, "did-finish-load");
    results.link = { events: [...events], url: wc.getURL().endsWith("/page") };
    await wc.loadURL(originA + "/home");
    events.length = 0;

    blockEvents = new Set(["will-navigate"]);
    await wc.executeJavaScript(`document.querySelector('#link').href = ${JSON.stringify(originB + "/page")}; document.querySelector('#link').click()`);
    await settleNavigation();
    results.willNavigateBlock = { events: [...events], stayed: wc.getURL() === originA + "/home" };
    events.length = 0;
    blockEvents = new Set(["will-frame-navigate", "will-redirect"]);

    await wc.executeJavaScript(`location.href = ${JSON.stringify(originB + "/page")}`);
    await settleNavigation();
    results.location = { events: [...events], stayed: wc.getURL() === originA + "/home" };
    events.length = 0;

    try { await wc.loadURL(originA + "/redirect-b"); } catch (error) { results.redirectLoadRejected = error.name; }
    results.redirectB = { events: [...events], reachedB: wc.getURL().startsWith(originB) };
    events.length = 0;
    preventAfterRedirect = true;
    await wc.loadURL(originA + "/redirect-a");
    preventAfterRedirect = false;
    results.redirectA = { events: [...events], reachedA: wc.getURL() === originA + "/page" };
    await wc.loadURL(originA + "/home");
    events.length = 0;

    await wc.executeJavaScript(`document.querySelector('#frame').src = ${JSON.stringify(originB + "/page")}`);
    await settleNavigation();
    results.iframe = { events: [...events], frameURL: wc.mainFrame.frames[0]?.url ?? null };
    events.length = 0;

    const popupEvent = new Promise((resolve) => wc.setWindowOpenHandler((details) => {
      popups.push({ target: details.url.startsWith(originA) ? "A" : details.url.startsWith(originB) ? "B" : details.url, disposition: details.disposition, userGesture: details.userGesture ?? null });
      resolve();
      return { action: "deny" };
    }));
    await Promise.all([popupEvent, wc.executeJavaScript(`window.open(${JSON.stringify(originB + "/page")})`)]);
    const targetEvent = new Promise((resolve) => wc.setWindowOpenHandler((details) => {
      popups.push({ target: details.url.startsWith(originA) ? "A" : details.url.startsWith(originB) ? "B" : details.url, disposition: details.disposition, userGesture: details.userGesture ?? null });
      resolve();
      return { action: "deny" };
    }));
    await Promise.all([targetEvent, wc.executeJavaScript("document.querySelector('#blank').click()")]);
    results.popups = { popups, events: [...events], count: BrowserWindow.getAllWindows().length };

    const active = wc.session;
    const isolated = session.fromPartition(`persist:checker-other-${process.pid}`);
    await get(active, originA + "/echo");
    await get(isolated, originA + "/echo");
    await get(active, originB + "/echo");
    results.cookies = requests.filter((request) => request.path === "/echo").map(({ server, cookie }) => ({ server, cookie }));
    const limitStarted = Date.now();
    const large = await get(active, originA + "/large");
    const aborted = await get(active, originA + "/slow");
    results.limits = { large, aborted, elapsedMs: Date.now() - limitStarted };

    // Direct loadURL is a main-process action; compare it with page-triggered navigation.
    events.length = 0;
    await wc.loadURL("about:blank");
    results.aboutBlank = { events: [...events], url: wc.getURL() };
    events.length = 0;
    await wc.loadURL("data:text/html,probe");
    results.data = { events: [...events], url: wc.getURL() };
    await wc.loadURL(originA + "/home");
    events.length = 0;
    const schemeRequests = [];
    const schemeStarts = [];
    wc.on("did-start-navigation", (event) => schemeStarts.push(event.url));
    active.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      schemeRequests.push({ url: details.url, type: details.resourceType });
      callback({ cancel: ["mainFrame", "subFrame"].includes(details.resourceType) && !details.url.startsWith(originA) });
    });
    blockEvents = new Set(["will-frame-navigate", "will-navigate"]);
    await wc.executeJavaScript("location.href = 'about:blank'");
    await settleNavigation();
    results.pageAboutBlank = { events: [...events], stayed: wc.getURL() === originA + "/home", requests: [...schemeRequests], starts: [...schemeStarts] };
    await wc.loadURL(originA + "/home");
    events.length = 0;
    schemeRequests.length = 0;
    schemeStarts.length = 0;
    await wc.executeJavaScript("location.href = 'data:text/html,probe'");
    await settleNavigation();
    results.pageData = { events: [...events], stayed: wc.getURL() === originA + "/home", requests: [...schemeRequests], starts: [...schemeStarts] };
    await wc.loadURL("about:blank");
    events.length = 0;
    schemeRequests.length = 0;
    schemeStarts.length = 0;
    await wc.executeJavaScript("location.href = 'data:text/html,probe'");
    await settleNavigation();
    results.blankToData = { events: [...events], landed: wc.getURL().startsWith("data:"), requests: [...schemeRequests], starts: [...schemeStarts] };

    const closed = once(window, "closed");
    window.close();
    await closed;
    results.close = { closed: true, mainAlive: app.isReady() };
    const crashWindow = createWindow(partition);
    await crashWindow.loadURL(originA + "/home");
    const gone = once(crashWindow.webContents, "render-process-gone");
    crashWindow.webContents.forcefullyCrashRenderer();
    const [, details] = await gone;
    results.crash = { reason: details.reason, mainAlive: app.isReady() };
    const crashClosed = once(crashWindow, "closed");
    crashWindow.destroy();
    await crashClosed;
  assert.equal(results.initial.hidden, true);
  assert.equal(results.initial.url, true);
  assert.deepEqual(results.initial.events.map(({ name }) => name), ["will-frame-navigate"]);
  assert.deepEqual(results.initial.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null });
  assert.equal(results.initial.cookieCount, 1);
  assert.deepEqual(results.link.events.map(({ name }) => name), ["will-frame-navigate", "will-navigate"]);
  assert.equal(results.willNavigateBlock.stayed, true);
  assert.equal(results.willNavigateBlock.events.find(({ name }) => name === "will-navigate")?.blocked, true);
  assert.equal(results.location.stayed, true);
  assert.equal(results.location.events[0]?.name, "will-frame-navigate");
  assert.equal(results.redirectB.reachedB, false);
  assert.equal(results.redirectB.events[0]?.name, "will-redirect");
  assert.equal(results.redirectA.reachedA, true);
  assert.deepEqual(results.redirectA.events.map(({ name }) => name), ["will-redirect", "did-redirect-navigation"]);
  assert.equal(results.iframe.events[0]?.main, false);
  assert.equal(results.iframe.frameURL.startsWith(originA), true);
  assert.equal(results.popups.count, 1);
  assert.equal(results.popups.popups.length, 2);
  assert.deepEqual(results.popups.popups.map(({ userGesture }) => userGesture), [null, null]);
  assert.deepEqual(results.cookies.map(({ cookie }) => cookie), ["probe=session-a", null, "probe=session-a"]);
  assert.equal(results.limits.large.kind, "too-large");
  assert.equal(results.limits.large.size, 1024 * 1024 + 1);
  assert.equal(results.limits.aborted.kind, "timeout");
  assert.deepEqual(results.aboutBlank, { events: [], url: "about:blank" });
  assert.deepEqual(results.data, { events: [], url: "data:text/html,probe" });
  assert.equal(results.pageAboutBlank.stayed, false);
  assert.deepEqual(results.pageAboutBlank.events, []);
  assert.deepEqual(results.pageAboutBlank.requests, []);
  assert.deepEqual(results.pageAboutBlank.starts, ["about:blank"]);
  assert.equal(results.pageData.stayed, true);
  assert.equal(results.blankToData.landed, false);
  assert.equal(results.close.mainAlive, true);
  assert.equal(results.crash.reason, "crashed");
  assert.equal(results.crash.mainAlive, true);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    app.quit();
    await rm(dataDir, { recursive: true, force: true });
  }
}

void run();
