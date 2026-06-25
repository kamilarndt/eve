import { defineEval } from "eve/evals";

import {
  authoredFanoutExecutionsOverlap,
  FANOUT_SIZE,
  fanoutRequestsUseExpectedLabels,
} from "./fanout.js";
import { formatToolFanoutTrace } from "./tool-fanout-timing.js";

const TOOL_NAME = "streamed-action";
const LABELS = [
  "fanout-authored-01",
  "fanout-authored-02",
  "fanout-authored-03",
  "fanout-authored-04",
  "fanout-authored-05",
  "fanout-authored-06",
  "fanout-authored-07",
  "fanout-authored-08",
  "fanout-authored-09",
  "fanout-authored-10",
] as const;

export default defineEval({
  description: "Static tools smoke: ten authored tool calls begin concurrently.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`${TOOL_NAME}\` tool exactly ${FANOUT_SIZE} separate times in one tool-use step.`,
        `Use each label exactly once: ${LABELS.map((label) => `"${label}"`).join(", ")}.`,
        "Start every call before waiting for any result. Do not use any other tool.",
        "After every call returns, reply with exactly: authored fanout complete",
      ].join("\n"),
    );
    turn.expectOk();
    t.log(formatToolFanoutTrace({ events: turn.events, toolName: TOOL_NAME }));

    t.didNotFail();
    t.completed();
    t.calledTool(TOOL_NAME, { isError: false, times: FANOUT_SIZE });
    t.noFailedActions();
    t.event(
      (events) => fanoutRequestsUseExpectedLabels({ events, labels: LABELS, toolName: TOOL_NAME }),
      "ten authored requests use their distinct labels",
    );
    t.event(
      (events) => authoredFanoutExecutionsOverlap({ events, toolName: TOOL_NAME }),
      "ten authored executions overlap",
    );
  },
});
