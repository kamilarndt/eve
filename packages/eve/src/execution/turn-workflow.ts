import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import { cancelPendingLocalSubagentsUntilSettled } from "#execution/cancel-pending-local-subagents-until-settled.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHookWithPendingRead,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { turnStep } from "#execution/workflow-steps.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { raceWithTurnAbort, TurnCancelledError } from "#harness/turn-cancellation.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

export type { TurnWorkflowInput };

/** Runs one complete logical turn, including child-agent waits when supported. */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);

  if (input.driverCapabilities?.turnInbox !== true) {
    return runLegacyTurnWorkflow(input);
  }

  return runTurnOwnedWorkflow(input);
}

async function runTurnOwnedWorkflow(input: TurnWorkflowInput): Promise<void> {
  const inbox = createHook<TurnInboxPayload>({ token: `${input.completionToken}:inbox` });
  // Hook promises and iterators share one durable cursor. Create the iterator before
  // claiming so conflict replay is consumed by getConflict(), not a later iterator read.
  const iterator = inbox[Symbol.asyncIterator]();
  const abortController = new AbortController();
  if (input.stepInput.abortSignal?.aborted === true) {
    abortController.abort(new TurnCancelledError());
  }
  const cursor = new TurnExecutionCursor({
    abortSignal: abortController.signal,
    controlToken: input.completionToken,
    parentWritable: input.stepInput.parentWritable,
    serializedContext: input.stepInput.serializedContext,
    sessionState: input.stepInput.sessionState,
  });
  // Delivery request ids stay unique across every wait in this turn. A forwarded
  // delivery left unconsumed when one wait resolves would otherwise reuse a later
  // wait's id and be mis-accepted as that wait's response.
  let deliveryRequestSeq = 0;
  const nextDeliveryRequestId = (): string =>
    `${inbox.token}:delivery:${String(deliveryRequestSeq++)}`;
  const bufferedDeliveries: DeliverHookPayload[] = [];
  let nextStepInput = input.stepInput.input;
  let ownsInbox = false;
  let cancelHook: ReturnType<typeof createHook<{ readonly kind: "turn-cancel" }>> | undefined;
  let cancelIterator: AsyncIterator<{ readonly kind: "turn-cancel" }> | undefined;
  let cancelWatcher: Promise<void> | undefined;
  let ownsCancelHook = false;

  try {
    try {
      await claimHookOwnership(inbox);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    cancelHook = createHook<{ readonly kind: "turn-cancel" }>({
      token: `${input.completionToken}:cancel`,
    });
    cancelIterator = cancelHook[Symbol.asyncIterator]();
    await claimHookOwnership(cancelHook);
    ownsCancelHook = true;
    cancelWatcher = cancelIterator.next().then((next) => {
      if (!next.done) abortController.abort(new TurnCancelledError());
    });

    while (true) {
      const result = await turnStep(cursor.createStepInput(nextStepInput));

      if (result.action === "done") {
        await cursor.finish(
          result,
          {
            kind: "done",
            output: result.output ?? "",
            isError: result.isError,
            usage: result.usage,
          },
          bufferedDeliveries,
        );
        return;
      }

      // A pending runtime-action batch (model-driven `park` or dynamic-workflow
      // interrupt) is resolved in-line so the turn stays alive across the wait;
      // the two arms differ only in their dispatch path.
      const pendingActionKeys =
        result.action === "dispatch-workflow-runtime-actions" || result.action === "park"
          ? result.pendingRuntimeActionKeys
          : undefined;

      if (pendingActionKeys !== undefined) {
        await cursor.adopt(result);
        const dispatch =
          result.action === "dispatch-workflow-runtime-actions"
            ? dispatchWorkflowRuntimeActionsStep
            : dispatchRuntimeActionsStep;
        const dispatchResult = await dispatch({
          abortSignal: abortController.signal,
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          parentContinuationToken: inbox.token,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        await cursor.adopt(dispatchResult);

        const results = await waitForRuntimeActionResults({
          bufferedDeliveries,
          cursor,
          inboxToken: inbox.token,
          initialResults: dispatchResult.results,
          iterator,
          nextDeliveryRequestId,
          pendingActionKeys,
          abortSignal: abortController.signal,
        });
        nextStepInput = { kind: "runtime-action-result", results };
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        await cursor.finish(
          result,
          {
            authorizationNames: result.authorizationNames,
            kind: "park",
          },
          bufferedDeliveries,
        );
        return;
      }

      await cursor.adopt(result);
      nextStepInput = undefined;
    }
  } catch (error) {
    await cancelPendingLocalSubagentsUntilSettled({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    await cursor.send({ error: normalizeSerializableError(error), kind: "turn-error" });
    throw error;
  } finally {
    if (ownsCancelHook && cancelHook !== undefined && cancelIterator !== undefined) {
      await disposeHookWithPendingRead(cancelHook, cancelIterator);
    } else if (cancelIterator !== undefined) {
      await closeHookIterator(cancelIterator);
    }
    void cancelWatcher;
    if (ownsInbox) await disposeHookWithPendingRead(inbox, iterator);
    else await closeHookIterator(iterator);
  }
}

async function waitForRuntimeActionResults(input: {
  readonly abortSignal?: AbortSignal;
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly cursor: TurnExecutionCursor;
  readonly inboxToken: string;
  readonly initialResults: readonly RuntimeActionResult[];
  readonly iterator: AsyncIterator<TurnInboxPayload>;
  readonly nextDeliveryRequestId: () => string;
  readonly pendingActionKeys: readonly string[];
}): Promise<readonly RuntimeActionResult[]> {
  let pendingDeliveryRequest: string | undefined;
  const results: RuntimeActionResult[] = [...input.initialResults];

  while (true) {
    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys: input.pendingActionKeys,
      results,
    });
    if (ready !== undefined) {
      if (pendingDeliveryRequest !== undefined) {
        // The entry may already be racing public input against this wait.
        // Cancellation keeps that input available for the next parent turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return ready;
    }

    if (input.cursor.sessionState.hasProxyInputRequests && pendingDeliveryRequest === undefined) {
      pendingDeliveryRequest = input.nextDeliveryRequestId();
      await input.cursor.send({
        continuationToken: input.cursor.sessionState.continuationToken,
        inboxToken: input.inboxToken,
        kind: "turn-delivery-request",
        requestId: pendingDeliveryRequest,
      });
    }

    const next = await raceWithTurnAbort(input.iterator.next(), input.abortSignal);
    if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    const value = next.value;
    if (value.kind === "runtime-action-result") {
      results.push(...value.results);
      continue;
    }

    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const proxyResult = await runProxySubagentEventStep({
        hookPayload: value,
        parentWritable: input.cursor.parentWritable,
        serializedContext: input.cursor.serializedContext,
        sessionState: input.cursor.sessionState,
      });
      await input.cursor.adopt(proxyResult);
      continue;
    }

    // Only `driver-delivery` reaches the inbox for public input: children
    // resume it with results/HITL, and the driver relays public deliveries
    // through the request handshake. A stale, non-matching request id means
    // the turn already resolved and the driver re-buffered the delivery.
    if (value.kind === "driver-delivery" && value.requestId === pendingDeliveryRequest) {
      await input.cursor.send({ kind: "turn-delivery-accepted", requestId: value.requestId });
      pendingDeliveryRequest = undefined;

      const remainder = await routeDeliverToChildren({
        auth: value.delivery.auth,
        parentWritable: input.cursor.parentWritable,
        payloads: value.delivery.payloads,
        sessionState: input.cursor.sessionState,
      });
      if (remainder !== undefined) {
        input.bufferedDeliveries.push({ ...value.delivery, payloads: [remainder] });
      }
    }
  }
}

async function runLegacyTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
              usage: result.usage,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-workflow-runtime-actions") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "dispatch-workflow-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingActionKeys = result.pendingRuntimeActionKeys;
        const canPark =
          pendingActionKeys !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        const action: NextDriverAction =
          pendingActionKeys !== undefined
            ? {
                kind: "dispatch-runtime-actions",
                pendingActionKeys,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationNames: result.authorizationNames,
              };

        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: { action, kind: "turn-result" },
        });
        return;
      }

      currentStepInput = {
        abortSignal: currentStepInput.abortSignal,
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}
