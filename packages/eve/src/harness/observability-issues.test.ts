import { describe, expect, it } from "vitest";

import {
  accumulateObservabilityIssues,
  getObservabilityIssueState,
  observabilityIssueAttributes,
  setObservabilityIssueState,
} from "#harness/observability-issues.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { HarnessSession } from "#harness/types.js";

describe("accumulateObservabilityIssues", () => {
  it("records one issue for a failed model step", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "step.failed",
        data: {
          code: "MODEL_CALL_FAILED",
          message: "Model call failed",
          sequence: 2,
          stepIndex: 1,
          turnId: "turn_1",
        },
      }),
      previous: undefined,
    });

    expect(state).toMatchObject({
      errorCount: 1,
      failedStepCount: 1,
      issueCount: 1,
      lastIssueAt: "2026-07-07T12:00:00.000Z",
      lastIssueCode: "MODEL_CALL_FAILED",
      lastIssueType: "step_failed",
      seenIssueInTurn: true,
      turnId: "turn_1",
    });
    expect(state.session).toMatchObject({
      errorCount: 1,
      failedStepCount: 1,
      issueCount: 1,
      lastIssueCode: "MODEL_CALL_FAILED",
      lastIssueType: "step_failed",
    });
  });

  it("records failed action results with the failing tool name", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "ETIMEDOUT", message: "Timed out" },
          result: {
            callId: "call_linear",
            isError: true,
            kind: "tool-result",
            output: "Timed out",
            toolName: "linear.createIssue",
          },
          sequence: 4,
          status: "failed",
          stepIndex: 1,
          turnId: "turn_1",
        },
      }),
      previous: undefined,
    });

    expect(state).toMatchObject({
      errorCount: 1,
      failedActionCount: 1,
      issueCount: 1,
      lastIssueCode: "ETIMEDOUT",
      lastIssueTool: "linear.createIssue",
      lastIssueType: "action_failed",
    });
  });

  it("does not double-count the standard step -> turn -> session failure cascade", () => {
    const afterStep = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "step.failed",
        data: {
          code: "OUTPUT_SCHEMA_NOT_FULFILLED",
          message: "No structured output",
          sequence: 7,
          stepIndex: 0,
          turnId: "turn_2",
        },
      }),
      previous: undefined,
    });
    const afterTurn = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "turn.failed",
        data: {
          code: "OUTPUT_SCHEMA_NOT_FULFILLED",
          message: "No structured output",
          sequence: 8,
          stepIndex: 0,
          turnId: "turn_2",
        },
      }),
      previous: afterStep,
    });
    const afterSession = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "session.failed",
        data: {
          code: "OUTPUT_SCHEMA_NOT_FULFILLED",
          message: "No structured output",
          sessionId: "wrun_session",
        },
      }),
      previous: afterTurn,
    });

    expect(afterSession).toMatchObject({
      errorCount: 1,
      failedStepCount: 1,
      failedTurnCount: 1,
      issueCount: 1,
      lastIssueCode: "OUTPUT_SCHEMA_NOT_FULFILLED",
      lastIssueType: "step_failed",
    });
    expect(afterSession.session).toMatchObject({
      errorCount: 1,
      failedStepCount: 1,
      failedTurnCount: 1,
      issueCount: 1,
    });
  });

  it("projects the current run issue state into sparse eve attributes", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "E_DENIED", message: "Denied" },
          result: {
            callId: "call_child",
            isError: true,
            kind: "subagent-result",
            output: null,
            subagentName: "researcher",
          },
          sequence: 2,
          status: "rejected",
          stepIndex: 0,
          turnId: "turn_3",
        },
      }),
      previous: undefined,
    });

    expect(observabilityIssueAttributes(state)).toEqual({
      "$eve.error_count": 0,
      "$eve.failed_action_count": 0,
      "$eve.failed_step_count": 0,
      "$eve.failed_turn_count": 0,
      "$eve.issue_count": 1,
      "$eve.last_issue_at": "2026-07-07T12:00:00.000Z",
      "$eve.last_issue_code": "E_DENIED",
      "$eve.last_issue_tool": "researcher",
      "$eve.last_issue_type": "action_rejected",
      "$eve.rejected_action_count": 1,
    });
  });

  it("stores issue state on the serializable harness session state map", () => {
    const session = { sessionId: "wrun_session" } as HarnessSession;
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "step.failed",
        data: {
          code: "MODEL_CALL_FAILED",
          message: "Model call failed",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_4",
        },
      }),
      previous: undefined,
    });

    const nextSession = setObservabilityIssueState(session, state);

    expect(getObservabilityIssueState(nextSession.state)).toEqual(state);
    expect(session.state).toBeUndefined();
  });
});

function eventWithTime<T extends HandleMessageStreamEvent>(event: T): T {
  return {
    ...event,
    meta: { at: "2026-07-07T12:00:00.000Z" },
  };
}
