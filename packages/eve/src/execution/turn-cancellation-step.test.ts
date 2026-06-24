import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { cancelTurnSegmentStep } from "#execution/turn-cancellation-step.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

describe("cancelTurnSegmentStep", () => {
  beforeEach(() => {
    resumeHookMock.mockReset().mockResolvedValue(undefined);
  });

  it("resumes the cooperative cancellation hook once", async () => {
    await expect(cancelTurnSegmentStep({ hookId: "turn:child" })).resolves.toBeUndefined();

    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("ignores an unavailable cooperative cancellation hook", async () => {
    resumeHookMock.mockRejectedValue(new HookNotFoundError("turn:child"));

    await expect(cancelTurnSegmentStep({ hookId: "turn:child" })).resolves.toBeUndefined();

    expect(resumeHookMock).toHaveBeenCalledOnce();
  });
});
