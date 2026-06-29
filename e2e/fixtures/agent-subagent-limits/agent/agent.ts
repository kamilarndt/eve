import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

const DEPTH_PROMPT_MARKER = "depth guardrail e2e";
const FANOUT_PROMPT_MARKER = "fanout guardrail e2e";
const DEPTH_RESULT_MARKER = "SUBAGENT_DEPTH_LIMIT_E2E_OK";
const FANOUT_RESULT_MARKER = "SUBAGENT_FANOUT_LIMIT_E2E_OK";

export default defineAgent({
  limits: {
    subagents: {
      maxCallsPerStep: 1,
      maxDepth: 1,
    },
  },
  model: mockModel(handleRootRequest),
  modelContextWindowTokens: 1_000_000,
});

function handleRootRequest(request: MockModelRequest) {
  const prompt = request.lastUserMessage ?? "";

  if (prompt.includes(DEPTH_PROMPT_MARKER)) {
    const result = request.toolResults.find((entry) => entry.name === "depth-prober");
    if (result !== undefined) {
      return `${DEPTH_RESULT_MARKER}: ${JSON.stringify(result.output)}`;
    }

    return {
      toolCalls: [
        {
          id: "depth-prober-call",
          input: { message: "try one nested self-delegation" },
          name: "depth-prober",
        },
      ],
    };
  }

  if (prompt.includes(FANOUT_PROMPT_MARKER)) {
    const results = request.toolResults.filter((entry) => entry.name === "echo-marker");
    if (results.length > 0) {
      return `${FANOUT_RESULT_MARKER}: ${JSON.stringify(results.map((entry) => entry.output))}`;
    }

    return {
      toolCalls: [
        {
          id: "fanout-accepted-call",
          input: { message: "accepted fanout child" },
          name: "echo-marker",
        },
        {
          id: "fanout-rejected-call",
          input: { message: "rejected fanout child" },
          name: "echo-marker",
        },
      ],
    };
  }

  return "Unknown subagent limit eval prompt.";
}
