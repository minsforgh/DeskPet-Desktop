import { describe, expect, it } from "vitest";
import { validatePetEvent, validateReactionRule } from "@deskpet/core";

describe("M3 event and reaction limits", () => {
  it("validates line object and variable values", () => {
    const event = { source: "orca", type: "notify", line: { id: "orca.done", vars: { task: "😀".repeat(500) } } };
    expect(validatePetEvent(event).ok).toBe(true);
    for (const line of [null, {}, { id: "" }, { id: "orca.done", extra: true },
      { id: "orca.done", vars: [] }, { id: "orca.done", vars: { task: "😀".repeat(501) } },
      { id: "orca.done", vars: { task: "a\nb" } }, { id: "orca.done", vars: { task: "a\u007fb" } }])
      expect(validatePetEvent({ ...event, line }).ok).toBe(false);
  });
  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(validatePetEvent({ source: "http", type: "notify", text: "😀".repeat(120) }).ok).toBe(true);
    expect(validatePetEvent({ source: "http", type: "notify", text: "😀".repeat(121) }).ok).toBe(false);
  });

  it("accepts only safe integer TTL and timestamp boundaries", () => {
    for (const ttlMs of [1, Number.MAX_SAFE_INTEGER])
      expect(validatePetEvent({ source: "http", type: "notify", ttlMs }).ok).toBe(true);
    for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(validatePetEvent({ source: "http", type: "notify", ttlMs }).ok).toBe(false);
    for (const timestamp of [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER])
      expect(validatePetEvent({ source: "http", type: "notify", timestamp }).ok).toBe(true);
    for (const timestamp of [Number.MIN_SAFE_INTEGER - 1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(validatePetEvent({ source: "http", type: "notify", timestamp }).ok).toBe(false);
  });

  it("checks duration and repeat at their inclusive integer boundaries", () => {
    for (const [durationMs, repeat] of [[1, 1], [60_000, 10]]) {
      expect(validateReactionRule({ match: {}, play: "happy", durationMs, repeat }).ok).toBe(true);
    }
    for (const [durationMs, repeat] of [[0, 1], [60_001, 1], [1.5, 1], [1, 0], [1, 11], [1, 2.5]]) {
      expect(validateReactionRule({ match: {}, play: "happy", durationMs, repeat }).ok).toBe(false);
    }
  });

  it("uses the pack relative sheet path rules for sound", () => {
    for (const sound of ["sounds/warning.wav", "한글/알림.wav"]) {
      expect(validateReactionRule({ match: {}, play: "happy", sound }).ok).toBe(true);
    }
    for (const sound of ["../warning.wav", "sounds/../warning.wav", "/warning.wav", "C:/warning.wav", "sounds\\warning.wav", "sounds//warning.wav", "sounds/file. "]) {
      const result = validateReactionRule({ match: {}, play: "happy", sound });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("sound");
    }
  });

  it("names invalid fields in errors", () => {
    const result = validatePetEvent({ type: "notify", actions: [{ label: 1, action: false }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/source.*actions\[0\]\.label.*actions\[0\]\.action/u);
  });
});
