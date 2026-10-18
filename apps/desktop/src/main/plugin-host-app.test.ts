import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@deskpet/plugin-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ActionRegistry } from "./actions.js";
import { createPluginHostApp, describePermissions, displayBadgeText, permissionDialogOptions, pluginStatusLine } from "./plugin-host-app.js";

test("badge display keeps readable characters and rejects control characters", () => {
  expect(displayBadgeText("확인\n 대기\u007f 1건")).toBe("확인 대기 1건");
  expect(displayBadgeText("ok\u0085done")).toBe("okdone");
});

test("plugin status line includes an active badge", () => {
  expect(pluginStatusLine({ id: "orca", name: "Orca", state: "running", consecutiveErrors: 0,
    badge: "확인 대기 1건" })).toBe("Orca: 실행 중 · 확인 대기 1건");
});

const manifest = (permissions: PluginManifest["permissions"]): PluginManifest => ({
  id: "weather", name: "Weather", version: "1.0.0", apiVersion: "1", entry: "index.js", description: "", permissions, contributes: {},
});

describe("describePermissions", () => {
  test("shows the separate Socket Mode approval line", () => {
    const permissions = { network: ["slack.com"], socketMode: ["slack.com"] };
    expect(describePermissions(permissions)).toEqual([
      "인터넷 접속: slack.com",
      "Slack 실시간 연결: slack.com에 연결 요청을 보내고 수신 확인을 자동으로 보냅니다",
    ]);
    expect(permissionDialogOptions(manifest(permissions)).detail).toContain(
      "Slack 실시간 연결: slack.com에 연결 요청을 보내고 수신 확인을 자동으로 보냅니다");
  });
  test("shows separate Orca approval lines in the dialog", () => {
    const permissions = { orcaRead: true, orcaGateResolve: true, orcaOpenTerminal: true };
    const lines = [
      "Orca 진행 상태 읽기: 이 컴퓨터의 Run, 작업, 게이트와 비소비 수신함을 조회합니다",
      "Orca 게이트 처리: 사용자가 선택한 버튼으로 게이트 답변을 보냅니다",
      "Orca 터미널 열기: 사용자가 누른 버튼으로 해당 터미널 탭으로 전환합니다",
    ];
    expect(describePermissions(permissions)).toEqual(lines);
    expect(permissionDialogOptions({ ...manifest(permissions), apiVersion: "2" }).detail)
      .toContain(lines.map((line) => `• ${line}`).join("\n"));
  });
  test("lists every permission as a Korean sentence, with shell first and stressed", () => {
    const lines = describePermissions({ network: ["a.com", "b.com"], openExternal: ["https://a.com/*"], windows: ["login"],
      secrets: true, shell: true });
    expect(lines).toEqual([
      "임의 명령 실행: 이 컴퓨터에서 어떤 프로그램이든 실행할 수 있습니다",
      "인터넷 접속: a.com, b.com",
      "브라우저로 링크 열기: https://a.com/*",
      "창 열기: login",
      "비밀 값(토큰, 비밀번호)을 저장하고 읽기",
    ]);
  });

  test("says nothing for permissions that are absent or false", () => {
    expect(describePermissions({})).toEqual([]);
    expect(describePermissions({ network: [], secrets: false, shell: false })).toEqual([]);
  });
});

describe("permissionDialogOptions", () => {
  test("offers 허용 and 허용 안 함 with 허용 안 함 as the default and the escape answer", () => {
    const options = permissionDialogOptions(manifest({ network: ["a.com"] }));
    expect(options).toMatchObject({ type: "question", buttons: ["허용", "허용 안 함"], defaultId: 1, cancelId: 1, noLink: true });
    expect(options.message).toContain('"Weather"');
    expect(options.detail).toContain("• 인터넷 접속: a.com");
  });

  test("uses the warning style when the plugin can run commands", () => {
    const options = permissionDialogOptions(manifest({ shell: true }));
    expect(options.type).toBe("warning");
    expect(options.detail).toContain("• 임의 명령 실행");
  });
});

describe("pluginStatusLine", () => {
  test("shows the name, the state, and the reason only for invalid and disabled plugins", () => {
    expect(pluginStatusLine({ id: "w", name: "Weather", state: "running", consecutiveErrors: 0 })).toBe("Weather: 실행 중");
    expect(pluginStatusLine({ id: "w", state: "invalid", reason: "manifest is invalid", consecutiveErrors: 0 }))
      .toBe("w: 사용할 수 없음 (manifest is invalid)");
    expect(pluginStatusLine({ id: "w", name: "Weather", state: "disabled", reason: "오류가 3번 이어졌습니다", consecutiveErrors: 3 }))
      .toBe("Weather: 꺼짐 (오류가 3번 이어졌습니다)");
    expect(pluginStatusLine({ id: "w", name: "Weather", state: "needs-permission", reason: "ignored", consecutiveErrors: 0 }))
      .toBe("Weather: 허용 대기");
  });
});

describe("createPluginHostApp", () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

  async function emptyHost() {
    const userDataDir = await mkdtemp(join(tmpdir(), "deskpet-host-app-"));
    directories.push(userDataDir);
    const actions = new ActionRegistry();
    const core = vi.fn();
    actions.register("deskpet.ping", core);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const host = createPluginHostApp({
      scanRoot: join(userDataDir, "no-plugins"), userDataDir, actions, receivePetEvent: vi.fn(), logger, env: {},
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" },
      createChannel: () => { throw new Error("no plugin should start"); },
      showPermissionDialog: async () => false, openExternal: vi.fn(), fetch: vi.fn(), execFile: vi.fn(),
      getConfig: () => ({}), saveConfig: vi.fn(), httpActionAllowlist: () => [],
    });
    return { host, core };
  }

  test("is not ready before start, ready once an empty scan root is done, and lists no plugins", async () => {
    const { host } = await emptyHost();
    expect(host.state().ready).toBe(false);
    host.start();
    await vi.waitFor(() => { expect(host.state().ready).toBe(true); });
    expect(host.state()).toMatchObject({ plugins: [], permissionPrompt: null, pids: {} });
    expect(host.menu()).toEqual([]);
    await host.stop();
  });

  test("runs core actions over HTTP and reports unknown ids as not found", async () => {
    const { host, core } = await emptyHost();
    expect(await host.invokeHttpAction("deskpet.ping", { x: 1 })).toEqual({ ok: true });
    expect(core).toHaveBeenCalledWith({ x: 1 });
    expect(await host.invokeHttpAction("weather.refresh")).toEqual({ ok: false, reason: "not-found" });
    await host.stop();
  });

  test("tells the menu listener when the start has finished", async () => {
    const { host } = await emptyHost();
    const listener = vi.fn();
    host.onMenuChange(listener);
    host.start();
    await vi.waitFor(() => { expect(host.state().ready).toBe(true); });
    expect(listener).toHaveBeenCalled();
    await host.stop();
  });
});
