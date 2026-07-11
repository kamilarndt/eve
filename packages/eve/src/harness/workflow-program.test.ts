import { jsonSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { continueWorkflowProgram, executeWorkflowProgram } from "#harness/workflow-program.js";
import type { HarnessToolMap } from "#harness/types.js";
import {
  continueWorkflowSandboxInterrupt,
  runWorkflowSandboxProgram,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";

vi.mock("#shared/workflow-sandbox.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#shared/workflow-sandbox.js")>();
  return {
    ...original,
    continueWorkflowSandboxInterrupt: vi.fn(),
    runWorkflowSandboxProgram: vi.fn(),
    unwrapWorkflowSandboxResult: vi.fn(),
  };
});

describe("executeWorkflowProgram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs saved JavaScript once with iteration bindings and agent-only tools", async () => {
    const abortSignal = new AbortController().signal;
    const sandboxResult = { result: "sandbox-result" };
    vi.mocked(runWorkflowSandboxProgram).mockResolvedValue(sandboxResult);
    vi.mocked(unwrapWorkflowSandboxResult).mockResolvedValue({
      output: { ok: true },
      status: "completed",
    });

    await expect(
      executeWorkflowProgram({
        abortSignal,
        continuationSecurity: { signingKey: "test-signing-key" },
        context: {
          input: { accountId: "acct_1" },
          iteration: 4,
          scheduledAt: "2026-07-10T20:00:00.000Z",
          state: { cursor: "next" },
        },
        outerToolCallId: "loop-generation-4",
        program: { js: "return { accountId: input.accountId, cursor: state.cursor };" },
        tools: orchestrationTools(),
      }),
    ).resolves.toEqual({ output: { ok: true }, status: "completed" });

    expect(runWorkflowSandboxProgram).toHaveBeenCalledOnce();
    const call = vi.mocked(runWorkflowSandboxProgram).mock.calls[0]?.[0];
    expect(call?.abortSignal).toBe(abortSignal);
    expect(call?.outerToolCallId).toBe("loop-generation-4");
    expect(Object.keys(call?.hostTools ?? {})).toEqual(["researcher"]);
    expect(call?.js).toContain('const input = {"accountId":"acct_1"};');
    expect(call?.js).toContain('const state = {"cursor":"next"};');
    expect(call?.js).toContain("const iteration = 4;");
    expect(call?.js).toContain('const scheduledAt = "2026-07-10T20:00:00.000Z";');
    expect(call?.js).toContain("return { accountId: input.accountId, cursor: state.cursor };");
    expect(unwrapWorkflowSandboxResult).toHaveBeenCalledWith(
      sandboxResult,
      expect.objectContaining({ signingKey: "test-signing-key" }),
    );
  });

  it("resumes a signed program interrupt on the same agents-only host surface", async () => {
    const abortSignal = new AbortController().signal;
    const interrupt = { continuation: { ledger: [] } } as never;
    const continued = { result: "continued" };
    vi.mocked(continueWorkflowSandboxInterrupt).mockResolvedValue(continued);
    vi.mocked(unwrapWorkflowSandboxResult).mockResolvedValue({
      output: "research-result",
      status: "completed",
    });

    await expect(
      continueWorkflowProgram({
        abortSignal,
        continuationSecurity: { signingKey: "test-signing-key" },
        interrupt,
        resolution: "research-result",
        tools: orchestrationTools(),
      }),
    ).resolves.toEqual({ output: "research-result", status: "completed" });

    expect(continueWorkflowSandboxInterrupt).toHaveBeenCalledWith({
      abortSignal,
      continuationSecurity: { signingKey: "test-signing-key" },
      interrupt,
      lifecycle: undefined,
      resolution: "research-result",
      tools: expect.objectContaining({ researcher: expect.any(Object) }),
    });
    const tools = vi.mocked(continueWorkflowSandboxInterrupt).mock.calls[0]?.[0].tools;
    expect(Object.keys(tools ?? {})).toEqual(["researcher"]);
    expect(unwrapWorkflowSandboxResult).toHaveBeenCalledWith(continued, {
      signingKey: "test-signing-key",
    });
  });
});

function orchestrationTools(): HarnessToolMap {
  return new Map<string, HarnessToolDefinition>([
    [
      "researcher",
      {
        description: "Delegate to the researcher.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      },
    ],
    [
      "bash",
      {
        description: "Run a shell command.",
        execute: async () => "ok",
        inputSchema: jsonSchema({ type: "object" }),
        name: "bash",
      },
    ],
  ]);
}
