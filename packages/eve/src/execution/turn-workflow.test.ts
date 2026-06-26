import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HookPayload } from "#channel/types.js";
import { cancelPendingRemoteAgentTurnsStep } from "#execution/cancel-pending-remote-agent-turns-step.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { turnWorkflow } from "#execution/turn-workflow.js";
import {
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxyInputRequestStep, turnStep } from "#execution/workflow-steps.js";

interface CancelHookControl {
  readonly dispose: ReturnType<typeof vi.fn>;
  resolve(value?: unknown): void;
}

let cancelHookControl: CancelHookControl | undefined;
const inboxHooks: unknown[] = [];
const resumeHookMock = vi.fn();
const createHookMock = vi.fn();

function createHookForTest(options?: { readonly token?: string }): unknown {
  if (options?.token?.endsWith(":cancel") !== true) {
    return inboxHooks.shift() ?? createInboxMock([]).hook;
  }

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
}

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWorkflowMetadata: vi.fn(() => ({ url: "https://eve.example.com" })),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

vi.mock("./cancel-pending-remote-agent-turns-step.js", () => ({
  cancelPendingRemoteAgentTurnsStep: vi.fn(),
}));

vi.mock("./workflow-steps.js", () => ({
  runProxyInputRequestStep: vi.fn(),
  turnStep: vi.fn(),
}));

vi.mock("./dispatch-runtime-actions-step.js", () => ({
  dispatchRuntimeActionsStep: vi.fn(),
}));

vi.mock("./dispatch-workflow-runtime-actions-step.js", () => ({
  dispatchWorkflowRuntimeActionsStep: vi.fn(),
}));

vi.mock("./workflow-callback-url.js", () => ({
  resolveWorkflowCallbackBaseUrl: vi.fn((metadataUrl: string) => metadataUrl),
}));

describe("turnWorkflow", () => {
  beforeEach(() => {
    createHookMock.mockImplementation(createHookForTest);
  });

  afterEach(() => {
    cancelHookControl = undefined;
    inboxHooks.length = 0;
    vi.clearAllMocks();
    resumeHookMock.mockReset();
    createHookMock.mockReset();
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

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      sessionState,
    });
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
      expect(cancelPendingRemoteAgentTurnsStep).toHaveBeenCalledWith({
        serializedContext: input.stepInput.serializedContext,
        sessionState,
      });
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

  it("uses an inherited abort signal without creating a child cancel hook", async () => {
    const abortController = new AbortController();
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "child output",
      serializedContext: { state: "done" },
      sessionState,
    });
    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      sessionState,
    });

    await turnWorkflow({
      ...input,
      stepInput: {
        ...input.stepInput,
        abortSignal: abortController.signal,
      },
    });

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBe(abortController.signal);
    expect(createHookMock).not.toHaveBeenCalledWith({ token: "http:test:cancel" });
    expect(cancelHookControl).toBeUndefined();
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

  it("deduplicates concurrent turn workflows through inbox ownership", async () => {
    const sessionState = createSessionState();
    const ownerInbox = createInboxMock([]);
    const duplicateInbox = createInboxMock([], {
      conflict: { runId: "wrun_owner" },
    });
    inboxHooks.push(ownerInbox.hook, duplicateInbox.hook);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      sessionState,
    });
    await Promise.all([turnWorkflow(input), turnWorkflow(input)]);

    expect(turnStep).toHaveBeenCalledOnce();
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-error")).toEqual([]);
    expect(ownerInbox.dispose).toHaveBeenCalledOnce();
    expect(duplicateInbox.dispose).toHaveBeenCalledOnce();
    expect(ownerInbox.createIterator).toHaveBeenCalledOnce();
    expect(duplicateInbox.createIterator).toHaveBeenCalledOnce();
  });

  it("deduplicates a cross-realm inbox conflict rejection", async () => {
    const inbox = installInbox([], {
      claimError: {
        conflictingRunId: "wrun_owner",
        name: "HookConflictError",
        token: "turn-token:inbox",
      },
    });
    const { input } = createInput({ driverCapabilities: { turnInbox: true } });

    await turnWorkflow(input);

    expect(turnStep).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(inbox.createIterator).toHaveBeenCalledOnce();
  });

  it("reports non-conflict inbox claim failures to the driver", async () => {
    const failure = new Error("hook storage unavailable");
    const inbox = installInbox([], { claimError: failure });
    const { input } = createInput({ driverCapabilities: { turnInbox: true } });

    await expect(turnWorkflow(input)).rejects.toBe(failure);

    expect(turnStep).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock.mock.calls[0]?.[0]).toBe("turn-token");
    expect(resumeHookMock.mock.calls[0]?.[1]).toMatchObject({ kind: "turn-error" });
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(inbox.createIterator).toHaveBeenCalledOnce();
  });

  it("keeps a local subagent result inside one turn workflow", async () => {
    const initialState = createSessionState({ continuationToken: "slack:C1:" });
    const pendingState = createSessionState({ continuationToken: "slack:C1:T1" });
    const completedState = createSessionState({ continuationToken: "slack:C1:T1" });
    installInbox([
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "parent output",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: initialState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      continuationToken: "slack:C1:T1",
      kind: "turn-continuation-token",
    });
    expect(resumeHookMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchRuntimeActionsStep).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const abortSignal = vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(dispatchRuntimeActionsStep).toHaveBeenCalledWith({
      abortSignal,
      callbackBaseUrl: "https://eve.example.com",
      parentContinuationToken: "turn-token:inbox",
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0]).toMatchObject({
      abortSignal,
      input: {
        kind: "runtime-action-result",
        results: [expect.objectContaining({ callId: "call-1", output: "child output" })],
      },
    });
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result")).toEqual([
      [
        "turn-token",
        expect.objectContaining({
          action: expect.objectContaining({ kind: "done", output: "parent output" }),
        }),
      ],
    ]);
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "dispatch-runtime-actions" }),
      }),
    );
  });

  it("keeps dynamic-workflow child dispatch and immediate remote failures in the same turn", async () => {
    const pendingState = createSessionState();
    const completedState = createSessionState();
    installInbox([]);
    vi.mocked(dispatchWorkflowRuntimeActionsStep).mockResolvedValue({
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          output: { code: "REMOTE_AGENT_START_FAILED", message: "remote unavailable" },
          subagentName: "research",
        },
      ],
      sessionState: pendingState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: ["subagent-call:research:call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "handled failure",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(dispatchWorkflowRuntimeActionsStep).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      callbackBaseUrl: "https://eve.example.com",
      parentContinuationToken: "turn-token:inbox",
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({
      kind: "runtime-action-result",
      results: [expect.objectContaining({ callId: "call-1", isError: true })],
    });
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
  });

  it("proxies child HITL and pulls the response through the active turn", async () => {
    const pendingState = createSessionState();
    const proxyState = createSessionState({ hasProxyInputRequests: true });
    const completedState = createSessionState();
    const requestId = "turn-token:inbox:delivery:0";
    installInbox([
      {
        callId: "call-1",
        childContinuationToken: "subagent:parent:call-1",
        childSessionId: "child-session",
        event: { requests: [], sequence: 0, stepIndex: 0, turnId: "turn_0" },
        kind: "subagent-input-request",
        subagentName: "delegate",
      },
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        },
        kind: "driver-delivery",
        requestId,
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "approved child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(runProxyInputRequestStep).mockResolvedValue({
      serializedContext: { state: "proxied" },
      sessionState: proxyState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue(undefined);
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(runProxyInputRequestStep).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      continuationToken: "http:test",
      inboxToken: "turn-token:inbox",
      kind: "turn-delivery-request",
      requestId,
    });
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      kind: "turn-delivery-accepted",
      requestId,
    });
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        sessionState: proxyState,
      }),
    );
  });

  it("mints a unique delivery request id per wait so a stale forward is not re-accepted", async () => {
    const pendingState = createSessionState({ hasProxyInputRequests: true });
    const completedState = createSessionState();
    // The first wait resolves on its child result while a delivery forwarded for
    // request `:delivery:0` is still queued behind it. The second wait must mint
    // a fresh id so that stale forward is dropped, not mistaken for its response.
    installInbox([
      {
        kind: "runtime-action-result",
        results: [
          { callId: "call-1", kind: "subagent-result", output: "first", subagentName: "delegate" },
        ],
      },
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        },
        kind: "driver-delivery",
        requestId: "turn-token:inbox:delivery:0",
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-2",
            kind: "subagent-result",
            output: "second",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue(undefined);
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "batch-1" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-2"],
        serializedContext: { state: "batch-2" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    const deliveryRequestIds = resumeHookMock.mock.calls
      .filter((call) => call[1]?.kind === "turn-delivery-request")
      .map((call) => call[1]?.requestId);
    expect(deliveryRequestIds).toEqual([
      "turn-token:inbox:delivery:0",
      "turn-token:inbox:delivery:1",
    ]);
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-delivery-accepted" }),
    );
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });
});

interface InboxMock {
  readonly createIterator: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly hook: unknown;
}

function installInbox(
  values: readonly unknown[],
  options: {
    readonly claimError?: unknown;
    readonly conflict?: { readonly runId: string } | null;
  } = {},
): InboxMock {
  const inbox = createInboxMock(values, options);
  inboxHooks.push(inbox.hook);
  return inbox;
}

function createInboxMock(
  values: readonly unknown[],
  options: {
    readonly claimError?: unknown;
    readonly conflict?: { readonly runId: string } | null;
  } = {},
): InboxMock {
  const queue = [...values];
  const dispose = vi.fn();
  const createIterator = vi.fn(() => ({
    next: vi.fn(async () => {
      const value = queue.shift();
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
  }));
  const hook = {
    token: "turn-token:inbox",
    getConflict: vi.fn(async () => {
      if (options.claimError !== undefined) throw options.claimError;
      return options.conflict ?? null;
    }),
    dispose,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return createIterator();
    },
  };
  return { createIterator, dispose, hook };
}

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
