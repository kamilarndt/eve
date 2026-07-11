import { afterEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import {
  advanceExperimentalWorkflowStep,
  cancelExperimentalWorkflowIterationStep,
  createExperimentalWorkflowOuterToolCallId,
  loadExperimentalWorkflowSnapshotStep,
  pollExperimentalWorkflowIterationStep,
  startExperimentalWorkflowIterationStep,
} from "#execution/experimental-workflow-steps.js";
import { deserializeContext } from "#context/serialize.js";
import { getHookByToken, getRun, resumeHook, start } from "#internal/workflow/runtime.js";

vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
}));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));

describe("persisted ExperimentalWorkflow references", () => {
  it("does not re-run the input transform during background load or advance", async () => {
    const validate = vi.fn();
    const load = vi.fn(async () => null);
    const advance = vi.fn(async () => null);
    vi.mocked(deserializeContext).mockResolvedValue({
      require: () => ({
        resolvedAgent: {
          experimentalWorkflow: {
            advance,
            load,
            referenceSchema: { "~standard": { validate } },
            sourceId: "source:workflow",
          },
        },
      }),
    } as never);
    const reference = { generation: 7, workflowId: "42" };

    await expect(
      loadExperimentalWorkflowSnapshotStep({
        definitionSourceId: "source:workflow",
        reference,
        serializedContext: { captured: true },
      }),
    ).resolves.toBeNull();
    await expect(
      advanceExperimentalWorkflowStep({
        advance: {
          completedAt: "2026-07-10T20:00:01.000Z",
          expectedIteration: 0,
          nextDueAt: "2026-07-10T20:00:11.000Z",
          outcome: { kind: "completed" },
          reference,
        },
        definitionSourceId: "source:workflow",
        serializedContext: { captured: true },
        snapshot: {
          cadence: { delaySeconds: 10, kind: "after-completion" },
          dueAt: "2026-07-10T20:00:00.000Z",
          input: null,
          iteration: 0,
          program: { js: "return null" },
        },
      }),
    ).resolves.toEqual({
      nextDueAt: "2026-07-10T20:00:11.000Z",
      nextSnapshot: null,
    });

    expect(validate).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(reference);
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ reference }));
  });
});

describe("startExperimentalWorkflowIterationStep", () => {
  afterEach(() => {
    vi.mocked(deserializeContext).mockReset();
    vi.mocked(getHookByToken).mockReset();
    vi.mocked(getRun).mockReset();
    vi.mocked(start).mockReset();
    vi.useRealTimers();
  });

  it("adopts the child owner when start committed before its response was lost", async () => {
    const responseLost = new Error("start response lost");
    const load = vi.fn().mockResolvedValue(iterationSnapshot(0));
    installExperimentalWorkflowDefinition(load);
    vi.mocked(getHookByToken)
      .mockRejectedValueOnce(new HookNotFoundError("iteration-owner"))
      .mockResolvedValue({ runId: "winner-run" } as never);
    vi.mocked(start).mockRejectedValueOnce(responseLost);
    const input = iterationDispatchInput();

    await expect(startExperimentalWorkflowIterationStep(input)).rejects.toBe(responseLost);
    await expect(startExperimentalWorkflowIterationStep(input)).resolves.toEqual({
      runId: "winner-run",
    });

    expect(start).toHaveBeenCalledOnce();
  });

  it("recovers an already-advanced cursor instead of starting a stale duplicate", async () => {
    const responseLost = new Error("start response lost");
    const load = vi
      .fn()
      .mockResolvedValueOnce(iterationSnapshot(0))
      .mockResolvedValueOnce(iterationSnapshot(1));
    installExperimentalWorkflowDefinition(load);
    vi.mocked(getHookByToken).mockRejectedValue(new HookNotFoundError("iteration-owner"));
    vi.mocked(start).mockRejectedValueOnce(responseLost);
    const input = iterationDispatchInput();

    await expect(startExperimentalWorkflowIterationStep(input)).rejects.toBe(responseLost);
    await expect(startExperimentalWorkflowIterationStep(input)).resolves.toEqual({
      cursor: {
        dueAt: "2026-07-10T20:00:01.000Z",
        iteration: 1,
      },
      kind: "advanced",
    });

    expect(start).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retains a queued iteration candidate when ownership publication exceeds the bounded wait", async () => {
    vi.useFakeTimers();
    installExperimentalWorkflowDefinition(vi.fn().mockResolvedValue(iterationSnapshot(0)));
    vi.mocked(getHookByToken).mockRejectedValue(new HookNotFoundError("iteration-owner"));
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("pending") } as never);
    vi.mocked(start).mockResolvedValue({
      runId: "queued-iteration",
      status: Promise.resolve("pending"),
    } as never);

    const started = startExperimentalWorkflowIterationStep(iterationDispatchInput());
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(started).resolves.toEqual({ runId: "queued-iteration" });
  });
});

function iterationDispatchInput() {
  return {
    controller: {
      controlToken: "control",
      definitionSourceId: "source:workflow",
      readyToken: "ready",
      reference: { id: "loop" },
      serializedContext: { captured: true },
      sessionState: {
        continuationToken: "workflow:session",
        emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
        hasProxyInputRequests: false,
        sessionId: "session",
        version: 1 as const,
      },
      version: 1 as const,
    },
    expectedDueAt: "2026-07-10T20:00:00.000Z",
    expectedIteration: 0,
  };
}

function installExperimentalWorkflowDefinition(load: ReturnType<typeof vi.fn>): void {
  vi.mocked(deserializeContext).mockResolvedValue({
    require: () => ({
      resolvedAgent: {
        experimentalWorkflow: {
          load,
          sourceId: "source:workflow",
        },
      },
    }),
  } as never);
}

function iterationSnapshot(iteration: number) {
  return {
    cadence: { delaySeconds: 1, kind: "after-completion" as const },
    dueAt: `2026-07-10T20:00:0${String(iteration)}.000Z`,
    input: null,
    iteration,
    program: { js: "return null" },
  };
}

describe("cancelExperimentalWorkflowIterationStep", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each(["cancelled", "completed", "failed"] as const)(
    "treats a missing child hook on a %s run as settled",
    async (status) => {
      vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("iteration-run:cancel"));
      vi.mocked(getRun).mockReturnValue({ status: Promise.resolve(status) } as never);

      await expect(
        cancelExperimentalWorkflowIterationStep({
          reason: "controller stopped",
          runId: "iteration-run",
        }),
      ).resolves.toBe(true);

      expect(resumeHook).toHaveBeenCalledOnce();
      expect(getRun).toHaveBeenCalledWith("iteration-run");
    },
  );

  it("reports a queued candidate as not yet cancelled when its hook is missing", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("iteration-run:cancel"));
    vi.mocked(getRun).mockReturnValue({
      status: Promise.resolve("pending"),
    } as never);

    await expect(cancelExperimentalWorkflowIterationStep({ runId: "iteration-run" })).resolves.toBe(
      false,
    );

    expect(resumeHook).toHaveBeenCalledOnce();
  });
});

describe("pollExperimentalWorkflowIterationStep", () => {
  it("treats a resiliently queued child that is not visible yet as missing", async () => {
    vi.mocked(getRun).mockReturnValue({
      status: Promise.reject(new WorkflowRunNotFoundError("iteration-run")),
    } as never);

    await expect(pollExperimentalWorkflowIterationStep("iteration-run")).resolves.toEqual({
      kind: "missing",
    });
  });
});

describe("createExperimentalWorkflowOuterToolCallId", () => {
  it("names otherwise identical attempts by their durable child run", () => {
    expect(createExperimentalWorkflowOuterToolCallId("controller-a-child", 1)).toBe(
      "experimental-workflow-controller-a-child-attempt-1",
    );
    expect(createExperimentalWorkflowOuterToolCallId("controller-b-child", 1)).not.toBe(
      createExperimentalWorkflowOuterToolCallId("controller-a-child", 1),
    );
  });
});
