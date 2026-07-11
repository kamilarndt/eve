import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#compiled/@workflow/core/index.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { ExperimentalWorkflowEntryInput } from "#execution/experimental-workflow-controller.js";
import {
  experimentalWorkflowEntry,
  type ExperimentalWorkflowIterationExecutionResult,
} from "#execution/experimental-workflow-entry.js";
import {
  cancelExperimentalWorkflowIterationStep,
  loadExperimentalWorkflowSnapshotStep,
  pollExperimentalWorkflowIterationStep,
  startExperimentalWorkflowIterationStep,
} from "#execution/experimental-workflow-steps.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  disposeHookWithPendingRead,
} from "#execution/hook-ownership.js";
import type { ExperimentalWorkflowSnapshot } from "#shared/experimental-workflow-definition.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWorkflowMetadata: vi.fn(() => ({ workflowRunId: "controller-run" })),
  getWritable: vi.fn(() => new WritableStream<Uint8Array>()),
  sleep: vi.fn(),
}));

vi.mock("./experimental-workflow-execution.js", () => ({
  runExperimentalWorkflowIteration: vi.fn(),
}));

vi.mock("./experimental-workflow-steps.js", () => ({
  cancelExperimentalWorkflowIterationStep: vi.fn(),
  loadExperimentalWorkflowSnapshotStep: vi.fn(),
  pollExperimentalWorkflowIterationStep: vi.fn(),
  sendExperimentalWorkflowIterationCompletionStep: vi.fn(),
  startExperimentalWorkflowIterationStep: vi.fn(),
}));

vi.mock("./hook-ownership.js", () => ({
  claimHookOwnership: vi.fn(),
  closeHookIterator: vi.fn(),
  disposeHook: vi.fn(),
  disposeHookWithPendingRead: vi.fn(),
  isHookConflictError: vi.fn(() => false),
}));

vi.mocked(disposeHookWithPendingRead).mockImplementation(async (hook) => {
  await disposeHook(hook);
});

describe("experimentalWorkflowEntry", () => {
  afterEach(() => {
    vi.clearAllMocks();
    createHookMock.mockReset();
  });

  it("keeps one controller owner across successive iterations", async () => {
    const initial = snapshot(0, "2020-07-10T20:00:00.000Z");
    const next = snapshot(1, "2020-07-10T21:00:00.000Z");
    const control = installControlHook(neverSettles());
    vi.mocked(loadExperimentalWorkflowSnapshotStep).mockResolvedValue(initial);
    vi.mocked(startExperimentalWorkflowIterationStep)
      .mockResolvedValueOnce({ runId: "iteration-run-0" })
      .mockResolvedValueOnce({ runId: "iteration-run-1" });
    vi.mocked(pollExperimentalWorkflowIterationStep)
      .mockResolvedValueOnce({ kind: "settled", result: iterationResult(next, "first") })
      .mockResolvedValueOnce({ kind: "settled", result: iterationResult(null, "second") });

    await expect(experimentalWorkflowEntry(entryInput())).resolves.toEqual({
      kind: "completed",
      nextDueAt: "2026-07-10T21:00:10.000Z",
      output: "second",
    });

    expect(createHookMock).toHaveBeenCalledTimes(3);
    expect(createHookMock).toHaveBeenNthCalledWith(1, { token: "workflow-control" });
    expect(createHookMock).toHaveBeenNthCalledWith(2, {
      token: "workflow-control:ready:0:2020-07-10T20:00:00.000Z",
    });
    expect(createHookMock).toHaveBeenNthCalledWith(3, {
      token: "workflow-control:ready:1:2020-07-10T21:00:00.000Z",
    });
    expect(control.getConflict).toHaveBeenCalledOnce();
    expect(claimHookOwnership).toHaveBeenCalledTimes(2);
    expect(control.getConflict.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loadExperimentalWorkflowSnapshotStep).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(loadExperimentalWorkflowSnapshotStep).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(claimHookOwnership).mock.invocationCallOrder[0]!);
    expect(startExperimentalWorkflowIterationStep).toHaveBeenNthCalledWith(1, {
      controller: entryInput(),
      expectedDueAt: initial.dueAt,
      expectedIteration: initial.iteration,
    });
    expect(startExperimentalWorkflowIterationStep).toHaveBeenNthCalledWith(2, {
      controller: entryInput(),
      expectedDueAt: next.dueAt,
      expectedIteration: next.iteration,
    });
    expect(disposeHook).toHaveBeenCalledTimes(3);
  });

  it("does not dispatch an immediately due successor ahead of an already queued stop", async () => {
    const stop = deferred<IteratorResult<{ kind: "stop"; reason?: string }>>();
    installControlHook(stop.promise);
    vi.mocked(loadExperimentalWorkflowSnapshotStep).mockResolvedValue(
      snapshot(0, "2020-07-10T20:00:00.000Z"),
    );
    vi.mocked(startExperimentalWorkflowIterationStep).mockResolvedValue({
      runId: "iteration-run-0",
    });
    vi.mocked(pollExperimentalWorkflowIterationStep).mockImplementationOnce(async () => {
      stop.resolve({ done: false, value: { kind: "stop", reason: "edited" } });
      return {
        kind: "settled",
        result: iterationResult(snapshot(1, "2020-07-10T21:00:00.000Z"), "first"),
      };
    });

    await expect(experimentalWorkflowEntry(entryInput())).resolves.toEqual({
      kind: "stopped",
      reason: "edited",
    });

    expect(startExperimentalWorkflowIterationStep).toHaveBeenCalledOnce();
  });

  it("consumes a stop queued during load before publishing readiness", async () => {
    vi.mocked(sleep).mockReturnValue(neverSettles());
    installControlHook(
      Promise.resolve({ done: false, value: { kind: "stop", reason: "definition edited" } }),
    );
    vi.mocked(loadExperimentalWorkflowSnapshotStep).mockResolvedValue(
      snapshot(0, "2999-07-10T20:00:00.000Z"),
    );

    await expect(experimentalWorkflowEntry(entryInput())).resolves.toEqual({
      kind: "stopped",
      reason: "definition edited",
    });

    expect(startExperimentalWorkflowIterationStep).not.toHaveBeenCalled();
    expect(createHookMock).toHaveBeenCalledOnce();
    expect(claimHookOwnership).not.toHaveBeenCalled();
    expect(disposeHook).toHaveBeenCalledOnce();
  });

  it("joins iteration cancellation before releasing controller ownership", async () => {
    const cancel = deferred<boolean>();
    const stop = deferred<IteratorResult<{ kind: "stop"; reason?: string }>>();
    const terminalPoll =
      deferred<Awaited<ReturnType<typeof pollExperimentalWorkflowIterationStep>>>();
    vi.mocked(sleep).mockReturnValueOnce(neverSettles()).mockResolvedValue(undefined);
    installControlHook(stop.promise);
    vi.mocked(loadExperimentalWorkflowSnapshotStep).mockResolvedValue(
      snapshot(0, "2020-07-10T20:00:00.000Z"),
    );
    vi.mocked(startExperimentalWorkflowIterationStep).mockResolvedValue({
      runId: "iteration-run",
    });
    vi.mocked(pollExperimentalWorkflowIterationStep)
      .mockImplementationOnce(async () => {
        stop.resolve({ done: false, value: { kind: "stop", reason: "deleted" } });
        return { kind: "pending" };
      })
      .mockResolvedValueOnce({ kind: "pending" })
      .mockReturnValueOnce(terminalPoll.promise);
    vi.mocked(cancelExperimentalWorkflowIterationStep)
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(cancel.promise);

    let settled = false;
    const result = experimentalWorkflowEntry(entryInput()).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => {
      expect(cancelExperimentalWorkflowIterationStep).toHaveBeenCalledTimes(2);
      expect(cancelExperimentalWorkflowIterationStep).toHaveBeenLastCalledWith({
        reason: "deleted",
        runId: "iteration-run",
      });
    });
    expect(settled).toBe(false);
    expect(disposeHook).not.toHaveBeenCalled();

    cancel.resolve(true);
    await vi.waitFor(() => {
      expect(pollExperimentalWorkflowIterationStep).toHaveBeenCalledTimes(3);
    });
    expect(settled).toBe(false);
    terminalPoll.resolve({ kind: "settled", result: { kind: "stopped", reason: "deleted" } });
    await expect(result).resolves.toEqual({ kind: "stopped", reason: "deleted" });
    expect(disposeHook).toHaveBeenCalledTimes(2);
  });

  it("releases ownership when the current definition is incompatible", async () => {
    installControlHook(neverSettles());
    vi.mocked(loadExperimentalWorkflowSnapshotStep).mockRejectedValue(
      new Error("ExperimentalWorkflow definition changed from old to new"),
    );

    await expect(experimentalWorkflowEntry(entryInput())).rejects.toThrow(
      "definition changed from old to new",
    );

    expect(closeHookIterator).not.toHaveBeenCalled();
    expect(disposeHook).toHaveBeenCalledOnce();
  });
});

function entryInput(): ExperimentalWorkflowEntryInput {
  return {
    controlToken: "workflow-control",
    definitionSourceId: "module:agent/tools/workflow.ts",
    readyToken: "workflow-control:ready:0:2020-07-10T20:00:00.000Z",
    reference: { workflowId: "workflow-1" },
    serializedContext: { captured: true },
    sessionState: sessionState("session-0"),
    version: 1,
  };
}

function installControlHook(first: Promise<IteratorResult<{ kind: "stop"; reason?: string }>>): {
  readonly getConflict: ReturnType<typeof vi.fn>;
} {
  const getConflict = vi.fn(async () => null);
  const iterator = {
    next: vi.fn(() => first),
  };
  createHookMock.mockReturnValue({
    getConflict,
    [Symbol.asyncIterator]: () => iterator,
  });
  return { getConflict };
}

function iterationResult(
  nextSnapshot: ExperimentalWorkflowSnapshot | null,
  output: string,
): ExperimentalWorkflowIterationExecutionResult {
  return {
    next:
      nextSnapshot === null
        ? null
        : { dueAt: nextSnapshot.dueAt, iteration: nextSnapshot.iteration },
    result: {
      kind: "completed",
      nextDueAt: "2026-07-10T21:00:10.000Z",
      output,
    },
  };
}

function snapshot(iteration: number, dueAt: string): ExperimentalWorkflowSnapshot {
  return {
    cadence: { delaySeconds: 10, kind: "after-completion" },
    dueAt,
    input: { iteration },
    iteration,
    program: { js: "return input.iteration" },
  };
}

function sessionState(sessionId: string): DurableSessionState {
  return {
    continuationToken: `workflow:${sessionId}`,
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId,
    version: 1,
  };
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
