import { describe, expect, it } from "vitest";

import { experimentalWorkflowAdvanceRetryFixtureWorkflow } from "#internal/testing/experimental-workflow-advance.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { start } from "#internal/workflow/runtime.js";

describe("experimentalWorkflowEntry integration", () => {
  it("retries a committed advance with identical compare-and-set input", async () => {
    const runtime = createTestRuntime({
      agent: { name: "experimental-workflow-advance-retry" },
    });

    await runtime.run(async () => {
      const run = await start(experimentalWorkflowAdvanceRetryFixtureWorkflow, [
        {
          cadence: {
            delaySeconds: 10,
            kind: "after-completion",
          },
        },
      ]);

      const result = await run.returnValue;

      expect(result.attempt).toBe(2);
      expect(result.retried).toEqual(result.committed);
      expect(result.committed.nextDueAt).toBe(
        new Date(Date.parse(result.committed.completedAt) + 10_000).toISOString(),
      );
    });
  });
});
