import { HookNotFoundError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import { deserializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { getNextExperimentalWorkflowDueAt } from "#execution/experimental-workflow-cadence.js";
import {
  createExperimentalWorkflowIterationInput,
  getExperimentalWorkflowIterationOwnershipToken,
  type ExperimentalWorkflowIterationDispatchInput,
} from "#execution/durable-session-migrations/experimental-workflow.js";
import type { ExperimentalWorkflowIterationResult } from "#execution/experimental-workflow-entry.js";
import { hydrateDurableSession } from "#execution/session.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import {
  experimentalWorkflowIterationReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import {
  clearPendingRuntimeActionBatch,
  resolvePendingRuntimeActions,
} from "#harness/runtime-actions.js";
import { createWorkflowRuntimeActionErrorResolution } from "#harness/workflow-sandbox.js";
import {
  continueWorkflowProgram,
  executeWorkflowProgram,
  type WorkflowProgramContext,
} from "#harness/workflow-program.js";
import { getWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import {
  clearPendingWorkflowInterrupt,
  setPendingWorkflowInterrupt,
} from "#harness/workflow-interrupt-state.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  getWorkflowRuntimeActionInterrupts,
} from "#harness/workflow-runtime-action-state.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import {
  assertExperimentalWorkflowDefinitionSourceId,
  parseExperimentalWorkflowSnapshot,
} from "#runtime/experimental-workflow-boundary.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  ExperimentalWorkflowAdvance,
  ExperimentalWorkflowCadence,
  ExperimentalWorkflowSnapshot,
} from "#shared/experimental-workflow-definition.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

const ITERATION_OWNER_HOOK_RETRY_ATTEMPTS = 300;
const ITERATION_OWNER_HOOK_RETRY_DELAY_MS = 100;

export async function loadExperimentalWorkflowSnapshotStep(input: {
  readonly definitionSourceId: string;
  readonly reference: JsonValue;
  readonly serializedContext: Record<string, unknown>;
}): Promise<ExperimentalWorkflowSnapshot | null> {
  "use step";

  return loadExperimentalWorkflowSnapshot(input);
}

async function loadExperimentalWorkflowSnapshot(input: {
  readonly definitionSourceId: string;
  readonly reference: JsonValue;
  readonly serializedContext: Record<string, unknown>;
}): Promise<ExperimentalWorkflowSnapshot | null> {
  const ctx = await deserializeContext(input.serializedContext);
  const definition = ctx.require(BundleKey).resolvedAgent.experimentalWorkflow;
  if (definition === undefined) {
    throw new Error("The current deployment no longer configures this ExperimentalWorkflow.");
  }
  assertExperimentalWorkflowDefinitionSourceId({
    actualSourceId: definition.sourceId,
    expectedSourceId: input.definitionSourceId,
  });
  const snapshot = await definition.load(input.reference);
  return snapshot === null ? null : parseExperimentalWorkflowSnapshot(snapshot);
}

export async function executeExperimentalWorkflowProgramStep(input: {
  readonly abortSignal: AbortSignal;
  readonly attempt: number;
  readonly iterationRunId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly snapshot: ExperimentalWorkflowSnapshot;
}) {
  "use step";

  const { bundle, session } = await hydrateExperimentalWorkflowSession(input);
  const context: Mutable<WorkflowProgramContext> = {
    input: input.snapshot.input,
    iteration: input.snapshot.iteration,
    scheduledAt: input.snapshot.dueAt,
  };
  if (input.snapshot.state !== undefined) context.state = input.snapshot.state;
  return executeWorkflowProgram({
    abortSignal: input.abortSignal,
    continuationSecurity: getWorkflowContinuationSecurity(session),
    context,
    outerToolCallId: createExperimentalWorkflowOuterToolCallId(input.iterationRunId, input.attempt),
    program: input.snapshot.program,
    tools: createNodeHarnessTools({
      node: getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId),
    }),
  });
}

export function createExperimentalWorkflowOuterToolCallId(
  iterationRunId: string,
  attempt: number,
): string {
  return `experimental-workflow-${iterationRunId}-attempt-${String(attempt)}`;
}

export async function prepareExperimentalWorkflowDispatchStep(input: {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly pendingActionKeys: readonly string[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const { session } = await hydrateExperimentalWorkflowSession(input);
  const cleanSession = clearPendingRuntimeActionBatch(clearPendingWorkflowInterrupt(session));
  const parked = setPendingWorkflowInterrupt({
    interrupt: input.interrupt,
    responseMessages: [],
    session: cleanSession,
  });
  return {
    pendingActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(input.interrupt),
    sessionState: createDurableSessionState({ session: parked }),
  };
}

export async function continueExperimentalWorkflowProgramStep(input: {
  readonly abortSignal: AbortSignal;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly results: readonly RuntimeActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}) {
  "use step";

  const { bundle, session } = await hydrateExperimentalWorkflowSession(input);
  const tools = createNodeHarnessTools({
    node: getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId),
  });
  const continuationSecurity = getWorkflowContinuationSecurity(session);
  let currentInterrupt = input.interrupt;
  let result:
    | { readonly output: unknown; readonly status: "completed" }
    | { readonly interrupt: WorkflowSandboxInterrupt; readonly status: "interrupted" } = {
    interrupt: currentInterrupt,
    status: "interrupted",
  };

  for (const resolution of input.results) {
    result = await continueWorkflowProgram({
      abortSignal: input.abortSignal,
      continuationSecurity,
      interrupt: currentInterrupt,
      resolution:
        "isError" in resolution && resolution.isError === true
          ? createWorkflowRuntimeActionErrorResolution(resolution.output)
          : resolution.output,
      tools,
    });
    if (result.status === "completed") return result;
    const nextInterrupt = getWorkflowRuntimeActionInterrupts(result.interrupt)[0];
    if (nextInterrupt === undefined) return result;
    currentInterrupt = nextInterrupt;
  }
  return result;
}

export async function resolveExperimentalWorkflowRuntimeActionsStep(input: {
  readonly results: readonly RuntimeActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const { session } = await hydrateExperimentalWorkflowSession(input);
  const resolved = await resolvePendingRuntimeActions({
    session,
    stepInput: { runtimeActionResults: input.results },
  });
  if (resolved.outcome !== "resolved") {
    throw new Error("ExperimentalWorkflow runtime-action batch did not resolve completely.");
  }
  return { sessionState: createDurableSessionState({ session: resolved.session }) };
}

/** Records the only wall-clock value used by one persistence transition. */
export async function captureExperimentalWorkflowAdvanceTimingStep(input: {
  readonly cadence: ExperimentalWorkflowCadence;
}): Promise<{ readonly completedAt: string; readonly nextDueAt: string }> {
  "use step";

  const completedAt = new Date().toISOString();
  return {
    completedAt,
    nextDueAt: getNextExperimentalWorkflowDueAt({
      cadence: input.cadence,
      completedAt,
    }),
  };
}

export async function advanceExperimentalWorkflowStep(input: {
  readonly advance: ExperimentalWorkflowAdvance<JsonValue>;
  readonly definitionSourceId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly snapshot: ExperimentalWorkflowSnapshot;
}): Promise<{
  readonly nextDueAt: string;
  readonly nextSnapshot: ExperimentalWorkflowSnapshot | null;
}> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const definition = ctx.require(BundleKey).resolvedAgent.experimentalWorkflow;
  if (definition === undefined) {
    throw new Error("The current deployment no longer configures this ExperimentalWorkflow.");
  }
  assertExperimentalWorkflowDefinitionSourceId({
    actualSourceId: definition.sourceId,
    expectedSourceId: input.definitionSourceId,
  });
  const next = await definition.advance({
    ...input.advance,
  });
  if (next === null) return { nextDueAt: input.advance.nextDueAt, nextSnapshot: null };

  const nextSnapshot = parseExperimentalWorkflowSnapshot(next);
  if (nextSnapshot.iteration !== input.snapshot.iteration + 1) {
    throw new Error(
      `ExperimentalWorkflow advance() returned iteration ${String(nextSnapshot.iteration)}; expected ${String(input.snapshot.iteration + 1)}.`,
    );
  }
  if (nextSnapshot.dueAt !== input.advance.nextDueAt) {
    throw new Error(
      `ExperimentalWorkflow advance() returned dueAt "${nextSnapshot.dueAt}"; expected "${input.advance.nextDueAt}".`,
    );
  }
  return { nextDueAt: input.advance.nextDueAt, nextSnapshot };
}

export async function startExperimentalWorkflowIterationStep(
  input: ExperimentalWorkflowIterationDispatchInput,
): Promise<ExperimentalWorkflowIterationStartResult> {
  "use step";

  const ownershipToken = getExperimentalWorkflowIterationOwnershipToken(
    input.controller.controlToken,
    input.expectedIteration,
  );
  try {
    return { runId: (await getHookByToken(ownershipToken)).runId };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }

  // The previous start can commit, run to completion, advance the app-owned
  // cursor, and dispose its ownership hook before this step's response is
  // durably recorded. Recover that committed transition from the source of
  // truth before starting another child for the stale cursor.
  const currentSnapshot = await loadExperimentalWorkflowSnapshot({
    definitionSourceId: input.controller.definitionSourceId,
    reference: input.controller.reference,
    serializedContext: input.controller.serializedContext,
  });
  if (currentSnapshot === null) return { kind: "terminal" };
  if (currentSnapshot.iteration > input.expectedIteration) {
    return {
      cursor: {
        dueAt: currentSnapshot.dueAt,
        iteration: currentSnapshot.iteration,
      },
      kind: "advanced",
    };
  }
  if (
    currentSnapshot.iteration !== input.expectedIteration ||
    currentSnapshot.dueAt !== input.expectedDueAt
  ) {
    throw new Error(
      `ExperimentalWorkflow iteration cursor changed from ${String(input.expectedIteration)} at "${input.expectedDueAt}" to ${String(currentSnapshot.iteration)} at "${currentSnapshot.dueAt}".`,
    );
  }

  const wireInput = createExperimentalWorkflowIterationInput(input);
  const run = await startWorkflowPreferLatest(experimentalWorkflowIterationReference, [wireInput]);
  for (let attempt = 0; attempt < ITERATION_OWNER_HOOK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return { runId: (await getHookByToken(ownershipToken)).runId };
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      let status: Awaited<typeof run.status> | undefined;
      try {
        status = await run.status;
      } catch (statusError) {
        if (!WorkflowRunNotFoundError.is(statusError)) throw statusError;
      }
      if (status === "cancelled" || status === "completed" || status === "failed") {
        return { runId: run.runId };
      }
      if (attempt === ITERATION_OWNER_HOOK_RETRY_ATTEMPTS - 1) {
        // The candidate is already durable even if its hook is slow to publish.
        // Returning its id lets the controller poll or cancel it without
        // discarding ownership at this bounded step boundary.
        return { runId: run.runId };
      }
      await new Promise((resolve) => setTimeout(resolve, ITERATION_OWNER_HOOK_RETRY_DELAY_MS));
    }
  }
  return { runId: run.runId };
}

export type ExperimentalWorkflowIterationStartResult =
  | { readonly runId: string }
  | {
      readonly cursor: { readonly dueAt: string; readonly iteration: number };
      readonly kind: "advanced";
    }
  | { readonly kind: "terminal" };

export type ExperimentalWorkflowIterationPollResult =
  | { readonly kind: "missing" }
  | { readonly kind: "pending" }
  | { readonly error: unknown; readonly kind: "rejected" }
  | { readonly kind: "settled"; readonly result: ExperimentalWorkflowIterationResult };

export type ExperimentalWorkflowIterationCompletionPayload = {
  readonly kind: "iteration-settling";
  readonly runId: string;
};

/** Notifies the durable controller after the iteration has finished its cleanup. */
export async function sendExperimentalWorkflowIterationCompletionStep(input: {
  readonly controlToken: string;
  readonly payload: ExperimentalWorkflowIterationCompletionPayload;
}): Promise<void> {
  "use step";

  await resumeHook(input.controlToken, input.payload);
}

/**
 * Reads one child status without holding a worker while the child is active.
 * The workflow body separates pending probes with durable `sleep()` calls.
 */
export async function pollExperimentalWorkflowIterationStep(
  runId: string,
): Promise<ExperimentalWorkflowIterationPollResult> {
  "use step";

  const run = getRun(runId);
  let status: Awaited<typeof run.status>;
  try {
    status = await run.status;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return { kind: "missing" };
    throw error;
  }
  if (status !== "cancelled" && status !== "completed" && status !== "failed") {
    return { kind: "pending" };
  }

  try {
    return {
      kind: "settled",
      result: (await run.returnValue) as ExperimentalWorkflowIterationResult,
    };
  } catch (error) {
    return { error: normalizeSerializableError(error), kind: "rejected" };
  }
}

export async function cancelExperimentalWorkflowIterationStep(input: {
  readonly reason?: string;
  readonly runId: string;
}): Promise<boolean> {
  "use step";

  const token = `${input.runId}:cancel`;
  try {
    const control: { kind: "cancel"; reason?: string } = {
      kind: "cancel",
    };
    if (input.reason !== undefined) control.reason = input.reason;
    await resumeHook(token, control);
    return true;
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }

  let status: Awaited<ReturnType<typeof getRun>["status"]> | undefined;
  try {
    status = await getRun(input.runId).status;
  } catch (error) {
    if (!WorkflowRunNotFoundError.is(error)) throw error;
  }
  return status === "cancelled" || status === "completed" || status === "failed";
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

async function hydrateExperimentalWorkflowSession(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}) {
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const durable = await readDurableSession(input.sessionState);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable,
    turnAgent: bundle.turnAgent,
  });
  return { bundle, session };
}
