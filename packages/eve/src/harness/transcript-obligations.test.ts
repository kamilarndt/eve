import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  closeDanglingToolCalls,
  type DanglingToolCall,
  INTERRUPTED_TOOL_CALL_RESULT,
} from "#harness/transcript-obligations.js";

function assistantToolCall(toolCallId: string, providerExecuted?: boolean): ModelMessage {
  const part: {
    input: unknown;
    providerExecuted?: boolean;
    toolCallId: string;
    toolName: string;
    type: "tool-call";
  } = {
    input: { command: "pwd" },
    toolCallId,
    toolName: "bash",
    type: "tool-call",
  };
  if (providerExecuted !== undefined) {
    part.providerExecuted = providerExecuted;
  }
  return { content: [part], role: "assistant" };
}

function toolResult(toolCallId: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value: "ok" },
        toolCallId,
        toolName: "bash",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

/** The request-assembly guard's closure policy, as wired in the tool loop. */
function reconcileToolTranscript(messages: ModelMessage[]): {
  messages: ModelMessage[];
  repaired: readonly DanglingToolCall[];
} {
  const { closed, messages: reconciled } = closeDanglingToolCalls(messages, () => ({
    type: "error-text",
    value: INTERRUPTED_TOOL_CALL_RESULT,
  }));
  return { messages: reconciled, repaired: closed };
}

describe("closeDanglingToolCalls with the guard policy", () => {
  it("passes a balanced transcript through unchanged", () => {
    const messages: ModelMessage[] = [
      { content: "run pwd", role: "user" },
      assistantToolCall("call-1"),
      toolResult("call-1"),
      { content: "done", role: "assistant" },
    ];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it("closes a dangling local tool call with a synthetic error result in the adjacent message", () => {
    const messages: ModelMessage[] = [
      { content: "run pwd", role: "user" },
      assistantToolCall("call-1"),
      { content: "anything else?", role: "user" },
    ];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([{ toolCallId: "call-1", toolName: "bash" }]);
    expect(result.messages).toEqual([
      { content: "run pwd", role: "user" },
      assistantToolCall("call-1"),
      {
        content: [
          {
            output: { type: "error-text", value: INTERRUPTED_TOOL_CALL_RESULT },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "anything else?", role: "user" },
    ]);
  });

  it("merges the closure into an existing adjacent tool message", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            input: {},
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          {
            input: {},
            toolCallId: "call-2",
            toolName: "bash",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      toolResult("call-2"),
    ];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([{ toolCallId: "call-1", toolName: "bash" }]);
    expect(result.messages).toHaveLength(2);
    const closure = result.messages[1];
    expect(closure?.role).toBe("tool");
    expect(closure?.content).toEqual([
      {
        output: { type: "error-text", value: INTERRUPTED_TOOL_CALL_RESULT },
        toolCallId: "call-1",
        toolName: "bash",
        type: "tool-result",
      },
      {
        output: { type: "text", value: "ok" },
        toolCallId: "call-2",
        toolName: "bash",
        type: "tool-result",
      },
    ]);
  });

  it("closes a dangling call at the end of the transcript", () => {
    const messages: ModelMessage[] = [assistantToolCall("call-1")];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([{ toolCallId: "call-1", toolName: "bash" }]);
    expect(result.messages.at(-1)).toEqual({
      content: [
        {
          output: { type: "error-text", value: INTERRUPTED_TOOL_CALL_RESULT },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("ignores provider-executed tool calls", () => {
    const messages: ModelMessage[] = [assistantToolCall("call-1", true)];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it("counts inline assistant tool-results as closures", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          {
            input: {},
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          {
            output: { type: "text", value: "ok" },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "assistant",
      },
    ];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it("closes a call whose approval response never produced a result — no exemptions", () => {
    // An approval-response is not a closure: providers strip it, so a call
    // with only a response replays as a dangling tool_use. The harness
    // closes every approved call at resume; anything still dangling here is
    // an orphan.
    const messages: ModelMessage[] = [
      {
        content: [
          {
            input: {},
            toolCallId: "call-1",
            toolName: "client_tool",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            approvalId: "approval-1",
            approved: true,
            type: "tool-approval-response",
          },
        ],
        role: "tool",
      },
    ];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([{ toolCallId: "call-1", toolName: "client_tool" }]);
    const closure = result.messages[1];
    expect(closure?.role).toBe("tool");
    const closureParts = (closure?.content ?? []) as Array<Record<string, unknown>>;
    expect(closureParts.map((part) => part.type)).toEqual([
      "tool-result",
      "tool-approval-response",
    ]);
  });

  it("closes each dangling call exactly once when it appears twice", () => {
    const messages: ModelMessage[] = [assistantToolCall("call-1"), assistantToolCall("call-1")];

    const result = reconcileToolTranscript(messages);

    expect(result.repaired).toEqual([{ toolCallId: "call-1", toolName: "bash" }]);
  });
});

describe("closeDanglingToolCalls", () => {
  it("closes only the calls the resolver supplies an output for, with that output", () => {
    const messages: ModelMessage[] = [
      assistantToolCall("call-invalid"),
      assistantToolCall("call-parked"),
    ];

    const result = closeDanglingToolCalls(messages, (call) =>
      call.toolCallId === "call-invalid"
        ? { type: "error-text", value: "Failed to parse tool-call arguments" }
        : undefined,
    );

    expect(result.closed).toEqual([{ toolCallId: "call-invalid", toolName: "bash" }]);
    expect(result.messages).toEqual([
      messages[0],
      {
        content: [
          {
            output: { type: "error-text", value: "Failed to parse tool-call arguments" },
            toolCallId: "call-invalid",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      messages[1],
    ]);
  });

  it("does not re-close a call that already has a tool result", () => {
    const messages: ModelMessage[] = [assistantToolCall("call-1"), toolResult("call-1")];

    const result = closeDanglingToolCalls(messages, () => ({
      type: "error-text",
      value: "should not appear",
    }));

    expect(result.closed).toEqual([]);
    expect(result.messages).toEqual(messages);
  });
});
