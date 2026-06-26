import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { HandleMessageStreamEvent, TimedHandleMessageStreamEvent } from "#protocol/message.js";
import { timestampHandleMessageStreamEvent } from "#protocol/message.js";

/** Assigns replay-stable identities to events emitted by one Workflow step. */
export class StepEventMetadataCursor {
  #nextOrdinal = 0;
  readonly #stepId: string;
  readonly #workflowRunId: string;

  constructor(input: { readonly stepId: string; readonly workflowRunId: string }) {
    this.#stepId = input.stepId;
    this.#workflowRunId = input.workflowRunId;
  }

  /** Stamps one event with its stable step-local ordinal. */
  stamp(event: HandleMessageStreamEvent): TimedHandleMessageStreamEvent {
    return timestampHandleMessageStreamEvent(event, undefined, {
      ordinal: this.#nextOrdinal++,
      stepId: this.#stepId,
      workflowRunId: this.#workflowRunId,
    });
  }
}

/** Creates an event metadata cursor for the currently executing Workflow step. */
export function createStepEventMetadataCursor(
  input: {
    readonly stepId?: string;
    readonly workflowRunId?: string;
  } = {},
): StepEventMetadataCursor {
  const identity =
    input.stepId !== undefined && input.workflowRunId !== undefined
      ? { stepId: input.stepId, workflowRunId: input.workflowRunId }
      : readCurrentStepIdentity();
  return new StepEventMetadataCursor({
    stepId: identity.stepId,
    workflowRunId: identity.workflowRunId,
  });
}

function readCurrentStepIdentity(): { readonly stepId: string; readonly workflowRunId: string } {
  try {
    return {
      stepId: getStepMetadata().stepId,
      workflowRunId: getWorkflowMetadata().workflowRunId,
    };
  } catch (error) {
    if (process.env.NODE_ENV === "test") {
      return { stepId: "test-step", workflowRunId: "test-run" };
    }
    throw error;
  }
}
