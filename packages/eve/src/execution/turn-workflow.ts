import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { finalizeCancelledTurnStep } from "#execution/finalize-cancelled-turn-step.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { runProxyInputRequestStep, turnStep } from "#execution/workflow-steps.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

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
  const cursor = new TurnExecutionCursor({
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

  try {
    try {
      await claimHookOwnership(inbox);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    const terminal = await runWithTurnCancellation({
      continuationToken: input.stepInput.sessionState.continuationToken,
      execute: async (abortSignal) => {
        while (true) {
          let result: Awaited<ReturnType<typeof turnStep>>;
          try {
            result = await turnStep({
              ...cursor.createStepInput(nextStepInput),
              abortSignal,
            });
          } catch (error) {
            if (!abortSignal.aborted) throw error;

            const cancelled = await finalizeCancelledTurnStep({
              parentWritable: cursor.parentWritable,
              serializedContext: cursor.serializedContext,
              sessionState: cursor.sessionState,
            });
            return { ...cancelled, action: { kind: "park" as const } };
          }

          if (result.action === "done") {
            return {
              action: {
                isError: result.isError,
                kind: "done" as const,
                output: result.output ?? "",
              },
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            };
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

            return {
              action: {
                authorizationNames: result.authorizationNames,
                kind: "park" as const,
              },
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            };
          }

          await cursor.adopt(result);
          nextStepInput = undefined;
        }
      },
      inheritedSignal: input.stepInput.abortSignal,
    });

    await cursor.finish(terminal, terminal.action, bufferedDeliveries);
  } catch (error) {
    await cursor.send({ error: normalizeSerializableError(error), kind: "turn-error" });
    throw error;
  } finally {
    await closeHookIterator(iterator);
    if (ownsInbox) await disposeHook(inbox);
  }
}

async function waitForRuntimeActionResults(input: {
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

    const next = await input.iterator.next();
    if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    const value = next.value;
    if (value.kind === "runtime-action-result") {
      results.push(...value.results);
      continue;
    }

    if (value.kind === "subagent-input-request") {
      const proxyResult = await runProxyInputRequestStep({
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
  try {
    const action = await runWithTurnCancellation({
      continuationToken: input.stepInput.sessionState.continuationToken,
      execute: async (abortSignal): Promise<NextDriverAction> => {
        let currentStepInput: TurnStepInput = { ...input.stepInput, abortSignal };

        while (true) {
          let result: Awaited<ReturnType<typeof turnStep>>;
          try {
            result = await turnStep(currentStepInput);
          } catch (error) {
            if (!abortSignal.aborted) throw error;

            const cancelled = await finalizeCancelledTurnStep({
              parentWritable: currentStepInput.parentWritable,
              serializedContext: currentStepInput.serializedContext,
              sessionState: currentStepInput.sessionState,
            });
            return {
              kind: "park",
              serializedContext: cancelled.serializedContext,
              sessionState: cancelled.sessionState,
            };
          }

          if (result.action === "done") {
            return {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            };
          }

          if (result.action === "dispatch-workflow-runtime-actions") {
            return {
              kind: "dispatch-workflow-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            };
          }

          if (result.action === "park") {
            const pendingActionKeys = result.pendingRuntimeActionKeys;
            const canPark =
              pendingActionKeys !== undefined ||
              result.hasPendingAuthorization ||
              (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
              input.mode === "conversation";

            if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

            return pendingActionKeys !== undefined
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
          }

          currentStepInput = {
            abortSignal,
            input: undefined,
            parentWritable: currentStepInput.parentWritable,
            serializedContext: result.serializedContext,
            sessionState: result.sessionState,
          };
        }
      },
      inheritedSignal: input.stepInput.abortSignal,
    });

    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { action, kind: "turn-result" },
    });
  } catch (error) {
    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}

async function runWithTurnCancellation<T>(input: {
  readonly continuationToken: string;
  readonly execute: (abortSignal: AbortSignal) => Promise<T>;
  readonly inheritedSignal: AbortSignal | undefined;
}): Promise<T> {
  const abortState = resolveAbortState(input.inheritedSignal);
  const cancelHook =
    abortState.abortController === undefined
      ? undefined
      : createCancelHook(input.continuationToken);
  let ownsCancelHook = false;

  try {
    if (cancelHook !== undefined) {
      await claimHookOwnership(cancelHook);
      ownsCancelHook = true;
    }

    const execution = input.execute(abortState.abortSignal);
    if (cancelHook === undefined || abortState.abortController === undefined) {
      return await execution;
    }

    const abortController = abortState.abortController;
    return await Promise.race([
      execution,
      cancelHook.then(() => {
        abortController.abort();
        return execution;
      }),
    ]);
  } finally {
    if (ownsCancelHook && cancelHook !== undefined) {
      await disposeHook(cancelHook);
    }
  }
}

function resolveAbortState(inheritedSignal: AbortSignal | undefined): {
  readonly abortController?: AbortController;
  readonly abortSignal: AbortSignal;
} {
  if (inheritedSignal !== undefined) {
    return { abortSignal: inheritedSignal };
  }

  const abortController = new AbortController();
  return { abortController, abortSignal: abortController.signal };
}

function createCancelHook(continuationToken: string) {
  if (continuationToken.length === 0) {
    return undefined;
  }

  return createHook<unknown>({ token: `${continuationToken}:cancel` });
}
