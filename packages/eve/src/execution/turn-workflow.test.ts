import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHook } from "#compiled/@workflow/core/index.js";
import type { HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { notifyDriverStep, turnWorkflow } from "#execution/turn-workflow.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { turnStep } from "#execution/workflow-steps.js";
import { createCancellationReason } from "#execution/cancellation.js";

const resumeHookMock = vi.fn();
const disposeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn((options?: { readonly token?: string }) => ({
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<void>>(() => {}),
      };
    },
    dispose: disposeHookMock,
    getConflict: vi.fn().mockResolvedValue(null),
    token: options?.token ?? "cancel-token",
  })),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./workflow-steps.js", () => ({
  turnStep: vi.fn(),
}));

describe("turnWorkflow", () => {
  beforeEach(() => {
    vi.mocked(createHook).mockImplementation(
      (options?: { readonly token?: string }) =>
        ({
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<void>>(() => {}) };
          },
          dispose: disposeHookMock,
          getConflict: vi.fn().mockResolvedValue(null),
          token: options?.token ?? "cancel-token",
        }) as never,
    );
  });

  afterEach(() => {
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

    expect(turnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        abortController: expect.any(AbortController),
        input: input.stepInput.input,
        parentWritable,
        serializedContext: input.stepInput.serializedContext,
        sessionState,
      }),
    );
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

  it("aborts the active turn step when the private cancellation hook resumes", async () => {
    let cancel: ((result: IteratorResult<void>) => void) | undefined;
    vi.mocked(createHook).mockImplementationOnce(
      (options?: { readonly token?: string }) =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<void>>((resolve) => {
                  cancel = resolve;
                }),
            };
          },
          dispose: disposeHookMock,
          getConflict: vi.fn().mockResolvedValue(null),
          token: options?.token ?? "cancel-token",
        }) as never,
    );
    vi.mocked(turnStep).mockImplementationOnce(
      async ({ abortController }) =>
        await new Promise((_, reject) => {
          abortController?.signal.addEventListener(
            "abort",
            () => reject(abortController.signal.reason),
            {
              once: true,
            },
          );
        }),
    );

    const { input } = createInput();
    const running = turnWorkflow(input);
    await vi.waitFor(() => expect(cancel).toBeTypeOf("function"));
    cancel?.({ done: false, value: undefined });
    await running;

    const controller = vi.mocked(turnStep).mock.calls[0]?.[0].abortController;
    expect(controller?.signal.aborted).toBe(true);
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      kind: "turn-cancelled",
      scope: "turn",
    });
  });

  it("reports session scope when authored code cancels from inside the step", async () => {
    vi.mocked(turnStep).mockImplementationOnce(async ({ abortController }) => {
      const reason = createCancellationReason("session");
      abortController?.abort(reason);
      throw reason;
    });

    await turnWorkflow(createInput().input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      kind: "turn-cancelled",
      scope: "session",
    });
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

    expect(turnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        abortController: expect.any(AbortController),
        input: delivery,
        parentWritable,
        serializedContext: { state: "start" },
        sessionState,
      }),
    );
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

describe("notifyDriverStep", () => {
  it("ignores a late result after the parent completion hook is retired", async () => {
    resumeHookMock.mockRejectedValueOnce(new HookNotFoundError("turn-token"));

    await expect(
      notifyDriverStep({
        completionToken: "turn-token",
        payload: { kind: "turn-cancelled", scope: "turn" },
      }),
    ).resolves.toBeUndefined();
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
