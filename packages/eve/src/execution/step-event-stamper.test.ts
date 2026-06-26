import { describe, expect, it } from "vitest";

import { createStepEventStamper } from "#execution/step-event-stamper.js";
import { createActionsRequestedEvent, createStepStartedEvent } from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";

function actionEvent(callId: string, input: JsonObject) {
  return createActionsRequestedEvent({
    actions: [{ callId, input, kind: "tool-call", toolName: "lookup" }],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  });
}

describe("createStepEventStamper", () => {
  it("recreates event IDs across retries without depending on emission order", () => {
    const firstAttempt = createStepEventStamper("step_1");
    const replay = createStepEventStamper("step_1");
    const firstCall = actionEvent("call_1", { city: "New York", units: "celsius" });
    const secondCall = actionEvent("call_2", { city: "London", units: "celsius" });

    const firstCallId = firstAttempt(firstCall).meta.id;
    const secondCallId = firstAttempt(secondCall).meta.id;

    expect(replay(secondCall).meta.id).toBe(secondCallId);
    expect(replay(firstCall).meta.id).toBe(firstCallId);
    expect(firstCallId).toMatch(/^evt_[A-Za-z0-9_-]{43}$/);
  });

  it("distinguishes repeated identical events and recreates each occurrence on replay", () => {
    const event = createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn_0" });
    const firstAttempt = createStepEventStamper("step_1");
    const replay = createStepEventStamper("step_1");

    const firstIds = [firstAttempt(event).meta.id, firstAttempt(event).meta.id];
    const replayIds = [replay(event).meta.id, replay(event).meta.id];

    expect(new Set(firstIds).size).toBe(2);
    expect(replayIds).toEqual(firstIds);
  });

  it("uses canonical object keys and changes identity when event content changes", () => {
    const firstAttempt = createStepEventStamper("step_1");
    const replay = createStepEventStamper("step_1");
    const changedReplay = createStepEventStamper("step_1");

    const firstId = firstAttempt(actionEvent("call_1", { city: "New York", units: "celsius" })).meta
      .id;
    const reorderedId = replay(actionEvent("call_1", { units: "celsius", city: "New York" })).meta
      .id;
    const changedId = changedReplay(actionEvent("call_1", { city: "London", units: "celsius" }))
      .meta.id;

    expect(reorderedId).toBe(firstId);
    expect(changedId).not.toBe(firstId);
  });
});
