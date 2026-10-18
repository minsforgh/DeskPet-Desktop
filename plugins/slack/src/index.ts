import type { LinePetEvent } from "@deskpet/core";
import type { PluginContext, PluginDefinition, SocketModeEvent, SocketModeStatus } from "@deskpet/plugin-sdk/v2";
import type { ConfigSchema, Disposable } from "@deskpet/plugin-sdk";

const ACTION = "slack.open";
const BADGE = "slack.status";
const TEAM = /^T[A-Z0-9]+$/u;
const CHANNEL = /^[CDG][A-Z0-9]+$/u;
const USER = /^[UW][A-Z0-9]+$/u;
const CACHE_LIMIT = 256;
const EVENT_LIMIT = 512;

export const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    appToken: { type: "string", title: "앱 수준 토큰", secret: true },
    userToken: { type: "string", title: "사용자 토큰", secret: true },
    memberId: { type: "string", title: "내 멤버 ID" },
    channelIds: { type: "array", title: "지정 채널 ID", items: { type: "string" }, default: [] },
    keywords: { type: "array", title: "키워드", items: { type: "string" }, default: [] },
    mentionsOnly: { type: "boolean", title: "멘션만 알림", default: false },
    hideBody: { type: "boolean", title: "본문 숨기기", default: false },
  },
};

export interface Settings {
  memberId: string;
  channelIds: readonly string[];
  keywords: readonly string[];
  mentionsOnly: boolean;
  hideBody: boolean;
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export function settings(value: Readonly<Record<string, unknown>>): Settings {
  return {
    memberId: typeof value.memberId === "string" ? value.memberId.trim() : "",
    channelIds: strings(value.channelIds), keywords: strings(value.keywords),
    mentionsOnly: value.mentionsOnly === true, hideBody: value.hideBody === true,
  };
}
const field = (value: Readonly<Record<string, unknown>>, key: string): string =>
  typeof value[key] === "string" ? value[key] : "";

export type MessageKind = "mention" | "dm" | "channel";
export function messageKind(message: SocketModeEvent, config: Settings): MessageKind | undefined {
  if (message.type !== "message" || field(message.event, "type") !== "message") return undefined;
  const event = message.event;
  if (event.subtype !== undefined || event.bot_id !== undefined || event.bot_profile !== undefined ||
      (config.memberId && event.user === config.memberId)) return undefined;
  const body = field(event, "text");
  if (config.memberId && body.includes(`<@${config.memberId}>`)) return "mention";
  if (event.channel_type === "im") return "dm";
  if (config.mentionsOnly || !config.channelIds.includes(field(event, "channel"))) return undefined;
  return config.keywords.length === 0 || config.keywords.some((word) => word !== "" && body.includes(word))
    ? "channel" : undefined;
}

const clean = (value: string): string => Array.from(value, (character) => {
  const point = character.codePointAt(0) ?? 0;
  return point <= 31 && character !== "\n" || point >= 127 && point <= 159 ? " " : character;
}).join("").replace(/\n{2,}/gu, "\n").replace(/ {2,}/gu, " ").trim();

export function plainText(value: string, users: ReadonlyMap<string, string> = new Map(),
  channels: ReadonlyMap<string, string> = new Map()): string {
  return clean(value
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/gu,
      (_, id: string, label: string | undefined) => `@${users.get(id) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/gu,
      (_, id: string, label: string | undefined) => `#${channels.get(id) ?? label ?? id}`)
    .replace(/<(https:\/\/[^\s>|]+)(?:\|([^>]*))?>/gu,
      (_, url: string, label: string | undefined) => label ?? url));
}

export function preview(header: string, body: string, hidden: boolean): string {
  const heading = Array.from(clean(header)).slice(0, 120).join("");
  if (hidden || !body || Array.from(heading).length >= 119) return heading;
  const space = 119 - Array.from(heading).length;
  const points = Array.from(body);
  return `${heading}\n${points.slice(0, points.length > space ? space - 1 : space).join("")}${points.length > space ? "…" : ""}`;
}

const slotText = (value: string): string => Array.from(value, (character) => {
  const point = character.codePointAt(0) ?? 0;
  return point <= 31 || point >= 127 && point <= 159 ? " " : character;
}).join("");

export function slackUrl(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = args as Record<string, unknown>;
  return typeof value.team === "string" && TEAM.test(value.team) &&
    typeof value.channel === "string" && CHANNEL.test(value.channel)
    ? `https://app.slack.com/client/${value.team}/${value.channel}` : undefined;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? key);
  cache.set(key, value);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function name(value: unknown): string | undefined {
  const entry = object(value);
  const profile = object(entry?.profile);
  for (const candidate of [profile?.display_name, profile?.real_name, entry?.real_name, entry?.name]) {
    if (typeof candidate === "string" && clean(candidate)) return clean(candidate);
  }
  return undefined;
}

export function createSlackPlugin(ctx: PluginContext): Disposable {
  let config = settings(ctx.config);
  let disposed = false;
  let warning: "token-required" | "permission-required" | undefined;
  const seen = new Set<string>();
  const users = new Map<string, string>();
  const userTeams = new Map<string, string>();
  const channels = new Map<string, string>();
  const resources: Disposable[] = [];

  const lookup = async (id: string, kind: "user" | "channel"): Promise<string> => {
    const cache = kind === "user" ? users : channels;
    if (cache.has(id)) return cache.get(id) ?? id;
    try {
      const response = await ctx.slack.get({ userTokenSecret: "userToken",
        method: kind === "user" ? "users.info" : "conversations.info",
        query: kind === "user" ? { user: id } : { channel: id } });
      const body = object(response.body);
      const found = response.status === 200 && body?.ok === true ? name(body[kind]) : undefined;
      if (kind === "user") {
        const team = object(body?.user)?.team_id;
        if (typeof team === "string" && TEAM.test(team)) remember(userTeams, id, team);
      }
      remember(cache, id, found ?? id);
      return found ?? id;
    } catch {
      remember(cache, id, id);
      ctx.log.warn("slack:lookup-failed count=1");
      return id;
    }
  };

  const onEvent = async (message: SocketModeEvent): Promise<void> => {
    if (disposed) return;
    const kind = messageKind(message, config);
    if (!kind) return;
    const event = message.event;
    const channel = field(event, "channel");
    const ts = field(event, "ts");
    const eventId = field(event, "event_id");
    const messageId = channel && ts ? `${channel}:${ts}` : "";
    const key = eventId || messageId;
    if (!key || [eventId, messageId].some((id) => id && seen.has(id))) return;
    for (const id of [eventId, messageId]) {
      if (!id) continue;
      if (seen.size >= EVENT_LIMIT) seen.delete(seen.values().next().value ?? "");
      seen.add(id);
    }
    const senderId = field(event, "user");
    const sender = USER.test(senderId) ? await lookup(senderId, "user") : senderId || "알 수 없음";
    const channelName = kind === "dm" ? "DM" :
      `#${CHANNEL.test(channel) ? await lookup(channel, "channel") : channel}`;
    const team = [field(event, "team"), field(event, "team_id"), userTeams.get(senderId) ?? ""]
      .find((candidate) => TEAM.test(candidate)) ?? "";
    const body = config.hideBody ? "" : slotText(plainText(field(event, "text"), users, channels));
    const shown = preview(`${sender} · ${channelName}`, body, config.hideBody);
    const bodyStart = shown.indexOf("\n");
    const hidden = bodyStart < 0;
    const notification: LinePetEvent = { source: "slack", type: "notify", key,
      line: { id: `slack.${kind}${hidden ? "-hidden" : ""}`, vars: {
        sender: slotText(sender), channel: slotText(channelName),
        ...(!hidden ? { body: shown.slice(bodyStart + 1) } : {}),
      } },
      priority: kind === "channel" ? "normal" : "high" };
    if (slackUrl({ team, channel })) notification.actions = [
      { label: "Slack 에서 열기", action: ACTION, args: { team, channel } },
    ];
    else ctx.log.info("slack:open-target-unavailable count=1");
    if (!disposed) ctx.emit(notification);
  };

  const onStatus = (status: SocketModeStatus): void => {
    if (disposed) return;
    const labels: Record<SocketModeStatus, string> = {
      connecting: "Slack 연결 중", connected: "Slack 연결됨", reconnecting: "Slack 다시 연결 중",
      "token-required": "Slack 토큰 확인 필요", "permission-required": "Slack 권한 부족",
    };
    ctx.setBadge(BADGE, { text: labels[status], tone: status === "connected" ? "ok" :
      status === "token-required" || status === "permission-required" ? "warn" : "neutral" });
    if (status === "connected" || status === "connecting") warning = undefined;
    if ((status === "token-required" || status === "permission-required") && warning !== status) {
      warning = status;
      ctx.emit({ source: "slack", type: "notify", key: `status:${status}`,
        line: { id: `slack.${status}` }, priority: "high" });
    }
  };

  resources.push(ctx.registerAction(ACTION, async (args) => {
    const url = slackUrl(args);
    if (url) await ctx.openExternal(url);
  }));
  resources.push(ctx.onConfigChange((next) => {
    config = settings(next);
    users.clear(); userTeams.clear(); channels.clear();
  }));
  void ctx.slack.connect({ appTokenSecret: "appToken", onEvent, onStatus }).then((connection) => {
    if (disposed) connection.dispose();
    else resources.push(connection);
  }).catch(() => { ctx.log.warn("slack:connect-failed count=1"); });
  return { dispose() {
    disposed = true;
    for (const resource of resources) resource.dispose();
    ctx.setBadge(BADGE, null);
  } };
}

let active: Disposable | undefined;
export default { configSchema, activate(ctx) {
  active?.dispose();
  active = createSlackPlugin(ctx);
}, deactivate() {
  active?.dispose();
  active = undefined;
} } satisfies PluginDefinition;
