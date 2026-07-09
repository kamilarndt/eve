import { describe, expect, it } from "vitest";

import {
  accumulateObservabilityIssues,
  getObservabilityIssueState,
  observabilityIssueAttributes,
  preserveObservabilityIssueState,
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

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    expect(state).toMatchObject({
      issue: {
        at: "2026-07-07T12:00:00.000Z",
        code: "MODEL_CALL_FAILED",
        source: "workflow",
        turnId: "turn_1",
        type: "step_failed",
      },
      seenIssueInTurn: true,
      turnId: "turn_1",
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

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    expect(state).toMatchObject({
      issue: {
        code: "ETIMEDOUT",
        source: "tool",
        tool: "linear.createIssue",
        toolCallId: "call_linear",
        turnId: "turn_1",
        type: "action_failed",
      },
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

    expect(afterSession).toBeDefined();
    if (!afterSession) throw new Error("expected issue state");
    expect(afterSession).toMatchObject({
      issue: {
        code: "OUTPUT_SCHEMA_NOT_FULFILLED",
        source: "workflow",
        turnId: "turn_2",
        type: "step_failed",
      },
      seenIssueInTurn: true,
    });
  });

  it("projects the current issue occurrence into a versioned eve attribute", () => {
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

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    expect(observabilityIssueAttributes(state)).toEqual({
      "$eve.issue":
        '{"at":"2026-07-07T12:00:00.000Z","c":"E_DENIED","call":"call_child","s":"subagent","t":"action_rejected","tool":"researcher","turn":"turn_3","v":1}',
    });
  });

  it("preserves the issue code before shrinking optional deep-link fields", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "REMOTE_SUBAGENT_FAILED", message: "Remote failed" },
          result: {
            callId: "call_" + "x".repeat(2048),
            isError: true,
            kind: "subagent-result",
            output: { code: "REMOTE_SUBAGENT_FAILED" },
            subagentKind: "remote",
            subagentName: "reviewer-" + "y".repeat(2048),
          },
          sequence: 3,
          status: "failed",
          stepIndex: 0,
          turnId: "turn_" + "z".repeat(2048),
        },
      }),
      previous: undefined,
    });

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    const value = observabilityIssueAttributes(state)["$eve.issue"];
    expect(typeof value).toBe("string");
    const parsed = JSON.parse(String(value)) as { c?: string };
    expect(parsed.c).toBe("REMOTE_SUBAGENT_FAILED");
  });

  it("records failed remote subagent results separately from local subagents", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "REMOTE_AGENT_FAILED", message: "Remote failed" },
          result: {
            callId: "call_remote",
            isError: true,
            kind: "subagent-result",
            output: { code: "REMOTE_AGENT_FAILED", message: "Remote failed" },
            subagentKind: "remote",
            subagentName: "reviewer",
          },
          sequence: 3,
          status: "failed",
          stepIndex: 0,
          turnId: "turn_remote",
        },
      }),
      previous: undefined,
    });

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    expect(state).toMatchObject({
      issue: {
        code: "REMOTE_AGENT_FAILED",
        source: "remote_subagent",
        tool: "reviewer",
        toolCallId: "call_remote",
        turnId: "turn_remote",
        type: "action_failed",
      },
    });
  });

  it("keeps the action issue when a later step failure wraps the same turn", () => {
    const afterAction = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "REMOTE_AGENT_FAILED", message: "Remote failed" },
          result: {
            callId: "call_remote",
            isError: true,
            kind: "subagent-result",
            output: { code: "REMOTE_AGENT_FAILED", message: "Remote failed" },
            subagentKind: "remote",
            subagentName: "reviewer",
          },
          sequence: 3,
          status: "failed",
          stepIndex: 0,
          turnId: "turn_remote",
        },
      }),
      previous: undefined,
    });

    const afterStep = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "step.failed",
        data: {
          code: "STEP_FAILED",
          message: "Step failed after action error",
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_remote",
        },
      }),
      previous: afterAction,
    });

    expect(afterStep).toMatchObject({
      issue: {
        code: "REMOTE_AGENT_FAILED",
        source: "remote_subagent",
        tool: "reviewer",
        toolCallId: "call_remote",
        turnId: "turn_remote",
        type: "action_failed",
      },
    });
  });

  it("keeps oversized issue payloads as valid bounded JSON", () => {
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "E_" + "X".repeat(2048), message: "Too long" },
          result: {
            callId: "call_" + "x".repeat(2048),
            isError: true,
            kind: "tool-result",
            output: "Too long",
            toolName: "tool_" + "y".repeat(2048),
          },
          sequence: 3,
          status: "failed",
          stepIndex: 0,
          turnId: "turn_" + "z".repeat(2048),
        },
      }),
      previous: undefined,
    });

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    const value = observabilityIssueAttributes(state)["$eve.issue"];
    expect(typeof value).toBe("string");
    expect(new TextEncoder().encode(String(value)).length).toBeLessThanOrEqual(256);
    const parsed = JSON.parse(String(value)) as { c?: string; s?: string; t?: string; v?: number };
    expect(parsed.c?.startsWith("E_")).toBe(true);
    expect(parsed.s).toBe("tool");
    expect(parsed.t).toBe("action_failed");
    expect(parsed.v).toBe(1);
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

    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    const nextSession = setObservabilityIssueState(session, state);

    expect(getObservabilityIssueState(nextSession.state)).toEqual(state);
    expect(session.state).toBeUndefined();
  });

  it("preserves issue state when a later session snapshot replaces harness state", () => {
    const base = { sessionId: "wrun_session" } as HarnessSession;
    const state = accumulateObservabilityIssues({
      event: eventWithTime({
        type: "action.result",
        data: {
          error: { code: "ACTION_RESULT_REJECTED", message: "Tool execution was denied." },
          result: {
            callId: "call_bash",
            isError: true,
            kind: "tool-result",
            output: "Tool execution was denied.",
            toolName: "bash",
          },
          sequence: 1,
          status: "rejected",
          stepIndex: 0,
          turnId: "turn_5",
        },
      }),
      previous: undefined,
    });
    expect(state).toBeDefined();
    if (!state) throw new Error("expected issue state");
    const source = setObservabilityIssueState(base, state);
    const priorSnapshot = {
      ...base,
      state: { "eve.harness.other": { value: true } },
    } as HarnessSession;

    const preserved = preserveObservabilityIssueState(source, priorSnapshot);

    expect(preserved.state?.["eve.harness.other"]).toEqual({ value: true });
    expect(getObservabilityIssueState(preserved.state)).toEqual(state);
  });
});

function eventWithTime<T extends HandleMessageStreamEvent>(event: T): T {
  return {
    ...event,
    meta: { at: "2026-07-07T12:00:00.000Z" },
  };
}
