import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import {
  startExperimentalWorkflow,
  stopExperimentalWorkflow,
} from "#execution/experimental-workflow-controller.js";
import { defineTool, ExperimentalWorkflow } from "#public/definitions/tool.js";

vi.mock("#execution/experimental-workflow-controller.js", () => ({
  startExperimentalWorkflow: vi.fn(),
  stopExperimentalWorkflow: vi.fn(),
}));

describe("configured ExperimentalWorkflow controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startExperimentalWorkflow).mockResolvedValue({ runId: "run_1" });
    vi.mocked(stopExperimentalWorkflow).mockResolvedValue({
      runId: "run_1",
      stopped: true,
    });
  });

  it("starts and stops through the active tool abort signal", async () => {
    const workflow = ExperimentalWorkflow({
      referenceSchema: z.object({ generation: z.string(), loopId: z.string() }),
      async load() {
        return null;
      },
      async advance() {
        return null;
      },
    });
    const signal = new AbortController().signal;
    const context = { abortSignal: signal };
    const reference = { generation: "generation_1", loopId: "loop_1" };

    await expect(workflow.start(reference, context)).resolves.toEqual({ runId: "run_1" });
    await expect(
      workflow.stop({ reason: "edited", reference, runId: "run_1" }, context),
    ).resolves.toEqual({ runId: "run_1", stopped: true });

    expect(startExperimentalWorkflow).toHaveBeenCalledWith(reference, signal);
    expect(stopExperimentalWorkflow).toHaveBeenCalledWith(
      { reason: "edited", reference, runId: "run_1" },
      signal,
    );
  });

  it("accepts the context inferred for an authored defineTool executor", () => {
    const workflow = ExperimentalWorkflow({
      referenceSchema: z.object({ loopId: z.string() }),
      async load() {
        return null;
      },
      async advance() {
        return null;
      },
    });

    const tool = defineTool({
      description: "Starts one configured workflow reference.",
      inputSchema: z.object({ loopId: z.string() }),
      execute(input, context) {
        return workflow.start(input, context);
      },
    });

    expect(typeof tool.execute).toBe("function");
  });

  it("rejects reference schemas whose transformed output is not durable JSON", () => {
    const defineInvalidWorkflow = (): void => {
      ExperimentalWorkflow({
        // @ts-expect-error a transformed Date cannot cross the durable reference boundary.
        referenceSchema: z.string().transform(() => new Date()),
        async load() {
          return null;
        },
        async advance() {
          return null;
        },
      });
    };
    expect(defineInvalidWorkflow).toBeTypeOf("function");
  });
});
