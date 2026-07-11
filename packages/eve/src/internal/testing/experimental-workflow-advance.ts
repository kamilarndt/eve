import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { captureExperimentalWorkflowAdvanceTimingStep } from "#execution/experimental-workflow-steps.js";
import type {
  ExperimentalWorkflowAdvance,
  ExperimentalWorkflowCadence,
} from "#shared/experimental-workflow-definition.js";
import type { JsonValue } from "#shared/json.js";

const committedByRunId = new Map<string, ExperimentalWorkflowAdvance<JsonValue>>();

/** Simulates an adapter that commits its write, then loses the step response. */
export async function commitExperimentalWorkflowAdvanceThenRetryStep(input: {
  readonly advance: ExperimentalWorkflowAdvance<JsonValue>;
  readonly runId: string;
}): Promise<{
  readonly attempt: number;
  readonly committed: ExperimentalWorkflowAdvance<JsonValue>;
  readonly retried: ExperimentalWorkflowAdvance<JsonValue>;
}> {
  "use step";

  const metadata = getStepMetadata();
  const committed = committedByRunId.get(input.runId);
  if (committed === undefined) {
    committedByRunId.set(input.runId, input.advance);
    throw new Error("experimental-workflow-advance: committed before response was lost");
  }

  committedByRunId.delete(input.runId);
  return {
    attempt: metadata.attempt,
    committed,
    retried: input.advance,
  };
}

/** Drives the production timing step through a real retrying persistence step. */
export async function experimentalWorkflowAdvanceRetryFixtureWorkflow(input: {
  readonly cadence: ExperimentalWorkflowCadence;
}): Promise<{
  readonly attempt: number;
  readonly committed: ExperimentalWorkflowAdvance<JsonValue>;
  readonly retried: ExperimentalWorkflowAdvance<JsonValue>;
}> {
  "use workflow";

  const timing = await captureExperimentalWorkflowAdvanceTimingStep({ cadence: input.cadence });
  const advance: ExperimentalWorkflowAdvance<JsonValue> = {
    ...timing,
    expectedIteration: 7,
    outcome: { kind: "completed", output: "fixture-output" },
    reference: { id: "fixture-reference" },
  };

  return await commitExperimentalWorkflowAdvanceThenRetryStep({
    advance,
    runId: String(getWorkflowMetadata().workflowRunId),
  });
}
