import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  appendExecutedToolResults,
  executeApprovedToolCalls,
} from "#harness/approved-tool-execution.js";

function createDefinition(overrides: Partial<HarnessToolDefinition> = {}): HarnessToolDefinition {
  return {
    description: "Echo",
    inputSchema: jsonSchema({ type: "object" }),
    name: "echo",
    ...overrides,
  };
}

const call = {
  callId: "call-1",
  input: { note: "hi" },
  kind: "tool-call",
  toolName: "echo",
} as const;

describe("executeApprovedToolCalls", () => {
  it("executes the approved call and returns a durable result part plus action.result payload", async () => {
    const execute = vi.fn().mockResolvedValue({ echoed: "hi" });
    const outcome = await executeApprovedToolCalls({
      calls: [call],
      messages: [],
      resolveTool: () => createDefinition({ execute }),
    });

    expect(execute).toHaveBeenCalledWith(
      { note: "hi" },
      expect.objectContaining({ toolCallId: "call-1" }),
    );
    expect(outcome.executed).toHaveLength(1);
    expect(outcome.executed[0]?.part).toEqual({
      output: { type: "json", value: { echoed: "hi" } },
      toolCallId: "call-1",
      toolName: "echo",
      type: "tool-result",
    });
    expect(outcome.executed[0]?.actionResult).toEqual({
      callId: "call-1",
      kind: "tool-result",
      output: { echoed: "hi" },
      toolName: "echo",
    });
  });

  it("applies the author's toModelOutput to the durable result", async () => {
    const outcome = await executeApprovedToolCalls({
      calls: [call],
      messages: [],
      resolveTool: () =>
        createDefinition({
          execute: () => ({ echoed: "hi" }),
          toModelOutput: () => ({ type: "text", value: "echoed hi" }),
        }),
    });

    expect(outcome.executed[0]?.part.output).toEqual({ type: "text", value: "echoed hi" });
  });

  it("closes a throwing execute with an error result instead of leaving the call dangling", async () => {
    const outcome = await executeApprovedToolCalls({
      calls: [call],
      messages: [],
      resolveTool: () =>
        createDefinition({
          execute: () => {
            throw new Error("boom");
          },
        }),
    });

    expect(outcome.executed[0]?.part.output).toEqual({ type: "error-text", value: "boom" });
    expect(outcome.executed[0]?.actionResult).toMatchObject({
      callId: "call-1",
      isError: true,
      output: "boom",
    });
  });

  it("closes an approved call whose tool no longer resolves", async () => {
    const outcome = await executeApprovedToolCalls({
      calls: [call],
      messages: [],
      resolveTool: () => undefined,
    });

    expect(outcome.executed[0]?.part.output).toEqual({
      type: "error-text",
      value: 'Tool "echo" is no longer available.',
    });
    expect(outcome.executed[0]?.actionResult).toMatchObject({ isError: true });
  });

  it("closes an execute-less tool with an error result instead of leaving it dangling", async () => {
    const outcome = await executeApprovedToolCalls({
      calls: [call],
      messages: [],
      resolveTool: () => createDefinition(),
    });

    expect(outcome.executed[0]?.part.output).toEqual({
      type: "error-text",
      value: 'Tool "echo" has no local execution and cannot run.',
    });
    expect(outcome.executed[0]?.actionResult).toMatchObject({ isError: true });
  });

  it("executes calls sequentially in batch order", async () => {
    const order: string[] = [];
    const outcome = await executeApprovedToolCalls({
      calls: [call, { ...call, callId: "call-2", input: { note: "second" } }],
      messages: [],
      resolveTool: () =>
        createDefinition({
          execute: async (input: { note: string }) => {
            order.push(input.note);
            return input.note;
          },
        }),
    });

    expect(order).toEqual(["hi", "second"]);
    expect(outcome.executed.map((entry) => entry.part.output)).toEqual([
      { type: "text", value: "hi" },
      { type: "text", value: "second" },
    ]);
  });
});

describe("appendExecutedToolResults", () => {
  const part = {
    output: { type: "text", value: "ok" },
    toolCallId: "call-1",
    toolName: "echo",
    type: "tool-result",
  } as const;

  it("merges results into the trailing tool message", () => {
    const messages: ModelMessage[] = [
      { content: "hi", role: "user" },
      {
        content: [{ approvalId: "approval-1", approved: true, type: "tool-approval-response" }],
        role: "tool",
      },
    ];

    const result = appendExecutedToolResults(messages, [part]);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      content: [{ approvalId: "approval-1", approved: true, type: "tool-approval-response" }, part],
      role: "tool",
    });
  });

  it("appends a new tool message when the transcript does not end in one", () => {
    const messages: ModelMessage[] = [{ content: "hi", role: "user" }];

    const result = appendExecutedToolResults(messages, [part]);

    expect(result).toEqual([
      { content: "hi", role: "user" },
      { content: [part], role: "tool" },
    ]);
  });

  it("returns a copy when there is nothing to append", () => {
    const messages: ModelMessage[] = [{ content: "hi", role: "user" }];

    expect(appendExecutedToolResults(messages, [])).toEqual(messages);
  });
});
