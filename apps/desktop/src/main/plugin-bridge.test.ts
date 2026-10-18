import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "./actions.js";
import { maskPluginLog } from "./log-mask.js";
import { createPluginBridge, type PluginBridgeDeps } from "./plugin-bridge.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "deskpet-bridge-"));
  directories.push(userDataDir);
  const actions = new ActionRegistry();
  const receivePetEvent = vi.fn();
  const invokeAction = vi.fn(async () => ({ ok: true }));
  const addTrayItem = vi.fn<PluginBridgeDeps["addTrayItem"]>(() => vi.fn());
  const addReactionRule = vi.fn<PluginBridgeDeps["addReactionRule"]>(() => vi.fn());
  const openExternal = vi.fn();
  const fetch = vi.fn(async () => new Response("ok"));
  const execFile = vi.fn<PluginBridgeDeps["execFile"]>((_command, _args, _options, callback) => {
    callback(null, "done", "");
  });
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8").slice("encrypted:".length)),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: PluginBridgeDeps = {
    receivePetEvent, actions, invokeAction, addTrayItem, addReactionRule, openExternal,
    fetch, execFile, safeStorage, logger, userDataDir,
    env: { Path: "safe-path", SystemRoot: "windows", HOME: "do-not-pass", SECRET: "hidden" },
  };
  return { bridge: createPluginBridge(deps), deps, actions, receivePetEvent, invokeAction,
    addTrayItem, addReactionRule, openExternal, fetch, execFile, safeStorage, logger, userDataDir };
}

describe("createPluginBridge", () => {
  it("routes events, actions, tray items, reaction rules and badges through injected hooks", async () => {
    const { bridge, actions, receivePetEvent, invokeAction, addTrayItem, addReactionRule } = await setup();
    const event = { source: "weather", type: "react", mood: "happy" } as const;
    await bridge.emit(event);
    expect(receivePetEvent).toHaveBeenCalledWith(event);

    const disposeAction = bridge.register("weather", "action", 1, { id: "weather.open" });
    expect(await actions.invoke("weather.open", { x: 1 })).toEqual({ ok: true });
    expect(invokeAction).toHaveBeenCalledWith("weather", "weather.open", { x: 1 });
    expect(() => bridge.register("weather", "action", 2, { id: "other.open" })).toThrow();
    if (typeof disposeAction === "function") disposeAction();
    expect(await actions.invoke("weather.open")).toEqual({ ok: false, reason: "not-found" });

    const disposeTray = bridge.register("weather", "trayItem", 3,
      { id: "weather.item", label: "날씨", action: "weather.open" });
    expect(addTrayItem).toHaveBeenCalledWith("weather",
      { id: "weather.item", label: "날씨", action: "weather.open" }, expect.any(Function));
    addTrayItem.mock.calls[0]?.[2]();
    expect(invokeAction).toHaveBeenCalledWith("weather", "weather.open");
    if (typeof disposeTray === "function") disposeTray();
    expect(addTrayItem.mock.results[0]?.value).toHaveBeenCalledOnce();

    const rule = { match: { mood: "happy" }, play: "happy" } as const;
    const disposeRule = bridge.register("weather", "reactionRule", 4, rule);
    expect(addReactionRule).toHaveBeenCalledWith("weather", rule);
    if (typeof disposeRule === "function") disposeRule();
    expect(addReactionRule.mock.results[0]?.value).toHaveBeenCalledOnce();

    bridge.setBadge("weather", "status", { text: "1" });
    expect(bridge.badges.get("weather:status")).toEqual({ text: "1" });
    bridge.setBadge("weather", "status", null);
    expect(bridge.badges.has("weather:status")).toBe(false);
  });

  it("uses injected fetch and shell with credentials omitted", async () => {
    const { bridge, fetch, openExternal } = await setup();
    const init: RequestInit = { method: "GET", credentials: "include", redirect: "manual" };
    await bridge.fetch("https://example.com/a", init);
    expect(fetch).toHaveBeenCalledWith("https://example.com/a",
      { method: "GET", credentials: "omit", redirect: "manual" });
    await bridge.openExternal("https://example.com/a");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
  });

  it("executes without a shell and enforces command limits", async () => {
    const { bridge, execFile, deps } = await setup();
    expect(await bridge.exec("node.exe", ["--version"])).toEqual({ stdout: "done", code: 0 });
    expect(execFile).toHaveBeenCalledWith("node.exe", ["--version"], {
      timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      env: { PATH: "safe-path", SystemRoot: "windows" },
    }, expect.any(Function));
    await expect(bridge.exec("TASK.CMD", [])).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    await expect(bridge.exec("task.bat", [])).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    expect(execFile).toHaveBeenCalledOnce();
    expect(await bridge.exec("task.cmd.exe", [])).toEqual({ stdout: "done", code: 0 });

    const timeout = Object.assign(new Error("timeout"), { killed: true });
    deps.execFile = (_command, _args, _options, callback) => callback(timeout, "", "");
    await expect(bridge.exec("node.exe", [])).rejects.toMatchObject({ code: "E_TIMEOUT" });
    deps.execFile = (_command, _args, _options, callback) => callback(null, "x".repeat(1024 * 1024 + 1), "");
    await expect(bridge.exec("node.exe", [])).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    deps.execFile = (_command, _args, _options, callback) => callback(null, "x".repeat(1024 * 1024), "y");
    await expect(bridge.exec("node.exe", [])).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    deps.execFile = (_command, _args, _options, callback) =>
      callback(Object.assign(new Error("exit 7"), { code: 7 }), "partial", "");
    expect(await bridge.exec("node.exe", [])).toEqual({ stdout: "partial", code: 7 });
  });

  it("encrypts secrets and masks values separately for each plugin", async () => {
    const { bridge, userDataDir, logger } = await setup();
    await bridge.secrets.set("weather", "api_key", "topsecret123");
    const stored = await readFile(path.join(userDataDir, "plugin-secrets.json"), "utf8");
    expect(stored).not.toContain("topsecret123");
    expect(await bridge.secrets.get("weather", "api_key")).toBe("topsecret123");
    bridge.log("info", "value=topsecret123", "weather");
    expect(logger.info).toHaveBeenCalledWith("[plugin:weather] value=***");
    expect(bridge.formatPluginOutput("other", "topsecret123")).toBe("[plugin:other] topsecret123");
    expect(bridge.formatPluginOutput("weather", "topsecret123")).toBe("[plugin:weather] ***");
    expect(bridge.maskPluginText("weather", "topsecret123")).toBe("***");
    expect(bridge.maskPluginText("other", "topsecret123")).toBe("topsecret123");
  });

  it("rejects plaintext fallback when safeStorage is unavailable", async () => {
    const { bridge, safeStorage, userDataDir } = await setup();
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(bridge.secrets.set("weather", "api_key", "topsecret123"))
      .rejects.toMatchObject({ code: "E_UNAVAILABLE" });
    await expect(readFile(path.join(userDataDir, "plugin-secrets.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("maskPluginLog", () => {
  it("masks headers, bearer values and sensitive query values while retaining other fields", () => {
    expect(maskPluginLog("Authorization: Bearer abc\nCookie: x=1\r\nSet-Cookie: y=2", new Set()))
      .toBe("Authorization: ***\\nCookie: ***\\nSet-Cookie: ***");
    expect(maskPluginLog("Bearer abc https://x.test/?token=a&key=b&secret=c&password=d&code=e&name=f", new Set()))
      .toBe("Bearer *** https://x.test/?token=***&key=***&secret=***&password=***&code=***&name=f");
    expect(maskPluginLog("not-a-header Authorization: value", new Set())).toBe("not-a-header Authorization: value");
    expect(maskPluginLog("AUTHORIZATION: abc\nhttps://x.test/?TOKEN=x&codex=y", new Set()))
      .toBe("AUTHORIZATION: ***\\nhttps://x.test/?TOKEN=***&codex=y");
  });

  it("honors six-character secret and 2 KiB line boundaries", () => {
    expect(maskPluginLog("short5 longsecret", new Set(["short5", "longsecret"]))).toBe("*** ***");
    expect(maskPluginLog("short", new Set(["short"]))).toBe("short");
    expect(maskPluginLog("before long\nsecret after", new Set(["long\nsecret"]))).toBe("before *** after");
    expect(Buffer.byteLength(maskPluginLog("가".repeat(1000), new Set()), "utf8")).toBeLessThanOrEqual(2048);
    expect(maskPluginLog("x".repeat(2048), new Set())).toHaveLength(2048);
    expect(maskPluginLog("x".repeat(2049), new Set())).toHaveLength(2048);
  });

  it("counts the plugin prefix inside the 2 KiB output limit", async () => {
    const { bridge } = await setup();
    expect(Buffer.byteLength(bridge.formatPluginOutput("weather", "x".repeat(3000)), "utf8")).toBe(2048);
  });

  it("lets the settings window store, detect and delete a secret in the plugin's own namespace", async () => {
    const { bridge, userDataDir } = await setup();
    await bridge.secrets.set("weather", "token", "super-secret-value");
    expect(await bridge.hasSecret("weather", "token")).toBe(true);
    expect(await bridge.hasSecret("other", "token")).toBe(false);
    expect(await bridge.secrets.get("weather", "token")).toBe("super-secret-value");
    expect(await readFile(path.join(userDataDir, "plugin-secrets.json"), "utf8")).not.toContain("super-secret-value");
    await bridge.deleteSecret("weather", "token");
    expect(await bridge.hasSecret("weather", "token")).toBe(false);
    expect(await bridge.secrets.get("weather", "token")).toBeNull();
  });
});
