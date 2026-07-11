/**
 * Durable wire inputs for the stable ExperimentalWorkflow entrypoints.
 *
 * Controller runs can outlive a deployment, and each controller dispatches
 * its iteration to the latest deployment. Both boundaries therefore require
 * an explicit version even before the first shape change. Future changes add
 * one-step migrations to the corresponding chain below.
 */
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { JsonValue } from "#shared/json.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";

export const EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION = 1;
export const EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION = 1;

export interface ExperimentalWorkflowEntryInput {
  readonly controlToken: string;
  readonly definitionSourceId: string;
  readonly readyToken: string;
  readonly reference: JsonValue;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly version: typeof EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION;
}

export interface ExperimentalWorkflowIterationInput {
  readonly controller: ExperimentalWorkflowEntryInput;
  readonly expectedDueAt: string;
  readonly expectedIteration: number;
  readonly ownershipToken: string;
  readonly version: typeof EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION;
}

export type ExperimentalWorkflowEntryDispatchInput = Omit<
  ExperimentalWorkflowEntryInput,
  "version"
>;

export type ExperimentalWorkflowIterationDispatchInput = Omit<
  ExperimentalWorkflowIterationInput,
  "ownershipToken" | "version"
>;

const entryInputMigrations: readonly VersionMigration[] = [];
const iterationInputMigrations: readonly VersionMigration[] = [];

export function getExperimentalWorkflowReadyToken(
  controlToken: string,
  cursor: { readonly dueAt: string; readonly iteration: number } | null,
): string {
  return cursor === null
    ? `${controlToken}:ready:missing`
    : `${controlToken}:ready:${String(cursor.iteration)}:${cursor.dueAt}`;
}

export function getExperimentalWorkflowIterationOwnershipToken(
  controlToken: string,
  iteration: number,
): string {
  return `${controlToken}:iteration:${String(iteration)}:owner`;
}

export function createExperimentalWorkflowEntryInput(
  input: ExperimentalWorkflowEntryDispatchInput,
): ExperimentalWorkflowEntryInput {
  return { ...input, version: EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION };
}

export function createExperimentalWorkflowIterationInput(
  input: ExperimentalWorkflowIterationDispatchInput,
): ExperimentalWorkflowIterationInput {
  return {
    ...input,
    ownershipToken: getExperimentalWorkflowIterationOwnershipToken(
      input.controller.controlToken,
      input.expectedIteration,
    ),
    version: EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION,
  };
}

export function migrateExperimentalWorkflowEntryInput(
  value: unknown,
): ExperimentalWorkflowEntryInput {
  return runMigrationChain<ExperimentalWorkflowEntryInput>({
    label: "experimental workflow entry input",
    migrations: entryInputMigrations,
    targetVersion: EXPERIMENTAL_WORKFLOW_ENTRY_INPUT_VERSION,
    value,
  });
}

export function migrateExperimentalWorkflowIterationInput(
  value: unknown,
): ExperimentalWorkflowIterationInput {
  return runMigrationChain<ExperimentalWorkflowIterationInput>({
    label: "experimental workflow iteration input",
    migrations: iterationInputMigrations,
    targetVersion: EXPERIMENTAL_WORKFLOW_ITERATION_INPUT_VERSION,
    value,
  });
}
