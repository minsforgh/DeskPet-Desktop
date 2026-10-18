import type { PetEvent } from "./contracts.js";

type NotifyEvent = PetEvent & { type: "notify" };
type Priority = NonNullable<PetEvent["priority"]>;

export interface QueuedNotification {
  event: NotifyEvent;
  receivedAtMs: number;
  /** Low priority only changes the expression; callers should not show a bubble. */
  expressionOnly: boolean;
  groupedEvents?: readonly NotifyEvent[];
}

export interface NotificationQueueOptions {
  groupWindowMs?: number;
  groupThreshold?: number;
  minBubbleIntervalMs?: number;
  maxPending?: number;
  canDeliver?: (notification: QueuedNotification, nowMs: number) => boolean;
}

interface Entry {
  event: NotifyEvent;
  receivedAtMs: number;
  order: number;
}

interface Candidate {
  entries: Entry[];
  notification: QueuedNotification;
  priority: Priority;
  order: number;
}

const priorityRank: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Pure notification scheduling: the caller supplies every clock reading. */
export class NotificationQueue {
  private readonly entries: Entry[] = [];
  private readonly options: Required<Omit<NotificationQueueOptions, "canDeliver">> & Pick<NotificationQueueOptions, "canDeliver">;
  private nextOrder = 0;
  private lastBubbleAtMs: number | undefined;
  private overflowDropped = 0;
  private expiredDropped = 0;

  constructor(options: NotificationQueueOptions = {}) {
    this.options = {
      groupWindowMs: options.groupWindowMs ?? 30_000,
      groupThreshold: options.groupThreshold ?? 3,
      minBubbleIntervalMs: options.minBubbleIntervalMs ?? 5_000,
      maxPending: options.maxPending ?? 100,
      canDeliver: options.canDeliver,
    };
  }

  enqueue(event: PetEvent, nowMs: number): boolean {
    if (event.type !== "notify") return false;
    this.expire(nowMs);
    const notify = event as NotifyEvent;
    const existing = notify.key === undefined ? undefined : this.entries.find((entry) =>
      entry.event.source === notify.source && entry.event.key === notify.key);
    if (existing) {
      existing.event = notify;
      existing.receivedAtMs = nowMs;
    } else {
      this.entries.push({ event: notify, receivedAtMs: nowMs, order: this.nextOrder++ });
    }
    while (this.entries.length > this.options.maxPending) {
      let lowest = 0;
      for (let index = 1; index < this.entries.length; index += 1) {
        const current = this.entries[index];
        const previous = this.entries[lowest];
        if (current && previous && (priorityRank[current.event.priority ?? "normal"] < priorityRank[previous.event.priority ?? "normal"] ||
          (priorityRank[current.event.priority ?? "normal"] === priorityRank[previous.event.priority ?? "normal"] && current.order < previous.order))) lowest = index;
      }
      this.entries.splice(lowest, 1);
      this.overflowDropped += 1;
    }
    return true;
  }

  next(nowMs: number): { notification?: QueuedNotification; nextAtMs?: number } {
    this.expire(nowMs);
    const candidates = this.candidates();
    candidates.sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority] || left.order - right.order);
    let nextAtMs: number | undefined;
    for (const candidate of candidates) {
      if (!this.options.canDeliver?.(candidate.notification, nowMs) && this.options.canDeliver) continue;
      const bubble = !candidate.notification.expressionOnly;
      const readyAt = this.lastBubbleAtMs === undefined ? nowMs : this.lastBubbleAtMs + this.options.minBubbleIntervalMs;
      if (bubble && nowMs < readyAt) {
        nextAtMs = nextAtMs === undefined ? readyAt : Math.min(nextAtMs, readyAt);
        continue;
      }
      for (const entry of candidate.entries) this.entries.splice(this.entries.indexOf(entry), 1);
      if (bubble) this.lastBubbleAtMs = nowMs;
      return { notification: candidate.notification };
    }
    return { nextAtMs };
  }

  private expire(nowMs: number): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.event.ttlMs !== undefined && nowMs - entry.receivedAtMs > entry.event.ttlMs) {
        this.entries.splice(index, 1);
        this.expiredDropped += 1;
      }
    }
  }

  snapshot(): { pending: readonly QueuedNotification[]; pendingCount: number; overflowDropped: number; expiredDropped: number } {
    return {
      pending: this.candidates().map((candidate) => candidate.notification),
      pendingCount: this.entries.length,
      overflowDropped: this.overflowDropped,
      expiredDropped: this.expiredDropped,
    };
  }

  private candidates(): Candidate[] {
    const pending = [...this.entries].sort((a, b) => a.order - b.order);
    const assigned = new Set<Entry>();
    const candidates: Candidate[] = [];
    for (const first of pending) {
      if (assigned.has(first)) continue;
      const group = pending.filter((entry) =>
        !assigned.has(entry) && entry.event.source === first.event.source &&
        entry.receivedAtMs >= first.receivedAtMs && entry.receivedAtMs - first.receivedAtMs <= this.options.groupWindowMs);
      const members = group.length >= this.options.groupThreshold ? group : [first];
      members.forEach((entry) => assigned.add(entry));
      const priority = members.reduce<Priority>((highest, entry) =>
        priorityRank[entry.event.priority ?? "normal"] > priorityRank[highest] ? entry.event.priority ?? "normal" : highest, "low");
      const event: NotifyEvent = members.length === 1 ? first.event : {
        source: first.event.source,
        type: "notify",
        text: `${first.event.source} 알림 ${members.length}개`,
        detail: members.map((entry) => entry.event.text ?? entry.event.detail ?? "").join("\n"),
        priority,
      };
      candidates.push({
        entries: members,
        notification: {
          event,
          receivedAtMs: first.receivedAtMs,
          expressionOnly: priority === "low",
          ...(members.length > 1 ? { groupedEvents: members.map((entry) => entry.event) } : {}),
        },
        priority,
        order: first.order,
      });
    }
    return candidates;
  }
}
