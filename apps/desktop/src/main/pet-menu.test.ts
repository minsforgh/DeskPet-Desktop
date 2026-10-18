import { describe, expect, test, vi } from "vitest";
import type { PetEvent } from "@deskpet/core";
import { buildPetMenuTemplate, checkInteraction, createInteractionRunner, findPetMenuClick, getDefaultInteractions, interactionEvent,
  interactionPlay, INTERACTION_PLAY, isUserDirect, mergeInteractions, petMenuLabels, sanitizeInteraction, sanitizeInteractions, userInteractionsToStore, USER_DIRECT,
  type PetInteraction, type PetMenuActions } from "./pet-menu.js";

const actions = (): PetMenuActions => ({ interact: vi.fn(), openSettings: vi.fn(), toggleDoNotDisturb: vi.fn(),
  hidePet: vi.fn(), openLogsFolder: vi.fn(), quitApp: vi.fn() });
const build = (extra: Partial<Parameters<typeof buildPetMenuTemplate>[0]> = {}) =>
  buildPetMenuTemplate({ interactions: getDefaultInteractions(), pluginItems: [], doNotDisturbChecked: false, actions: actions(), ...extra });
const shipped = getDefaultInteractions();
const shippedLabels = shipped.map(({ label }) => label);
const shippedPat = shipped[0] as PetInteraction;
const shippedTalk = shipped[1] as PetInteraction;
const shippedScare = shipped[2] as PetInteraction;
const item = (extra: Partial<PetInteraction> = {}): PetInteraction =>
  ({ id: "wave", label: "손 흔들기", mood: "happy", speak: true, lines: ["안녕!"], builtin: false, ...extra });
const notifyLike = (): PetEvent => ({ source: "http", type: "notify", text: "외부" });

test("the menu lists interactions, then system items", () => {
  expect(petMenuLabels(build())).toEqual([...shippedLabels, "-", "설정…", "방해 금지", "숨김", "오류 기록 폴더 열기", "종료"]);
});

test("plugin items are inserted flat between separators and left out when there are none", () => {
  const click = vi.fn();
  const template = build({ pluginItems: [{ label: "Alpha: 실행 중" }, { label: "인사", click }] });
  expect(petMenuLabels(template)).toEqual([...shippedLabels, "-", "Alpha: 실행 중", "인사", "-", "설정…", "방해 금지", "숨김", "오류 기록 폴더 열기", "종료"]);
  expect(template.some((entry) => entry.submenu !== undefined)).toBe(false);
  expect(template.find((entry) => entry.label === "Alpha: 실행 중")?.enabled).toBe(false);
  expect(template.find((entry) => entry.label === "인사")).toMatchObject({ click });
  expect(findPetMenuClick(template, "Alpha: 실행 중")).toBeUndefined();
  findPetMenuClick(template, "인사")?.();
  expect(click).toHaveBeenCalledOnce();
});

test("the do-not-disturb checkbox shows the current state", () => {
  for (const checked of [true, false]) {
    expect(build({ doNotDisturbChecked: checked }).find((entry) => entry.label === "방해 금지")).toMatchObject({ type: "checkbox", checked });
  }
});

test("system items call their actions and an interaction goes through interact", () => {
  const a = actions();
  const template = build({ actions: a });
  for (const label of ["설정…", "방해 금지", "숨김", "오류 기록 폴더 열기", "종료", shippedPat.label]) findPetMenuClick(template, label)?.();
  expect(a.openSettings).toHaveBeenCalledOnce();
  expect(a.toggleDoNotDisturb).toHaveBeenCalledOnce();
  expect(a.hidePet).toHaveBeenCalledOnce();
  expect(a.openLogsFolder).toHaveBeenCalledOnce();
  expect(a.quitApp).toHaveBeenCalledOnce();
  expect(a.interact).toHaveBeenCalledWith(getDefaultInteractions()[0]);
});

test("a speaking interaction is a normal-priority notify with the line as written and no voice", () => {
  expect(interactionEvent(getDefaultInteractions()[0] as PetInteraction)).toEqual({
    source: "pet-menu", type: "notify", key: "pet-menu.pat", text: shippedPat.lines[0], mood: "happy", priority: "normal", ttlMs: 4000,
    [USER_DIRECT]: true,
  });
  expect("voice" in interactionEvent(item())).toBe(false);
});

test("a silent interaction only changes the expression: a react without text", () => {
  expect(interactionEvent(item({ speak: false }))).toEqual({ source: "pet-menu", type: "react", key: "pet-menu.wave", mood: "happy", priority: "low", ttlMs: 4000, [USER_DIRECT]: true });
  expect(interactionEvent(item({ lines: [] }))).toMatchObject({ type: "react" });
});

test("interaction events carry the user-direct marker on a symbol key JSON cannot hold", () => {
  const speaking = interactionEvent(item());
  const silent = interactionEvent(item({ speak: false }));
  expect(isUserDirect(speaking)).toBe(true);
  expect(isUserDirect(silent)).toBe(true);
  expect(isUserDirect(notifyLike())).toBe(false);
  // The wire format has no symbol keys, so what arrives over HTTP /event or the CLI can never be user-direct,
  // even when a client adds a forged string-keyed field.
  const fromJson: PetEvent = JSON.parse(JSON.stringify({ ...speaking, userDirect: true }));
  expect(isUserDirect(fromJson)).toBe(false);
});

test("interaction play is internal and JSON or string-keyed external events cannot request it", () => {
  const event = interactionEvent(item({ mood: "happy", play: "surprised" }));
  expect(event.mood).toBe("happy");
  expect(interactionPlay(event)).toBe("surprised");
  expect(Reflect.get(event, INTERACTION_PLAY)).toBe("surprised");
  expect(interactionPlay(JSON.parse(JSON.stringify({ ...event, interactionPlay: "worried", play: "worried" })))).toBeUndefined();
  expect(interactionPlay(notifyLike())).toBeUndefined();
});

test("the lines are used in turn, per interaction", () => {
  const sent: string[] = [];
  let now = 0;
  const run = createInteractionRunner((event) => { sent.push(`${event.key}:${event.text}`); }, () => now);
  const a = item({ lines: ["하나", "둘", "셋"] });
  const b = item({ id: "other", lines: ["x", "y"] });
  for (let index = 0; index < 4; index += 1) { now += 1000; run(a); }
  now += 1000;
  run(b);
  expect(sent).toEqual(["pet-menu.wave:하나", "pet-menu.wave:둘", "pet-menu.wave:셋", "pet-menu.wave:하나", "pet-menu.other:x"]);
});

test("the defaults are three speaking built-ins and changing one call's result does not change the next", () => {
  const first = getDefaultInteractions();
  expect(first.map(({ id, mood, speak, lines, builtin }) => [id, mood, speak, lines, builtin])).toEqual(
    shipped.map(({ id, mood, speak, lines, builtin }) => [id, mood, speak, lines, builtin]));
  (first[0] as PetInteraction).lines.push("바뀜");
  (first[0] as PetInteraction).label = "바뀜";
  expect(getDefaultInteractions()[0]).toEqual(shippedPat);
});

describe("sanitizeInteraction", () => {
  test("accepts safe play and sequence names and rejects malformed play names", () => {
    for (const play of ["a", "bow-2", "a".repeat(32)])
      expect(checkInteraction({ ...item(), play })).toMatchObject({ ok: true, value: { play } });
    for (const play of ["", "2bow", "Bow", "bow_2", "a".repeat(33), "constructor", "__proto__", 3, null])
      expect(checkInteraction({ ...item(), play })).toEqual({ ok: false, message: "재생 동작이 올바르지 않아요" });
    expect(checkInteraction({ ...item(), sequence: "greeting" })).toMatchObject({ ok: true, value: { sequence: "greeting" } });
    expect(checkInteraction({ ...item(), sequence: "" })).toEqual({ ok: false, message: "시퀀스가 올바르지 않아요" });
  });
  test("keeps a valid item, trims the label and the lines and drops blank lines", () => {
    expect(sanitizeInteraction({ id: "a-1", label: "  인사 ", mood: "sleepy", speak: false, lines: ["  안녕 ", "   ", "", "잘 가"] }))
      .toEqual({ id: "a-1", label: "인사", mood: "sleepy", speak: false, lines: ["안녕", "잘 가"], builtin: false });
    expect(sanitizeInteraction({ ...item(), hidden: true, builtin: true })).toEqual({ ...item(), hidden: true, builtin: false });
  });

  test("refuses bad ids, labels, moods, flags and non-objects", () => {
    for (const bad of [null, "x", [], { ...item(), id: "Upper" }, { ...item(), id: "" }, { ...item(), id: "a".repeat(33) }, { ...item(), id: "한글" },
      { ...item(), id: 3 }, { ...item(), label: "" }, { ...item(), label: "   " }, { ...item(), label: "가".repeat(21) }, { ...item(), label: "a\u0000b" },
      { ...item(), label: "줄\n바꿈" }, { ...item(), mood: "angry" }, { ...item(), mood: 1 }, { ...item(), speak: "yes" }, { ...item(), speak: undefined },
      { ...item(), hidden: "yes" }, { ...item(), lines: "x" }, { ...item(), lines: [1] }]) {
      expect(sanitizeInteraction(bad)).toBeUndefined();
    }
    expect(sanitizeInteraction({ ...item(), label: "가".repeat(20) })).toBeDefined();
    expect(sanitizeInteraction({ ...item(), id: "a".repeat(32) })).toBeDefined();
  });

  test("lines: at most 16, each at most 120 code points, no control characters or line breaks", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `줄 ${index}`);
    expect(sanitizeInteraction({ ...item(), lines: lines(16) })?.lines).toHaveLength(16);
    expect(sanitizeInteraction({ ...item(), lines: lines(17) })).toBeUndefined();
    expect(sanitizeInteraction({ ...item(), lines: [...lines(16), "  "] })?.lines).toHaveLength(16);
    expect(sanitizeInteraction({ ...item(), lines: ["가".repeat(120)] })).toBeDefined();
    expect(checkInteraction({ ...item(), lines: ["가".repeat(121)] })).toEqual({ ok: false, message: "대사는 120자 이하여야 해요" });
    expect(sanitizeInteraction({ ...item(), lines: ["😀".repeat(120)] })).toBeDefined();
    expect(sanitizeInteraction({ ...item(), lines: ["😀".repeat(121)] })).toBeUndefined();
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\tb", "\u007f", "\u001b[31m"]) expect(sanitizeInteraction({ ...item(), lines: [bad] })).toBeUndefined();
  });

  test("inherited properties do not count", () => {
    const sneaky = Object.create({ id: "wave", label: "x", mood: "happy", speak: true, lines: [] }) as unknown;
    expect(sanitizeInteraction(sneaky)).toBeUndefined();
  });
});

describe("mergeInteractions", () => {
  test("a partial list overwrites shipped entries in place and puts added ones after", () => {
    const merged = mergeInteractions(getDefaultInteractions(), [item({ id: "wave" }), item({ id: "talk", label: "대화", lines: ["네?"] })]);
    expect(merged.map(({ id }) => id)).toEqual(["pat", "talk", "scare", "wave"]);
    expect(merged[1]).toMatchObject({ label: "대화", lines: ["네?"], builtin: true });
    expect(merged[0]).toEqual(getDefaultInteractions()[0]);
    expect(merged[3]?.builtin).toBe(false);
  });

  test("a full list keeps the order as written", () => {
    const ordered = mergeInteractions(getDefaultInteractions(), [item({ id: "scare" }), item({ id: "wave" }), item({ id: "pat" }), item({ id: "talk" })]);
    expect(ordered.map(({ id }) => id)).toEqual(["scare", "wave", "pat", "talk"]);
    expect(ordered.map(({ builtin }) => builtin)).toEqual([true, false, true, true]);
    const hidden = mergeInteractions(getDefaultInteractions(), [item({ id: "talk" }), item({ id: "scare" }), item({ id: "pat", hidden: true })]);
    expect(hidden.map(({ id }) => id)).toEqual(["talk", "scare", "pat"]);
  });

  test("legacy custom-only lists keep defaults first", () => {
    const merged = mergeInteractions(getDefaultInteractions(), [item({ id: "b" }), item({ id: "a" })]);
    expect(merged.map(({ id }) => id)).toEqual(["pat", "talk", "scare", "b", "a"]);
    expect(merged.slice(3).every(({ builtin }) => !builtin)).toBe(true);
  });

  test("hidden items stay in the list but not in the menu", () => {
    const merged = mergeInteractions(getDefaultInteractions(), [item({ id: "pat", label: shippedPat.label, lines: shippedPat.lines, hidden: true })]);
    expect(merged[0]?.hidden).toBe(true);
    expect(petMenuLabels(build({ interactions: merged })).slice(0, 3)).toEqual([shippedTalk.label, shippedScare.label, "-"]);
  });

  test("invalid and repeated items are dropped, and no more than 12 new ones are added", () => {
    const many = Array.from({ length: 15 }, (_, index) => item({ id: `n${index}` }));
    const merged = mergeInteractions(getDefaultInteractions(), [{ id: "BAD" }, null, item({ id: "n0", label: "첫째" }), ...many]);
    expect(merged).toHaveLength(15);
    expect(merged[3]?.label).toBe("첫째");
    expect(sanitizeInteractions([{ id: "BAD" }, item({ id: "x" }), item({ id: "x", label: "또" })]).map(({ label }) => label)).toEqual(["손 흔들기"]);
    expect(sanitizeInteractions(many)).toHaveLength(12);
    expect(sanitizeInteractions("no")).toEqual([]);
  });

  test("does not change its inputs", () => {
    const defaults = getDefaultInteractions();
    const before = JSON.stringify(defaults);
    mergeInteractions(defaults, [item({ id: "pat" })]);
    expect(JSON.stringify(defaults)).toBe(before);
  });
});

test("only changed built-ins and added items are stored", () => {
  const defaults = getDefaultInteractions();
  const edited = mergeInteractions(defaults, [item({ id: "pat", label: shippedPat.label, lines: ["내가 쓴 대사"] }), item()]);
  expect(userInteractionsToStore(defaults, edited).map(({ id }) => id)).toEqual(["pat", "wave"]);
  expect(userInteractionsToStore(defaults, mergeInteractions(defaults, []))).toEqual([]);
});

test("the same interaction fires at most once per 500 ms", () => {
  let now = 1000;
  const send = vi.fn();
  const run = createInteractionRunner(send, () => now);
  const pat = item({ id: "pat", lines: ["a"] });
  const talk = item({ id: "talk", lines: ["b"] });
  expect(run(pat)).toBe(true);
  now = 1499;
  expect(run(pat)).toBe(false);
  expect(run(talk)).toBe(true);
  now = 1500;
  expect(run(pat)).toBe(true);
  expect(send).toHaveBeenCalledTimes(3);
});

test("adding one entry to the interaction list adds one menu item", () => {
  const more = [...getDefaultInteractions(), item()];
  expect(petMenuLabels(build({ interactions: more })).slice(0, 4)).toEqual([...shippedLabels, "손 흔들기"]);
});
