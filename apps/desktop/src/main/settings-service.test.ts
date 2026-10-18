import { validatePetEvent, type DoNotDisturbConfig, type LinePetEvent, type PetEvent, type VoiceTemplates } from "@deskpet/core";
import type { ConfigSchema } from "@deskpet/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultInteractions, type PetInteraction } from "./pet-menu.js";
import type { PluginSettingsEntry } from "./plugin-host-app.js";
import type { PluginMenuItem } from "./tray.js";
import { createSettingsService, parseDirtyFlag, validateGeneral, validatePluginInput, validateVoiceRequest, type SettingsBackend } from "./settings-service.js";
import { applyVoice, type VoiceCounters } from "./voice.js";
import type { BadgePlacement, BubbleDisplay, DeskpetSettings } from "./settings.js";

const reminders: ConfigSchema = {
  type: "object",
  properties: { rules: { type: "array", default: [], items: { type: "object", required: ["id", "time", "text"], properties: {
    id: { type: "string", title: "ID" },
    time: { type: "string", title: "시각" },
    days: { type: "array", items: { type: "number" }, enum: [0, 1, 2, 3, 4, 5, 6] },
    text: { type: "string" },
    priority: { type: "string", enum: ["low", "normal", "high"] },
  } } } },
  required: ["rules"],
};
const account: ConfigSchema = {
  type: "object",
  properties: {
    name: { type: "string", title: "이름" },
    count: { type: "number" },
    on: { type: "boolean" },
    mode: { type: "string", enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" } },
    token: { type: "string", secret: true },
  },
  required: ["name"],
};
const validRule = { id: "lunch", time: "12:00", text: "점심", days: [1, 3] };
const noSecrets = {};

describe("validateGeneral", () => {
  it("accepts HH:MM windows and drops an empty schedule", () => {
    expect(validateGeneral({ enabled: true, schedule: [{ start: "22:00", end: "07:00" }, { start: "00:00", end: "23:59" }] }))
      .toEqual({ ok: true, value: { enabled: true, schedule: [{ start: "22:00", end: "07:00" }, { start: "00:00", end: "23:59" }] } });
    expect(validateGeneral({ enabled: false, schedule: [] })).toEqual({ ok: true, value: { enabled: false } });
  });

  it("reports each wrong time with its row and field, and rejects a malformed request", () => {
    for (const bad of ["9:00", "24:00", "12:60", "", "12:5", " 12:00", "aa:bb", "12:00:00"]) {
      expect(validateGeneral({ enabled: false, schedule: [{ start: "09:00", end: bad }] }))
        .toEqual({ ok: false, errors: [{ path: "schedule.0.end", message: "HH:MM 형식(예: 22:00)으로 입력하세요" }] });
    }
    const both = validateGeneral({ enabled: false, schedule: [{ start: "bad", end: "bad" }, { start: "01:00", end: "02:00" }] });
    expect(both).toMatchObject({ ok: false });
    expect(both.ok ? [] : both.errors.map(({ path }) => path)).toEqual(["schedule.0.start", "schedule.0.end"]);
    for (const request of [null, [], "x", { enabled: "yes", schedule: [] }, { enabled: true }, { enabled: true, schedule: "no" },
      { enabled: true, schedule: Array.from({ length: 21 }, () => ({ start: "01:00", end: "02:00" })) }]) {
      expect(validateGeneral(request)).toMatchObject({ ok: false });
    }
    expect(validateGeneral({ enabled: false, schedule: [null] })).toMatchObject({ ok: false });
  });
});

describe("validatePluginInput", () => {
  it("accepts a valid object array and keeps only declared, non-blank properties", () => {
    const result = validatePluginInput(reminders, false, noSecrets,
      { rules: [{ ...validRule, priority: "high", extra: "dropped" }, { id: "b", time: "08:00", text: "x", days: [], priority: "" }] }, {});
    expect(result).toEqual({ ok: true, value: { secrets: {}, config: { rules: [
      { ...validRule, priority: "high" }, { id: "b", time: "08:00", text: "x" }] } } });
  });

  it("reports required, enum, type and length errors by dotted path and saves nothing", () => {
    const result = validatePluginInput(reminders, false, noSecrets, { rules: [
      { id: "", time: "09:00", text: "x" },
      { id: "a", time: "09:00", text: "x", days: [7] },
      { id: "b", time: "09:00", text: "x", days: ["1"] },
      { id: "c", time: "09:00", text: "x", priority: "urgent" },
      { id: "d", time: 900, text: "x" },
      { id: "e", time: "09:00", text: "x".repeat(1001) },
      "not an object",
    ] }, {});
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      { path: "rules.0.id", message: "필수 항목입니다" },
      { path: "rules.1.days.0", message: "목록에 있는 값을 고르세요" },
      { path: "rules.2.days.0", message: "숫자를 입력하세요" },
      { path: "rules.3.priority", message: "목록에 있는 값을 고르세요" },
      { path: "rules.4.time", message: "값이 올바르지 않습니다" },
      { path: "rules.5.text", message: "1000자 이하로 입력하세요" },
      { path: "rules.6", message: "항목이 올바르지 않습니다" },
    ]);
  });

  it("bounds the list length and rejects a non-array value for an array field", () => {
    expect(validatePluginInput(reminders, false, noSecrets, { rules: Array.from({ length: 101 }, () => validRule) }, {})).toMatchObject({ ok: false });
    expect(validatePluginInput(reminders, false, noSecrets, { rules: { id: "x" } }, {})).toMatchObject({ ok: false });
    expect(validatePluginInput(reminders, false, noSecrets, {}, {})).toEqual({ ok: false, errors: [{ path: "rules", message: "필수 항목입니다" }] });
    expect(validatePluginInput(reminders, false, noSecrets, { rules: [] }, {})).toEqual({ ok: true, value: { config: { rules: [] }, secrets: {} } });
  });

  it("checks scalar fields: type, enum, finite numbers and required strings", () => {
    const ok = validatePluginInput(account, true, noSecrets, { name: "n", count: 3, on: false, mode: "b", tags: ["x", "y"] }, {});
    expect(ok).toEqual({ ok: true, value: { config: { name: "n", count: 3, on: false, mode: "b", tags: ["x", "y"] }, secrets: {} } });
    const bad = validatePluginInput(account, true, noSecrets, { name: "", count: Number.NaN, on: "yes", mode: "c", tags: ["", 4] }, {});
    expect(bad.ok ? [] : bad.errors.map(({ path }) => path)).toEqual(["name", "count", "on", "mode", "tags.0", "tags.1"]);
    expect(validatePluginInput(account, true, noSecrets, { name: "n", count: Number.POSITIVE_INFINITY }, {})).toMatchObject({ ok: false });
  });

  it("keeps secret values out of the config and refuses them without the secrets permission", () => {
    const allowed = validatePluginInput(account, true, noSecrets, { name: "n", token: "should-not-pass" }, { token: "abc-123456" });
    expect(allowed).toEqual({ ok: true, value: { config: { name: "n" }, secrets: { token: "abc-123456" } } });
    const denied = validatePluginInput(account, false, noSecrets, { name: "n" }, { token: "abc-123456" });
    expect(denied).toEqual({ ok: false, errors: [{ path: "token", message: "이 플러그인은 비밀 값을 저장할 권한이 없습니다" }] });
    expect(validatePluginInput(account, true, noSecrets, { name: "n" }, { name: "x" })).toEqual(
      { ok: false, errors: [{ path: "name", message: "비밀 항목이 아닙니다" }] });
    expect(validatePluginInput(account, true, noSecrets, { name: "n" }, { unknown: "x" })).toMatchObject({ ok: false });
    expect(validatePluginInput(account, true, noSecrets, { name: "n" }, { token: "é".repeat(4097) })).toMatchObject({ ok: false });
    expect(validatePluginInput(account, true, noSecrets, { name: "n" }, { token: 5 })).toMatchObject({ ok: false });
    // An empty password box means "leave the stored value alone", not "store an empty value".
    expect(validatePluginInput(account, true, noSecrets, { name: "n" }, { token: "" })).toEqual({ ok: true, value: { config: { name: "n" }, secrets: {} } });
  });

  it("requires a required secret only while none is stored", () => {
    const required: ConfigSchema = { ...account, required: ["name", "token"] };
    expect(validatePluginInput(required, true, {}, { name: "n" }, {})).toEqual({ ok: false, errors: [{ path: "token", message: "필수 항목입니다" }] });
    expect(validatePluginInput(required, true, { token: true }, { name: "n" }, {})).toMatchObject({ ok: true });
  });

  it("does not let a prototype-named property reach Object.prototype", () => {
    const schema: ConfigSchema = { type: "object", properties: { ["__proto__"]: { type: "string" } } };
    const result = validatePluginInput(schema, false, noSecrets, JSON.parse('{"__proto__":"x"}') as Record<string, unknown>, {});
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.ok ? result.value.config : {})).toBe(Object.prototype);
  });
});

function setup(entry: Partial<PluginSettingsEntry> = {}) {
  const stored = { token: false };
  const form: NonNullable<PluginSettingsEntry["form"]> = { schema: account, values: { name: "old" }, secrets: stored, canStoreSecrets: true };
  const plugins: PluginSettingsEntry[] = [
    { id: "alpha", name: "Alpha", state: "running", statusLine: "Alpha: 실행 중", notice: "", form, ...entry },
    { id: "gamma", name: "Gamma", state: "disabled", statusLine: "Gamma: 꺼짐", notice: "꺼짐" },
  ];
  let dnd: DoNotDisturbConfig = { enabled: false, schedule: [{ start: "22:00", end: "07:00" }] };
  const host = {
    settingsPlugins: vi.fn(async () => plugins),
    savePluginSettings: vi.fn(async (_id: string, _config: Record<string, unknown>, secrets: Readonly<Record<string, string>>) => {
      if ("token" in secrets) stored.token = true;
    }),
    clearPluginSecret: vi.fn(async () => { stored.token = false; }),
    menu: vi.fn((): PluginMenuItem[] => []),
    idle: vi.fn(async () => undefined),
  };
  const saveDoNotDisturb = vi.fn((next: DoNotDisturbConfig) => { dnd = next; return true; });
  const backend: SettingsBackend = { doNotDisturb: () => dnd, saveDoNotDisturb, host: () => host,
    voice: () => ({ characterName: "테스트", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
    interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined };
  return { service: createSettingsService(backend), backend, host, saveDoNotDisturb, stored, plugins };
}

it("shows default badge placement and validates every save before applying it", async () => {
  const { backend } = setup();
  let badge: BadgePlacement = { side: "above", gap: 3 };
  const save = vi.fn((next: BadgePlacement) => { badge = next; return true; });
  backend.badgePlacement = () => badge;
  backend.saveBadgePlacement = save;
  const service = createSettingsService(backend);
  expect((await service.load()).badge).toEqual({ side: "above", gap: 3 });
  for (const invalid of [null, {}, { side: "below", gap: 3 }, { side: "left", gap: -1 }, { side: "right", gap: 41 },
    { side: "above", gap: 2.5 }, { side: "above", gap: "3" }]) expect(service.saveBadge(invalid).ok).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(service.saveBadge({ side: "left", gap: 40 })).toEqual({ ok: true });
  expect((await service.load()).badge).toEqual({ side: "left", gap: 40 });
});

it("shows default bubble display and validates every save before applying it", async () => {
  const { backend } = setup();
  let bubble: BubbleDisplay = { maxWidthDip: 280, maxLines: 4 };
  const save = vi.fn((next: BubbleDisplay) => { bubble = next; return true; });
  backend.bubbleDisplay = () => bubble;
  backend.saveBubbleDisplay = save;
  const service = createSettingsService(backend);
  expect((await service.load()).bubble).toEqual({ maxWidthDip: 280, maxLines: 4 });
  for (const invalid of [null, {}, { maxWidthDip: 179, maxLines: 4 }, { maxWidthDip: 601, maxLines: 4 },
    { maxWidthDip: 280.5, maxLines: 4 }, { maxWidthDip: 280, maxLines: 2 }, { maxWidthDip: 280, maxLines: 13 },
    { maxWidthDip: 280, maxLines: "4" }]) expect(service.saveBubble(invalid).ok).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(service.saveBubble({ maxWidthDip: 400, maxLines: 12 })).toEqual({ ok: true });
  expect((await service.load()).bubble).toEqual({ maxWidthDip: 400, maxLines: 12 });
});

describe("line settings service", () => {
  it("saves and resets only the current pack's requested map", () => {
    const { backend } = setup();
    let settings: DeskpetSettings = { doNotDisturb: { enabled: false }, lineOverrides: {
      other: { "fixture.done": ["Other"] }, "wolf-maid": { "missing.line": ["Keep"] } },
      lineReactions: { other: { "fixture.done": { play: "happy" } },
        "wolf-maid": { "missing.line": { play: "happy" } } } };
    backend.lineSettings = () => ({ settings, packId: "wolf-maid", sequenceIds: new Set(["notice"]), catalogs: [{ pluginId: "fixture",
      catalog: { version: 1, lines: [{ id: "fixture.done", label: "Done", kind: "done", variables: [], variants: ["Done"] }] } }] });
    backend.saveLineSettings = (next) => { settings = next; return true; };
    const service = createSettingsService(backend);
    expect(service.lineOverridesSave({ lines: { "fixture.done": ["{task} 완료"] } })).toEqual({ ok: true });
    expect(service.lineReactionsSave({ lines: { "fixture.done": { play: "worried" } } })).toEqual({ ok: true });
    expect(service.lineSettingsLoad()).toMatchObject({ ok: true, overrides: { "fixture.done": ["{task} 완료"] },
      reactions: { "fixture.done": { play: "worried" } } });
    const parts = { prefix: "앞말", content: "내용", suffix: "끝말" };
    expect(service.lineOverridesSave({ lines: { "fixture.done": [parts] } })).toEqual({ ok: true });
    expect(service.lineSettingsLoad()).toMatchObject({ ok: true, overrides: { "fixture.done": [parts] } });
    expect(settings.lineOverrides?.["wolf-maid"]?.["fixture.done"]).toEqual([parts]);
    expect(service.lineOverridesSave({ lines: { "fixture.done": [""] } })).toMatchObject({ ok: false });
    expect(service.lineReactionsSave({ lines: { "fixture.done": { play: "../bad" } } })).toMatchObject({ ok: false });
    expect(service.lineReactionsSave({ lines: { "fixture.done": { sequence: "missing" } } })).toMatchObject({ ok: false });
    expect(service.lineOverridesReset()).toEqual({ ok: true });
    expect(service.lineReactionsReset()).toEqual({ ok: true });
    expect(settings.lineOverrides).toEqual({ other: { "fixture.done": ["Other"] }, "wolf-maid": { "missing.line": ["Keep"] } });
    expect(settings.lineReactions).toEqual({ other: { "fixture.done": { play: "happy" } },
      "wolf-maid": { "missing.line": { play: "happy" } } });
  });
});

describe("line send", () => {
  function lineSetup() {
    const { backend } = setup();
    const sent: Array<{ event: LinePetEvent; previewText?: string; variant?: number }> = [];
    let time = 10_000;
    const catalog = (id: string) => ({ version: 1 as const, lines: [{ id: `${id}.done`, label: "Done", kind: "done" as const,
      variables: ["name"], variants: ["{name} 완료"] }] });
    backend.lineSettings = () => ({ settings: { doNotDisturb: { enabled: false } }, packId: "wolf-maid",
      catalogs: [{ pluginId: "alpha", catalog: catalog("alpha") }, { pluginId: "gamma", catalog: catalog("gamma") }] });
    backend.sendLinePreview = (event, previewText, variant) => { sent.push({ event,
      ...(previewText === undefined ? {} : { previewText }), ...(variant === undefined ? {} : { variant }) }); };
    backend.now = () => time;
    return { service: createSettingsService(backend), sent, advance: (ms: number) => { time += ms; } };
  }

  it("sends the line with its plugin as source and the filled variables", async () => {
    const { service, sent } = lineSetup();
    expect(await service.lineSend({ lineId: "alpha.done", vars: { name: "철수" }, previewText: "임시 문장" })).toEqual({ ok: true });
    expect(sent).toEqual([{ event: { source: "alpha", type: "notify", key: "settings.line-preview",
      line: { id: "alpha.done", vars: { name: "철수" } } }, previewText: "임시 문장" }]);
  });

  it("fills missing variables and sends without a preview sentence by default", async () => {
    const { service, sent, advance } = lineSetup();
    expect(await service.lineSend({ lineId: "alpha.done" })).toEqual({ ok: true });
    expect(sent[0]).toEqual({ event: { source: "alpha", type: "notify", key: "settings.line-preview",
      line: { id: "alpha.done", vars: { name: "예시" } } } });
    advance(500);
    expect(await service.lineSend({ lineId: "alpha.done" })).toEqual({ ok: false, message: "너무 빨라요. 잠시 후 다시 눌러 주세요" });
  });

  it("passes the selected preview variant only through the settings send path", async () => {
    const { service, sent } = lineSetup();
    expect(await service.lineSend({ lineId: "alpha.done", previewText: "철수 완료", vars: { name: "철수" }, variant: 1 }))
      .toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ previewText: "철수 완료", variant: 1 });
    expect(sent[0]?.event).not.toHaveProperty("variant");
    expect(await service.lineSend({ lineId: "alpha.done", variant: 8 })).toMatchObject({ ok: false });
  });

  it("refuses unregistered lines, stopped plugins, unknown variables and extra fields", async () => {
    const { service, sent } = lineSetup();
    expect(await service.lineSend({ lineId: "alpha.missing" })).toEqual({ ok: false, message: "등록되지 않은 대사예요" });
    expect(await service.lineSend({ lineId: "gamma.done" })).toMatchObject({ ok: false, message: expect.stringContaining("켜져 있지 않아") });
    expect(await service.lineSend({ lineId: "alpha.done", vars: { other: "x" } })).toMatchObject({ ok: false });
    expect(await service.lineSend({ lineId: "alpha.done", source: "gamma" })).toMatchObject({ ok: false });
    expect(await service.lineSend({ lineId: 5 })).toMatchObject({ ok: false });
    expect(await service.lineSend({ lineId: "alpha.done", previewText: 5 })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it("keeps the preview sentence out of the event, so HTTP /event and plugin emit have nothing to set", async () => {
    const { service, sent } = lineSetup();
    await service.lineSend({ lineId: "alpha.done", previewText: "임시 문장" });
    const event = sent[0]?.event;
    expect(JSON.stringify(event)).not.toContain("임시 문장");
    expect(Object.keys(event ?? {}).sort()).toEqual(["key", "line", "source", "type"]);
    // A public event naming previewText is not a send: the service only reads the explicit argument.
    const forged = { source: "alpha", type: "notify", previewText: "x", line: { id: "alpha.done" } };
    const validated = validatePetEvent(forged);
    expect(validated.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("reminder enable", () => {
  it("runs the existing tray enable action and waits for its effect", async () => {
    const { service, host, plugins } = setup();
    const entry: PluginSettingsEntry = { id: "reminders", name: "Reminders", state: "disabled", statusLine: "꺼짐", notice: "꺼짐" };
    plugins.push(entry);
    host.menu.mockReturnValue([{ label: "다시 켜기 (reminders)", click: () => { entry.state = "running"; } }]);
    expect(await service.enableReminder()).toEqual({ ok: true });
    expect(host.idle).toHaveBeenCalledOnce();
    expect(await service.enableReminder()).toMatchObject({ ok: false });
  });
});

describe("parseDirtyFlag", () => {
  it("accepts exactly true or false and refuses every other payload", () => {
    expect(parseDirtyFlag(true)).toBe(true);
    expect(parseDirtyFlag(false)).toBe(false);
    for (const bad of [null, undefined, 0, 1, Number.NaN, "", "true", "yes", {}, [], [true], { dirty: true }])
      expect(parseDirtyFlag(bad)).toBeUndefined();
  });
});

describe("createSettingsService", () => {
  it("loads the general settings and every plugin entry", async () => {
    const { service } = setup();
    const view = await service.load();
    expect(view.general).toEqual({ enabled: false, schedule: [{ start: "22:00", end: "07:00" }] });
    expect(view.plugins.map(({ id }) => id)).toEqual(["alpha", "gamma"]);
  });

  it("saves valid do-not-disturb input through the backend and refuses invalid input without calling it", () => {
    const { service, saveDoNotDisturb } = setup();
    expect(service.saveGeneral({ enabled: true, schedule: [{ start: "01:00", end: "02:00" }] })).toEqual({ ok: true });
    expect(saveDoNotDisturb).toHaveBeenCalledWith({ enabled: true, schedule: [{ start: "01:00", end: "02:00" }] });
    expect(service.saveGeneral({ enabled: true, schedule: [{ start: "1:00", end: "02:00" }] })).toMatchObject({ ok: false });
    expect(saveDoNotDisturb).toHaveBeenCalledTimes(1);
    saveDoNotDisturb.mockReturnValueOnce(false);
    expect(service.saveGeneral({ enabled: true, schedule: [] })).toEqual({ ok: false, errors: [{ path: "", message: "저장하지 못했습니다" }] });
  });

  it("stores the secret before the config, never puts it in the config, and answers only saved or not", async () => {
    const { service, host } = setup();
    const result = await service.savePlugin({ pluginId: "alpha", config: { name: "new" }, secrets: { token: "hunter2-secret" } });
    expect(result).toEqual({ ok: true, secrets: { token: true } });
    expect(host.savePluginSettings).toHaveBeenCalledWith("alpha", { name: "new" }, { token: "hunter2-secret" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("returns field errors and saves nothing when any field is wrong", async () => {
    const { service, host } = setup();
    const result = await service.savePlugin({ pluginId: "alpha", config: { name: "" }, secrets: { token: "kept-out" } });
    expect(result).toEqual({ ok: false, errors: [{ path: "name", message: "필수 항목입니다" }] });
    expect(host.savePluginSettings).not.toHaveBeenCalled();
  });

  it("refuses plugins that are not running, unknown plugins and malformed requests", async () => {
    const { service, host } = setup();
    const unavailable = { ok: false, errors: [{ path: "", message: "이 플러그인은 지금 설정할 수 없습니다" }] };
    expect(await service.savePlugin({ pluginId: "gamma", config: {}, secrets: {} })).toEqual(unavailable);
    expect(await service.savePlugin({ pluginId: "nobody", config: {}, secrets: {} })).toEqual(unavailable);
    expect(await service.savePlugin({ pluginId: 5, config: {}, secrets: {} })).toEqual(unavailable);
    expect(await service.savePlugin(null)).toEqual(unavailable);
    expect(await service.savePlugin({ pluginId: "alpha", config: [], secrets: {} })).toMatchObject({ ok: false });
    expect(await service.savePlugin({ pluginId: "alpha", config: {}, secrets: null })).toMatchObject({ ok: false });
    expect(host.savePluginSettings).not.toHaveBeenCalled();
  });

  it("clears only a declared secret field of a running plugin", async () => {
    const { service, host, stored } = setup();
    stored.token = true;
    expect(await service.clearSecret({ pluginId: "alpha", field: "token" })).toEqual({ ok: true, secrets: { token: false } });
    expect(host.clearPluginSecret).toHaveBeenCalledWith("alpha", "token");
    for (const payload of [{ pluginId: "alpha", field: "name" }, { pluginId: "alpha", field: "missing" }, { pluginId: "alpha", field: 1 },
      { pluginId: "gamma", field: "token" }, { pluginId: "alpha" }, null]) {
      expect(await service.clearSecret(payload)).toMatchObject({ ok: false });
    }
    expect(host.clearPluginSecret).toHaveBeenCalledTimes(1);
  });

  it("reports a write failure without leaking the error text", async () => {
    const { service, host } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    host.savePluginSettings.mockRejectedValueOnce(new Error("EACCES C:\\secret\\path"));
    expect(await service.savePlugin({ pluginId: "alpha", config: { name: "n" }, secrets: {} })).toEqual(
      { ok: false, errors: [{ path: "", message: "저장하지 못했습니다" }] });
    error.mockRestore();
  });
});

describe("voice", () => {
  const templates: VoiceTemplates = { done: ["{task} 끝났어요! {result}", "{task} 마쳤어요", "{folder} 끝"], waiting: ["확인해 주세요. {message}"] };
  function voiceSetup(options: { templates?: VoiceTemplates; problems?: string[] } = {}) {
    const sent: PetEvent[] = [];
    let time = 10_000;
    const service = createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "늑대 메이드", templates: options.templates ?? templates, problems: options.problems ?? ["templates.x is not a known kind"] }),
      sendVoicePreview: (event) => { sent.push(event); },
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined,
      now: () => time,
    });
    return { service, sent, advance: (ms: number) => { time += ms; } };
  }

  it("lists all seven kinds in order with the usable variants, and the file's problems", () => {
    const { service } = voiceSetup();
    const view = service.voiceLoad();
    expect(view.characterName).toBe("늑대 메이드");
    expect(view.kinds.map(({ kind }) => kind)).toEqual(["done", "waiting", "failed", "info", "deadline", "reminder", "alert"]);
    expect(view.kinds[0]?.variants).toEqual(templates.done);
    expect(view.kinds[2]?.variants).toEqual([]);
    expect(view.problems).toEqual(["templates.x is not a known kind"]);
  });

  it("gives every kind no variants for a character without templates", () => {
    const { service: raw, advance } = voiceSetup({ templates: {}, problems: [] });
    const service = { ...raw, voicePreview: (payload: unknown) => { advance(1_000); return raw.voicePreview(payload); } };
    expect(service.voiceLoad().kinds.every(({ variants }) => variants.length === 0)).toBe(true);
    expect(service.voicePreview({ kind: "done", slots: { task: "빌드" } })).toEqual({ ok: true, text: null, variantCount: 0 });
  });

  it("previews what renderVoice gives and walks the variants by number", () => {
    const { service: raw, advance } = voiceSetup();
    const service = { ...raw, voicePreview: (payload: unknown) => { advance(1_000); return raw.voicePreview(payload); } };
    const slots = { task: "빌드", result: "통과", folder: "app" };
    expect(service.voicePreview({ kind: "done", slots })).toEqual({ ok: true, text: "빌드 끝났어요! 통과", variantCount: 3 });
    expect(service.voicePreview({ kind: "done", slots, variant: 1 })).toMatchObject({ text: "빌드 마쳤어요" });
    expect(service.voicePreview({ kind: "done", slots, variant: 2 })).toMatchObject({ text: "app 끝" });
    expect(service.voicePreview({ kind: "done", slots, variant: 3 })).toMatchObject({ text: "빌드 끝났어요! 통과" });
  });

  it("reports no text when no variant has its slots filled", () => {
    const { service: raw, advance } = voiceSetup();
    const service = { ...raw, voicePreview: (payload: unknown) => { advance(1_000); return raw.voicePreview(payload); } };
    expect(service.voicePreview({ kind: "waiting", slots: {} })).toEqual({ ok: true, text: null, variantCount: 1 });
    expect(service.voicePreview({ kind: "waiting", slots: { message: "   " } })).toMatchObject({ text: null });
  });

  it("does not consume the rotation that real events use", () => {
    const { service, sent, advance } = voiceSetup();
    const counters: VoiceCounters = {};
    for (let index = 0; index < 5; index += 1) { advance(1_000); service.voicePreview({ kind: "done", slots: { task: "빌드", result: "통과" }, variant: index }); }
    expect(sent).toEqual([]);
    expect(counters).toEqual({});
    const event: PetEvent = { source: "x", type: "notify", text: "t", voice: { kind: "done", slots: { task: "빌드", result: "통과" } } };
    expect(applyVoice(event, templates, counters).text).toBe("빌드 끝났어요! 통과");
  });

  it("refuses unknown kinds, unknown slot keys, extra fields, 501 characters and control characters", () => {
    const { service, sent, advance } = voiceSetup();
    const refused = { ok: false, message: "요청이 올바르지 않습니다" };
    const bad: unknown[] = [
      { kind: "party", slots: {} }, { kind: 3 }, null, "done", [],
      { kind: "done", slots: { title: "x" } }, { kind: "done", slots: { task: 5 } }, { kind: "done", slots: [] },
      { kind: "done", extra: 1 }, { kind: "done", variant: -1 }, { kind: "done", variant: 1.5 }, { kind: "done", variant: "1" },
      { kind: "done", slots: { task: "가".repeat(501) } }, { kind: "done", slots: { task: "a\u0000b" } },
      { kind: "done", slots: { task: "줄\n바꿈" } }, { kind: "done", slots: { task: "\u007f" } },
    ];
    for (const payload of bad) {
      advance(2_000);
      expect(service.voicePreview(payload)).toEqual(refused);
      expect(service.voiceSend(payload)).toEqual(refused);
    }
    expect(sent).toEqual([]);
    advance(2_000);
    expect(service.voicePreview({ kind: "done", slots: { task: "가".repeat(500) } })).toMatchObject({ ok: true });
  });

  it("sends a settings event through the pet's event path only on request, at most once a second", () => {
    const { service, sent, advance } = voiceSetup();
    service.voiceLoad();
    service.voicePreview({ kind: "done", slots: { task: "빌드" } });
    expect(sent).toEqual([]);
    expect(service.voiceSend({ kind: "done", slots: { task: "빌드", result: "" } })).toEqual({ ok: true });
    expect(sent).toEqual([{ source: "settings", type: "notify", key: "settings.voice-preview", text: "(미리보기) 빌드",
      voice: { kind: "done", slots: { task: "빌드" } } }]);
    advance(999);
    expect(service.voiceSend({ kind: "done", slots: { task: "빌드" } })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
    advance(1);
    expect(service.voiceSend({ kind: "waiting", slots: { message: "m" } })).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toBe("(미리보기) m");
  });

  it("falls back to a plain sentence when the slots give nothing to say", () => {
    const { service, sent } = voiceSetup();
    service.voiceSend({ kind: "info" });
    expect(sent[0]).toMatchObject({ text: "(미리보기) 어투 테스트", voice: { kind: "info", slots: {} } });
  });

  it("sends a temporary variant as rendered text without changing the active voice", () => {
    const { service, sent, advance } = voiceSetup();
    expect(service.voiceSend({ kind: "done", slots: { task: "빌드", result: "통과" }, template: "임시 {task}: {result}" }))
      .toEqual({ ok: true });
    expect(sent[0]).toEqual({ source: "settings", type: "notify", key: "settings.voice-preview", text: "임시 빌드: 통과" });
    advance(2_000);
    expect(service.voiceSend({ kind: "done", slots: { task: "빌드" }, template: "{missing}" }))
      .toEqual({ ok: false, message: "버려질 변형은 보낼 수 없어요" });
    expect(service.voiceSend({ kind: "done", slots: { task: "빌드" }, template: "{result}" }))
      .toEqual({ ok: false, message: "이 샘플로는 변형을 보낼 수 없어요" });
    expect(sent).toHaveLength(1);
  });
});

describe("validateVoiceRequest", () => {
  it("keeps only non-blank slots and defaults the variant to 0", () => {
    expect(validateVoiceRequest({ kind: "alert", slots: { message: " 로그인 ", task: "" } }))
      .toEqual({ ok: true, voice: { kind: "alert", slots: { message: " 로그인 " } }, variant: 0 });
  });
  it("does not let a __proto__ slot through", () => {
    expect(validateVoiceRequest(JSON.parse('{"kind":"done","slots":{"__proto__":"x"}}'))).toEqual({ ok: false });
  });
});

describe("voice preview rate limit", () => {
  it("answers a second valid preview within a second with a message, and a refused request does not count", () => {
    let time = 10_000;
    const service = createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "x", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined, now: () => time,
    });
    expect(service.voicePreview({ kind: "bad" })).toEqual({ ok: false, message: "요청이 올바르지 않습니다" });
    expect(service.voicePreview({ kind: "done" })).toMatchObject({ ok: true });
    time += 999;
    expect(service.voicePreview({ kind: "done" })).toEqual({ ok: false, message: "너무 빨라요. 잠시 후 다시 눌러 주세요" });
    time += 1;
    expect(service.voicePreview({ kind: "done" })).toMatchObject({ ok: true });
  });
});

describe("interactions", () => {
  function interactionSetup(stored: PetInteraction[] = []) {
    let user = stored;
    let time = 10_000;
    const ran: PetInteraction[] = [];
    const saveInteractions = vi.fn((next: PetInteraction[]) => { user = next; return Promise.resolve(); });
    const service = createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "x", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve(user), save: saveInteractions }, runInteraction: (interaction) => { ran.push(interaction); }, now: () => time,
    });
    return { service, saveInteractions, ran, advance: (ms: number) => { time += ms; }, stored: () => user };
  }
  const row = (extra: Record<string, unknown> = {}) => ({ id: "custom-1", label: "새 상호작용", mood: "neutral", speak: true, lines: ["…"], ...extra });
  const defaultRows = () => getDefaultInteractions().map(({ id, label, mood, speak, lines }) => ({ id, label, mood, speak, lines }));

  it("loads the merged list with the shipped defaults", async () => {
    const { service } = interactionSetup([{ ...row({ id: "pat", label: "쓰다듬기", lines: ["내가 쓴 대사"] }), builtin: false } as PetInteraction]);
    const view = await service.interactionsLoad();
    expect(view.items.map(({ id }) => id)).toEqual(["pat", "talk", "scare"]);
    expect(view.items[0]).toMatchObject({ lines: ["내가 쓴 대사"], builtin: true });
    expect(view.defaults[0]?.lines).toEqual(getDefaultInteractions()[0]?.lines);
  });

  it("stores only what differs from the defaults and answers with the new list", async () => {
    const { service, stored } = interactionSetup();
    const items = [{ ...defaultRows()[0], lines: ["내가 쓴 대사"] }, ...defaultRows().slice(1), row()];
    const result = await service.interactionsSave({ items });
    expect(result).toMatchObject({ ok: true });
    expect(stored().map(({ id }) => id)).toEqual(["pat", "custom-1"]);
    expect(await service.interactionsSave({ items: defaultRows() })).toMatchObject({ ok: true });
    expect(stored()).toEqual([]);
  });

  it("refuses an invalid row with its index and saves nothing", async () => {
    const { service, saveInteractions } = interactionSetup();
    expect(await service.interactionsSave({ items: [row({ lines: ["가".repeat(121)] })] })).toEqual({ ok: false, errors: [{ path: "0", message: "대사는 120자 이하여야 해요" }] });
    expect(await service.interactionsSave({ items: [row(), row()] })).toEqual({ ok: false, errors: [{ path: "1", message: "같은 id가 이미 있어요" }] });
    expect(await service.interactionsSave({ items: [row({ lines: [" "] })] })).toEqual({ ok: false, errors: [{ path: "0", message: "대사를 한 줄 이상 적어 주세요" }] });
    expect(await service.interactionsSave({ items: [row({ speak: false, lines: [] })] })).toMatchObject({ ok: true });
    saveInteractions.mockClear();
    for (const bad of [null, [], "x", {}, { items: "x" }, { items: [null] }, { items: Array.from({ length: 16 }, (_, index) => row({ id: `n${index}` })) }]) {
      expect(await service.interactionsSave(bad)).toMatchObject({ ok: false });
    }
    expect(await service.interactionsSave({ items: [...defaultRows(), ...Array.from({ length: 13 }, (_, index) => row({ id: `n${index}` }))] }))
      .toEqual({ ok: false, errors: [{ path: "", message: "요청이 올바르지 않습니다" }] });
    expect(saveInteractions).not.toHaveBeenCalled();
  });

  it("reports a failed write", async () => {
    const { service, saveInteractions } = interactionSetup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    saveInteractions.mockRejectedValueOnce(new Error("disk"));
    expect(await service.interactionsSave({ items: [row()] })).toEqual({ ok: false, errors: [{ path: "", message: "저장하지 못했습니다" }] });
    error.mockRestore();
  });

  it("runs a checked interaction at most once a second and refuses a bad one", () => {
    const { service, ran, advance } = interactionSetup();
    expect(service.interactionsTry(row({ label: " 인사 " }))).toEqual({ ok: true });
    expect(ran[0]).toMatchObject({ label: "인사", lines: ["…"] });
    expect(service.interactionsTry(row())).toEqual({ ok: false, message: "너무 빨라요. 잠시 후 다시 눌러 주세요" });
    advance(1_000);
    expect(service.interactionsTry({ ...row(), mood: "angry" })).toEqual({ ok: false, message: "표정이 올바르지 않아요" });
    expect(service.interactionsTry(row())).toEqual({ ok: true });
    expect(ran).toHaveLength(2);
  });
});

describe("packInteractionsLoad", () => {
  function setup(loadInteractions: (id: unknown) => Promise<unknown>) {
    return createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined,
      packs: { loadInteractions } as unknown as NonNullable<SettingsBackend["packs"]>,
    });
  }

  it("returns the chosen pack's merged list with the defaults", async () => {
    const asked: unknown[] = [];
    const service = setup(async (id) => { asked.push(id); return { problems: ["x"], interactions: { version: 1,
      items: [{ id: "wave", label: "손", mood: "happy", bubble: true, lines: ["안녕"] }], hidden: [] } }; });
    const result = await service.packInteractionsLoad({ packId: "mine" }) as { ok: true; view: { items: PetInteraction[] }; problems: string[] };
    expect(asked).toEqual(["mine"]);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual(["x"]);
    expect(result.view.items.map(({ id }) => id)).toContain("wave");
  });

  it("fails on a bad payload or a rejected load", async () => {
    const service = setup(async () => { throw new Error("no such pack"); });
    expect(await service.packInteractionsLoad("mine")).toMatchObject({ ok: false });
    expect(await service.packInteractionsLoad({ packId: "mine" })).toMatchObject({ ok: false, errors: [{ message: "no such pack" }] });
  });
});

describe("sequences IPC", () => {
  function setup(packs: Partial<NonNullable<SettingsBackend["packs"]>> | undefined) {
    return createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined,
      ...(packs ? { packs: packs as NonNullable<SettingsBackend["packs"]> } : {}),
    });
  }

  it("passes the pack id and sequences through and wraps failures", async () => {
    const loadSequences = vi.fn(async () => ({ sequences: { sequences: [] }, problems: [], plays: {} }));
    const saveSequences = vi.fn(async (id: unknown, value: unknown) => { if (id === "bad") throw new Error("rejected"); void value; return { packId: String(id), derived: false }; });
    const service = setup({ loadSequences, saveSequences });
    expect(await service.sequencesLoad({ packId: "mine" })).toMatchObject({ ok: true, sequences: { sequences: [] } });
    expect(loadSequences).toHaveBeenCalledWith("mine");
    expect(await service.sequencesSave({ packId: "mine", sequences: { version: 1, sequences: [] } })).toMatchObject({ ok: true, packId: "mine" });
    expect(await service.sequencesSave({ packId: "bad", sequences: {} })).toMatchObject({ ok: false, errors: [{ message: "rejected" }] });
    for (const bad of [null, "x", []]) {
      expect(await service.sequencesLoad(bad)).toMatchObject({ ok: false });
      expect(await service.sequencesSave(bad)).toMatchObject({ ok: false });
    }
    expect(await setup(undefined).sequencesSave({ packId: "mine", sequences: {} })).toMatchObject({ ok: false });
  });
});

describe("reactions IPC", () => {
  it("passes a validated pack request through the settings service and reports write errors", async () => {
    const loadReactions = vi.fn(async () => ({ reactions: { kinds: {} }, problems: [], plays: {}, sequences: [] }));
    const saveReactions = vi.fn(async (id: unknown, value: unknown) => {
      if (id === "bad") throw new Error("rejected");
      void value;
      return { packId: String(id), derived: false };
    });
    const packs: Partial<NonNullable<SettingsBackend["packs"]>> = { loadReactions, saveReactions };
    const service = createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined,
      packs: packs as NonNullable<SettingsBackend["packs"]>,
    });
    expect(await service.reactionsLoad({ packId: "mine" })).toMatchObject({ ok: true, reactions: { kinds: {} } });
    expect(loadReactions).toHaveBeenCalledWith("mine");
    const body = { version: 1, kinds: { done: { play: "happy" } } };
    expect(await service.reactionsSave({ packId: "mine", reactions: body })).toMatchObject({ ok: true, packId: "mine" });
    expect(saveReactions).toHaveBeenCalledWith("mine", body);
    expect(await service.reactionsSave({ packId: "bad", reactions: body })).toMatchObject({ ok: false, errors: [{ message: "rejected" }] });
    for (const bad of [null, "x", []]) {
      expect(await service.reactionsLoad(bad)).toMatchObject({ ok: false });
      expect(await service.reactionsSave(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("motions IPC", () => {
  it("passes a validated pack request through the settings service and reports write errors", async () => {
    const loadMotions = vi.fn(async () => ({ motions: {}, landing: "normal" as const, problems: [], states: [],
      nonLoopStates: [], resolved: {} }));
    const saveMotions = vi.fn(async (id: unknown, value: unknown) => {
      if (id === "bad") throw new Error("rejected");
      void value;
      return { packId: String(id), derived: false };
    });
    const packs: Partial<NonNullable<SettingsBackend["packs"]>> = { loadMotions, saveMotions };
    const service = createSettingsService({
      doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "", templates: {}, problems: [] }), sendVoicePreview: () => undefined,
      interactionStore: { load: () => Promise.resolve([]), save: () => Promise.resolve() }, runInteraction: () => undefined,
      packs: packs as NonNullable<SettingsBackend["packs"]>,
    });
    expect(await service.motionsLoad({ packId: "mine" })).toMatchObject({ ok: true, landing: "normal" });
    expect(loadMotions).toHaveBeenCalledWith("mine");
    const body = { version: 1, motions: { land: { play: "happy" } }, landing: "soft" };
    expect(await service.motionsSave({ packId: "mine", motions: body })).toMatchObject({ ok: true, packId: "mine" });
    expect(saveMotions).toHaveBeenCalledWith("mine", body);
    expect(await service.motionsSave({ packId: "bad", motions: body })).toMatchObject({ ok: false, errors: [{ message: "rejected" }] });
    for (const bad of [null, "x", []]) {
      expect(await service.motionsLoad(bad)).toMatchObject({ ok: false });
      expect(await service.motionsSave(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("developer mode switch (D-044)", () => {
  const make = (available: boolean) => {
    const save = vi.fn(() => true);
    const service = createSettingsService({ doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "x", templates: {}, problems: [] }), sendVoicePreview: () => {},
      interactionStore: { load: async () => [], save: async () => {} }, runInteraction: () => {},
      developerMode: () => ({ available, enabled: false }), saveDeveloperMode: save });
    return { service, save };
  };

  it("reports availability in load and saves a boolean only when available", async () => {
    const on = make(true);
    expect((await on.service.load()).developerMode).toEqual({ available: true, enabled: false });
    expect(on.service.saveDeveloperMode({ enabled: true })).toEqual({ ok: true });
    expect(on.save).toHaveBeenCalledWith(true);
    for (const bad of [{ enabled: "yes" }, {}, null, "x"]) expect(on.service.saveDeveloperMode(bad).ok).toBe(false);
    expect(on.save).toHaveBeenCalledTimes(1);
    const off = make(false);
    expect(off.service.saveDeveloperMode({ enabled: true }).ok).toBe(false);
    expect(off.save).not.toHaveBeenCalled();
  });
});

describe("launch at login switch (ADR-0010 §6)", () => {
  const make = (available: boolean) => {
    const save = vi.fn(() => true);
    const service = createSettingsService({ doNotDisturb: () => ({ enabled: false }), saveDoNotDisturb: () => true, host: () => undefined,
      voice: () => ({ characterName: "x", templates: {}, problems: [] }), sendVoicePreview: () => {},
      interactionStore: { load: async () => [], save: async () => {} }, runInteraction: () => {},
      launchAtLogin: () => ({ available, enabled: true }), saveLaunchAtLogin: save });
    return { service, save };
  };

  it("reports the view in load and saves a boolean only when available", async () => {
    const on = make(true);
    expect((await on.service.load()).launchAtLogin).toEqual({ available: true, enabled: true });
    expect(on.service.saveLaunchAtLogin({ enabled: false })).toEqual({ ok: true });
    expect(on.save).toHaveBeenCalledWith(false);
    for (const bad of [{ enabled: "yes" }, {}, null, "x"]) expect(on.service.saveLaunchAtLogin(bad).ok).toBe(false);
    expect(on.save).toHaveBeenCalledTimes(1);
    const off = make(false);
    expect(off.service.saveLaunchAtLogin({ enabled: true }).ok).toBe(false);
    expect(off.save).not.toHaveBeenCalled();
  });
});
