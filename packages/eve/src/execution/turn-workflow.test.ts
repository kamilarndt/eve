import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { turnWorkflow } from "#execution/turn-workflow.js";
import {
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { turnStep } from "#execution/workflow-steps.js";

interface CancelHookControl {
  readonly dispose: ReturnType<typeof vi.fn>;
  resolve(value?: unknown): void;
}

let cancelHookControl: CancelHookControl | undefined;
const resumeHookMock = vi.fn();
const createHookMock = vi.fn((options?: { readonly token?: string }) => {
  let resolvePending!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    resolvePending = resolve;
  });
  const dispose = vi.fn();
  cancelHookControl = {
    dispose,
    resolve(value = undefined) {
      resolvePending(value);
    },
  };
  return {
    dispose,
    getConflict: vi.fn().mockResolvedValue(null),
    then: pending.then.bind(pending),
    token: options?.token ?? "cancel-token",
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (options?: { readonly token?: string }) => createHookMock(options),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./workflow-steps.js", () => ({
  turnStep: vi.fn(),
}));

describe("turnWorkflow", () => {
  afterEach(() => {
    cancelHookControl = undefined;
    vi.clearAllMocks();
    resumeHookMock.mockReset();
  });

  it("notifies the driver when a turn completes", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input, parentWritable } = createInput({ sessionState });
    await turnWorkflow(input);

    expect(turnStep).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      input: input.stepInput.input,
      parentWritable,
      serializedContext: input.stepInput.serializedContext,
      sessionState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        kind: "done",
        output: "ok",
        serializedContext: { state: "done" },
        sessionState,
      },
      kind: "turn-result",
    });
  });

  it("aborts the active turn and waits for it to settle before disposing the hook", async () => {
    const sessionState = createSessionState();
    type TurnStepResult = Awaited<ReturnType<typeof turnStep>>;
    let resolveTurnStep!: (result: TurnStepResult) => void;
    const turnStepResult = new Promise<TurnStepResult>((resolve) => {
      resolveTurnStep = resolve;
    });
    let abortSignal: AbortSignal | undefined;
    vi.mocked(turnStep).mockImplementationOnce(async (stepInput) => {
      abortSignal = stepInput.abortSignal;
      return await turnStepResult;
    });

    const { input } = createInput({ sessionState });
    const workflow = turnWorkflow(input);

    await vi.waitFor(() => {
      expect(turnStep).toHaveBeenCalledTimes(1);
      expect(abortSignal).toBeInstanceOf(AbortSignal);
    });

    const hook = cancelHookControl;
    if (hook === undefined || abortSignal === undefined) {
      throw new Error("Expected the root turn to create a cancel hook and abort signal.");
    }

    expect(createHookMock).toHaveBeenCalledWith({ token: "http:test:cancel" });
    expect(abortSignal.aborted).toBe(false);

    let workflowSettled = false;
    void workflow.then(
      () => {
        workflowSettled = true;
      },
      () => {
        workflowSettled = true;
      },
    );

    hook.resolve();

    await vi.waitFor(() => {
      expect(abortSignal?.aborted).toBe(true);
    });
    await Promise.resolve();
    expect(workflowSettled).toBe(false);
    expect(hook.dispose).not.toHaveBeenCalled();

    resolveTurnStep({
      action: "done",
      output: "cancel settled",
      serializedContext: { state: "done" },
      sessionState,
    });

    await expect(workflow).resolves.toBeUndefined();
    expect(hook.dispose).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(hook.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      resumeHookMock.mock.invocationCallOrder[0]!,
    );
  });

  it("migrates a pre-version (unversioned) input and runs the first turn step", async () => {
    const sessionState = createSessionState();
    const parentWritable = new WritableStream<Uint8Array>();
    const delivery = {
      kind: "deliver",
      payloads: [{ message: "hello" }],
    } satisfies HookPayload;
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    await turnWorkflow({
      capabilities: undefined,
      completionToken: "turn-token",
      delivery,
      mode: "conversation",
      parentWritable,
      serializedContext: { state: "start" },
      sessionState,
    });

    expect(turnStep).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      input: delivery,
      parentWritable,
      serializedContext: { state: "start" },
      sessionState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-result" }),
    );
  });

  it("keeps tool-loop continuations inside the same turn workflow", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "continue",
        serializedContext: { state: "continued" },
        sessionState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "after continue",
        serializedContext: { state: "done" },
        sessionState,
      });

    const { input } = createInput({ sessionState });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].input).toBe(input.stepInput.input);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toBeUndefined();
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "done", output: "after continue" }),
        kind: "turn-result",
      }),
    );
  });

  it("parks when an authorization is pending", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: true,
      hasPendingInputBatch: false,
      serializedContext: { state: "needs-auth" },
      sessionState,
    });

    const { input } = createInput({
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({
          kind: "park",
          sessionState,
        }),
        kind: "turn-result",
      }),
    );
  });

  it("dispatches runtime actions when a runtime action batch is pending", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
      serializedContext: { state: "pending-runtime-action" },
      sessionState,
    });

    const { input } = createInput({ mode: "task", sessionState });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        kind: "dispatch-runtime-actions",
        pendingActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "pending-runtime-action" },
        sessionState,
      },
      kind: "turn-result",
    });
  });

  it("parks for pending input when the channel supports input requests", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: true,
      serializedContext: { state: "pending-input" },
      sessionState,
    });

    const { input } = createInput({
      capabilities: { requestInput: true },
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({
          kind: "park",
          serializedContext: { state: "pending-input" },
        }),
        kind: "turn-result",
      }),
    );
  });

  it("reports task-mode waits as turn errors", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      serializedContext: { state: "task-wait" },
      sessionState,
    });

    const { input } = createInput({ mode: "task", sessionState });
    await expect(turnWorkflow(input)).rejects.toThrow();

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock.mock.calls[0]?.[0]).toBe("turn-token");
    expect(resumeHookMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "turn-error",
    });
  });
});

function createInput(
  overrides: Partial<Omit<TurnWorkflowInput, "stepInput" | "version">> & {
    readonly sessionState?: DurableSessionState;
  } = {},
): {
  readonly input: TurnWorkflowInput;
  readonly parentWritable: WritableStream<Uint8Array>;
} {
  const { sessionState = createSessionState(), ...workflowOverrides } = overrides;
  const parentWritable = new WritableStream<Uint8Array>();
  return {
    input: {
      capabilities: undefined,
      completionToken: "turn-token",
      mode: "conversation",
      stepInput: {
        input: { kind: "deliver", payloads: [{ message: "hello" }] } satisfies HookPayload,
        parentWritable,
        serializedContext: { state: "start" },
        sessionState,
      },
      ...workflowOverrides,
      version: TURN_WORKFLOW_INPUT_VERSION,
    },
    parentWritable,
  };
}

function createSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}
