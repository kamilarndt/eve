import { describe, expect, it } from "vitest";

import { StepEventMetadataCursor } from "#execution/session-event-metadata.js";
import { createTurnStartedEvent } from "#protocol/message.js";

describe("StepEventMetadataCursor", () => {
  it("reuses event IDs when Workflow replays the same step", () => {
    const first = cursor("step_7");
    const replay = cursor("step_7");
    const event = createTurnStartedEvent({ sequence: 2, turnId: "turn_2" });

    expect(first.stamp(event).meta.eventId).toBe(replay.stamp(event).meta.eventId);
  });

  it("gives distinct Workflow steps distinct event IDs", () => {
    const first = cursor("step_7");
    const second = cursor("step_8");
    const event = createTurnStartedEvent({ sequence: 2, turnId: "turn_2" });

    expect(first.stamp(event).meta.eventId).not.toBe(second.stamp(event).meta.eventId);
  });

  it("namespaces the same step ID by Workflow run", () => {
    const first = cursor("step_7");
    const second = new StepEventMetadataCursor({
      stepId: "step_7",
      workflowRunId: "run_2",
    });
    const event = createTurnStartedEvent({ sequence: 2, turnId: "turn_2" });

    expect(first.stamp(event).meta.eventId).not.toBe(second.stamp(event).meta.eventId);
  });

  it("gives every event in one step a unique ordinal", () => {
    const metadata = cursor("step_7");
    const event = createTurnStartedEvent({ sequence: 2, turnId: "turn_2" });

    expect(metadata.stamp(event).meta.eventId).not.toBe(metadata.stamp(event).meta.eventId);
  });
});

function cursor(stepId: string): StepEventMetadataCursor {
  return new StepEventMetadataCursor({
    stepId,
    workflowRunId: "run_1",
  });
}
