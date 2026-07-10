import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import {
  createRuntimeActionRequestFromToolCall,
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "research subagent",
        input: { message: "go" },
        kind: "subagent-call",
        name: "researcher",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

describe("createRuntimeActionRequestFromToolCall", () => {
  it("projects the owning tool's display argument onto the serializable action", () => {
    const definition = {
      description: "Run a shell command.",
      formatDisplayArgument: (input) =>
        typeof input.command === "string" ? input.command.split("\n", 1)[0] : undefined,
      inputSchema: jsonSchema({ type: "object" }),
      name: "bash",
    } satisfies HarnessToolDefinition;
    const tools: HarnessToolMap = new Map([[definition.name, definition]]);

    expect(
      createRuntimeActionRequestFromToolCall({
        toolCall: {
          input: { command: "sh -c script/foo.sh\necho ignored" },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-call",
        },
        tools,
      }),
    ).toEqual({
      callId: "call-1",
      displayArgument: "sh -c script/foo.sh",
      input: { command: "sh -c script/foo.sh\necho ignored" },
      kind: "tool-call",
      toolName: "bash",
    });
  });

  it("does not derive display text for a tool without an explicit formatter", () => {
    const definition = {
      description: "Fetch an authored URL.",
      inputSchema: jsonSchema({ type: "object" }),
      name: "web_fetch",
    } satisfies HarnessToolDefinition;
    const tools: HarnessToolMap = new Map([[definition.name, definition]]);

    expect(
      createRuntimeActionRequestFromToolCall({
        toolCall: {
          input: { url: "https://alice:secret@example.com/data" },
          toolCallId: "call-2",
          toolName: "web_fetch",
          type: "tool-call",
        },
        tools,
      }),
    ).toEqual({
      callId: "call-2",
      input: { url: "https://alice:secret@example.com/data" },
      kind: "tool-call",
      toolName: "web_fetch",
    });
  });
});

describe("resolvePendingRuntimeActions", () => {
  it("draws completed child usage down against the parent's session totals", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });
  });

  it("leaves the parent's totals untouched when the child reports no usage", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
  });
});
