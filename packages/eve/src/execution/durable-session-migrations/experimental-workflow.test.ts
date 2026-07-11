import { describe, expect, it } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";

import {
  createExperimentalWorkflowEntryInput,
  createExperimentalWorkflowIterationInput,
  EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION,
  EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION,
  migrateExperimentalWorkflowEntryInput,
  migrateExperimentalWorkflowIterationInput,
} from "./experimental-workflow.js";

describe("experimental workflow durable inputs", () => {
  it("creates and reads the current entry wire", () => {
    const input = createExperimentalWorkflowEntryInput({
      controlToken: "control",
      definitionSourceId: "source:workflow",
      readyToken: "ready",
      reference: { id: "loop" },
      serializedContext: { captured: true },
      sessionState: sessionState(),
    });

    expect(input.version).toBe(EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION);
    expect(migrateExperimentalWorkflowEntryInput(input)).toBe(input);
  });

  it("creates and reads the minimal current iteration wire", () => {
    const controller = createExperimentalWorkflowEntryInput({
      controlToken: "control",
      definitionSourceId: "source:workflow",
      readyToken: "ready",
      reference: { id: "loop" },
      serializedContext: { captured: true },
      sessionState: sessionState(),
    });
    const input = createExperimentalWorkflowIterationInput({
      controller,
      expectedDueAt: "2026-07-10T20:00:00.000Z",
      expectedIteration: 4,
    });

    expect(input).toMatchObject({
      expectedDueAt: "2026-07-10T20:00:00.000Z",
      expectedIteration: 4,
      ownershipToken: "control:iteration:4:owner",
      version: EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION,
    });
    expect(input).not.toHaveProperty("snapshot");
    expect(migrateExperimentalWorkflowIterationInput(input)).toBe(input);
  });

  it.each([
    ["entry", migrateExperimentalWorkflowEntryInput],
    ["iteration", migrateExperimentalWorkflowIterationInput],
  ] as const)("rejects missing, malformed, and newer %s versions", (_label, migrate) => {
    expect(() => migrate({})).toThrow(/no numeric "version"/u);
    expect(() => migrate({ version: "1" })).toThrow(/no numeric "version"/u);
    expect(() => migrate({ version: 999 })).toThrow(/newer than the supported version/u);
  });
});

function sessionState(): DurableSessionState {
  return {
    continuationToken: "workflow:session",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "session",
    version: 1,
  };
}
