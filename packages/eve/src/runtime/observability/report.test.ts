import { beforeEach, describe, expect, it, vi } from "vitest";

const reportMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  experimental_reportObservabilityEvent: (...args: unknown[]) => reportMock(...args),
}));

const { reportEveObservabilityEvent } = await import("./report.js");

describe("reportEveObservabilityEvent", () => {
  beforeEach(() => {
    reportMock.mockReset();
    reportMock.mockResolvedValue(undefined);
  });

  it("skips non-issue stream events", async () => {
    await reportEveObservabilityEvent({
      type: "message.appended",
      data: {
        messageDelta: "hello",
        messageSoFar: "hello",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
    });

    expect(reportMock).not.toHaveBeenCalled();
  });

  it("reports failed action results", async () => {
    const event = {
      type: "action.result" as const,
      data: {
        error: {
          code: "ETIMEDOUT",
          message: "Linear API timed out after 10s",
        },
        result: {
          callId: "call_1",
          isError: true,
          kind: "tool-result" as const,
          name: "linear.createIssue",
          output: { code: "ETIMEDOUT" },
          toolName: "linear.createIssue",
        },
        sequence: 2,
        status: "failed" as const,
        stepIndex: 0,
        turnId: "turn_1",
      },
      meta: { at: "2026-07-09T00:00:00.000Z" },
    };

    await reportEveObservabilityEvent(event);

    expect(reportMock).toHaveBeenCalledWith({
      type: "action.result",
      data: {
        error: { code: "ETIMEDOUT" },
        result: {
          callId: "call_1",
          kind: "tool-result",
          name: "linear.createIssue",
          output: { code: "ETIMEDOUT" },
          toolName: "linear.createIssue",
        },
        sequence: 2,
        status: "failed",
        stepIndex: 0,
        turnId: "turn_1",
      },
      meta: { at: "2026-07-09T00:00:00.000Z" },
    });
  });

  it("reports child subagent issue events", async () => {
    const event = {
      type: "subagent.event" as const,
      data: {
        callId: "call_1",
        subagentName: "deployment-reviewer",
        event: {
          type: "turn.failed" as const,
          data: {
            code: "REMOTE_SUBAGENT_FAILED",
            details: { prompt: "private child prompt" },
            message: "Subagent failed",
            sequence: 3,
            turnId: "turn_child",
          },
        },
      },
    };

    await reportEveObservabilityEvent(event);

    expect(reportMock).toHaveBeenCalledWith({
      type: "subagent.event",
      data: {
        callId: "call_1",
        subagentName: "deployment-reviewer",
        event: {
          type: "turn.failed",
          data: {
            code: "REMOTE_SUBAGENT_FAILED",
            sequence: 3,
            turnId: "turn_child",
          },
        },
      },
    });
  });
});
