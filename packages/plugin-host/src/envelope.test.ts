import { describe, expect, it } from "vitest";
import { isEnvelope, MAX_MESSAGE_BYTES, validateEnvelope } from "./envelope.js";

describe("plugin envelopes", () => {
  it("accepts each v1 envelope variant", () => {
    expect(isEnvelope({ v: 1, kind: "req", id: 1, method: "hello", params: null })).toBe(true);
    expect(isEnvelope({ v: 1, kind: "res", id: 1, ok: true, value: null })).toBe(true);
    expect(isEnvelope({ v: 1, kind: "res", id: 1, ok: false, error: { code: "E_PERMISSION", message: "denied" } })).toBe(true);
  });

  it.each([
    { v: 2, kind: "req", id: 1, method: "hello", params: null },
    { v: 1, kind: "req", id: 0, method: "hello", params: null },
    { v: 1, kind: "req", id: 1, method: "hello" },
    { v: 1, kind: "req", id: 1, method: "", params: null },
    { v: 1, kind: "res", id: 1, ok: false, error: "bad" },
    { v: 1, kind: "res", id: 1, ok: true, value: null, error: { code: "x", message: "x" } },
    null,
  ])("rejects malformed envelope %#", (value) => {
    expect(validateEnvelope(value)).toEqual({ ok: false, reason: "shape" });
  });

  it("enforces the 1 MiB encoded limit", () => {
    const base = { v: 1, kind: "req", id: 1, method: "x", params: "" };
    const overhead = Buffer.byteLength(JSON.stringify(base));
    expect(validateEnvelope({ ...base, params: "x".repeat(MAX_MESSAGE_BYTES - overhead) }).ok).toBe(true);
    expect(validateEnvelope({ ...base, params: "x".repeat(MAX_MESSAGE_BYTES - overhead + 1) })).toEqual({ ok: false, reason: "size" });
  });

  it("counts structured-clone binary data in messages", () => {
    for (const extra of [
      new ArrayBuffer(2 * MAX_MESSAGE_BYTES),
      new Uint8Array(2 * MAX_MESSAGE_BYTES),
      new DataView(new ArrayBuffer(2 * MAX_MESSAGE_BYTES)),
      new Map([["payload", new ArrayBuffer(2 * MAX_MESSAGE_BYTES)]]),
    ]) {
      expect(validateEnvelope({ v: 1, kind: "req", id: 1, method: "emit",
        params: { event: { source: "demo", type: "notify", extra } } }))
        .toEqual({ ok: false, reason: "size" });
    }
  });
});
