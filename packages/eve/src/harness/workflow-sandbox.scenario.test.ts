import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { getWorkflowRuntimeActionInterrupts } from "#harness/workflow-runtime-action-state.js";
import { continueWorkflowProgram, executeWorkflowProgram } from "#harness/workflow-program.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import {
  continueWorkflowSandboxInterrupt,
  getWorkflowSandboxInterrupt,
  type WorkflowSandboxLifecycle,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";

function orchestrationTools(): HarnessToolMap {
  return new Map<string, HarnessToolDefinition>([
    [
      "echo-marker",
      {
        description: "Echo one marker.",
        inputSchema: jsonSchema({
          properties: { message: { type: "string" } },
          required: ["message"],
          type: "object",
        }),
        name: "echo-marker",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/echo-marker",
          subagentName: "echo-marker",
        },
      },
    ],
  ]);
}

const concurrentProgram = `return await Promise.all([
  tools["echo-marker"]({ message: "alpha" }),
  tools["echo-marker"]({ message: "beta" }),
]);`;
const continuationSecurity = {
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
  signingKey: "workflow-sandbox-scenario-test-key",
};

describe("Workflow concurrent continuation", () => {
  it("executes a detached saved program without a model call", async () => {
    await expect(
      executeWorkflowProgram({
        continuationSecurity,
        context: {
          input: { accountId: "acct_1" },
          iteration: 2,
          scheduledAt: "2026-07-10T20:00:00.000Z",
          state: { cursor: "cursor_1" },
        },
        outerToolCallId: "detached-iteration-2",
        program: {
          js: "return { accountId: input.accountId, cursor: state.cursor, iteration, scheduledAt };",
        },
        tools: new Map(),
      }),
    ).resolves.toEqual({
      output: {
        accountId: "acct_1",
        cursor: "cursor_1",
        iteration: 2,
        scheduledAt: "2026-07-10T20:00:00.000Z",
      },
      status: "completed",
    });
  });

  it("collects promptly interrupted Promise.all siblings in one ledger", async () => {
    const tools = orchestrationTools();
    const { modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools: tools,
      tools: buildToolSet({ tools }),
    });
    const execute = modelTools.Workflow?.execute as
      | ((input: { js: string }, options: { messages: []; toolCallId: string }) => Promise<unknown>)
      | undefined;

    const initialOutput = await execute!(
      { js: concurrentProgram },
      { messages: [], toolCallId: "workflow-call" },
    );
    const interrupt = await getWorkflowSandboxInterrupt(initialOutput, continuationSecurity);

    expect(interrupt!.continuation.auth.expiresAtMs - interrupt!.continuation.auth.issuedAtMs).toBe(
      continuationSecurity.maxAgeMs,
    );
    expect(getWorkflowRuntimeActionInterrupts(interrupt!).map((entry) => entry.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);
  });

  it("preserves and resolves sibling interrupts when a later call interrupts first", async () => {
    const tools = orchestrationTools();
    const lifecycle: WorkflowSandboxLifecycle = {
      async onNestedToolCall(event) {
        if ((event.input as { message?: string }).message === "alpha") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    };
    const { hostTools, modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools: tools,
      lifecycle,
      tools: buildToolSet({ tools }),
    });
    const execute = modelTools.Workflow?.execute as
      | ((input: { js: string }, options: { messages: []; toolCallId: string }) => Promise<unknown>)
      | undefined;
    expect(execute).toBeDefined();

    const initialOutput = await execute!(
      { js: concurrentProgram },
      { messages: [], toolCallId: "workflow-call" },
    );
    const racedInterrupt = await getWorkflowSandboxInterrupt(initialOutput, continuationSecurity);
    expect(racedInterrupt?.input).toEqual({ message: "beta" });

    const pending = getWorkflowRuntimeActionInterrupts(racedInterrupt!);
    expect(pending.map((interrupt) => interrupt.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);

    const firstContinuation = await continueWorkflowSandboxInterrupt({
      continuationSecurity,
      interrupt: pending[0]!,
      lifecycle,
      resolution: "alpha-result",
      tools: hostTools,
    });
    const firstUnwrapped = await unwrapWorkflowSandboxResult(
      firstContinuation,
      continuationSecurity,
    );
    expect(firstUnwrapped).toMatchObject({
      interrupt: { input: { message: "beta" } },
      status: "interrupted",
    });
    if (firstUnwrapped.status !== "interrupted") throw new Error("Expected second interrupt.");

    const finalContinuation = await continueWorkflowSandboxInterrupt({
      continuationSecurity,
      interrupt: firstUnwrapped.interrupt,
      lifecycle,
      resolution: "beta-result",
      tools: hostTools,
    });
    await expect(
      unwrapWorkflowSandboxResult(finalContinuation, continuationSecurity),
    ).resolves.toEqual({
      output: ["alpha-result", "beta-result"],
      status: "completed",
    });
  });

  it("aborts resumed program code after its child interrupt resolves", async () => {
    const tools = orchestrationTools();
    const initial = await executeWorkflowProgram({
      continuationSecurity,
      context: {
        input: null,
        iteration: 1,
        scheduledAt: "2026-07-10T20:00:00.000Z",
      },
      outerToolCallId: "resumed-loop",
      program: {
        js: 'await tools["echo-marker"]({ message: "before-loop" }); while (true) {}',
      },
      tools,
    });
    expect(initial.status).toBe("interrupted");
    if (initial.status !== "interrupted") throw new Error("Expected child interrupt.");

    const abortController = new AbortController();
    const abortReason = new Error("stop resumed dynamic workflow");
    abortController.abort(abortReason);

    await expect(
      continueWorkflowProgram({
        abortSignal: abortController.signal,
        continuationSecurity,
        interrupt: initial.interrupt,
        resolution: "child-result",
        tools,
      }),
    ).rejects.toMatchObject({
      code: "CODE_MODE_ABORTED",
      message: "Code mode execution was aborted.",
    });
  });
});
