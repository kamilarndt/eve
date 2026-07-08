import { createHook } from "#compiled/@workflow/core/index.js";

import { disposeHook } from "#execution/hook-ownership.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/** Derives the per-turn cancel hook token from the turn's completion token. */
export function turnCancelHookToken(completionToken: string): string {
  return `${completionToken}:cancel`;
}

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * per-turn cancel hook and the durable `AbortController` whose signal is
 * serialized into every `turnStep`.
 *
 * The abort fires in the continuation of the cancel-hook read, keying it
 * to the `hook_received` journal event so it is replay-deterministic.
 * Must be created inside a `"use workflow"` body.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once the cancel payload is consumed and the turn
   * signal aborted. Race it against turn-owned awaits — never `await` it
   * alone.
   */
  readonly requested: Promise<"cancel">;
  /** Disposes the hook; an outstanding cancel read is abandoned. */
  dispose(): Promise<void>;
}

/** Creates the cancel hook + durable controller for one turn workflow run. */
export function createTurnCancellationControl(completionToken: string): TurnCancellationControl {
  const hook = createHook<unknown>({ token: turnCancelHookToken(completionToken) });
  const iterator = hook[Symbol.asyncIterator]();
  const controller = new AbortController();
  const requested = iterator.next().then(() => {
    controller.abort(new TurnCancelledError());
    return "cancel" as const;
  });

  return {
    signal: controller.signal,
    requested,
    async dispose(): Promise<void> {
      // Dispose-only, never `iterator.return()`: the iterator is suspended
      // in a pending durable read that `return()` would wait on forever,
      // leaving the run `running` and its hooks unswept. Disposal drops
      // the read.
      await disposeHook(hook);
    },
  };
}
