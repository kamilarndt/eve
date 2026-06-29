import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

const DEPTH_PROBER_MARKER = "DEPTH_PROBER_LIMIT_OBSERVED";

export default defineAgent({
  description:
    "Deterministic depth-limit probe. It attempts one nested self-subagent call, then reports the tool result it received.",
  model: mockModel(handleDepthProbeRequest),
  modelContextWindowTokens: 1_000_000,
});

function handleDepthProbeRequest(request: MockModelRequest) {
  const result = request.toolResults.find((entry) => entry.name === "agent");

  if (result !== undefined) {
    return `${DEPTH_PROBER_MARKER}: ${JSON.stringify(result.output)}`;
  }

  return {
    toolCalls: [
      {
        id: "depth-prober-self-call",
        input: { message: "this nested self-delegation should hit maxDepth" },
        name: "agent",
      },
    ],
  };
}
