import type { HandleMessageStreamEvent } from "#protocol/message.js";

/** Hides only exact re-deliveries of a stable server event ID. */
export class ReplayNormalizer {
  readonly #seenEventIds: Set<string>;

  constructor(seenEventIds?: readonly string[]) {
    this.#seenEventIds = new Set(seenEventIds);
  }

  /** Current serializable event-ID set. */
  get seenEventIds(): readonly string[] {
    return [...this.#seenEventIds];
  }

  /** Returns false only when this exact event ID was already observed. */
  shouldExpose(event: HandleMessageStreamEvent): boolean {
    const eventId = event.meta?.eventId;
    if (eventId === undefined) return true;
    if (this.#seenEventIds.has(eventId)) return false;
    this.#seenEventIds.add(eventId);
    return true;
  }
}
