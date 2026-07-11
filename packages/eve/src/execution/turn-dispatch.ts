import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import {
  dispatchTurnStep,
  probeTurnWorkflowSettlementStep,
  requestTurnWorkflowCancellationStep,
} from "#execution/workflow-steps.js";
import { isTurnCancellation, raceWithTurnAbort } from "#harness/turn-cancellation.js";
import type { RunMode } from "#shared/run-mode.js";

/** Dispatches one turn and services its private-inbox control protocol until it terminates. */
export async function dispatchAndAwaitTurn(input: {
  readonly abortSignal?: AbortSignal;
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly capabilities?: SessionCapabilities;
  readonly controlToken: string;
  readonly delivery: HookPayload;
  readonly deliveryHook: SessionDeliveryHook;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextDriverAction> {
  const control = new TurnControlReceiver({
    bufferedDeliveries: input.bufferedDeliveries,
    deliveryHook: input.deliveryHook,
    token: input.controlToken,
  });

  try {
    const dispatched = await dispatchTurnStep({
      abortSignal: input.abortSignal,
      capabilities: input.capabilities,
      completionToken: control.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    try {
      return await raceWithTurnAbort(control.waitForAction(), input.abortSignal);
    } catch (error) {
      if (isTurnCancellation(error)) {
        const ownerRunId = await requestTurnWorkflowCancellation(
          `${control.token}:cancel`,
          dispatched.runId,
        );
        await awaitTurnWorkflowSettlement(ownerRunId);
      }
      throw error;
    }
  } finally {
    await control.dispose();
  }
}

async function requestTurnWorkflowCancellation(
  cancelToken: string,
  fallbackRunId: string,
): Promise<string> {
  let delayMs = 100;
  while (true) {
    const ownerRunId = await requestTurnWorkflowCancellationStep({
      cancelToken,
      fallbackRunId,
    });
    if (ownerRunId !== null) return ownerRunId;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 1_000);
  }
}

async function awaitTurnWorkflowSettlement(runId: string): Promise<void> {
  let delayMs = 100;
  while (!(await probeTurnWorkflowSettlementStep(runId))) {
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 1_000);
  }
}
