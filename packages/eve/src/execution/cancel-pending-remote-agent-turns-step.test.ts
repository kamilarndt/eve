import { beforeEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { cancelPendingRemoteAgentTurnsStep } from "#execution/cancel-pending-remote-agent-turns-step.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import {
  recordPendingRemoteAgentSession,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("./durable-session-store.js", () => ({
  readDurableSession: vi.fn(),
}));

vi.mock("../context/serialize.js", () => ({
  deserializeContext: vi.fn(),
}));

vi.mock("./remote-agent-dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
}));

describe("cancelPendingRemoteAgentTurnsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels the remote turn retained on a pending runtime action", async () => {
    const session = recordPendingRemoteAgentSession({
      callId: "call-remote",
      continuationToken: "eve:remote-turn",
      session: setPendingRuntimeActionBatch({
        actions: [
          {
            callId: "call-remote",
            description: "Research",
            input: { message: "investigate" },
            kind: "remote-agent-call",
            name: "research",
            nodeId: "remote/research",
            remoteAgentName: "research",
          },
        ],
        event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
        responseMessages: [],
        session: createSession(),
      }),
      sessionId: "remote-session",
    });
    const registry = new Map();
    const remote = { name: "research" } as never;
    vi.mocked(readDurableSession).mockResolvedValue(session);
    vi.mocked(deserializeContext).mockResolvedValue({
      require: vi.fn(() => ({ subagentRegistry: { subagentsByNodeId: registry } })),
    } as never);
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote);

    await cancelPendingRemoteAgentTurnsStep({
      serializedContext: { context: "serialized" },
      sessionState: {
        continuationToken: "eve:parent",
        emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
        hasProxyInputRequests: false,
        sessionId: "parent-session",
        version: 1,
      },
    });

    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith({
      nodeId: "remote/research",
      registry,
      remoteAgentName: "research",
    });
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
      continuationToken: "eve:remote-turn",
      remote,
      sessionId: "remote-session",
    });
  });
});

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "eve:parent",
    history: [],
    sessionId: "parent-session",
  };
}
