import { defineEval } from "eve/evals";

const DEPTH_LIMIT_CODE = "EVE_SUBAGENT_DEPTH_LIMIT_EXCEEDED";
const DEPTH_RESULT_MARKER = "SUBAGENT_DEPTH_LIMIT_E2E_OK";

export default defineEval({
  description:
    "Subagent limits e2e: a child subagent cannot start a nested subagent after maxDepth is reached.",
  tags: ["subagents", "limits", "depth"],

  async test(t) {
    await t.send("depth guardrail e2e: ask the depth-prober subagent to attempt one nested call.");

    t.succeeded();
    t.calledSubagent("depth-prober", {
      output: new RegExp(DEPTH_LIMIT_CODE),
      count: 1,
    });
    t.messageIncludes(DEPTH_RESULT_MARKER);
    t.messageIncludes(DEPTH_LIMIT_CODE);
    t.messageIncludes(/Do not retry this subagent call/);
  },
});
