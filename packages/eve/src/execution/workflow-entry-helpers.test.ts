import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { waitForPendingRuntimeActionResults } from "#execution/workflow-entry-helpers.js";

describe("waitForPendingRuntimeActionResults", () => {
  it("returns cancellation as an interruption value", async () => {
    const sessionState: DurableSessionState = {
      continuationToken: "http:test",
      emissionState: {
        sequence: 1,
        sessionStarted: true,
        stepIndex: 1,
        turnId: "turn_1",
      },
      hasProxyInputRequests: false,
      sessionId: "session-1",
      version: 1,
    };
    const consumeNext = vi.fn();
    const rekeyHook = vi.fn();

    await expect(
      waitForPendingRuntimeActionResults({
        bufferedDeliveries: [],
        cancellation: async () => ({ kind: "cancelled", scope: "session" }),
        consumeNext,
        getNextPromise: () => new Promise(() => undefined),
        parentWritable: new WritableStream<Uint8Array>(),
        pendingActionKeys: ["subagent:call-1"],
        rekeyHook,
        serializedContext: { context: true },
        sessionState,
      }),
    ).resolves.toEqual({
      kind: "cancelled",
      scope: "session",
      serializedContext: { context: true },
      sessionState,
    });
    expect(consumeNext).not.toHaveBeenCalled();
    expect(rekeyHook).not.toHaveBeenCalled();
  });
});
