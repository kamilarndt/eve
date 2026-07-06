import { createSessionWaitingEvent, createTurnCancelledEvent } from "#protocol/message.js";
import type { HarnessEmitFn } from "#harness/types.js";

import type { HarnessEmissionState } from "#harness/emission.js";

/**
 * Emits the cancelled-turn epilogue: `turn.cancelled` → `session.waiting`.
 *
 * Cancellation is not failure — no `step.failed`, `turn.failed`, or
 * `session.failed` is emitted — and the session stays open for the next
 * message. Returns the between-turns emission state for the next turn.
 *
 * `state` is the last *persisted* emission state. When the cancelled step
 * began the turn, `emitTurnPreamble` already emitted `turn.started` (the
 * first abort check sits behind the preamble) but its state update was
 * never persisted, so the current turn id is reconstructed from the same
 * `turn_${sequence}` formula. `sessionStarted` is stamped `true` for the
 * same reason: the preamble's `session.started` is already on the stream.
 */
export async function emitCancelledTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCancelledEvent({
      sequence: state.sequence,
      turnId: state.turnId === "" ? `turn_${state.sequence}` : state.turnId,
    }),
  );
  await emitFn(createSessionWaitingEvent());

  return {
    sessionStarted: true,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}
