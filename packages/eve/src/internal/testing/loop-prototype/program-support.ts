import { eventId } from "./ids.js";
import type {
  EffectCall,
  EffectName,
  EventRecord,
  LoopBackend,
  SessionCheckpoint,
  SessionState,
  WireValue,
} from "./types.js";

export async function appendEvent(
  backend: LoopBackend,
  state: SessionState,
  operation: EventRecord["operationId"],
  payload: WireValue,
  eventOrdinal = 0,
): Promise<SessionState> {
  const event: EventRecord = {
    id: eventId(operation, eventOrdinal),
    logId: state.eventLogId,
    operationId: operation,
    payload,
    sequence: state.nextEventSequence,
  };
  await backend.appendEvents([event]);
  return { ...state, nextEventSequence: state.nextEventSequence + 1 };
}

export function replaceCheckpoint(
  previous: SessionCheckpoint,
  leaseOwner: SessionCheckpoint["leaseOwner"],
  state: SessionState,
): SessionCheckpoint {
  return {
    leaseOwner,
    revision: previous.revision + 1,
    state,
    version: 1,
  };
}

export function idempotentRetry(maxAttempts: number): EffectCall<EffectName>["retry"] {
  return { idempotency: "required", maxAttempts };
}
