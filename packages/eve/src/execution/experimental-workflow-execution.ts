import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { cancelPendingLocalSubagentsUntilSettled } from "#execution/cancel-pending-local-subagents-until-settled.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { ExperimentalWorkflowEntryInput } from "#execution/experimental-workflow-controller.js";
import type { ExperimentalWorkflowIterationExecutionResult } from "#execution/experimental-workflow-entry.js";
import {
  advanceExperimentalWorkflowStep,
  captureExperimentalWorkflowAdvanceTimingStep,
  continueExperimentalWorkflowProgramStep,
  executeExperimentalWorkflowProgramStep,
  prepareExperimentalWorkflowDispatchStep,
  resolveExperimentalWorkflowRuntimeActionsStep,
} from "#execution/experimental-workflow-steps.js";
import type { TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import { raceWithTurnAbort } from "#harness/turn-cancellation.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type {
  ExperimentalWorkflowAdvanceOutcome,
  ExperimentalWorkflowSnapshot,
} from "#shared/experimental-workflow-definition.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

export async function runExperimentalWorkflowIteration(input: {
  readonly abortSignal: AbortSignal;
  readonly inboxIterator: AsyncIterator<TurnInboxPayload>;
  readonly inboxToken: string;
  readonly input: ExperimentalWorkflowEntryInput;
  readonly iterationRunId: string;
  readonly onSessionState: (sessionState: DurableSessionState) => void;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly snapshot: ExperimentalWorkflowSnapshot;
}): Promise<ExperimentalWorkflowIterationExecutionResult> {
  let sessionState = input.input.sessionState;
  let output: JsonValue | undefined;
  let failure: string | undefined;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const attempted = await runExperimentalWorkflowProgramAttempt({
        ...input,
        attempt,
        input: { ...input.input, sessionState },
        onSessionState(nextSessionState) {
          sessionState = nextSessionState;
          input.onSessionState(nextSessionState);
        },
      });
      sessionState = attempted.sessionState;
      output = attempted.output;
      failure = undefined;
      break;
    } catch (error) {
      // `sessionState` is attempt-local and may be newer than the outer
      // iteration's last observed snapshot when cancellation races a step
      // return. Retain workflow ownership until every child is terminal.
      await cancelPendingLocalSubagentsUntilSettled({
        serializedContext: input.input.serializedContext,
        sessionState,
      });
      if (input.abortSignal.aborted) throw error;
      sessionState = input.input.sessionState;
      input.onSessionState(sessionState);
      failure = error instanceof Error ? error.message : String(error);
      if (attempt === 4) break;
    }
  }

  let outcome: ExperimentalWorkflowAdvanceOutcome;
  if (failure === undefined) {
    const completed: { kind: "completed"; output?: JsonValue } = { kind: "completed" };
    if (output !== undefined) completed.output = output;
    outcome = completed;
  } else {
    outcome = { error: failure, kind: "failed" };
  }
  const timing = await captureExperimentalWorkflowAdvanceTimingStep({
    cadence: input.snapshot.cadence,
  });
  const advanced = await advanceExperimentalWorkflowStep({
    advance: {
      ...timing,
      expectedIteration: input.snapshot.iteration,
      outcome,
      reference: input.input.reference,
    },
    definitionSourceId: input.input.definitionSourceId,
    serializedContext: input.input.serializedContext,
    snapshot: input.snapshot,
  });
  let result: ExperimentalWorkflowIterationExecutionResult["result"];
  if (failure === undefined) {
    const completed: { kind: "completed"; nextDueAt: string; output?: JsonValue } = {
      kind: "completed",
      nextDueAt: advanced.nextDueAt,
    };
    if (output !== undefined) completed.output = output;
    result = completed;
  } else {
    result = { error: failure, kind: "failed", nextDueAt: advanced.nextDueAt };
  }
  return {
    next:
      advanced.nextSnapshot === null
        ? null
        : {
            dueAt: advanced.nextSnapshot.dueAt,
            iteration: advanced.nextSnapshot.iteration,
          },
    result,
  };
}

async function runExperimentalWorkflowProgramAttempt(input: {
  readonly abortSignal: AbortSignal;
  readonly attempt: number;
  readonly inboxIterator: AsyncIterator<TurnInboxPayload>;
  readonly inboxToken: string;
  readonly input: ExperimentalWorkflowEntryInput;
  readonly iterationRunId: string;
  readonly onSessionState: (sessionState: DurableSessionState) => void;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly snapshot: ExperimentalWorkflowSnapshot;
}): Promise<{ readonly output?: JsonValue; readonly sessionState: DurableSessionState }> {
  throwIfAborted(input.abortSignal);

  let programResult = await executeExperimentalWorkflowProgramStep({
    abortSignal: input.abortSignal,
    attempt: input.attempt,
    iterationRunId: input.iterationRunId,
    serializedContext: input.input.serializedContext,
    sessionState: input.input.sessionState,
    snapshot: input.snapshot,
  });
  let sessionState = input.input.sessionState;

  while (programResult.status === "interrupted") {
    throwIfAborted(input.abortSignal);
    const prepared = await prepareExperimentalWorkflowDispatchStep({
      interrupt: programResult.interrupt,
      serializedContext: input.input.serializedContext,
      sessionState,
    });
    sessionState = prepared.sessionState;
    input.onSessionState(sessionState);
    const dispatched = await dispatchWorkflowRuntimeActionsStep({
      abortSignal: input.abortSignal,
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(String(getWorkflowMetadata().url)),
      parentContinuationToken: input.inboxToken,
      parentWritable: input.parentWritable,
      serializedContext: input.input.serializedContext,
      sessionState,
    });
    sessionState = dispatched.sessionState;
    input.onSessionState(sessionState);
    const results = await waitForExperimentalWorkflowRuntimeActions({
      abortSignal: input.abortSignal,
      initialResults: dispatched.results,
      iterator: input.inboxIterator,
      pendingActionKeys: prepared.pendingActionKeys,
    });
    const resolved = await resolveExperimentalWorkflowRuntimeActionsStep({
      results,
      serializedContext: input.input.serializedContext,
      sessionState,
    });
    sessionState = resolved.sessionState;
    input.onSessionState(sessionState);
    programResult = await continueExperimentalWorkflowProgramStep({
      abortSignal: input.abortSignal,
      interrupt: programResult.interrupt,
      results,
      serializedContext: input.input.serializedContext,
      sessionState,
    });
  }

  throwIfAborted(input.abortSignal);
  const output =
    programResult.output === undefined ? undefined : parseJsonValue(programResult.output);
  const result: { output?: JsonValue; sessionState: DurableSessionState } = {
    sessionState,
  };
  if (output !== undefined) result.output = output;
  return result;
}

async function waitForExperimentalWorkflowRuntimeActions(input: {
  readonly abortSignal: AbortSignal;
  readonly initialResults: readonly RuntimeActionResult[];
  readonly iterator: AsyncIterator<TurnInboxPayload>;
  readonly pendingActionKeys: readonly string[];
}): Promise<readonly RuntimeActionResult[]> {
  const results = [...input.initialResults];
  while (true) {
    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys: input.pendingActionKeys,
      results,
    });
    if (ready !== undefined) return ready;

    const next = await raceWithTurnAbort(input.iterator.next(), input.abortSignal);
    if (next.done) throw new Error("ExperimentalWorkflow inbox closed before children completed.");
    if (next.value.kind === "runtime-action-result") {
      results.push(...next.value.results);
      continue;
    }
    throw new Error(
      `ExperimentalWorkflow child requested unsupported interaction "${next.value.kind}".`,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("ExperimentalWorkflow stopped.");
}
