import { NotificationQueue, summarizeHeld, type PetEvent, type QueuedNotification } from "@deskpet/core";
import { isUserDirect } from "./pet-menu.js";
import type { RenderedPetEvent } from "./voice.js";

type BubblePriority = "normal" | "high" | "urgent";
type NotifyEvent = PetEvent & { type: "notify" };

const isNotify = (event: PetEvent): event is NotifyEvent => event.type === "notify";

/** How long a bubble stays up, by priority. The values are the product decision in the M3-C task. */
export const BUBBLE_DURATION_MS: Record<BubblePriority, number> = { normal: 6_000, high: 10_000, urgent: 15_000 };
/** Quiet time after a bubble closes before the next bubble (plan 8-2). */
export const BUBBLE_INTERVAL_MS = 5_000;
/** A reader can leave an expanded bubble up for at most five minutes (M13-5b decision). */
export const BUBBLE_EXPANDED_MAX_MS = 5 * 60_000;
const BUBBLE_COLLAPSED_MIN_MS = 3_000;

export interface ShownBubble {
  sequence: number;
  text: string;
  detail?: string;
  fullText?: string;
  parts?: RenderedPetEvent["parts"];
  priority: BubblePriority;
  actions?: PetEvent["actions"];
  shownAtMs: number;
  closeAtMs: number;
}

export interface DeliveryHost {
  /** The delivery clock advances independently of the pet's animation clock. */
  now(): number;
  /** False while the pet cannot present anything (not ready or hidden); notifications stay queued. */
  active(): boolean;
  /** True while do-not-disturb holds every non-urgent notification for one summary when it ends. */
  quiet(): boolean;
  /** Play the expression for a delivered notification. */
  react(event: PetEvent): void;
  /** The bubble appeared, was replaced, or (undefined) closed. */
  bubbleChanged(bubble: ShownBubble | undefined): void;
  /** Arm one timer for this clock time, or none when nothing is waiting. */
  schedule(atMs: number | undefined): void;
}

/** Takes notifications out of the queue only when one can be presented, and closes bubbles on time. */
export class NotificationDelivery {
  private bubble: ShownBubble | undefined;
  private nextBubbleAtMs = 0;
  private wakeAtMs: number | undefined;
  private bubbleSequence = 0;
  private pausedRemainingMs: number | undefined;
  /** Held back by quiet time; these skip the queue and return as one summary when quiet ends. */
  private held: QueuedNotification[] = [];
  private readonly queue: NotificationQueue;

  constructor(private readonly host: DeliveryHost) {
    this.queue = new NotificationQueue({ canDeliver: (notification, nowMs) => {
      if (this.bubble) return false;
      // Quiet passes urgent through under the usual rules and leaves every other notification queued.
      // A user-direct event skips the quiet hold too: the user asked for it right now.
      if (this.host.quiet() && notification.event.priority !== "urgent" && !isUserDirect(notification.event)) return false;
      return notification.expressionOnly || nowMs >= this.nextBubbleAtMs;
    } });
  }

  get current(): ShownBubble | undefined { return this.bubble; }
  get pending(): number { return this.queue.snapshot().pendingCount + this.held.length; }
  get nextAtMs(): number | undefined { return this.wakeAtMs; }

  enqueue(event: PetEvent): void {
    const now = this.host.now();
    if (this.host.quiet() && isNotify(event) && event.priority !== "urgent" && !isUserDirect(event)) {
      // Same source and key merge into the latest event, the same rule the queue applies (plan 8-2).
      const existing = event.key === undefined ? undefined
        : this.held.find((held) => held.event.source === event.source && held.event.key === event.key);
      if (existing) {
        existing.event = event;
        existing.receivedAtMs = now;
        existing.expressionOnly = event.priority === "low";
      } else {
        this.held.push({ event, receivedAtMs: now, expressionOnly: event.priority === "low" });
      }
    } else {
      if (isUserDirect(event)) {
        // A direct press reacts now; its bubble may wait longer than its TTL for the current bubble and gap.
        this.host.react(event);
        this.queue.enqueue({ ...event, ttlMs: undefined }, now);
      } else {
        this.queue.enqueue(event, now);
      }
    }
    this.pump();
  }

  /** A sequence step or an alert that interrupts it takes the visible bubble slot immediately. */
  showImmediately(event: PetEvent): boolean {
    if (!isNotify(event) || !event.text || event.priority === "low" || !this.host.active() ||
        (this.host.quiet() && event.priority !== "urgent" && !isUserDirect(event))) return false;
    if (!isUserDirect(event)) this.host.react(event);
    const now = this.host.now();
    const priority = event.priority === "high" || event.priority === "urgent" ? event.priority : "normal";
    this.pausedRemainingMs = undefined;
    this.bubble = { sequence: ++this.bubbleSequence, text: event.text, detail: event.detail,
      fullText: (event as RenderedPetEvent).fullText, parts: (event as RenderedPetEvent).parts, priority, actions: event.actions, shownAtMs: now,
      closeAtMs: now + Math.max(BUBBLE_DURATION_MS[priority], event.ttlMs ?? 0) };
    this.host.bubbleChanged(this.bubble);
    this.wakeAtMs = this.bubble.closeAtMs;
    this.host.schedule(this.wakeAtMs);
    return true;
  }

  /** The user clicked the bubble. */
  dismiss(): void {
    if (this.bubble) this.close(this.host.now());
    this.pump();
  }

  /** Apply a renderer expansion only to the bubble whose content it measured. */
  setExpanded(sequence: number, expanded: boolean): void {
    const bubble = this.bubble;
    if (!bubble || bubble.sequence !== sequence) return;
    const now = this.host.now();
    if (now >= bubble.closeAtMs) { this.pump(); return; }
    if (expanded) {
      if (this.pausedRemainingMs !== undefined) return;
      this.pausedRemainingMs = bubble.closeAtMs - now;
      bubble.closeAtMs = now + BUBBLE_EXPANDED_MAX_MS;
    } else {
      if (this.pausedRemainingMs === undefined) return;
      bubble.closeAtMs = now + Math.max(this.pausedRemainingMs, BUBBLE_COLLAPSED_MIN_MS);
      this.pausedRemainingMs = undefined;
    }
    this.pump();
  }

  /** Close an expired bubble, deliver what can be delivered now, and schedule the next wake-up. */
  pump(): void {
    const now = this.host.now();
    if (this.bubble && now >= this.bubble.closeAtMs) this.close(this.bubble.closeAtMs);
    this.expireHeld(now);
    if (!this.host.quiet() && this.host.active() && !this.bubble && this.held.length > 0) this.deliverHeld(now);
    let queueNextAtMs: number | undefined;
    while (this.host.active()) {
      const { notification, nextAtMs } = this.queue.next(now);
      queueNextAtMs = nextAtMs;
      if (!notification) break;
      this.deliver(notification, now);
    }
    // While quiet, only a showing bubble, a queued urgent notification, or a queued user-direct
    // event (it may be waiting out the inter-bubble gap) justifies waking up.
    const waiting = this.host.quiet()
      ? this.queue.snapshot().pending.some((notification) => notification.event.priority === "urgent" || isUserDirect(notification.event))
      : this.pending > 0;
    const wake = this.bubble ? this.bubble.closeAtMs
      : this.host.active() && waiting ? Math.max(queueNextAtMs ?? 0, this.nextBubbleAtMs) : undefined;
    this.wakeAtMs = wake !== undefined && wake > now ? wake : undefined;
    this.host.schedule(this.wakeAtMs);
  }

  /** Hand the notifications quiet time held back: one returns as itself, several become one summary. */
  private deliverHeld(now: number): void {
    const held = this.held;
    this.held = [];
    if (held.length === 1) {
      const [single] = held;
      if (single) this.deliver(single, now);
      return;
    }
    const summary = summarizeHeld(held.map((notification) => notification.event));
    if (summary && isNotify(summary)) this.deliver({ event: summary, receivedAtMs: now, expressionOnly: false }, now);
  }

  /** Drop held notifications past their ttl, with the same rule the queue uses for its own entries. */
  private expireHeld(now: number): void {
    this.held = this.held.filter((notification) =>
      notification.event.ttlMs === undefined || now - notification.receivedAtMs <= notification.event.ttlMs);
  }

  private deliver(notification: QueuedNotification, now: number): void {
    const { event } = notification;
    if (!isUserDirect(event)) this.host.react(event);
    // A notify event without text has nothing to say; it only changes the expression.
    if (notification.expressionOnly || !event.text) return;
    const priority = event.priority === "high" || event.priority === "urgent" ? event.priority : "normal";
    this.pausedRemainingMs = undefined;
    this.bubble = { sequence: ++this.bubbleSequence, text: event.text, detail: event.detail,
      fullText: (event as RenderedPetEvent).fullText, parts: (event as RenderedPetEvent).parts, priority, actions: event.actions, shownAtMs: now,
      closeAtMs: now + BUBBLE_DURATION_MS[priority] };
    this.host.bubbleChanged(this.bubble);
  }

  private close(atMs: number): void {
    this.bubble = undefined;
    this.pausedRemainingMs = undefined;
    this.nextBubbleAtMs = atMs + BUBBLE_INTERVAL_MS;
    this.host.bubbleChanged(undefined);
  }
}
