import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#compiled/@workflow/core/index.js";
import { cancelPendingLocalSubagentsStep } from "#execution/cancel-pending-local-subagents-step.js";
import { cancelPendingLocalSubagentsUntilSettled } from "#execution/cancel-pending-local-subagents-until-settled.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: vi.fn() }));
vi.mock("./cancel-pending-local-subagents-step.js", () => ({
  cancelPendingLocalSubagentsStep: vi.fn(),
}));

describe("cancelPendingLocalSubagentsUntilSettled", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("durably retries without releasing ownership after a bounded cancel attempt fails", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    vi.mocked(cancelPendingLocalSubagentsStep)
      .mockRejectedValueOnce(new Error("descendant still running"))
      .mockResolvedValueOnce({ cancelled: 2, settled: true });
    const input = {
      serializedContext: { captured: true },
      sessionState: {
        continuationToken: "workflow:root",
        emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
        hasProxyInputRequests: false,
        sessionId: "root",
        version: 1 as const,
      },
    };

    await expect(cancelPendingLocalSubagentsUntilSettled(input)).resolves.toEqual({
      cancelled: 2,
    });

    expect(cancelPendingLocalSubagentsStep).toHaveBeenCalledTimes(2);
    expect(cancelPendingLocalSubagentsStep).toHaveBeenNthCalledWith(1, input);
    expect(cancelPendingLocalSubagentsStep).toHaveBeenNthCalledWith(2, input);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
