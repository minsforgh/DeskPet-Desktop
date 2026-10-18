import { describe, expect, it } from "vitest";
import { MemoryPluginChannel } from "./channel.js";

describe("memory plugin channel", () => {
  it("delivers cloned messages in both directions and emits exit once", async () => {
    const [host, plugin] = MemoryPluginChannel.pair();
    const received: unknown[] = [];
    const exits: (number | null)[] = [];
    plugin.onMessage((message) => received.push(message));
    host.onMessage((message) => received.push(message));
    host.onExit((code) => exits.push(code));
    plugin.onExit((code) => exits.push(code));
    const request = { v: 1 as const, kind: "req" as const, id: 1, method: "hello", params: { value: 1 } };
    host.post(request);
    plugin.post({ v: 1, kind: "res", id: 1, ok: true, value: "ready" });
    await Promise.resolve();
    expect(received).toEqual([request, { v: 1, kind: "res", id: 1, ok: true, value: "ready" }]);
    expect(received[0]).not.toBe(request);
    host.kill();
    host.kill();
    expect(exits).toEqual([null, null]);
    plugin.post(request);
    await Promise.resolve();
    expect(received).toHaveLength(2);
  });
});
