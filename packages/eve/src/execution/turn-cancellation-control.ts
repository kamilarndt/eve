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
 * The token derives from the driver's already-indexed completion token
 * (`{sessionId}:turn-control:{n}`), so it is unique per turn workflow run
 * and never reused — which sidesteps the upstream dispose-ordering bugs
 * (workflow#2777, workflow#2778) by construction.
 *
 * The abort fires in the continuation of the cancel-hook read itself, so
 * its durable side effect is replay-deterministic: it is keyed to the
 * `hook_received` event in the run's log, never to live signal state or
 * to the winner of a promise race (both of which can differ between the
 * first run and a replay and would corrupt the event log). The runtime
 * delivers the abort to an in-flight step attempt in real time; the
 * workflow body itself never needs to observe the signal.
 *
 * Must be created inside a `"use workflow"` body: both `createHook` and
 * the hook-backed `AbortController` are workflow-runtime constructs.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once the cancel payload has been consumed and
   * the turn signal aborted (or when the hook closes at disposal; races
   * only happen before then). Race this against turn-owned awaits —
   * never `await` it alone.
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
      // Dispose-only, never `iterator.return()`: for a turn that was
      // never cancelled the iterator is suspended inside its pending
      // durable read, and an async generator only honors `return()`
      // after that read settles — which it never does. The runtime's
      // dispose drops the pending read (the sanctioned
      // dispose-with-outstanding-read pattern); a run that closed this
      // iterator instead would hang forever, never reach
      // `run_completed`, and leak its hooks in the world.
      await disposeHook(hook);
    },
  };
}
