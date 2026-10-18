import { describe, expect, test } from "vitest";
import { ActionRegistry } from "./actions.js";

describe("ActionRegistry.register id format", () => {
  const registry = new ActionRegistry();
  test.each(["deskpet.ping", "a.b", "claude-code.done", "reminders.snooze-5m"])("allows '%s'", (id) => {
    expect(() => registry.register(id, () => undefined)).not.toThrow();
  });
  test.each(["ping", "", ".ping", "deskpet.", "deskpet..ping", "deskpet.ping.again", "Deskpet.ping", "deskpet/pi ng",
    "deskpet_.ping"])("rejects '%s'", (id) => {
    expect(() => registry.register(id, () => undefined)).toThrow(/Invalid action id/);
  });
  test("rejects a duplicate id until dispose reopens it", () => {
    const registry = new ActionRegistry();
    const disposable = registry.register("test.once", () => undefined);
    expect(() => registry.register("test.once", () => undefined)).toThrow(/already registered/);
    disposable.dispose();
    expect(() => registry.register("test.once", () => undefined)).not.toThrow();
  });
});

describe("ActionRegistry.invoke", () => {
  test("runs only registered handlers, with the given args", async () => {
    const registry = new ActionRegistry();
    const received: Array<unknown | undefined> = [];
    registry.register("test.run", (args) => { received.push(args); });
    await expect(registry.invoke("test.absent", {})).resolves.toEqual({ ok: false, reason: "not-found" });
    // An id that register() would reject can never be on the allowlist, so it is also not-found.
    await expect(registry.invoke("no-dot")).resolves.toEqual({ ok: false, reason: "not-found" });
    await registry.invoke("test.run");
    await registry.invoke("test.run", { value: 1 });
    expect(received).toEqual([undefined, { value: 1 }]);
  });
  test("awaits async handlers before reporting success", async () => {
    const registry = new ActionRegistry();
    let finished = false;
    registry.register("test.async", async () => { await Promise.resolve(); finished = true; });
    await expect(registry.invoke("test.async")).resolves.toEqual({ ok: true });
    expect(finished).toBe(true);
  });
  test("reports throwing handlers as failed instead of rejecting", async () => {
    const registry = new ActionRegistry();
    registry.register("test.sync", () => { throw new Error("boom"); });
    registry.register("test.async", async () => { throw new Error("async boom"); });
    await expect(registry.invoke("test.sync")).resolves.toEqual({ ok: false, reason: "failed", error: "boom" });
    await expect(registry.invoke("test.async")).resolves.toEqual({ ok: false, reason: "failed", error: "async boom" });
  });
  test("a stale dispose cannot remove a newer registration", async () => {
    const registry = new ActionRegistry();
    const first: string[] = [];
    const second: string[] = [];
    const stale = registry.register("test.once", () => { first.push("first"); });
    stale.dispose();
    stale.dispose();
    await expect(registry.invoke("test.once")).resolves.toEqual({ ok: false, reason: "not-found" });
    registry.register("test.once", () => { second.push("second"); });
    stale.dispose();
    await expect(registry.invoke("test.once")).resolves.toEqual({ ok: true });
    expect(first).toEqual([]);
    expect(second).toEqual(["second"]);
  });
});
