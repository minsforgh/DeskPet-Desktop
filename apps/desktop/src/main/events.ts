import type { PetEvent } from "@deskpet/core";

export interface ReceivedPetEvent {
  event: PetEvent;
  receivedAt: number;
}

const MAX_EVENTS = 100;
const receivedEvents: ReceivedPetEvent[] = [];

/** Record an accepted event and return it with its timestamp filled in. */
export function recordPetEvent(event: PetEvent): PetEvent {
  const receivedAt = Date.now();
  const received = { ...event, timestamp: event.timestamp ?? receivedAt };
  receivedEvents.push({ event: received, receivedAt });
  if (receivedEvents.length > MAX_EVENTS) receivedEvents.shift();
  console.info("PetEvent received:", {
    source: event.source,
    type: event.type,
    priority: typeof event.priority === "string" ? event.priority : undefined,
  });
  return received;
}

export function recentPetEvents(limit = MAX_EVENTS): ReceivedPetEvent[] {
  return limit === 0 ? [] : receivedEvents.slice(-limit);
}
