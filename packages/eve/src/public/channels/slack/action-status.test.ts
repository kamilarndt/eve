import { describe, expect, it } from "vitest";

import {
  describeActionRequest,
  describeActionRequests,
} from "#public/channels/slack/action-status.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { JsonObject } from "#shared/json.js";

type ToolCallAction = Extract<RuntimeActionRequest, { kind: "tool-call" }>;

function toolCall(
  toolName: string,
  input: JsonObject = {},
  displayArgument?: string,
): ToolCallAction {
  const action: ToolCallAction = {
    callId: "c1",
    input,
    kind: "tool-call",
    toolName,
  };
  if (displayArgument !== undefined) action.displayArgument = displayArgument;
  return action;
}

describe("describeActionRequest", () => {
  it("capitalizes action names and appends only the precomputed display argument", () => {
    expect(describeActionRequest(toolCall("grep", {}, "useEveAgent"))).toBe("Grep useEveAgent");
    expect(describeActionRequest(toolCall("read_file", {}, "agent/agent.ts"))).toBe(
      "Read file agent/agent.ts",
    );
    expect(describeActionRequest(toolCall("bash", {}, "pnpm test"))).toBe("Bash pnpm test");
  });

  it("clips a long precomputed argument to Slack's final status limit", () => {
    const clipped = describeActionRequest(toolCall("bash", {}, "x".repeat(120)));
    expect(clipped.length).toBeLessThanOrEqual(50);
    expect(clipped.endsWith("...")).toBe(true);
  });

  it("does not infer display text from raw tool input", () => {
    expect(
      describeActionRequest(
        toolCall("web_fetch", { url: "https://alice:secret@example.com/data" }),
      ),
    ).toBe("Web fetch");
    expect(describeActionRequest(toolCall("close_issue", { issueNumber: 42 }))).toBe("Close issue");
  });

  it("capitalizes dispatched targets and skill loads", () => {
    expect(
      describeActionRequest({
        callId: "c1",
        description: "Reason about the issue",
        input: {},
        kind: "subagent-call",
        name: "reasoner",
        nodeId: "n1",
        subagentName: "reasoner",
      }),
    ).toBe("Reasoner");
    expect(
      describeActionRequest({
        callId: "c1",
        description: "Triage remotely",
        input: {},
        kind: "remote-agent-call",
        name: "triage",
        nodeId: "n1",
        remoteAgentName: "triage",
      }),
    ).toBe("Triage");
    expect(
      describeActionRequest({ callId: "c1", input: { skill: "arena" }, kind: "load-skill" }),
    ).toBe("Load skill arena");
  });
});

describe("describeActionRequests", () => {
  it("groups the most frequent action name and counts the mixed remainder", () => {
    expect(
      describeActionRequests([
        toolCall("grep", {}, "digest"),
        ...Array.from({ length: 5 }, () => toolCall("bash", {}, "sh -c script/foo.sh")),
        toolCall("read_file", {}, "agent/agent.ts"),
      ]),
    ).toBe("5 Bash sh -c script/foo.sh +2 more");
  });

  it("reserves room for the mixed-action suffix when the main label is long", () => {
    const status = describeActionRequests([
      ...Array.from({ length: 3 }, () => toolCall("read_file", {}, "a".repeat(80))),
      toolCall("grep", {}, "digest"),
      toolCall("glob", {}, "**/*.ts"),
    ]);

    expect(status.length).toBeLessThanOrEqual(50);
    expect(status.startsWith("3 Read file ")).toBe(true);
    expect(status.endsWith("+2 more")).toBe(true);
  });

  it("returns a generic label for an empty batch", () => {
    expect(describeActionRequests([])).toBe("Working...");
  });
});
