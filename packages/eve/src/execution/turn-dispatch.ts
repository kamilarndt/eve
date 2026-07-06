import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import { dispatchTurnStep } from "#execution/workflow-steps.js";
import type { RunMode } from "#shared/run-mode.js";

/** One settled turn: its terminal driver action plus deferred hook cleanup. */
export interface DispatchedTurn {
  readonly action: NextDriverAction;
  /**
   * Disposes the turn's control hook. The driver defers this until the
   * *next* turn is settled (or the session ends): the turn run's final
   * control send is an at-least-once step — a queued wake (e.g. a
   * duplicate cancel payload or the durable abort's own hook event) can
   * re-dispatch it while in flight
   * (https://github.com/vercel/workflow/issues/2780), and the late
   * duplicate resume must land on a live hook. A resume on a disposed
   * hook diverges the driver's replay and corrupts its event log
   * (https://github.com/vercel/workflow/issues/2781). By the time the
   * next turn settles, the previous turn's run has completed and can no
   * longer re-send.
   */
  dispose(): Promise<void>;
}

/** Dispatches one turn and services its private-inbox control protocol until it terminates. */
export async function dispatchAndAwaitTurn(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly capabilities?: SessionCapabilities;
  readonly controlToken: string;
  readonly delivery: HookPayload;
  readonly deliveryHook: SessionDeliveryHook;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<DispatchedTurn> {
  const control = new TurnControlReceiver({
    bufferedDeliveries: input.bufferedDeliveries,
    deliveryHook: input.deliveryHook,
    token: input.controlToken,
  });

  try {
    await dispatchTurnStep({
      capabilities: input.capabilities,
      completionToken: control.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    const action = await control.waitForAction();
    return { action, dispose: () => control.dispose() };
  } catch (error) {
    await control.dispose();
    throw error;
  }
}
