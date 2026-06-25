import { createHook } from "#compiled/@workflow/core/index.js";

import type { NextDriverAction } from "#execution/next-driver-action.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { finalizeCancelledTurnStep } from "#execution/finalize-cancelled-turn-step.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { turnStep } from "#execution/workflow-steps.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

/**
 * Hook payload the turn child workflow delivers to the parent driver
 * on completion. `turn-result` wraps a {@link NextDriverAction} the
 * driver dispatches on; `turn-error` carries a normalized error the
 * driver rethrows.
 */
export type TurnCompletionPayload =
  | { readonly kind: "turn-result"; readonly action: NextDriverAction }
  | { readonly kind: "turn-error"; readonly error: unknown };

export type { TurnWorkflowInput };

/**
 * Short-lived workflow that owns one runtime turn for the driver.
 *
 * `parentWritable` is threaded in from the driver run so event writes
 * land on the driver's stream. Resolves the turn into a
 * {@link NextDriverAction} and reports it back through
 * {@link notifyDriverStep}.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);
  const abortState = resolveAbortState(input.stepInput.abortSignal);
  const cancelHook =
    abortState.abortController === undefined
      ? undefined
      : createCancelHook(input.stepInput.sessionState.continuationToken);
  const initialStepInput: TurnStepInput = {
    ...input.stepInput,
    abortSignal: abortState.abortSignal,
  };

  try {
    let action: NextDriverAction;
    try {
      if (cancelHook !== undefined) {
        await claimHookOwnership(cancelHook);
      }

      const execution = runTurnExecution(input, initialStepInput);
      if (cancelHook === undefined || abortState.abortController === undefined) {
        action = await execution;
      } else {
        const abortController = abortState.abortController;
        action = await Promise.race([
          execution,
          cancelHook.then(() => {
            abortController.abort();
            return execution;
          }),
        ]);
      }
    } finally {
      if (cancelHook !== undefined) {
        await disposeHook(cancelHook);
      }
    }

    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: { action, kind: "turn-result" },
    });
  } catch (error) {
    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: {
        error: normalizeSerializableError(error),
        kind: "turn-error",
      },
    });
    throw error;
  }
}

async function runTurnExecution(
  input: TurnWorkflowInput,
  initialStepInput: TurnStepInput,
): Promise<NextDriverAction> {
  let currentStepInput = initialStepInput;

  while (true) {
    let result: Awaited<ReturnType<typeof turnStep>>;
    try {
      result = await turnStep(currentStepInput);
    } catch (error) {
      if (currentStepInput.abortSignal?.aborted !== true) {
        throw error;
      }

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

      if (!canPark) {
        throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);
      }

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

      return action;
    }

    currentStepInput = {
      abortSignal: currentStepInput.abortSignal,
      input: undefined,
      parentWritable: currentStepInput.parentWritable,
      serializedContext: result.serializedContext,
      sessionState: result.sessionState,
    };
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

/** Resumes the driver's one-shot completion hook with the turn result. */
export async function notifyDriverStep(input: {
  readonly completionToken: string;
  readonly payload: TurnCompletionPayload;
}): Promise<void> {
  "use step";

  await resumeHook(input.completionToken, input.payload);
}
