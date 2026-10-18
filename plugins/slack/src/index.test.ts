import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { parseLines, renderLine } from "@deskpet/core";
import type { LinePetEvent } from "@deskpet/core";
import type { PluginContext, SocketModeEvent, SocketModeStatus } from "@deskpet/plugin-sdk/v2";
import { createSlackPlugin, messageKind, plainText, preview, settings, slackUrl } from "./index.js";

const config = settings({ memberId: "UOWN", channelIds: ["CNEWS"], keywords: ["deploy"] });
const parsed = parseLines(JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")), "slack");
const lineText = (event: LinePetEvent | undefined): string | undefined =>
  event?.line ? renderLine(parsed.catalog, event.line.id, event.line.vars) : undefined;
const message = (overrides: Record<string, unknown> = {}): SocketModeEvent => ({
  type: "message", event: { type: "message", user: "UOTHER", channel: "CNEWS",
    channel_type: "channel", text: "deploy now", ts: "1", ...overrides },
});

describe("message selection", () => {
  test.each([
    ["mention", { text: "hello <@UOWN>", channel: "COTHER" }, "mention"],
    ["DM", { channel: "DCHAT", channel_type: "im", text: "hello" }, "dm"],
    ["channel keyword", {}, "channel"],
    ["keyword miss", { text: "hello" }, undefined],
    ["other channel", { channel: "COTHER" }, undefined],
    ["own message", { user: "UOWN" }, undefined],
    ["bot id", { bot_id: "B123" }, undefined],
    ["bot profile", { bot_profile: {} }, undefined],
    ["subtype", { subtype: "message_changed" }, undefined],
  ] as const)("%s", (_label, changes, expected) => {
    expect(messageKind(message(changes), config)).toBe(expected);
  });
  test("mentions only retains mentions and DM while suppressing channel alerts", () => {
    const only = { ...config, mentionsOnly: true };
    expect(messageKind(message(), only)).toBeUndefined();
    expect(messageKind(message({ text: "<@UOWN>" }), only)).toBe("mention");
    expect(messageKind(message({ channel_type: "im", text: "hello" }), only)).toBe("dm");
  });
  test("empty keywords include the configured channel", () => {
    expect(messageKind(message({ text: "hello" }), { ...config, keywords: [] })).toBe("channel");
  });
  test("non-message events are excluded", () => {
    expect(messageKind({ ...message(), type: "reaction_added" }, config)).toBeUndefined();
  });
});

test("mrkdwn becomes safe plain text", () => {
  expect(plainText("<@UOTHER|Jane> <@W123> <#CNEWS|general> <#C999> <https://example.test/a|link> <https://example.test/b>\u0001\n\nhi",
    new Map([["UOTHER", "Jenny"]]), new Map([["CNEWS", "news"]])))
    .toBe("@Jenny @W123 #news #C999 link https://example.test/b \nhi");
  expect(plainText("<@not-a-user> <http://example.test> <#bad>"))
    .toBe("<@not-a-user> <http://example.test> <#bad>");
});

test("preview clips Unicode code points inside the PetEvent 120 point limit", () => {
  const shown = preview("보낸 사람 · #채널", "😀한".repeat(80), false);
  expect(Array.from(shown)).toHaveLength(120);
  expect(shown).toMatch(/…$/u);
  expect(preview("보낸 사람 · DM", "비밀 본문", true)).toBe("보낸 사람 · DM");
});

test.each([
  [{ team: "T123", channel: "C456" }, "https://app.slack.com/client/T123/C456"],
  [{ team: "T123", channel: "D456" }, "https://app.slack.com/client/T123/D456"],
  [{ team: "T123", channel: "G456" }, "https://app.slack.com/client/T123/G456"],
  [{ team: "T123/evil", channel: "C456" }, undefined],
  [{ team: "T123", channel: "https://evil.test" }, undefined],
  [{ team: "T123", channel: "C456/../G1" }, undefined],
  [{ team: "T123" }, undefined],
  [{ channel: "C456" }, undefined],
])("button URL validates team and channel %#", (args, expected) => {
  expect(slackUrl(args)).toBe(expected);
});

function harness(teamId?: string, configOverride: Record<string, unknown> = {}) {
  const emitted: LinePetEvent[] = [];
  const badges: string[] = [];
  let onEvent: ((event: SocketModeEvent) => Promise<void> | void) | undefined;
  let onStatus: ((status: SocketModeStatus) => void) | undefined;
  let action: ((args?: unknown) => Promise<void> | void) | undefined;
  const opened: string[] = [];
  const context = {
    config: { memberId: "UOWN", channelIds: ["CNEWS"], keywords: [], ...configOverride },
    emit: (event: LinePetEvent) => emitted.push(event),
    setBadge: (_id: string, badge: { text: string } | null) => { if (badge) badges.push(badge.text); },
    registerAction: (_id: string, handler: (args?: unknown) => Promise<void> | void) => {
      action = handler; return { dispose() {} };
    },
    onConfigChange: () => ({ dispose() {} }),
    openExternal: async (url: string) => { opened.push(url); },
    slack: {
      connect: async (options: { onEvent: typeof onEvent; onStatus: typeof onStatus }) => {
        onEvent = options.onEvent; onStatus = options.onStatus; return { dispose() {} };
      },
      get: async (options: { method: string }) => options.method === "users.info"
        ? { status: 200, body: { ok: true, user: { profile: { display_name: "Jane" }, team_id: teamId } } }
        : { status: 200, body: { ok: true, channel: { name: "news" } } },
    },
    log: { warn: vi.fn(), info: vi.fn() },
  } as unknown as PluginContext;
  const disposable = createSlackPlugin(context);
  return { emitted, badges, opened, disposable,
    event: async (value: SocketModeEvent) => { await onEvent?.(value); },
    status: (value: SocketModeStatus) => onStatus?.(value),
    click: async (value: unknown) => { await action?.(value); } };
}

test("deduplicates a message and emits named sender, channel and action", async () => {
  const app = harness();
  await app.event(message({ event_id: "Ev1", team: "T123" }));
  await app.event(message({ event_id: "Ev1", team: "T123" }));
  await app.event(message({ team: "T123" }));
  expect(app.emitted).toHaveLength(1);
  expect(app.emitted[0]).toMatchObject({
    source: "slack", key: "Ev1", priority: "normal",
    line: { id: "slack.channel", vars: { sender: "Jane", channel: "#news", body: "deploy now" } },
    actions: [{ label: "Slack 에서 열기", args: { team: "T123", channel: "CNEWS" } }],
  });
  expect(parsed.problems).toEqual([]);
  expect(lineText(app.emitted[0])).toBe("Jane · #news\ndeploy now");
  await app.click({ team: "T123", channel: "CNEWS" });
  await app.click({ team: "T123", channel: "../evil" });
  expect(app.opened).toEqual(["https://app.slack.com/client/T123/CNEWS"]);
  app.disposable.dispose();
});

test("uses the sender lookup team when the event has no team", async () => {
  const app = harness("TTEAM");
  await app.event(message());
  expect(app.emitted[0]?.actions).toEqual([
    { label: "Slack 에서 열기", action: "slack.open", args: { team: "TTEAM", channel: "CNEWS" } },
  ]);
  await app.click({ team: "TTEAM", channel: "CNEWS" });
  expect(app.opened).toEqual(["https://app.slack.com/client/TTEAM/CNEWS"]);
  app.disposable.dispose();
});

test("omits the button when no valid team ID is available", async () => {
  const app = harness("bad/team");
  await app.event(message());
  expect(app.emitted[0]?.actions).toBeUndefined();
  app.disposable.dispose();
});

test("hideBody emits only the sender and DM heading", async () => {
  const app = harness("TTEAM", { hideBody: true });
  await app.event(message({ channel: "DCHAT", channel_type: "im", text: "private body" }));
  expect(app.emitted[0]?.line).toEqual({ id: "slack.dm-hidden", vars: { sender: "Jane", channel: "DM" } });
  expect(lineText(app.emitted[0])).toBe("Jane · DM");
  app.disposable.dispose();
});

test.each([
  ["mention", { text: "hello <@UOWN>", channel: "CNEWS" }, {}, "slack.mention", "hello @UOWN"],
  ["dm", { channel: "DCHAT", channel_type: "im", text: "hello" }, {}, "slack.dm", "hello"],
  ["hidden mention", { text: "hello <@UOWN>" }, { hideBody: true }, "slack.mention-hidden", undefined],
  ["hidden channel", { text: "hello" }, { hideBody: true }, "slack.channel-hidden", undefined],
] as const)("%s selects a catalog line with sender, channel and body variables", async (_name, changes, configOverride, id, body) => {
  const app = harness("TTEAM", configOverride);
  await app.event(message(changes));
  const line = app.emitted[0]?.line;
  expect(line?.id).toBe(id);
  expect(parsed.catalog.lines.map((entry) => entry.id)).toContain(line?.id);
  expect(line?.vars).toEqual({ sender: "Jane", channel: id.startsWith("slack.dm") ? "DM" : "#news",
    ...(body === undefined ? {} : { body }) });
  expect(lineText(app.emitted[0])).toBe(body === undefined
    ? `Jane · ${id.startsWith("slack.dm") ? "DM" : "#news"}`
    : `Jane · ${id.startsWith("slack.dm") ? "DM" : "#news"}\n${body}`);
  app.disposable.dispose();
});

test("malformed sender ID falls back without a user lookup", async () => {
  const app = harness("TTEAM");
  await app.event(message({ user: "not/a/user" }));
  expect(app.emitted[0]?.line).toEqual({ id: "slack.channel",
    vars: { sender: "not/a/user", channel: "#news", body: "deploy now" } });
  expect(lineText(app.emitted[0])).toBe("not/a/user · #news\ndeploy now");
  expect(app.emitted[0]?.actions).toBeUndefined();
  app.disposable.dispose();
});

test("long body keeps the existing clipped preview in a line variable", async () => {
  const app = harness("TTEAM");
  const body = "😀한".repeat(80);
  await app.event(message({ text: body }));
  expect(app.emitted[0]?.line?.id).toBe("slack.channel");
  expect(lineText(app.emitted[0])).toBe(preview("Jane · #news", body, false));
  app.disposable.dispose();
});

test("token and permission warnings appear once until connected", () => {
  const app = harness();
  app.status("token-required"); app.status("token-required");
  app.status("reconnecting"); app.status("token-required");
  app.status("permission-required"); app.status("permission-required");
  expect(app.emitted.map((event) => event.line?.id)).toEqual(["slack.token-required", "slack.permission-required"]);
  expect(app.emitted.map((event) => lineText(event))).toEqual(["Slack 토큰 확인 필요", "Slack 권한 부족"]);
  expect(app.emitted.every((event) => parsed.catalog.lines.some(({ id }) => id === event.line?.id))).toBe(true);
  app.status("connected"); app.status("token-required");
  expect(app.emitted.filter((event) => event.line?.id === "slack.token-required")).toHaveLength(2);
  app.status("connecting"); app.status("token-required");
  expect(app.emitted.filter((event) => event.line?.id === "slack.token-required")).toHaveLength(3);
  expect(app.badges).toContain("Slack 연결됨");
  app.disposable.dispose();
});
