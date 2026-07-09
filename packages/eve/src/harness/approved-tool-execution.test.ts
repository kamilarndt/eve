import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { requestAuthorization } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  closeApprovedActionBatch,
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

describe("closeApprovedActionBatch", () => {
  it("preserves every authorization challenge raised by an approved batch", async () => {
    const firstSignal = requestAuthorization([
      {
        challenge: { url: "https://idp.example/first" },
        hookUrl: "https://app.example/first/callback",
        name: "first_connection",
        resume: { nonce: "first" },
      },
    ]);
    const secondSignal = requestAuthorization([
      {
        challenge: { url: "https://idp.example/second" },
        hookUrl: "https://app.example/second/callback",
        name: "second_connection",
        resume: { nonce: "second" },
      },
    ]);
    const ctx = new ContextContainer();
    const tools = new Map([
      ["first", createDefinition({ execute: () => firstSignal, name: "first" })],
      ["second", createDefinition({ execute: () => secondSignal, name: "second" })],
    ]);

    const result = await contextStorage.run(ctx, () =>
      closeApprovedActionBatch({
        batch: {
          calls: [
            { ...call, callId: "call-first", toolName: "first" },
            { ...call, callId: "call-second", toolName: "second" },
          ],
        },
        ctx,
        messages: [],
        tools,
      }),
    );

    expect(result.authorizationSignal?.challenges).toEqual([
      ...firstSignal.challenges,
      ...secondSignal.challenges,
    ]);
  });

  it("places a result beside its matching call when later input already follows", async () => {
    const assistant: ModelMessage = {
      content: [
        {
          input: { note: "hi" },
          toolCallId: "call-1",
          toolName: "echo",
          type: "tool-call",
        },
      ],
      role: "assistant",
    };
    const approval: ModelMessage = {
      content: [{ approvalId: "approval-1", approved: true, type: "tool-approval-response" }],
      role: "tool",
    };
    const laterInput: ModelMessage = { content: "additional context", role: "user" };

    const result = await closeApprovedActionBatch({
      batch: { calls: [call] },
      ctx: undefined,
      messages: [assistant, approval, laterInput],
      tools: new Map([["echo", createDefinition({ execute: () => "ok" })]]),
    });

    expect(result.messages).toEqual([
      assistant,
      {
        content: [
          { approvalId: "approval-1", approved: true, type: "tool-approval-response" },
          {
            output: { type: "text", value: "ok" },
            toolCallId: "call-1",
            toolName: "echo",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      laterInput,
    ]);
  });
});
