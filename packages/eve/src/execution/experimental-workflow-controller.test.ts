import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { ActiveHarnessSessionKey } from "#context/active-harness-session-key.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  ChannelRequestIdKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  ModeKey,
  ParentSessionKey,
  SessionCallbackKey,
  SessionIdKey,
} from "#context/keys.js";
import {
  experimentalWorkflowEntryReference,
  type ExperimentalWorkflowEntryInput,
  startExperimentalWorkflow,
  stopExperimentalWorkflow,
} from "#execution/experimental-workflow-controller.js";
import { migrateExperimentalWorkflowEntryInput } from "#execution/durable-session-migrations/experimental-workflow.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { startWorkflowPreferLatest } from "#execution/workflow-runtime.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  experimentalWorkflowEntryReference: {
    workflowId: "workflow//eve//experimentalWorkflowEntry",
  },
  startWorkflowPreferLatest: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
}));

describe("experimental workflow controller", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startWorkflowPreferLatest).mockResolvedValue({
      returnValue: new Promise<never>(() => undefined),
      runId: "started-run",
    } as never);
    vi.mocked(getHookByToken)
      .mockRejectedValueOnce(new HookNotFoundError("test-control"))
      .mockResolvedValue({ runId: "owner-run" } as never);
    vi.mocked(resumeHook).mockResolvedValue({ runId: "owner-run" } as never);
    vi.mocked(getRun).mockReturnValue({
      returnValue: Promise.resolve({ kind: "stopped" }),
    } as never);
  });

  it("starts from a clean detached context and session", async () => {
    const ctx = createContext();

    const result = await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );

    expect(result).toEqual({ runId: "owner-run" });
    expect(startWorkflowPreferLatest).toHaveBeenCalledOnce();
    const call = vi.mocked(startWorkflowPreferLatest).mock.calls[0];
    if (call === undefined) throw new Error("Expected configured workflow start call.");
    const [reference] = call;
    const input = getStartedWorkflowInput(0);
    expect(reference).toEqual(experimentalWorkflowEntryReference);
    expect(input.reference).toEqual({ accountId: "acct_1", loopId: "loop_1" });
    expect(input).not.toHaveProperty("controllerId");
    expect(input.definitionSourceId).toBe("source:configured-workflow");
    expect(input.serializedContext).toEqual({
      "eve.auth": { principalId: "caller" },
      "eve.bundle": { nodeId: undefined, source: expect.any(Object) },
      "eve.channel": { kind: "slack", state: { channelId: "C-parent" } },
      "eve.continuationToken": expect.stringMatching(/^experimental-workflow:/u),
      "eve.initiatorAuth": { principalId: "initiator" },
      "eve.localSubagentsOnly": true,
      "eve.mode": "task",
      "eve.sessionId": expect.stringMatching(/^experimental-workflow:/u),
    });
    expect(input.serializedContext).not.toHaveProperty(ActiveHarnessSessionKey.name);
    const session = input.sessionState.snapshot?.session;
    expect(session?.sessionId).toMatch(/^experimental-workflow:/u);
    expect(session?.sessionId).not.toBe("parent-session");
    expect(session?.continuationToken).toMatch(/^experimental-workflow:/u);
    expect(session?.continuationToken).not.toBe("parent-continuation");
    expect(input.serializedContext[SessionIdKey.name]).toBe(session?.sessionId);
    expect(input.serializedContext[ContinuationTokenKey.name]).toBe(session?.continuationToken);
    expect(session?.history).toEqual([]);
    expect(session?.limits).toEqual({
      maxInputTokensPerSession: 5_000,
      maxOutputTokensPerSession: 1_000,
    });
    expect(session?.localSubagentsOnly).toBe(true);
    expect(session).not.toHaveProperty("rootSessionId");
    expect(session).not.toHaveProperty("outputSchema");
    expect(session).not.toHaveProperty("sandboxState");
    expect(session?.compaction).toBeUndefined();
    expect(session?.subagentDepth).toBe(0);
    expect(session?.subagentMaxDepth).toBe(2);
    expect(session?.workflowMaxSubagents).toBe(4);
    expect(session?.state).toEqual({
      "eve.harness.workflowContinuationSecurity": {
        signingKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        version: 1,
      },
    });
    expect(input.sessionState.hasProxyInputRequests).toBe(false);
    expect(input.sessionState.emissionState).toEqual({
      sequence: 0,
      sessionStarted: false,
      stepIndex: 0,
      turnId: "",
    });
    expect(getHookByToken).toHaveBeenLastCalledWith(input.readyToken);
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("derives the same controller identity from canonical reference JSON", async () => {
    const ctx = createContext();
    vi.mocked(getHookByToken)
      .mockReset()
      .mockRejectedValueOnce(new HookNotFoundError("first"))
      .mockResolvedValueOnce({ runId: "first-owner" } as never)
      .mockRejectedValueOnce(new HookNotFoundError("second"))
      .mockResolvedValueOnce({ runId: "second-owner" } as never);

    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );
    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ loopId: "loop_1", accountId: "acct_1" }),
    );

    const firstInput = getStartedWorkflowInput(0);
    const secondInput = getStartedWorkflowInput(1);
    expect(firstInput.controlToken).toBe(secondInput.controlToken);
  });

  it("keeps one production controller identity across deployment changes", async () => {
    const ctx = createContext();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_first");
    vi.mocked(getHookByToken)
      .mockReset()
      .mockRejectedValueOnce(new HookNotFoundError("first"))
      .mockResolvedValueOnce({ runId: "first-owner" } as never)
      .mockRejectedValueOnce(new HookNotFoundError("second"))
      .mockResolvedValueOnce({ runId: "second-owner" } as never);

    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_second");
    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );

    const firstInput = getStartedWorkflowInput(0);
    const secondInput = getStartedWorkflowInput(1);
    expect(firstInput.controlToken).toBe(secondInput.controlToken);
  });

  it("isolates preview controller identity by deployment", async () => {
    const ctx = createContext();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_first");
    vi.stubEnv("VERCEL_URL", "shared-preview.example.com");
    vi.mocked(getHookByToken)
      .mockReset()
      .mockRejectedValueOnce(new HookNotFoundError("first"))
      .mockResolvedValueOnce({ runId: "first-owner" } as never)
      .mockRejectedValueOnce(new HookNotFoundError("second"))
      .mockResolvedValueOnce({ runId: "second-owner" } as never);

    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_second");
    await contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
    );

    const firstInput = getStartedWorkflowInput(0);
    const secondInput = getStartedWorkflowInput(1);
    expect(firstInput.controlToken).not.toBe(secondInput.controlToken);
  });

  it("rejects when load returns null before the controller hook becomes active", async () => {
    const ctx = createContext();
    vi.mocked(getHookByToken).mockReset().mockRejectedValue(new HookNotFoundError("missing"));
    vi.mocked(startWorkflowPreferLatest).mockResolvedValue({
      returnValue: Promise.resolve({ kind: "deleted" }),
      runId: "deleted-run",
    } as never);

    await expect(
      contextStorage.run(ctx, () =>
        startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
      ),
    ).rejects.toThrow(/no active controller/u);
  });

  it("surfaces a load rejection before the controller hook becomes active", async () => {
    const ctx = createContext();
    const loadError = new Error("load exploded");
    const returnValue = Promise.reject(loadError);
    void returnValue.catch(() => undefined);
    vi.mocked(getHookByToken).mockReset().mockRejectedValue(new HookNotFoundError("missing"));
    vi.mocked(startWorkflowPreferLatest).mockResolvedValue({
      returnValue,
      runId: "failed-run",
    } as never);

    await expect(
      contextStorage.run(ctx, () =>
        startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
      ),
    ).rejects.toBe(loadError);
  });

  it("finishes readiness after enqueue even if the caller aborts", async () => {
    const ctx = createContext();
    const controller = new AbortController();
    const startResult = Promise.withResolvers<{
      readonly returnValue: Promise<never>;
      readonly runId: string;
    }>();
    vi.mocked(startWorkflowPreferLatest).mockReturnValue(startResult.promise as never);

    const start = contextStorage.run(ctx, () =>
      startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }, controller.signal),
    );
    await vi.waitFor(() => expect(startWorkflowPreferLatest).toHaveBeenCalledOnce());

    startResult.resolve({
      returnValue: new Promise<never>(() => undefined),
      runId: "started-run",
    });
    controller.abort(new Error("caller stopped waiting"));

    await expect(start).resolves.toEqual({ runId: "owner-run" });
  });

  it("adopts the active winner when a concurrently enqueued run settles as duplicate", async () => {
    const ctx = createContext();
    vi.mocked(getRun).mockReturnValue({
      returnValue: new Promise<never>(() => undefined),
      runId: "winner-run",
    } as never);
    vi.mocked(getHookByToken)
      .mockReset()
      .mockRejectedValueOnce(new HookNotFoundError("initial"))
      .mockReturnValueOnce(new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ runId: "winner-run" } as never);
    vi.mocked(startWorkflowPreferLatest).mockResolvedValue({
      returnValue: Promise.resolve({ kind: "duplicate", runId: "winner-run" }),
      runId: "loser-run",
    } as never);

    await expect(
      contextStorage.run(ctx, () =>
        startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
      ),
    ).resolves.toEqual({ runId: "winner-run" });
  });

  it("recaptures a duplicate winner after it rotates readiness", async () => {
    vi.useFakeTimers();
    try {
      const ctx = createContext();
      const definition = ctx.require(BundleKey).resolvedAgent.experimentalWorkflow!;
      vi.mocked(definition.load)
        .mockResolvedValueOnce({
          cadence: { delaySeconds: 10, kind: "after-completion" },
          dueAt: "2026-07-10T20:00:00.000Z",
          input: { task: "first" },
          iteration: 0,
          program: { js: "return input.task" },
        })
        .mockResolvedValueOnce({
          cadence: { delaySeconds: 10, kind: "after-completion" },
          dueAt: "2026-07-10T20:00:10.000Z",
          input: { task: "second" },
          iteration: 1,
          program: { js: "return input.task" },
        });

      let hookRead = 0;
      vi.mocked(getHookByToken)
        .mockReset()
        .mockImplementation(() => {
          hookRead += 1;
          if (hookRead === 1) return Promise.reject(new HookNotFoundError("initial control"));
          if (hookRead === 2) return new Promise<never>(() => undefined);
          if (hookRead <= 302) return Promise.reject(new HookNotFoundError("old ready"));
          return Promise.resolve({ runId: "winner-run" } as never);
        });
      vi.mocked(getRun).mockReturnValue({
        returnValue: new Promise<never>(() => undefined),
        runId: "winner-run",
      } as never);
      vi.mocked(startWorkflowPreferLatest).mockResolvedValue({
        returnValue: Promise.resolve({ kind: "duplicate", runId: "winner-run" }),
        runId: "loser-run",
      } as never);

      const start = contextStorage.run(ctx, () =>
        startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
      );
      await vi.runAllTimersAsync();

      await expect(start).resolves.toEqual({ runId: "winner-run" });
      expect(startWorkflowPreferLatest).toHaveBeenCalledOnce();
      expect(definition.load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a successor after a stale ready owner settles", async () => {
    const ctx = createContext();
    vi.mocked(getHookByToken)
      .mockReset()
      .mockResolvedValueOnce({ runId: "old-owner" } as never)
      .mockRejectedValueOnce(new HookNotFoundError("new-ready"))
      .mockRejectedValueOnce(new HookNotFoundError("old-control-gone"))
      .mockResolvedValueOnce({ runId: "new-owner" } as never);
    vi.mocked(getRun).mockReturnValueOnce({
      returnValue: Promise.resolve({ kind: "completed" }),
      runId: "old-owner",
    } as never);

    await expect(
      contextStorage.run(ctx, () =>
        startExperimentalWorkflow({ accountId: "acct_1", loopId: "loop_1" }),
      ),
    ).resolves.toEqual({ runId: "new-owner" });

    expect(startWorkflowPreferLatest).toHaveBeenCalledOnce();
  });

  it("stops the current owner and waits for its workflow run to settle", async () => {
    const ctx = createContext();

    await expect(
      contextStorage.run(ctx, () =>
        stopExperimentalWorkflow({
          reason: "loop edited",
          reference: { loopId: "loop_1", accountId: "acct_1" },
        }),
      ),
    ).resolves.toEqual({ runId: "owner-run", stopped: true });

    expect(resumeHook).toHaveBeenCalledWith(expect.any(String), {
      expectedRunId: "owner-run",
      kind: "stop",
      reason: "loop edited",
    });
    expect(getRun).toHaveBeenCalledWith("owner-run");
    expect(vi.mocked(getRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resumeHook).mock.invocationCallOrder[0]!,
    );
  });

  it("waits for stop settlement after delivery even if the caller aborts", async () => {
    const ctx = createContext();
    const controller = new AbortController();
    vi.mocked(resumeHook).mockImplementation(async () => {
      controller.abort(new Error("caller stopped waiting"));
      return { runId: "owner-run" } as never;
    });

    await expect(
      contextStorage.run(ctx, () =>
        stopExperimentalWorkflow(
          {
            reason: "loop edited",
            reference: { loopId: "loop_1", accountId: "acct_1" },
          },
          controller.signal,
        ),
      ),
    ).resolves.toEqual({ runId: "owner-run", stopped: true });
  });

  it("rejects immediately when abort lands before retry delay registration", async () => {
    const ctx = createContext();
    const controller = new AbortController();
    const abortReason = new Error("stop lookup cancelled");
    vi.mocked(resumeHook).mockImplementation(async () => {
      controller.abort(abortReason);
      throw new HookNotFoundError("missing-control");
    });

    await expect(
      contextStorage.run(ctx, () =>
        stopExperimentalWorkflow(
          { reference: { loopId: "loop_1", accountId: "acct_1" } },
          controller.signal,
        ),
      ),
    ).rejects.toBe(abortReason);
    expect(resumeHook).toHaveBeenCalledOnce();
  });
});

function getStartedWorkflowInput(callIndex: number): ExperimentalWorkflowEntryInput {
  const input = vi.mocked(startWorkflowPreferLatest).mock.calls[callIndex]?.[1][0];
  if (input === undefined) throw new Error(`Expected configured workflow start call ${callIndex}.`);
  return migrateExperimentalWorkflowEntryInput(input);
}

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    compiledArtifactsSource: {
      appRoot: "/app",
      kind: "disk",
      manifestPath: "/app/.eve/manifest.json",
      moduleMapPath: "/app/.eve/module-map.json",
    },
    resolvedAgent: {
      config: {
        limits: {
          maxInputTokensPerSession: 5_000,
          maxOutputTokensPerSession: 1_000,
          maxSubagentDepth: 2,
          maxSubagents: 4,
        },
      },
      experimentalWorkflow: {
        advance: vi.fn(),
        exportName: "default",
        load: vi.fn(async () => ({
          cadence: { delaySeconds: 10, kind: "after-completion" },
          dueAt: "2026-07-10T20:00:00.000Z",
          input: { task: "run" },
          iteration: 0,
          program: { js: "return input.task" },
        })),
        logicalPath: "agent/tools/workflow.ts",
        referenceSchema: {
          "~standard": {
            jsonSchema: { input: () => ({}), output: () => ({}) },
            validate: (value: unknown) => ({ value }),
            vendor: "test",
            version: 1,
          },
        },
        sourceId: "source:configured-workflow",
        sourceKind: "module",
      },
    },
    turnAgent: {
      instructions: ["current agent instructions"],
      model: { contextWindowTokens: 128_000, id: "test/model" },
      tools: [],
    },
  } as never);
  ctx.set(ChannelKey, { kind: "slack", state: { channelId: "C-parent" } } as never);
  ctx.set(AuthKey, { principalId: "caller" } as never);
  ctx.set(InitiatorAuthKey, { principalId: "initiator" } as never);
  ctx.set(SessionIdKey, "parent-session");
  ctx.set(ContinuationTokenKey, "parent-continuation");
  ctx.set(ParentSessionKey, {
    callId: "parent-call",
    rootSessionId: "root-session",
    sessionId: "parent-of-parent",
    turn: { id: "parent-turn", sequence: 7 },
  });
  ctx.set(CapabilitiesKey, { requestInput: true });
  ctx.set(ChannelRequestIdKey, "request-parent");
  ctx.set(ChannelInstrumentationKey, { traceId: "trace-parent" } as never);
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionCallbackKey, { token: "callback-parent" } as never);
  ctx.setVirtualContext(ActiveHarnessSessionKey, {
    agent: {
      modelReference: { id: "caller-model" },
      system: "caller system",
      tools: [],
    },
    compaction: {
      lastKnownInputTokens: 9_999,
      lastKnownPromptMessageCount: 99,
      recentWindowSize: 10,
      threshold: 100_000,
    },
    continuationToken: "parent-continuation",
    history: [{ role: "user", content: "create this loop" }],
    outputSchema: { type: "string" },
    rootSessionId: "root-session",
    sandboxState: { initialized: true, session: null },
    sessionId: "parent-session",
    state: {
      "eve.harness.emission": {
        sequence: 41,
        sessionStarted: true,
        stepIndex: 9,
        turnId: "caller-turn",
      },
      "eve.harness.pendingWorkflowInterrupt": { token: "caller-interrupt" },
      "eve.harness.sessionTokenBudgetBaseline": { inputTokens: 100 },
      "eve.harness.turnUsage": { inputTokens: 500, outputTokens: 100 },
      "eve.runtime.deferredStepInput": { message: "caller input" },
      "eve.runtime.hitl.approvedTools": ["dangerous-tool"],
      "eve.runtime.pendingActionBatch": { actions: ["caller-action"] },
      "eve.runtime.pendingInputBatch": { requests: ["caller-input"] },
      "eve.runtime.proxyInputRequests": { caller: "request" },
    },
    subagentDepth: 3,
    subagentMaxDepth: 5,
    workflowMaxSubagents: 99,
  } satisfies HarnessSession);
  return ctx;
}
