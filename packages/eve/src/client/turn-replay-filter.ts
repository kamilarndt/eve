import { createSessionEventIdentity, readTurnId } from "#client/session-utils.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

/** Suppresses exact replayed events without collapsing valid streaming chunks. */
export class TurnReplayFilter {
  readonly #eventIds = new Set<string>();
  #currentTurnId: string | undefined;
  #suppressRepeatableEvents = false;

  shouldSuppress(event: HandleMessageStreamEvent): boolean {
    const identity = createSessionEventIdentity(event);
    const turnId = readTurnId(event);

    if (turnId !== undefined) {
      if (this.#currentTurnId !== turnId) {
        this.#currentTurnId = turnId;
        this.#eventIds.clear();
        this.#suppressRepeatableEvents = false;
      } else if (event.type === "turn.started" && this.#eventIds.has(identity)) {
        this.#suppressRepeatableEvents = true;
      }
    }

    if (
      this.#eventIds.has(identity) &&
      (this.#suppressRepeatableEvents || isUniqueTurnLifecycleEvent(event))
    ) {
      return true;
    }

    this.#eventIds.add(identity);
    return false;
  }
}

function isUniqueTurnLifecycleEvent(event: HandleMessageStreamEvent): boolean {
  return !["message.appended", "reasoning.appended", "subagent.event"].includes(event.type);
}
