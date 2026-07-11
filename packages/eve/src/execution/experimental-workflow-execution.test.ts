import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelPendingLocalSubagentsUntilSettled } from "#execution/cancel-pending-local-subagents-until-settled.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { ExperimentalWorkflowEntryInput } from "#execution/experimental-workflow-controller.js";
import { runExperimentalWorkflowIteration } from "#execution/experimental-workflow-execution.js";
import {
  advanceExperimentalWorkflowStep,
  captureExperimentalWorkflowAdvanceTimingStep,
  executeExperimentalWorkflowProgramStep,
  prepareExperimentalWorkflowDispatchStep,
} from "#execution/experimental-workflow-steps.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: vi.fn(() => ({ url: "https://eve.example.com" })),
}));

vi.mock("./cancel-pending-local-subagents-until-settled.js", () => ({
  cancelPendingLocalSubagentsUntilSettled: vi.fn(),
}));

vi.mock("./dispatch-workflow-runtime-actions-step.js", () => ({
  dispatchWorkflowRuntimeActionsStep: vi.fn(),
}));

vi.mock("./experimental-workflow-steps.js", () => ({
  advanceExperimentalWorkflowStep: vi.fn(),
  captureExperimentalWorkflowAdvanceTimingStep: vi.fn(),
  continueExperimentalWorkflowProgramStep: vi.fn(),
  executeExperimentalWorkflowProgramStep: vi.fn(),
  prepareExperimentalWorkflowDispatchStep: vi.fn(),
  resolveExperimentalWorkflowRuntimeActionsStep: vi.fn(),
}));

vi.mock("./workflow-callback-url.js", () => ({
  resolveWorkflowCallbackBaseUrl: vi.fn((value: string) => value),
}));

describe("runExperimentalWorkflowIteration cancellation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cancels children from the attempt-local state before propagating an abort", async () => {
    const abortController = new AbortController();
    const abortReason = new TurnCancelledError("stop the dynamic workflow");
    const dispatchedState = sessionState("dispatched-child-state");
    vi.mocked(executeExperimentalWorkflowProgramStep).mockResolvedValue({
      interrupt: { token: "interrupt" },
      status: "interrupted",
    } as never);
    vi.mocked(prepareExperimentalWorkflowDispatchStep).mockResolvedValue({
      pendingActionKeys: ["subagent-call:delegate:call-1"],
      sessionState: sessionState("prepared-state"),
    });
    vi.mocked(dispatchWorkflowRuntimeActionsStep).mockResolvedValue({
      results: [],
      get sessionState() {
        abortController.abort(abortReason);
        return dispatchedState;
      },
    });
    vi.mocked(cancelPendingLocalSubagentsUntilSettled).mockResolvedValue({ cancelled: 1 });

    await expect(
      runExperimentalWorkflowIteration(executionInput(abortController.signal, vi.fn())),
    ).rejects.toBe(abortReason);

    expect(cancelPendingLocalSubagentsUntilSettled).toHaveBeenCalledWith({
      serializedContext: { captured: true },
      sessionState: dispatchedState,
    });
    expect(captureExperimentalWorkflowAdvanceTimingStep).not.toHaveBeenCalled();
    expect(advanceExperimentalWorkflowStep).not.toHaveBeenCalled();
  });

  it("keeps the aborted attempt pending until descendant cleanup settles", async () => {
    const abortController = new AbortController();
    const abortReason = new TurnCancelledError("stop the dynamic workflow");
    const cleanup = deferred<{ readonly cancelled: number }>();
    vi.mocked(executeExperimentalWorkflowProgramStep).mockResolvedValue({
      interrupt: { token: "interrupt" },
      status: "interrupted",
    } as never);
    vi.mocked(prepareExperimentalWorkflowDispatchStep).mockResolvedValue({
      pendingActionKeys: ["subagent-call:delegate:call-1"],
      sessionState: sessionState("prepared-state"),
    });
    vi.mocked(dispatchWorkflowRuntimeActionsStep).mockImplementation(async () => {
      abortController.abort(abortReason);
      return { results: [], sessionState: sessionState("dispatched-child-state") };
    });
    vi.mocked(cancelPendingLocalSubagentsUntilSettled).mockReturnValue(cleanup.promise);

    let settled = false;
    const execution = runExperimentalWorkflowIteration(
      executionInput(abortController.signal, vi.fn()),
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(cancelPendingLocalSubagentsUntilSettled).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    cleanup.resolve({ cancelled: 1 });
    await expect(execution).rejects.toBe(abortReason);
  });
});

describe("runExperimentalWorkflowIteration retries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retries three failed program attempts and completes on the fourth", async () => {
    vi.mocked(executeExperimentalWorkflowProgramStep)
      .mockRejectedValueOnce(new Error("attempt 1"))
      .mockRejectedValueOnce(new Error("attempt 2"))
      .mockRejectedValueOnce(new Error("attempt 3"))
      .mockResolvedValueOnce({ output: "done", status: "completed" } as never);
    vi.mocked(cancelPendingLocalSubagentsUntilSettled).mockResolvedValue({ cancelled: 0 });
    mockAdvance(null);

    await expect(
      runExperimentalWorkflowIteration(executionInput(new AbortController().signal, vi.fn())),
    ).resolves.toEqual({
      next: null,
      result: {
        kind: "completed",
        nextDueAt: "2026-07-10T20:00:10.000Z",
        output: "done",
      },
    });

    expect(executeExperimentalWorkflowProgramStep).toHaveBeenCalledTimes(4);
    expect(cancelPendingLocalSubagentsUntilSettled).toHaveBeenCalledTimes(3);
    expect(advanceExperimentalWorkflowStep).toHaveBeenCalledWith(
      expect.objectContaining({
        advance: expect.objectContaining({ outcome: { kind: "completed", output: "done" } }),
      }),
    );
  });

  it("records a failed outcome after all four program attempts fail", async () => {
    vi.mocked(executeExperimentalWorkflowProgramStep)
      .mockRejectedValueOnce(new Error("attempt 1"))
      .mockRejectedValueOnce(new Error("attempt 2"))
      .mockRejectedValueOnce(new Error("attempt 3"))
      .mockRejectedValueOnce(new Error("attempt 4"));
    vi.mocked(cancelPendingLocalSubagentsUntilSettled).mockResolvedValue({ cancelled: 0 });
    mockAdvance(null);

    await expect(
      runExperimentalWorkflowIteration(executionInput(new AbortController().signal, vi.fn())),
    ).resolves.toEqual({
      next: null,
      result: {
        error: "attempt 4",
        kind: "failed",
        nextDueAt: "2026-07-10T20:00:10.000Z",
      },
    });

    expect(executeExperimentalWorkflowProgramStep).toHaveBeenCalledTimes(4);
    expect(cancelPendingLocalSubagentsUntilSettled).toHaveBeenCalledTimes(4);
    expect(advanceExperimentalWorkflowStep).toHaveBeenCalledWith(
      expect.objectContaining({
        advance: expect.objectContaining({
          outcome: { error: "attempt 4", kind: "failed" },
        }),
      }),
    );
  });
});

function mockAdvance(nextSnapshot: null): void {
  vi.mocked(captureExperimentalWorkflowAdvanceTimingStep).mockResolvedValue({
    completedAt: "2026-07-10T20:00:00.000Z",
    nextDueAt: "2026-07-10T20:00:10.000Z",
  });
  vi.mocked(advanceExperimentalWorkflowStep).mockResolvedValue({
    nextDueAt: "2026-07-10T20:00:10.000Z",
    nextSnapshot,
  });
}

function executionInput(
  abortSignal: AbortSignal,
  onSessionState: (sessionState: DurableSessionState) => void,
) {
  return {
    abortSignal,
    inboxIterator: { next: vi.fn(() => new Promise(() => {})) } as never,
    inboxToken: "iteration-inbox",
    input: entryInput(),
    iterationRunId: "iteration-run",
    onSessionState,
    parentWritable: new WritableStream<Uint8Array>(),
    snapshot: {
      cadence: { delaySeconds: 10, kind: "after-completion" as const },
      dueAt: "2026-07-10T20:00:00.000Z",
      input: { task: "run" },
      iteration: 0,
      program: { js: "return tools.delegate(input)" },
    },
  };
}

function entryInput(): ExperimentalWorkflowEntryInput {
  return {
    controlToken: "workflow-control",
    definitionSourceId: "module:agent/tools/workflow.ts",
    readyToken: "workflow-ready",
    reference: { workflowId: "workflow-1" },
    serializedContext: { captured: true },
    sessionState: sessionState("initial-state"),
    version: 1,
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
