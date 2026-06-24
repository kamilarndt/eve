import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { finalizeCancellationStep } from "#execution/cancellation-step.js";

const dispatchStreamEventHooksMock = vi.fn();
const readDurableSessionMock = vi.fn();
const serializeContextMock = vi.fn();
const withContextScopeMock = vi.fn();

vi.mock("#context/hook-lifecycle.js", () => ({
  dispatchStreamEventHooks: (...args: unknown[]) => dispatchStreamEventHooksMock(...args),
}));

vi.mock("#context/run-step.js", () => ({
  withContextScope: (...args: unknown[]) => withContextScopeMock(...args),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: (...args: unknown[]) => serializeContextMock(...args),
}));

vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/durable-session-store.js")>()),
  createDurableSessionState: vi.fn(({ session }) => ({ session })),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));

vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: ({ durable }: { durable: HarnessSession }) => durable,
}));

describe("finalizeCancellationStep", () => {
  beforeEach(async () => {
    dispatchStreamEventHooksMock.mockReset().mockResolvedValue(undefined);
    readDurableSessionMock.mockReset().mockResolvedValue(
      setHarnessEmissionState(createSession(), {
        sequence: 2,
        sessionStarted: true,
        stepIndex: 1,
        turnId: "turn_2",
      }),
    );
    serializeContextMock.mockReset().mockReturnValue({ serialized: true });
    withContextScopeMock
      .mockReset()
      .mockImplementation(async (_ctx, session, callback) => callback(session));

    const { deserializeContext } = await import("#context/serialize.js");
    vi.mocked(deserializeContext).mockReset();
  });

  it("dispatches cancellation boundaries through channel handlers and authored hooks", async () => {
    const turnCancelled = vi.fn();
    const sessionWaiting = vi.fn();
    const adapter: ChannelAdapter = {
      kind: "test",
      "session.waiting": sessionWaiting,
      "turn.cancelled": turnCancelled,
    };
    const hookRegistry = { id: "hooks" };
    const bundle = {
      hookRegistry,
      resolvedAgent: { config: {} },
      turnAgent: {},
    };
    const ctx = {
      get: vi.fn(),
      require(key: unknown) {
        if (key === BundleKey) return bundle;
        if (key === ChannelKey) return adapter;
        throw new Error("Unexpected context key.");
      },
    };
    const { deserializeContext } = await import("#context/serialize.js");
    vi.mocked(deserializeContext).mockResolvedValue(ctx as never);

    const result = await finalizeCancellationStep({
      parentWritable: new WritableStream<Uint8Array>(),
      scope: "turn",
      serializedContext: {},
      sessionState: {
        continuationToken: "test:session",
        emissionState: {
          sequence: 2,
          sessionStarted: true,
          stepIndex: 1,
          turnId: "turn_2",
        },
        hasProxyInputRequests: false,
        sessionId: "session-1",
        version: 1,
      },
    });

    expect(turnCancelled).toHaveBeenCalledOnce();
    expect(sessionWaiting).toHaveBeenCalledOnce();
    expect(dispatchStreamEventHooksMock.mock.calls.map(([input]) => input.event.type)).toEqual([
      "turn.cancelled",
      "session.waiting",
    ]);
    expect(dispatchStreamEventHooksMock).toHaveBeenCalledWith(
      expect.objectContaining({ ctx, registry: hookRegistry }),
    );
    expect(withContextScopeMock.mock.calls[0]?.[3].abortSignal.aborted).toBe(true);
    expect(result.serializedContext).toEqual({ serialized: true });
  });

  it("does not emit a turn boundary when cancelling a parked session", async () => {
    readDurableSessionMock.mockResolvedValue(createSession());
    const turnCancelled = vi.fn();
    const sessionCancelled = vi.fn();
    const adapter: ChannelAdapter = {
      kind: "test",
      "session.cancelled": sessionCancelled,
      "turn.cancelled": turnCancelled,
    };
    const hookRegistry = { id: "hooks" };
    const ctx = {
      get: vi.fn(),
      require(key: unknown) {
        if (key === BundleKey) {
          return {
            hookRegistry,
            resolvedAgent: { config: {} },
            turnAgent: {},
          };
        }
        if (key === ChannelKey) return adapter;
        throw new Error("Unexpected context key.");
      },
    };
    const { deserializeContext } = await import("#context/serialize.js");
    vi.mocked(deserializeContext).mockResolvedValue(ctx as never);

    await finalizeCancellationStep({
      parentWritable: new WritableStream<Uint8Array>(),
      scope: "session",
      serializedContext: {},
      sessionState: {
        continuationToken: "test:session",
        emissionState: {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
        hasProxyInputRequests: false,
        sessionId: "session-1",
        version: 1,
      },
    });

    expect(turnCancelled).not.toHaveBeenCalled();
    expect(sessionCancelled).toHaveBeenCalledOnce();
    expect(dispatchStreamEventHooksMock.mock.calls.map(([input]) => input.event.type)).toEqual([
      "session.cancelled",
    ]);
  });
});

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test:session",
    history: [],
    sessionId: "session-1",
  };
}
