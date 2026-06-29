import { describe, expect, it } from "vitest";

import {
  applySubagentLimits,
  DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  resolveEffectiveSubagentLimits,
  setSubagentLimitState,
} from "#harness/subagent-limits.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "sess-test",
    state,
  };
}

function createSubagentAction(index: number): RuntimeSubagentCallActionRequest {
  return {
    callId: `call-${index}`,
    description: "Launch another copy.",
    input: { message: `work item ${index}` },
    kind: "subagent-call",
    name: "agent",
    nodeId: "__root__",
    subagentName: "agent",
  };
}

describe("resolveEffectiveSubagentLimits", () => {
  it("uses eve defaults when no limits are authored or inherited", () => {
    expect(resolveEffectiveSubagentLimits({})).toEqual({
      maxCallsPerStep: DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP,
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    });
  });

  it("allows root agents to raise default limits explicitly", () => {
    expect(
      resolveEffectiveSubagentLimits({
        authored: {
          maxCallsPerStep: 8,
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxCallsPerStep: 8,
      maxDepth: 6,
    });
  });

  it("inherits parent limits when a child does not author overrides", () => {
    expect(
      resolveEffectiveSubagentLimits({
        inherited: {
          maxCallsPerStep: 8,
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxCallsPerStep: 8,
      maxDepth: 6,
    });
  });

  it("lets child agents tighten inherited limits but not loosen them", () => {
    expect(
      resolveEffectiveSubagentLimits({
        authored: {
          maxCallsPerStep: 5,
          maxDepth: 10,
        },
        inherited: {
          maxCallsPerStep: 8,
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxCallsPerStep: 5,
      maxDepth: 6,
    });
  });
});

describe("applySubagentLimits", () => {
  it("uses configured per-step fan-out limits from session state", () => {
    const session = setSubagentLimitState({
      depth: undefined,
      limits: {
        maxCallsPerStep: 2,
        maxDepth: 4,
      },
      session: createSession(),
    });

    const result = applySubagentLimits({
      actions: [createSubagentAction(1), createSubagentAction(2), createSubagentAction(3)],
      session,
    });

    expect(result.actions.map((action) => action.callId)).toEqual(["call-1", "call-2"]);
    expect(result.rejectedResults).toEqual([
      {
        callId: "call-3",
        isError: true,
        kind: "subagent-result",
        output: {
          code: "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED",
          message:
            "This step requested 3 subagent calls, but eve allows 2. The first 2 were started. Retry the remaining work in a later step with at most 2 subagent calls.",
        },
        subagentName: "agent",
      },
    ]);
  });
});
