import {
  createHook,
  getWorkflowMetadata,
  getWritable,
  sleep,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import {
  getExperimentalWorkflowReadyToken,
  migrateExperimentalWorkflowEntryInput,
  migrateExperimentalWorkflowIterationInput,
  type ExperimentalWorkflowIterationInput,
} from "#execution/durable-session-migrations/experimental-workflow.js";
import { runExperimentalWorkflowIteration } from "#execution/experimental-workflow-execution.js";
import {
  cancelExperimentalWorkflowIterationStep,
  loadExperimentalWorkflowSnapshotStep,
  pollExperimentalWorkflowIterationStep,
  sendExperimentalWorkflowIterationCompletionStep,
  startExperimentalWorkflowIterationStep,
  type ExperimentalWorkflowIterationCompletionPayload,
} from "#execution/experimental-workflow-steps.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  disposeHookWithPendingRead,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import type { TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
import type { JsonValue } from "#shared/json.js";

type ExperimentalWorkflowControl =
  | ExperimentalWorkflowIterationCompletionPayload
  | {
      readonly expectedRunId?: string;
      readonly kind: "stop";
      readonly reason?: string;
    };

const EXPERIMENTAL_WORKFLOW_ITERATION_POLL_INITIAL_MS = 1_000;
const EXPERIMENTAL_WORKFLOW_ITERATION_POLL_MAX_MS = 60_000;
const EXPERIMENTAL_WORKFLOW_ITERATION_CANCEL_INITIAL_MS = 100;
const EXPERIMENTAL_WORKFLOW_ITERATION_CANCEL_MAX_MS = 5_000;
const EXPERIMENTAL_WORKFLOW_ITERATION_SETTLING_POLL_INITIAL_MS = 100;
const EXPERIMENTAL_WORKFLOW_ITERATION_SETTLING_POLL_MAX_MS = 5_000;
const EXPERIMENTAL_WORKFLOW_ITERATION_NOT_FOUND_DELAYS_MS = [1_000, 3_000, 6_000] as const;

export type ExperimentalWorkflowEntryResult =
  | { readonly kind: "completed"; readonly nextDueAt: string; readonly output?: JsonValue }
  | { readonly kind: "deleted" }
  | { readonly kind: "duplicate"; readonly runId: string }
  | { readonly error: string; readonly kind: "failed"; readonly nextDueAt: string }
  | { readonly kind: "stale" }
  | { readonly kind: "stopped"; readonly reason?: string };

export interface ExperimentalWorkflowIterationExecutionResult {
  readonly next: { readonly dueAt: string; readonly iteration: number } | null;
  readonly result: Extract<
    ExperimentalWorkflowEntryResult,
    { readonly kind: "completed" | "failed" }
  >;
}

/**
 * Latest-child to pinned-controller wire. Keep this shape additive-only for
 * v1 controllers; a breaking result change requires a negotiated entrypoint.
 */
export type ExperimentalWorkflowIterationResult =
  | ExperimentalWorkflowIterationExecutionResult
  | { readonly kind: "duplicate"; readonly runId: string }
  | { readonly kind: "deleted" }
  | { readonly kind: "stopped"; readonly reason?: string };

/** Owns and runs every durable iteration for one configured workflow reference. */
export async function experimentalWorkflowEntry(
  rawInput: unknown,
): Promise<ExperimentalWorkflowEntryResult> {
  "use workflow";

  const input = migrateExperimentalWorkflowEntryInput(rawInput);
  const runId = String(getWorkflowMetadata().workflowRunId);
  const controlHook = createHook<ExperimentalWorkflowControl>({ token: input.controlToken });
  const controlIterator = controlHook[Symbol.asyncIterator]();
  let readyHook: Hook<never> | undefined;
  let ownsControl = false;
  let ownsReady = false;

  try {
    let conflict: Awaited<ReturnType<typeof controlHook.getConflict>>;
    try {
      conflict = await controlHook.getConflict();
    } catch (error) {
      if (isHookConflictError(error) && typeof error.conflictingRunId === "string") {
        return { kind: "duplicate", runId: error.conflictingRunId };
      }
      throw error;
    }
    if (conflict !== null) {
      return { kind: "duplicate", runId: conflict.runId };
    }
    ownsControl = true;
    let controlWait = controlIterator.next();

    const initialSnapshot = await loadExperimentalWorkflowSnapshotStep({
      definitionSourceId: input.definitionSourceId,
      reference: input.reference,
      serializedContext: input.serializedContext,
    });
    if (initialSnapshot === null) return { kind: "deleted" };
    const initialReadiness = await consumeQueuedStopBeforeReadiness({
      controlIterator,
      controlWait,
      runId,
    });
    controlWait = initialReadiness.controlWait;
    if (initialReadiness.stop !== null) {
      return createStoppedEntryResult(initialReadiness.stop.reason);
    }
    let cursor = {
      dueAt: initialSnapshot.dueAt,
      iteration: initialSnapshot.iteration,
    };
    if (getExperimentalWorkflowReadyToken(input.controlToken, cursor) !== input.readyToken) {
      return { kind: "stale" };
    }

    readyHook = createHook<never>({
      token: input.readyToken,
    });
    await claimHookOwnership(readyHook);
    ownsReady = true;

    while (true) {
      const dueAt = new Date(cursor.dueAt);
      if (dueAt.getTime() > Date.now()) {
        const dueWait = sleep(dueAt);
        while (true) {
          const waitOutcome = await Promise.race([
            dueWait.then(() => ({ kind: "due" as const })),
            controlWait.then((result) => ({ kind: "control" as const, result })),
          ]);
          if (waitOutcome.kind === "due") break;
          if (waitOutcome.result.done) {
            throw new Error("ExperimentalWorkflow control hook closed while waiting.");
          }
          const stop = matchStopControl(waitOutcome.result.value, runId);
          if (stop !== null) {
            return createStoppedEntryResult(stop.reason);
          }
          controlWait = controlIterator.next();
        }
      }

      while (true) {
        const boundary = await Promise.race([
          controlWait.then((result) => ({ kind: "control" as const, result })),
          Promise.resolve().then(() => ({ kind: "dispatch" as const })),
        ]);
        if (boundary.kind === "dispatch") break;
        if (boundary.result.done) {
          throw new Error("ExperimentalWorkflow control hook closed before iteration dispatch.");
        }
        controlWait = controlIterator.next();
        const stop = matchStopControl(boundary.result.value, runId);
        if (stop !== null) return createStoppedEntryResult(stop.reason);
      }

      const iterationStart = await startExperimentalWorkflowIterationStep({
        controller: input,
        expectedDueAt: cursor.dueAt,
        expectedIteration: cursor.iteration,
      });
      if (!("runId" in iterationStart)) {
        await disposeHook(readyHook);
        ownsReady = false;
        if (iterationStart.kind === "terminal") return { kind: "deleted" };

        cursor = iterationStart.cursor;
        const readiness = await consumeQueuedStopBeforeReadiness({
          controlIterator,
          controlWait,
          runId,
        });
        controlWait = readiness.controlWait;
        if (readiness.stop !== null) return createStoppedEntryResult(readiness.stop.reason);
        readyHook = createHook<never>({
          token: getExperimentalWorkflowReadyToken(input.controlToken, cursor),
        });
        await claimHookOwnership(readyHook);
        ownsReady = true;
        continue;
      }

      let iterationRunId = iterationStart.runId;
      let stopping = false;
      let stopReason: string | undefined;

      while (true) {
        const outcome = await waitForExperimentalWorkflowIterationOrControl({
          controlWait,
          runId: iterationRunId,
        });

        if (outcome.kind === "iteration") {
          if ("kind" in outcome.result && outcome.result.kind === "duplicate") {
            iterationRunId = outcome.result.runId;
            if (stopping) {
              await cancelExperimentalWorkflowIteration({
                reason: stopReason,
                runId: iterationRunId,
              });
            }
            continue;
          }
          if (stopping) return createStoppedEntryResult(stopReason);
          if (!("next" in outcome.result)) return outcome.result;
          if (outcome.result.next === null) {
            await disposeHook(readyHook);
            ownsReady = false;
            return outcome.result.result;
          }
          await disposeHook(readyHook);
          ownsReady = false;
          cursor = outcome.result.next;
          const readiness = await consumeQueuedStopBeforeReadiness({
            controlIterator,
            controlWait,
            runId,
          });
          controlWait = readiness.controlWait;
          if (readiness.stop !== null) return createStoppedEntryResult(readiness.stop.reason);
          readyHook = createHook<never>({
            token: getExperimentalWorkflowReadyToken(input.controlToken, cursor),
          });
          await claimHookOwnership(readyHook);
          ownsReady = true;
          break;
        }

        if (outcome.result.done) {
          throw new Error("ExperimentalWorkflow control hook closed before execution settled.");
        }
        controlWait = controlIterator.next();
        if (
          outcome.result.value.kind === "iteration-settling" &&
          outcome.result.value.runId === iterationRunId
        ) {
          const result = await waitForExperimentalWorkflowIteration(iterationRunId, {
            initialDelayMs: EXPERIMENTAL_WORKFLOW_ITERATION_SETTLING_POLL_INITIAL_MS,
            maxDelayMs: EXPERIMENTAL_WORKFLOW_ITERATION_SETTLING_POLL_MAX_MS,
          });
          if ("kind" in result && result.kind === "duplicate") {
            iterationRunId = result.runId;
            if (stopping) {
              await cancelExperimentalWorkflowIteration({
                reason: stopReason,
                runId: iterationRunId,
              });
            }
            continue;
          }
          if (stopping) return createStoppedEntryResult(stopReason);
          if (!("next" in result)) return result;
          if (result.next === null) {
            await disposeHook(readyHook);
            ownsReady = false;
            return result.result;
          }
          await disposeHook(readyHook);
          ownsReady = false;
          cursor = result.next;
          const readiness = await consumeQueuedStopBeforeReadiness({
            controlIterator,
            controlWait,
            runId,
          });
          controlWait = readiness.controlWait;
          if (readiness.stop !== null) return createStoppedEntryResult(readiness.stop.reason);
          readyHook = createHook<never>({
            token: getExperimentalWorkflowReadyToken(input.controlToken, cursor),
          });
          await claimHookOwnership(readyHook);
          ownsReady = true;
          break;
        }

        const stop = matchStopControl(outcome.result.value, runId);
        if (stop === null || stopping) continue;
        stopping = true;
        stopReason = stop.reason;
        await cancelExperimentalWorkflowIteration({
          reason: stop.reason,
          runId: iterationRunId,
        });
      }
    }
  } finally {
    if (ownsReady && readyHook !== undefined) await disposeHook(readyHook);
    if (ownsControl) await disposeHookWithPendingRead(controlHook, controlIterator);
    else await closeHookIterator(controlIterator);
  }
}

async function cancelExperimentalWorkflowIteration(input: {
  readonly reason?: string;
  readonly runId: string;
}): Promise<void> {
  let delayMs = EXPERIMENTAL_WORKFLOW_ITERATION_CANCEL_INITIAL_MS;
  while (!(await cancelExperimentalWorkflowIterationStep(input))) {
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, EXPERIMENTAL_WORKFLOW_ITERATION_CANCEL_MAX_MS);
  }
}

type ExperimentalWorkflowIterationWaitOutcome =
  | { readonly kind: "control"; readonly result: IteratorResult<ExperimentalWorkflowControl> }
  | { readonly kind: "iteration"; readonly result: ExperimentalWorkflowIterationResult };

async function waitForExperimentalWorkflowIterationOrControl(input: {
  readonly controlWait: Promise<IteratorResult<ExperimentalWorkflowControl>>;
  readonly runId: string;
}): Promise<ExperimentalWorkflowIterationWaitOutcome> {
  let notFoundAttempt = 0;
  let pollDelayMs = EXPERIMENTAL_WORKFLOW_ITERATION_POLL_INITIAL_MS;
  while (true) {
    const polled = await pollExperimentalWorkflowIterationStep(input.runId);
    if (polled.kind === "settled") return { kind: "iteration", result: polled.result };
    if (polled.kind === "rejected") throw rebuildSerializableError(polled.error);
    const delayMs = nextExperimentalWorkflowPollDelay(polled.kind, notFoundAttempt, pollDelayMs);
    if (polled.kind === "missing") notFoundAttempt += 1;
    const wait = await Promise.race([
      sleep(delayMs).then(() => ({ kind: "poll" as const })),
      input.controlWait.then((result) => ({ kind: "control" as const, result })),
    ]);
    if (wait.kind === "control") return wait;
    if (polled.kind !== "missing") {
      notFoundAttempt = 0;
    }
    pollDelayMs = Math.min(pollDelayMs * 2, EXPERIMENTAL_WORKFLOW_ITERATION_POLL_MAX_MS);
  }
}

async function waitForExperimentalWorkflowIteration(
  runId: string,
  options: { readonly initialDelayMs: number; readonly maxDelayMs: number },
): Promise<ExperimentalWorkflowIterationResult> {
  let notFoundAttempt = 0;
  let pollDelayMs = options.initialDelayMs;
  while (true) {
    const polled = await pollExperimentalWorkflowIterationStep(runId);
    if (polled.kind === "settled") return polled.result;
    if (polled.kind === "rejected") throw rebuildSerializableError(polled.error);
    const delayMs = nextExperimentalWorkflowPollDelay(polled.kind, notFoundAttempt, pollDelayMs);
    if (polled.kind === "missing") notFoundAttempt += 1;
    else notFoundAttempt = 0;
    await sleep(delayMs);
    pollDelayMs = Math.min(pollDelayMs * 2, options.maxDelayMs);
  }
}

function nextExperimentalWorkflowPollDelay(
  kind: "missing" | "pending",
  notFoundAttempt: number,
  pendingDelayMs: number,
): number {
  if (kind === "pending") return pendingDelayMs;
  const delay = EXPERIMENTAL_WORKFLOW_ITERATION_NOT_FOUND_DELAYS_MS[notFoundAttempt];
  if (delay !== undefined) return delay;
  throw new Error("ExperimentalWorkflow iteration did not become visible within 10 seconds.");
}

/** Executes one saved program on the latest deployment selected by its waiter. */
export async function experimentalWorkflowIteration(
  rawInput: unknown,
): Promise<ExperimentalWorkflowIterationResult> {
  "use workflow";

  const runId = String(getWorkflowMetadata().workflowRunId);
  const ownershipHook = createHook<never>({
    token: readExperimentalWorkflowIterationOwnershipToken(rawInput),
  });
  try {
    let conflict: Awaited<ReturnType<typeof ownershipHook.getConflict>>;
    try {
      conflict = await ownershipHook.getConflict();
    } catch (error) {
      if (isHookConflictError(error) && typeof error.conflictingRunId === "string") {
        return { kind: "duplicate", runId: error.conflictingRunId };
      }
      throw error;
    }
    if (conflict !== null) return { kind: "duplicate", runId: conflict.runId };

    const input = migrateExperimentalWorkflowIterationInput(rawInput);
    let outcome:
      | { readonly error: unknown; readonly kind: "failed" }
      | { readonly kind: "succeeded"; readonly result: ExperimentalWorkflowIterationResult };
    try {
      outcome = {
        kind: "succeeded",
        result: await executeExperimentalWorkflowIteration(input, runId),
      };
    } catch (error) {
      outcome = { error, kind: "failed" };
    }

    await sendExperimentalWorkflowIterationCompletionStep({
      controlToken: input.controller.controlToken,
      payload: { kind: "iteration-settling", runId },
    });
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.result;
  } finally {
    await disposeHook(ownershipHook);
  }
}

function readExperimentalWorkflowIterationOwnershipToken(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("ExperimentalWorkflow iteration input has no ownership token.");
  }
  const token = Reflect.get(value, "ownershipToken");
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("ExperimentalWorkflow iteration input has no ownership token.");
  }
  return token;
}

async function executeExperimentalWorkflowIteration(
  input: ExperimentalWorkflowIterationInput,
  runId: string,
): Promise<ExperimentalWorkflowIterationResult> {
  const cancelHook = createHook<{ readonly kind: "cancel"; readonly reason?: string }>({
    token: `${runId}:cancel`,
  });
  const cancelIterator = cancelHook[Symbol.asyncIterator]();
  const inbox = createHook<TurnInboxPayload>({ token: `${runId}:inbox` });
  const inboxIterator = inbox[Symbol.asyncIterator]();

  try {
    const loadedSnapshot = await loadExperimentalWorkflowSnapshotStep({
      definitionSourceId: input.controller.definitionSourceId,
      reference: input.controller.reference,
      serializedContext: input.controller.serializedContext,
    });
    if (loadedSnapshot === null) return { kind: "deleted" };
    if (loadedSnapshot.iteration !== input.expectedIteration) {
      throw new Error(
        `ExperimentalWorkflow iteration changed from ${String(input.expectedIteration)} to ${String(loadedSnapshot.iteration)} before execution.`,
      );
    }
    if (loadedSnapshot.dueAt !== input.expectedDueAt) {
      throw new Error(
        `ExperimentalWorkflow dueAt changed from "${input.expectedDueAt}" to "${loadedSnapshot.dueAt}" before execution.`,
      );
    }

    const cancelWait = cancelIterator.next();
    const abortController = new AbortController();
    const execution = runExperimentalWorkflowIteration({
      abortSignal: abortController.signal,
      inboxIterator,
      inboxToken: inbox.token,
      input: input.controller,
      iterationRunId: runId,
      onSessionState() {},
      parentWritable: getWritable<Uint8Array>(),
      snapshot: loadedSnapshot,
    });
    const outcome = await Promise.race([
      execution.then(
        (result) => ({ kind: "execution" as const, result }),
        (error) => ({ error, kind: "execution-error" as const }),
      ),
      cancelWait.then((result) => ({ kind: "cancel" as const, result })),
    ]);

    if (outcome.kind === "execution") return outcome.result;
    if (outcome.kind === "execution-error") throw outcome.error;
    if (outcome.result.done) return await execution;

    abortController.abort(new Error(outcome.result.value.reason ?? "Workflow stopped."));
    await execution.catch(() => undefined);
    const stopped = createStoppedIterationResult(outcome.result.value.reason);
    return stopped;
  } finally {
    await disposeHookWithPendingRead(inbox, inboxIterator);
    await disposeHookWithPendingRead(cancelHook, cancelIterator);
  }
}

function matchStopControl(
  value: ExperimentalWorkflowControl,
  runId: string,
): Extract<ExperimentalWorkflowControl, { readonly kind: "stop" }> | null {
  if (value.kind !== "stop") return null;
  if (value.expectedRunId !== undefined && value.expectedRunId !== runId) return null;
  return value;
}

async function consumeQueuedStopBeforeReadiness(input: {
  readonly controlIterator: AsyncIterator<ExperimentalWorkflowControl>;
  readonly controlWait: Promise<IteratorResult<ExperimentalWorkflowControl>>;
  readonly runId: string;
}): Promise<{
  readonly controlWait: Promise<IteratorResult<ExperimentalWorkflowControl>>;
  readonly stop: Extract<ExperimentalWorkflowControl, { readonly kind: "stop" }> | null;
}> {
  let controlWait = input.controlWait;
  while (true) {
    const boundary = await Promise.race([
      controlWait.then((result) => ({ kind: "control" as const, result })),
      Promise.resolve().then(() => ({ kind: "ready" as const })),
    ]);
    if (boundary.kind === "ready") return { controlWait, stop: null };
    if (boundary.result.done) {
      throw new Error("ExperimentalWorkflow control hook closed before readiness.");
    }
    controlWait = input.controlIterator.next();
    const stop = matchStopControl(boundary.result.value, input.runId);
    if (stop !== null) return { controlWait, stop };
  }
}

function createStoppedIterationResult(
  reason: string | undefined,
): Extract<ExperimentalWorkflowIterationResult, { readonly kind: "stopped" }> {
  const result: { kind: "stopped"; reason?: string } = {
    kind: "stopped",
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}

function createStoppedEntryResult(
  reason: string | undefined,
): Extract<ExperimentalWorkflowEntryResult, { readonly kind: "stopped" }> {
  const result: { kind: "stopped"; reason?: string } = {
    kind: "stopped",
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}
