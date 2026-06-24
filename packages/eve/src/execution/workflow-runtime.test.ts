import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createWorkflowRuntime,
  LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";
import {
  isRuntimeCancellationConflictError,
  isRuntimeNoActiveSessionError,
} from "#execution/runtime-errors.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const getHookByTokenMock = vi.fn();
const getRunMock = vi.fn();
const resumeHookMock = vi.fn();
const startMock = vi.fn();

function createStartedRun(runId: string) {
  return {
    returnValue: new Promise<never>(() => undefined),
    runId,
  };
}

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getRun: (...args: unknown[]) => getRunMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

afterEach(() => {
  getHookByTokenMock.mockReset();
  getRunMock.mockReset();
  resumeHookMock.mockReset();
  startMock.mockReset();
  vi.mocked(getCompiledRuntimeAgentBundle).mockReset();
  vi.unstubAllEnvs();
});

describe("workflowEntryReference", () => {
  it("uses the installed eve package identity for the runtime workflow id", () => {
    const packageInfo = resolveInstalledPackageInfo();

    // The runtime references intentionally omit the `@<pkg.version>`
    // stamp so cross-deployment routing (`start(ref, args, {
    // deploymentId: "latest" })`) finds the same workflow on a newer
    // deployment even when eve itself has been upgraded.
    expect(workflowEntryReference.workflowId).toBe(`workflow//${packageInfo.name}//workflowEntry`);
    expect(workflowEntryReference.workflowId).not.toContain("/src/execution/");
    expect(workflowEntryReference.workflowId).not.toContain("@");
    expect(turnWorkflowReference.workflowId).toBe(`workflow//${packageInfo.name}//turnWorkflow`);
    expect(turnWorkflowReference.workflowId).not.toContain("/src/execution/");
    expect(turnWorkflowReference.workflowId).not.toContain("@");
  });
});

describe("createWorkflowRuntime#deliver", () => {
  const NOT_FOUND_TOKEN = "test:no-such-hook";

  function buildRuntime() {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  it("returns after the delivery hook accepts the turn", async () => {
    getHookByTokenMock.mockResolvedValue({ runId: "driver-run" });

    const result = await buildRuntime().deliver({
      auth: null,
      continuationToken: "eve:session-1",
      payload: { message: "continue" },
    });

    expect(result).toEqual({
      sessionId: "driver-run",
    });
    expect(resumeHookMock).toHaveBeenCalledOnce();
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("normalizes `HookNotFoundError` into `RuntimeNoActiveSessionError`", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    getHookByTokenMock.mockRejectedValue(new HookNotFoundError(NOT_FOUND_TOKEN));

    const runtime = buildRuntime();

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: NOT_FOUND_TOKEN,
        payload: {},
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);
  });

  it("re-throws unexpected errors from `getHookByToken`", async () => {
    const failure = new Error("transient backing-store outage");
    getHookByTokenMock.mockRejectedValue(failure);

    const runtime = buildRuntime();

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: NOT_FOUND_TOKEN,
        payload: {},
      }),
    ).rejects.toBe(failure);
  });
});

describe("createWorkflowRuntime cancellation", () => {
  function buildRuntime() {
    return createWorkflowRuntime({ compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource });
  }

  it("resumes the active turn hook only when it belongs to the requested session", async () => {
    getHookByTokenMock.mockResolvedValue({ runId: "session-1" });

    await buildRuntime().cancelTurn({ sessionId: "session-1" });

    expect(resumeHookMock).toHaveBeenCalledWith("session-1:cancel-turn", undefined);
  });

  it("rejects an active turn hook owned by a different session", async () => {
    getHookByTokenMock.mockResolvedValue({ runId: "session-2" });

    await expect(buildRuntime().cancelTurn({ sessionId: "session-1" })).rejects.toSatisfy(
      isRuntimeCancellationConflictError,
    );
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("accepts session cancellation by session id", async () => {
    getHookByTokenMock.mockResolvedValue({ runId: "session-1" });

    await buildRuntime().cancelSession({ sessionId: "session-1" });

    expect(resumeHookMock).toHaveBeenCalledWith("session-1:cancel-session", undefined);
    expect(getHookByTokenMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes stale cancellation capabilities to a conflict", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    getHookByTokenMock.mockRejectedValue(new HookNotFoundError("stale"));

    await expect(buildRuntime().cancelTurn({ sessionId: "session-1" })).rejects.toSatisfy(
      isRuntimeCancellationConflictError,
    );
  });
});

describe("createWorkflowRuntime#run", () => {
  const adapter: ChannelAdapter = { kind: "http" };

  function buildRuntime(compiledArtifactsSource: RuntimeCompiledArtifactsSource) {
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  function mockBundleAndRun(compiledArtifactsSource: RuntimeCompiledArtifactsSource): void {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      compiledArtifactsSource,
    } as never);
    getHookByTokenMock.mockResolvedValue({ runId: "driver-run" });
  }

  it("starts workflowEntry on the latest deployment in Vercel production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock.mockResolvedValue(createStartedRun("driver-run"));

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        {
          input: { message: "hello" },
          serializedContext: expect.objectContaining({
            "eve.bundle": { source: compiledArtifactsSource },
            "eve.channel": { kind: "http", state: {} },
            "eve.mode": "task",
          }),
        },
      ],
      { deploymentId: "latest" },
    );
  });

  it("falls back to the current deployment when latest is unsupported", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock
      .mockRejectedValueOnce(new Error(LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE))
      .mockResolvedValueOnce(createStartedRun("driver-run"));

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(startMock).toHaveBeenNthCalledWith(1, workflowEntryReference, expect.any(Array), {
      deploymentId: "latest",
    });
    expect(startMock).toHaveBeenNthCalledWith(2, workflowEntryReference, expect.any(Array));
  });

  it.each(["preview", "development", undefined])(
    "pins workflowEntry to the current deployment when VERCEL_ENV is %s",
    async (vercelEnv) => {
      // Preview and CLI deployments carry no git branch reference, so the
      // platform cannot resolve "latest" for them (HTTP 400). They must pin
      // to their own immutable deployment.
      if (vercelEnv === undefined) {
        vi.stubEnv("VERCEL_ENV", "");
        delete process.env.VERCEL_ENV;
      } else {
        vi.stubEnv("VERCEL_ENV", vercelEnv);
      }
      const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
      mockBundleAndRun(compiledArtifactsSource);
      startMock.mockResolvedValue(createStartedRun("driver-run"));

      await buildRuntime(compiledArtifactsSource).run({
        adapter,
        auth: null,
        input: { message: "hello" },
        mode: "task",
      });

      expect(startMock).toHaveBeenCalledTimes(1);
      expect(startMock).toHaveBeenCalledWith(workflowEntryReference, expect.any(Array));
    },
  );

  it("does not open the workflow event stream until the events stream is read", async () => {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      compiledArtifactsSource,
    } as never);
    const bytes = new TextEncoder().encode('{"type":"test.event"}\n');
    const getReadable = vi.fn(() => {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    });
    getRunMock.mockReturnValue({ getReadable });
    getHookByTokenMock.mockResolvedValue({ runId: "driver-run" });
    startMock.mockResolvedValue(createStartedRun("driver-run"));

    const handle = await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(getRunMock).not.toHaveBeenCalled();
    expect(getReadable).not.toHaveBeenCalled();

    const reader = handle.events.getReader();
    const event = await reader.read();
    reader.releaseLock();

    expect(event.value).toEqual({ type: "test.event" });
    expect(getRunMock).toHaveBeenCalledWith("driver-run");
    expect(getReadable).toHaveBeenCalledOnce();
  });
});
