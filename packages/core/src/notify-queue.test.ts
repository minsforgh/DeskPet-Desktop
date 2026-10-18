import { describe, expect, it } from "vitest";
import { NotificationQueue } from "@deskpet/core";
import type { PetEvent } from "@deskpet/core";

const event = (text: string, extra: Partial<PetEvent> = {}): PetEvent => ({ source: "source", type: "notify", text, ...extra });
const take = (queue: NotificationQueue, nowMs: number) => queue.next(nowMs).notification;

describe("NotificationQueue", () => {
  it("accepts only notify and orders by priority then arrival", () => {
    const queue = new NotificationQueue({ minBubbleIntervalMs: 0 });
    expect(queue.enqueue(event("react", { type: "react" }), 0)).toBe(false);
    expect(queue.enqueue(event("status", { type: "status" }), 0)).toBe(false);
    for (const [text, priority] of [["normal1", undefined], ["low", "low"], ["high1", "high"], ["urgent", "urgent"], ["high2", "high"], ["normal2", "normal"]] as const) {
      queue.enqueue(event(text, { source: text, key: text, ...(priority ? { priority } : {}) }), 0);
    }
    expect(Array.from({ length: 6 }, () => take(queue, 0)?.event.text)).toEqual(["urgent", "high1", "high2", "normal1", "normal2", "low"]);
  });

  it("replaces a source and key with the latest event at its first position", () => {
    const queue = new NotificationQueue({ minBubbleIntervalMs: 0 });
    queue.enqueue(event("old", { key: "a" }), 0);
    queue.enqueue(event("other", { key: "b" }), 1);
    queue.enqueue(event("new", { key: "a", ttlMs: 100 }), 2);
    queue.enqueue(event("different source", { source: "other", key: "a" }), 3);
    expect(queue.snapshot().pendingCount).toBe(3);
    expect([take(queue, 4)?.event.text, take(queue, 4)?.event.text, take(queue, 4)?.event.text]).toEqual(["new", "other", "different source"]);
  });

  it("keeps structured text on its own event through replacement and omits it from grouped titles", () => {
    const parts = { prefix: "Start", content: "new", suffix: "End" };
    const queue = new NotificationQueue({ minBubbleIntervalMs: 0 });
    const oldNotice = { ...event("old", { key: "same" }), parts: { ...parts, content: "old" } };
    const newNotice = { ...event("new", { key: "same" }), parts, fullText: "Start new End" };
    queue.enqueue(oldNotice, 0);
    queue.enqueue(newNotice, 1);
    expect(take(queue, 1)?.event).toMatchObject({ text: "new", parts, fullText: "Start new End" });
    const grouped = new NotificationQueue({ minBubbleIntervalMs: 0 });
    for (let index = 0; index < 3; index += 1) {
      const notice = { ...event(`notice ${index}`), parts };
      grouped.enqueue(notice, index);
    }
    const title = take(grouped, 2)?.event;
    expect(title?.text).toBe("source 알림 3개");
    expect(title).not.toHaveProperty("parts");
    expect(title).not.toHaveProperty("fullText");
  });

  it("groups three events from one source within the inclusive 30-second window, even with keys", () => {
    const queue = new NotificationQueue({ minBubbleIntervalMs: 0 });
    queue.enqueue(event("one"), 0);
    queue.enqueue(event("two"), 29_999);
    expect(take(queue, 29_999)?.event.text).toBe("one");
    queue.enqueue(event("three"), 30_000);
    expect(take(queue, 30_000)?.event.text).toBe("two");
    expect(take(queue, 30_000)?.event.text).toBe("three");
    const grouped = new NotificationQueue({ minBubbleIntervalMs: 0 });
    grouped.enqueue(event("one", { priority: "low" }), 0);
    grouped.enqueue(event("two", { priority: "high" }), 20_000);
    grouped.enqueue(event("three"), 30_000);
    const notification = take(grouped, 30_000);
    expect(notification?.event).toMatchObject({ text: "source 알림 3개", detail: "one\ntwo\nthree", priority: "high" });
    expect(notification?.groupedEvents).toHaveLength(3);
    expect(notification?.expressionOnly).toBe(false);
    const keyed = new NotificationQueue({ minBubbleIntervalMs: 0 });
    for (const [index, text] of ["a", "b", "c"].entries()) keyed.enqueue(event(text, { key: text }), index);
    expect(take(keyed, 2)?.groupedEvents?.map(({ key }) => key)).toEqual(["a", "b", "c"]);
    const outside = new NotificationQueue({ minBubbleIntervalMs: 0 });
    outside.enqueue(event("one"), 0);
    outside.enqueue(event("two"), 30_001);
    outside.enqueue(event("three"), 30_002);
    expect(take(outside, 30_002)?.event.text).toBe("one");
  });

  it("enforces five seconds between bubbles including urgent", () => {
    const queue = new NotificationQueue();
    queue.enqueue(event("first"), 0);
    expect(take(queue, 0)?.event.text).toBe("first");
    queue.enqueue(event("second"), 1);
    expect(queue.next(4_999)).toEqual({ nextAtMs: 5_000 });
    queue.enqueue(event("urgent", { priority: "urgent" }), 4_999);
    expect(queue.next(4_999)).toEqual({ nextAtMs: 5_000 });
    expect(take(queue, 5_000)?.event.text).toBe("urgent");
    expect(queue.next(9_999)).toEqual({ nextAtMs: 10_000 });
    expect(take(queue, 10_000)?.event.text).toBe("second");
  });

  it("discards expired events immediately before delivery and keeps the TTL boundary", () => {
    const queue = new NotificationQueue({ minBubbleIntervalMs: 0 });
    queue.enqueue(event("expired", { ttlMs: 10 }), 100);
    queue.enqueue(event("live", { ttlMs: 10 }), 101);
    expect(take(queue, 111)?.event.text).toBe("live");
    expect(queue.snapshot()).toMatchObject({ pendingCount: 0, expiredDropped: 1 });
  });

  it("marks low as expression only and does not consume bubble spacing", () => {
    const queue = new NotificationQueue();
    queue.enqueue(event("first"), 0);
    take(queue, 0);
    queue.enqueue(event("low", { priority: "low" }), 1);
    expect(take(queue, 1)).toMatchObject({ expressionOnly: true, event: { text: "low" } });
    queue.enqueue(event("next"), 2);
    expect(queue.next(4_999)).toEqual({ nextAtMs: 5_000 });
  });

  it("drops the oldest among lowest priority when the pending cap is exceeded", () => {
    const queue = new NotificationQueue({ maxPending: 3, minBubbleIntervalMs: 0 });
    queue.enqueue(event("high", { source: "high", priority: "high", key: "high" }), 0);
    queue.enqueue(event("low1", { source: "low1", priority: "low", key: "low1" }), 1);
    queue.enqueue(event("low2", { source: "low2", priority: "low", key: "low2" }), 2);
    queue.enqueue(event("normal", { source: "normal", key: "normal" }), 3);
    expect(queue.snapshot()).toMatchObject({ pendingCount: 3, overflowDropped: 1 });
    expect(Array.from({ length: 3 }, () => take(queue, 3)?.event.text)).toEqual(["high", "normal", "low2"]);
    const defaultQueue = new NotificationQueue();
    for (let index = 0; index < 101; index += 1) defaultQueue.enqueue(event(String(index), { source: String(index), key: String(index) }), index);
    expect(defaultQueue.snapshot()).toMatchObject({ pendingCount: 100, overflowDropped: 1 });
  });

  it("expires pending entries before applying the capacity limit", () => {
    const queue = new NotificationQueue({ maxPending: 2, minBubbleIntervalMs: 0 });
    queue.enqueue(event("old", { source: "old", key: "old", priority: "high", ttlMs: 1 }), 0);
    queue.enqueue(event("keep", { source: "keep", key: "keep", priority: "low" }), 0);
    queue.enqueue(event("new", { source: "new", key: "new" }), 2);
    expect(queue.snapshot()).toMatchObject({ pendingCount: 2, expiredDropped: 1, overflowDropped: 0 });
    expect([take(queue, 2)?.event.text, take(queue, 2)?.event.text]).toEqual(["new", "keep"]);
  });

  it("uses an injected delivery gate and leaves blocked notifications pending", () => {
    let allowed = false;
    const queue = new NotificationQueue({ canDeliver: (notification) => notification.event.priority === "urgent" || allowed, minBubbleIntervalMs: 0 });
    queue.enqueue(event("normal"), 0);
    expect(queue.next(0)).toEqual({ nextAtMs: undefined });
    queue.enqueue(event("urgent", { priority: "urgent" }), 1);
    expect(take(queue, 1)?.event.text).toBe("urgent");
    allowed = true;
    expect(take(queue, 1)?.event.text).toBe("normal");
  });

  it("accepts policy option overrides", () => {
    const queue = new NotificationQueue({ groupWindowMs: 10, groupThreshold: 2, minBubbleIntervalMs: 7, maxPending: 2 });
    queue.enqueue(event("one"), 0);
    queue.enqueue(event("two"), 10);
    expect(take(queue, 10)?.event.text).toBe("source 알림 2개");
    queue.enqueue(event("three"), 11);
    expect(queue.next(16)).toEqual({ nextAtMs: 17 });
  });
});
