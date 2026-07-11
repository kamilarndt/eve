import { beforeEach, describe, expect, it, vi } from "vitest";

const reportMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  experimental_reportExecutionErrorOccurrence: (...args: unknown[]) => reportMock(...args),
}));

const { reportEveExecutionErrorOccurrence } = await import("./report.js");

describe("reportEveExecutionErrorOccurrence", () => {
  beforeEach(() => {
    reportMock.mockReset();
    reportMock.mockResolvedValue(undefined);
  });

  it("skips non-error stream events", async () => {
    await reportEveExecutionErrorOccurrence({
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

    await reportEveExecutionErrorOccurrence(event);

    expect(reportMock).toHaveBeenCalledWith({
      type: "action.result",
      data: {
        error: { code: "ETIMEDOUT" },
        result: {
          callId: "call_1",
          kind: "tool-result",
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

  it("skips rejected action results", async () => {
    await reportEveExecutionErrorOccurrence({
      type: "action.result",
      data: {
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { message: "Blocked by policy" },
          toolName: "linear.createIssue",
        },
        sequence: 2,
        status: "rejected",
        stepIndex: 0,
        turnId: "turn_1",
      },
      meta: { at: "2026-07-09T00:00:00.000Z" },
    });

    expect(reportMock).not.toHaveBeenCalled();
  });

  it("reports child subagent execution error events", async () => {
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

    await reportEveExecutionErrorOccurrence(event);

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
