import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelDescendantsStep } from "#execution/cancel-descendants-step.js";
import {
  recordPendingRuntimeActionChild,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";

const getHookByTokenMock = vi.fn();
const readDurableSessionMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./durable-session-store.js")>()),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn().mockResolvedValue({
    require: () => ({
      subagentRegistry: { subagentsByNodeId: new Map() },
    }),
  }),
}));

describe("cancelDescendantsStep", () => {
  beforeEach(() => {
    getHookByTokenMock.mockReset().mockResolvedValue({ runId: "child-session" });
    resumeHookMock.mockReset().mockResolvedValue(undefined);
    readDurableSessionMock.mockReset();
  });

  it("returns after every recorded local child accepts cancellation", async () => {
    readDurableSessionMock.mockResolvedValue(createSessionWithChild());

    await cancelDescendantsStep({
      serializedContext: {},
      sessionState: {} as DurableSessionState,
    });

    expect(getHookByTokenMock).toHaveBeenCalledWith("subagent:parent:call-1");
    expect(resumeHookMock).toHaveBeenCalledWith("child-session:cancel-session", undefined);
  });

  it("ignores a child whose cancellation hook is unavailable", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    getHookByTokenMock.mockRejectedValue(new HookNotFoundError("subagent:parent:call-1"));
    readDurableSessionMock.mockResolvedValue(createSessionWithChild());

    await cancelDescendantsStep({
      serializedContext: {},
      sessionState: {} as DurableSessionState,
    });

    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("keeps parent cancellation non-fatal when a descendant request fails", async () => {
    resumeHookMock.mockRejectedValue(new Error("child unavailable"));
    readDurableSessionMock.mockResolvedValue(createSessionWithChild());

    await expect(
      cancelDescendantsStep({
        serializedContext: {},
        sessionState: {} as DurableSessionState,
      }),
    ).resolves.toBeUndefined();
  });
});

function createSessionWithChild(): HarnessSession {
  return recordPendingRuntimeActionChild({
    callId: "call-1",
    child: {
      continuationToken: "subagent:parent:call-1",
      sessionId: "child-session",
    },
    session: setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-1",
          description: "Slow child",
          input: { message: "work" },
          kind: "subagent-call",
          name: "child",
          nodeId: "subagents/child.ts",
          subagentName: "child",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn-0" },
      responseMessages: [],
      session: createSession(),
    }),
  });
}

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "eve:parent",
    history: [],
    sessionId: "parent-session",
  };
}
