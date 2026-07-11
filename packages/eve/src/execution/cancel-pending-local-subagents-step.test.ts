import { describe, expect, it, vi } from "vitest";

import { cancelPendingLocalSubagentsStep } from "#execution/cancel-pending-local-subagents-step.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { requestWorkflowRunCancellation } from "#execution/workflow-runtime.js";

vi.mock("#execution/durable-session-store.js", () => ({ readDurableSession: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", () => ({ requestWorkflowRunCancellation: vi.fn() }));

describe("cancelPendingLocalSubagentsStep", () => {
  it("cancels every recorded local child and waits for all cancellations", async () => {
    vi.mocked(requestWorkflowRunCancellation).mockResolvedValue(true);
    vi.mocked(readDurableSession).mockResolvedValue({
      state: {
        "eve.runtime.pendingActionBatch": {
          actions: [
            { callId: "call-1", kind: "subagent-call", nodeId: "researcher" },
            { callId: "call-2", kind: "remote-agent-call", nodeId: "remote" },
            { callId: "call-3", kind: "subagent-call", nodeId: "writer" },
          ],
          childContinuationTokens: {
            "call-1": "continuation-1",
            "call-3": "continuation-3",
          },
          childSessionIds: { "call-1": "session-1", "call-3": "session-3" },
          event: { sequence: 0, stepIndex: 0, turnId: "turn-1" },
          responseMessages: [],
        },
      },
    } as never);

    await expect(
      cancelPendingLocalSubagentsStep({
        serializedContext: {},
        sessionState: {} as never,
      }),
    ).resolves.toEqual({ cancelled: 2, settled: true });

    expect(requestWorkflowRunCancellation).toHaveBeenNthCalledWith(1, "session-1");
    expect(requestWorkflowRunCancellation).toHaveBeenNthCalledWith(2, "session-3");
  });

  it("waits for every sibling before reporting cancellation failures", async () => {
    const second = deferred<boolean>();
    const firstFailure = new Error("first cancellation failed");
    const secondFailure = new Error("second cancellation failed");
    vi.mocked(requestWorkflowRunCancellation)
      .mockRejectedValueOnce(firstFailure)
      .mockReturnValueOnce(second.promise);
    vi.mocked(readDurableSession).mockResolvedValue({
      state: {
        "eve.runtime.pendingActionBatch": {
          actions: [
            { callId: "call-1", kind: "subagent-call", nodeId: "researcher" },
            { callId: "call-2", kind: "subagent-call", nodeId: "writer" },
          ],
          childContinuationTokens: {
            "call-1": "continuation-1",
            "call-2": "continuation-2",
          },
          childSessionIds: { "call-1": "session-1", "call-2": "session-2" },
          event: { sequence: 0, stepIndex: 0, turnId: "turn-1" },
          responseMessages: [],
        },
      },
    } as never);

    let settled = false;
    const cancellation = cancelPendingLocalSubagentsStep({
      serializedContext: {},
      sessionState: {} as never,
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    second.reject(secondFailure);
    await expect(cancellation).rejects.toMatchObject({
      errors: [firstFailure, secondFailure],
      message: expect.stringContaining('"session-1", "session-2"'),
    });
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
} {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}
