import { expect, test } from "vitest";
import type { PetEvent } from "@deskpet/core";
import { BUBBLE_EXPANDED_MAX_MS, BUBBLE_INTERVAL_MS, NotificationDelivery, type ShownBubble } from "./delivery.js";
import { getDefaultInteractions, interactionEvent, isUserDirect, type PetInteraction } from "./pet-menu.js";

function setup() {
  const world = { now: 0, active: true, quiet: false, reactions: [] as PetEvent[], shown: [] as (string | undefined)[],
    timer: undefined as number | undefined, schedules: 0 };
  const delivery = new NotificationDelivery({
    now: () => world.now,
    active: () => world.active,
    quiet: () => world.quiet,
    react: (event) => { world.reactions.push(event); },
    bubbleChanged: (bubble: ShownBubble | undefined) => { world.shown.push(bubble?.text); },
    schedule: (atMs) => { world.timer = atMs; world.schedules += 1; },
  });
  const advance = (ms: number): void => { world.now += ms; delivery.pump(); };
  return { world, delivery, advance };
}

const notify = (text: string, extra: Partial<PetEvent> = {}): PetEvent => ({ source: text, type: "notify", text, ...extra });
const shipped = getDefaultInteractions();
const shippedPat = shipped[0] as PetInteraction;
const shippedTalk = shipped[1] as PetInteraction;

test("a visible sequence notice replaces its step immediately and respects its duration", () => {
  const { world, delivery, advance } = setup();
  expect(delivery.showImmediately(interactionEvent(getDefaultInteractions()[0] as PetInteraction))).toBe(true);
  expect(delivery.current?.text).toBe(shippedPat.lines[0]);
  const step = { ...interactionEvent(getDefaultInteractions()[0] as PetInteraction), text: "단계", ttlMs: 8_000 };
  expect(delivery.showImmediately(step)).toBe(true);
  expect(delivery.current).toMatchObject({ text: "단계", closeAtMs: 8_000 });
  expect(world.timer).toBe(8_000);
  advance(8_000);
  expect(delivery.current).toBeUndefined();
});

test("a shown external notice interrupts immediately but a held notice does not", () => {
  const { world, delivery } = setup();
  delivery.showImmediately(interactionEvent(getDefaultInteractions()[0] as PetInteraction));
  world.quiet = true;
  expect(delivery.showImmediately(notify("보류"))).toBe(false);
  delivery.enqueue(notify("보류"));
  expect(delivery.current?.text).toBe(shippedPat.lines[0]);
  expect(delivery.pending).toBe(1);
  expect(delivery.showImmediately(notify("긴급", { priority: "urgent" }))).toBe(true);
  expect(delivery.current?.text).toBe("긴급");
  expect(world.reactions.at(-1)?.text).toBe("긴급");
});

test("notification actions follow the shown bubble", () => {
  const { delivery } = setup();
  const actions = [{ label: "Ping", action: "deskpet.ping" }];
  delivery.enqueue(notify("choose", { actions }));
  expect(delivery.current?.actions).toEqual(actions);
  delivery.dismiss();
  expect(delivery.current).toBeUndefined();
});

test("structured parts and full text stay with the queued or immediate bubble", () => {
  const { delivery, advance } = setup();
  const parts = { prefix: "Start", content: "message", suffix: "End" };
  const structured = { ...notify("first"), parts, fullText: "Start message End" };
  delivery.enqueue(structured);
  expect(delivery.current).toMatchObject({ text: "first", parts, fullText: "Start message End" });
  delivery.dismiss();
  advance(BUBBLE_INTERVAL_MS);
  delivery.enqueue(notify("plain"));
  expect(delivery.current).toMatchObject({ text: "plain" });
  expect(delivery.current?.parts).toBeUndefined();
  const immediate = { ...notify("immediate"), parts, fullText: "Start message End" };
  expect(delivery.showImmediately(immediate)).toBe(true);
  expect(delivery.current).toMatchObject({ text: "immediate", parts, fullText: "Start message End" });
});

test("detail follows queued replacement and immediate display without leaking into the next bubble", () => {
  const { delivery, advance } = setup();
  delivery.enqueue(notify("blocking"));
  delivery.enqueue(notify("old", { source: "same", key: "key", detail: "old detail" }));
  delivery.enqueue(notify("new", { source: "same", key: "key", detail: "new detail" }));
  delivery.dismiss();
  advance(BUBBLE_INTERVAL_MS);
  expect(delivery.current).toMatchObject({ text: "new", detail: "new detail" });
  expect(delivery.showImmediately(notify("immediate", { detail: "immediate detail" }))).toBe(true);
  expect(delivery.current).toMatchObject({ text: "immediate", detail: "immediate detail" });
  delivery.dismiss();
  expect(delivery.current).toBeUndefined();
});

test("no timer exists until a notification is waiting or showing", () => {
  const { world, delivery } = setup();
  delivery.pump();
  expect(world.timer).toBeUndefined();
  delivery.enqueue(notify("a"));
  expect(delivery.current).toMatchObject({ text: "a", priority: "normal", closeAtMs: 6_000 });
  expect(world.timer).toBe(6_000);
  delivery.dismiss();
  expect(delivery.current).toBeUndefined();
  expect(delivery.pending).toBe(0);
  expect(world.timer).toBeUndefined();
});

test("bubbles last 6, 10, and 15 seconds by priority", () => {
  for (const [priority, ms] of [["normal", 6_000], ["high", 10_000], ["urgent", 15_000]] as const) {
    const { delivery, advance } = setup();
    delivery.enqueue(notify("a", { priority }));
    advance(ms - 1);
    expect(delivery.current?.text).toBe("a");
    advance(1);
    expect(delivery.current).toBeUndefined();
  }
});

test("expansion pauses the remaining time and collapse resumes it", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("long", { detail: "more" }));
  const sequence = delivery.current?.sequence;
  if (sequence === undefined) throw new Error("Bubble was not shown");
  advance(1_000);
  delivery.setExpanded(sequence, true);
  expect(world.timer).toBe(1_000 + BUBBLE_EXPANDED_MAX_MS);
  advance(10_000);
  expect(delivery.current?.text).toBe("long");
  delivery.setExpanded(sequence, false);
  expect(world.timer).toBe(16_000);
  advance(4_999);
  expect(delivery.current?.text).toBe("long");
  advance(1);
  expect(delivery.current).toBeUndefined();
});

test("collapse gives at least three seconds when little time remained", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("long"));
  const sequence = delivery.current?.sequence;
  if (sequence === undefined) throw new Error("Bubble was not shown");
  advance(5_900);
  delivery.setExpanded(sequence, true);
  advance(20_000);
  delivery.setExpanded(sequence, false);
  expect(world.timer).toBe(28_900);
  advance(2_999);
  expect(delivery.current?.text).toBe("long");
  advance(1);
  expect(delivery.current).toBeUndefined();
});

test("an expanded bubble closes at the five-minute limit and releases queued notifications", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("long"));
  const sequence = delivery.current?.sequence;
  if (sequence === undefined) throw new Error("Bubble was not shown");
  delivery.setExpanded(sequence, true);
  delivery.enqueue(notify("waiting"));
  advance(BUBBLE_EXPANDED_MAX_MS - 1);
  expect(delivery.current?.text).toBe("long");
  advance(1);
  expect(delivery.current).toBeUndefined();
  expect(world.timer).toBe(BUBBLE_EXPANDED_MAX_MS + BUBBLE_INTERVAL_MS);
  advance(BUBBLE_INTERVAL_MS);
  expect(delivery.current?.text).toBe("waiting");
});

test("replacement clears expansion and stale renderer updates cannot change its timer", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("first"));
  const sequence = delivery.current?.sequence;
  if (sequence === undefined) throw new Error("Bubble was not shown");
  delivery.setExpanded(sequence, true);
  expect(delivery.showImmediately(notify("urgent", { priority: "urgent" }))).toBe(true);
  expect(world.timer).toBe(15_000);
  delivery.setExpanded(sequence, false);
  delivery.setExpanded(sequence, true);
  expect(world.timer).toBe(15_000);
  advance(15_000);
  expect(delivery.current).toBeUndefined();
});

test("the next bubble waits five seconds after the previous one closes", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("b"));
  expect(delivery.pending).toBe(1);
  advance(6_000);
  expect(delivery.current).toBeUndefined();
  expect(world.timer).toBe(11_000);
  advance(4_999);
  expect(delivery.current).toBeUndefined();
  advance(1);
  expect(delivery.current?.text).toBe("b");
  expect(world.shown).toEqual(["a", undefined, "b"]);
});

test("the interval counts from an early dismissal, not from when the bubble appeared", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("b"));
  advance(5_500);
  delivery.dismiss();
  expect(world.timer).toBe(10_500);
  advance(4_999);
  expect(delivery.current).toBeUndefined();
  advance(1);
  expect(delivery.current?.text).toBe("b");
});

test("urgent waits behind the current bubble and obeys the five-second gap", () => {
  const { delivery, advance } = setup();
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("u1", { priority: "urgent" }));
  expect(delivery.current).toMatchObject({ text: "a", priority: "normal", closeAtMs: 6_000 });
  delivery.enqueue(notify("u2", { priority: "urgent" }));
  expect(delivery.pending).toBe(2);
  advance(6_000);
  expect(delivery.current).toBeUndefined();
  advance(5_000);
  expect(delivery.current?.text).toBe("u1");
  advance(15_000);
  advance(5_000);
  expect(delivery.current?.text).toBe("u2");
});

test("low priority and text-less notifications only react", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("quiet", { priority: "low", mood: "happy" }));
  delivery.enqueue({ source: "s", type: "notify", mood: "worried" });
  expect(world.shown).toEqual([]);
  expect(world.reactions.map((event) => event.mood)).toEqual(["happy", "worried"]);
  expect(delivery.pending).toBe(0);

  // While a bubble is showing, a low notification waits; it is delivered as soon as the bubble closes.
  advance(10_000);
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("later", { priority: "low", mood: "surprised" }));
  expect(delivery.pending).toBe(1);
  advance(6_000);
  expect(delivery.pending).toBe(0);
  expect(world.reactions.at(-1)?.mood).toBe("surprised");
  expect(world.timer).toBeUndefined();
});

test("nothing is delivered while the pet is inactive", () => {
  const { world, delivery } = setup();
  world.active = false;
  delivery.enqueue(notify("a"));
  expect(delivery.pending).toBe(1);
  expect(world.timer).toBeUndefined();
  world.active = true;
  delivery.pump();
  expect(delivery.current?.text).toBe("a");
});

test("an expired notification is dropped without leaving a timer", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("b", { ttlMs: 1_000 }));
  advance(6_000);
  expect(delivery.pending).toBe(0);
  expect(world.timer).toBeUndefined();
  advance(5_000);
  expect(world.shown).toEqual(["a", undefined]);
});

test("a direct press 0.5 seconds after a bubble appears reacts now and speaks after the gap", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("first"));
  advance(500);
  delivery.enqueue(interactionEvent(getDefaultInteractions()[1] as PetInteraction));
  expect(world.reactions.map((event) => event.mood)).toEqual([undefined, "neutral"]);
  expect(world.shown).toEqual(["first"]);
  expect(world.timer).toBe(6_000);
  advance(5_500);
  expect(world.shown).toEqual(["first", undefined]);
  expect(world.timer).toBe(11_000);
  advance(4_999);
  expect(delivery.current).toBeUndefined();
  advance(1);
  expect(world.shown).toEqual(["first", undefined, shippedTalk.lines[0]]);
  expect(world.reactions).toHaveLength(2);
});

test("an external event still expires while waiting for the bubble gap", () => {
  const { world, delivery, advance } = setup();
  delivery.enqueue(notify("first"));
  advance(6_500);
  delivery.enqueue(notify("external", { ttlMs: 4_000 }));
  expect(delivery.pending).toBe(1);
  advance(4_500);
  expect(world.shown).toEqual(["first", undefined]);
  expect(delivery.pending).toBe(0);
});

test("repeated direct presses in the gap keep only the latest line", () => {
  const { world, delivery, advance } = setup();
  const talk = { ...getDefaultInteractions()[1] as PetInteraction, lines: ["first line", "latest line"] };
  delivery.enqueue(notify("first"));
  advance(6_500);
  delivery.enqueue(interactionEvent(talk, 0));
  advance(500);
  delivery.enqueue(interactionEvent(talk, 1));
  expect(delivery.pending).toBe(1);
  expect(world.reactions).toHaveLength(3);
  advance(4_000);
  expect(world.shown).toEqual(["first", undefined, "latest line"]);
  expect(delivery.pending).toBe(0);
  expect(world.reactions).toHaveLength(3);
});

test("urgent notifications pass through quiet time with the usual rules", () => {
  const { world, delivery, advance } = setup();
  world.quiet = true;
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("u", { priority: "urgent" }));
  expect(world.shown).toEqual(["u"]);
  expect(world.reactions.map((event) => event.text)).toEqual(["u"]);
  expect(delivery.pending).toBe(1);
  expect(world.timer).toBe(15_000);
  advance(15_000);
  expect(delivery.current).toBeUndefined();
  // Only the held notification remains, so quiet time leaves no timer armed.
  expect(world.timer).toBeUndefined();
});

test("non-urgent notifications are held without a bubble or expression while quiet", () => {
  const { world, delivery } = setup();
  world.quiet = true;
  delivery.enqueue(notify("a", { mood: "happy" }));
  delivery.enqueue(notify("b"));
  expect(world.shown).toEqual([]);
  expect(world.reactions).toEqual([]);
  expect(delivery.pending).toBe(2);
  expect(world.timer).toBeUndefined();
});

test("held notifications come back as one summary when quiet ends", () => {
  const { world, delivery, advance } = setup();
  world.quiet = true;
  delivery.enqueue(notify("a"));
  delivery.enqueue(notify("b"));
  delivery.enqueue(notify("a"));
  advance(30_000);
  world.quiet = false;
  delivery.pump();
  expect(delivery.current).toMatchObject({ text: "방해 금지 중 알림 3개: a 2, b 1", priority: "normal", closeAtMs: 36_000 });
  expect(world.shown).toEqual(["방해 금지 중 알림 3개: a 2, b 1"]);
  expect(world.reactions).toHaveLength(1);
  expect(delivery.pending).toBe(0);
});

test("a single held notification returns as itself, not a summary", () => {
  const { world, delivery } = setup();
  world.quiet = true;
  delivery.enqueue(notify("only", { priority: "high" }));
  world.quiet = false;
  delivery.pump();
  expect(world.shown).toEqual(["only"]);
  expect(delivery.current).toMatchObject({ text: "only", priority: "high", closeAtMs: 10_000 });
  expect(world.reactions.map((event) => event.text)).toEqual(["only"]);
});

test("held notifications with the same source and key merge into the latest one", () => {
  const { world, delivery } = setup();
  world.quiet = true;
  delivery.enqueue(notify("jungle", { key: "jungle.manual.ok.Studying", text: "first" }));
  delivery.enqueue(notify("jungle", { key: "jungle.manual.ok.Studying", text: "second" }));
  expect(delivery.pending).toBe(1);
  world.quiet = false;
  delivery.pump();
  expect(world.shown).toEqual(["second"]);
});

test("held notifications with different keys from one source still summarize separately", () => {
  const { world, delivery } = setup();
  world.quiet = true;
  delivery.enqueue(notify("jungle", { key: "jungle.manual.ok.Studying", text: "first" }));
  delivery.enqueue(notify("jungle", { key: "jungle.manual.error", text: "second" }));
  expect(delivery.pending).toBe(2);
  world.quiet = false;
  delivery.pump();
  expect(world.shown).toEqual(["방해 금지 중 알림 2개: jungle 2"]);
});

test("held notifications that expire during quiet are left out of the summary", () => {
  const { world, delivery, advance } = setup();
  world.quiet = true;
  delivery.enqueue(notify("stale", { ttlMs: 1_000 }));
  delivery.enqueue(notify("fresh"));
  delivery.enqueue(notify("fresh2"));
  advance(60_000);
  expect(delivery.pending).toBe(2);
  world.quiet = false;
  delivery.pump();
  expect(delivery.current?.text).toBe("방해 금지 중 알림 2개: fresh 1, fresh2 1");
});

test("quiet time mixes urgent delivery with held notifications", () => {
  const { world, delivery, advance } = setup();
  world.quiet = true;
  delivery.enqueue(notify("u1", { priority: "urgent" }));
  delivery.enqueue(notify("u2", { priority: "urgent" }));
  delivery.enqueue(notify("a"));
  expect(delivery.current?.text).toBe("u1");
  expect(delivery.pending).toBe(2);
  expect(world.timer).toBe(15_000);
  advance(15_000);
  expect(delivery.current).toBeUndefined();
  // u2 waits out the five-second gap behind u1 even while quiet.
  expect(world.timer).toBe(20_000);
  advance(5_000);
  expect(delivery.current?.text).toBe("u2");
  advance(15_000);
  expect(world.timer).toBeUndefined();
  world.quiet = false;
  delivery.pump();
  expect(delivery.current?.text).toBe("a");
  expect(world.shown).toEqual(["u1", undefined, "u2", undefined, "a"]);
});

test("a user-direct interaction shows immediately while quiet; a normal event in the same state stays held", () => {
  const { world, delivery } = setup();
  // Do-not-disturb and fullscreen both reach delivery as one quiet flag (the app wires them together),
  // so quiet covers both hold states here.
  world.quiet = true;
  delivery.enqueue(interactionEvent(getDefaultInteractions()[0] as PetInteraction));
  expect(world.shown).toEqual([shippedPat.lines[0]]);
  expect(world.reactions.map((event) => event.mood)).toEqual(["happy"]);
  expect(delivery.pending).toBe(0);
  delivery.enqueue(notify("보류"));
  expect(world.shown).toEqual([shippedPat.lines[0]]);
  expect(delivery.pending).toBe(1);
});

test("a user-direct interaction held behind the bubble gap during quiet still shows without quiet ending", () => {
  const { world, delivery, advance } = setup();
  world.quiet = true;
  delivery.enqueue(notify("u", { priority: "urgent" }));
  advance(15_000);
  expect(world.timer).toBeUndefined();
  advance(1_500);
  delivery.enqueue(interactionEvent(getDefaultInteractions()[1] as PetInteraction));
  expect(world.shown).toEqual(["u", undefined]);
  // The five-second gap applies to the direct press too, and quiet time must not swallow
  // the wake-up that ends it.
  expect(world.timer).toBe(20_000);
  advance(3_500);
  expect(world.shown).toEqual(["u", undefined, shippedTalk.lines[0]]);
  expect(delivery.pending).toBe(0);
});

test("a plain userDirect field from outside does not bypass quiet", () => {
  const { world, delivery } = setup();
  world.quiet = true;
  // What an external /event or CLI client can send: a JSON string key, never the internal symbol.
  const forged: PetEvent = { ...notify("위조"), userDirect: true } as PetEvent;
  expect(isUserDirect(forged)).toBe(false);
  delivery.enqueue(forged);
  expect(world.shown).toEqual([]);
  expect(delivery.pending).toBe(1);
});
