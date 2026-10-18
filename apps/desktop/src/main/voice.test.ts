import { describe, expect, it } from "vitest";
import type { PetEvent } from "@deskpet/core";
import { applyVoice, type VoiceCounters } from "./voice.js";

const templates = { done: ["{task} 끝", "{task} 완료"] };
const base: PetEvent = { source: "claude", type: "notify", text: "원래 문구", detail: "d", key: "k", priority: "high",
  actions: [{ label: "열기", action: "x" }], ttlMs: 1000 };

describe("applyVoice", () => {
  it("uses user, pack, catalog, then text and skips unusable variants without kind templates", () => {
    const event = { ...base, line: { id: "fixture.done", vars: { task: "빌드" } }, voice: { kind: "done" as const } };
    const counters: VoiceCounters = {};
    const catalog = { version: 1 as const, lines: [{ id: "fixture.done", label: "Done", kind: "done" as const,
      variables: ["task"], variants: ["목록 {task}"] }] };
    const context = { catalogs: [catalog], packLines: { "fixture.done": ["팩 {task}"] },
      overrides: { "fixture.done": ["사용자 {task}"] } };
    expect(applyVoice(event, templates, counters, context).text).toBe("사용자 빌드");
    context.overrides["fixture.done"] = ["{missing}"];
    expect(applyVoice(event, templates, counters, context).text).toBe("팩 빌드");
    context.packLines["fixture.done"] = ["{missing}"];
    expect(applyVoice(event, templates, counters, context).text).toBe("목록 빌드");
    const listed = catalog.lines[0];
    if (!listed) throw new Error("Fixture line missing");
    listed.variants = ["{missing}"];
    expect(applyVoice(event, templates, counters, context).text).toBe("원래 문구");
    expect(applyVoice({ ...event, text: undefined }, templates, counters, context).text).toBeUndefined();
    expect(applyVoice({ ...event, line: undefined }, templates, counters, context).text).toBe("원래 문구");
  });
  it("returns an event without voice untouched", () => {
    const counters: VoiceCounters = {};
    expect(applyVoice(base, templates, counters)).toBe(base);
    expect(counters).toEqual({});
  });
  it("replaces only text with the rendering and rotates variants per kind", () => {
    const counters: VoiceCounters = {};
    const event = { ...base, voice: { kind: "done", slots: { task: "빌드" } } } as const;
    const first = applyVoice(event, templates, counters);
    expect(first).toEqual({ ...event, text: "빌드 끝", fullText: "빌드 끝" });
    expect(applyVoice(event, templates, counters).text).toBe("빌드 완료");
    expect(applyVoice(event, templates, counters).text).toBe("빌드 끝");
  });
  it("keeps structured parts with the rendered sentence and leaves plain events flat", () => {
    const counters: VoiceCounters = {};
    const structured = { done: [{ prefix: "앞말", content: "{task} 완료", suffix: "끝말" }] };
    const event = { ...base, voice: { kind: "done" as const, slots: { task: "빌드" } } };
    expect(applyVoice(event, structured, counters)).toMatchObject({ text: "앞말 빌드 완료 끝말",
      fullText: "앞말 빌드 완료 끝말", parts: { prefix: "앞말", content: "빌드 완료", suffix: "끝말" } });
    expect(applyVoice(base, structured, counters)).toBe(base);
  });
  it("keeps the sent text when there is no template for the kind or no slot value", () => {
    const counters: VoiceCounters = {};
    expect(applyVoice({ ...base, voice: { kind: "failed", slots: { task: "x" } } }, templates, counters)).toEqual({ ...base, voice: { kind: "failed", slots: { task: "x" } } });
    expect(applyVoice({ ...base, voice: { kind: "done" } }, templates, counters).text).toBe("원래 문구");
    expect(applyVoice({ ...base, voice: { kind: "done", slots: { task: "x" } } }, {}, counters).text).toBe("원래 문구");
    expect(counters).toEqual({});
  });
});
