import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";

import type { JsonValue } from "#shared/json.js";

/** JavaScript evaluated once per attempt of a dynamic workflow iteration. */
export interface ExperimentalWorkflowProgram {
  readonly js: string;
}

/** Minimum tool context needed to control a configured dynamic workflow. */
export interface ExperimentalWorkflowControlContext {
  readonly abortSignal: AbortSignal;
}

/** Identity of the durable controller that owns one workflow reference. */
export interface ExperimentalWorkflowStartResult {
  readonly runId: string;
}

/** Cooperative stop request for the controller that owns one workflow reference. */
export interface ExperimentalWorkflowStopInput<TReference = unknown> {
  readonly reason?: string;
  readonly reference: TReference;
  readonly runId?: string;
}

/** Result of looking up and cooperatively stopping a workflow controller. */
export interface ExperimentalWorkflowStopResult {
  readonly runId?: string;
  readonly stopped: boolean;
}

/** Wait relative to the terminal time of the preceding iteration. */
export interface ExperimentalWorkflowAfterCompletionCadence {
  readonly kind: "after-completion";
  readonly delaySeconds: number;
}

/** Run on an anchored interval, skipping slots elapsed during prior work. */
export interface ExperimentalWorkflowFixedRateCadence {
  readonly kind: "fixed-rate";
  readonly anchorAt: string;
  readonly intervalSeconds: number;
  readonly missed: "skip";
}

/** Run at local wall-clock times, skipping occurrences elapsed during prior work. */
export interface ExperimentalWorkflowDailyTimesCadence {
  readonly kind: "daily-times";
  readonly timeZone: string;
  readonly times: readonly string[];
  readonly missed: "skip";
}

/** Cadence variants understood by the experimental dynamic workflow runner. */
export type ExperimentalWorkflowCadence =
  | ExperimentalWorkflowAfterCompletionCadence
  | ExperimentalWorkflowDailyTimesCadence
  | ExperimentalWorkflowFixedRateCadence;

/** App-owned execution record returned to the framework for one current generation. */
export interface ExperimentalWorkflowSnapshot<
  TInput extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> {
  readonly cadence: ExperimentalWorkflowCadence;
  readonly dueAt: string;
  readonly input: TInput;
  readonly iteration: number;
  readonly program: ExperimentalWorkflowProgram;
  readonly state?: TState;
}

/** Terminal result the app persists before a successor iteration may start. */
export type ExperimentalWorkflowAdvanceOutcome =
  | {
      readonly kind: "completed";
      readonly output?: JsonValue;
    }
  | {
      readonly kind: "failed";
      readonly error: string;
    };

/** Compare-and-set input passed to the app-owned persistence adapter. */
export interface ExperimentalWorkflowAdvance<TReference extends JsonValue = JsonValue> {
  readonly completedAt: string;
  readonly expectedIteration: number;
  readonly nextDueAt: string;
  readonly outcome: ExperimentalWorkflowAdvanceOutcome;
  readonly reference: TReference;
}

/** Schema contract needed for both runtime validation and manifest generation. */
export type ExperimentalWorkflowReferenceSchema = StandardJSONSchemaV1<unknown, JsonValue> &
  StandardSchemaV1<unknown, JsonValue>;

/**
 * App-owned persistence adapter for a dynamic workflow definition.
 *
 * Ownership checks stay in the app's model-facing tools. Background workflow
 * execution receives only the opaque reference those tools authorized.
 */
export interface ExperimentalWorkflowConfig<
  TReferenceSchema extends ExperimentalWorkflowReferenceSchema,
  TInput extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> {
  readonly referenceSchema: TReferenceSchema;
  /**
   * Reads the current snapshot without mutating application state. `start()`
   * may call this synchronously to bind readiness before the controller loads
   * it again, and durable step retries may repeat either read. Implementations
   * must therefore be replay-safe.
   */
  load(
    reference: StandardJSONSchemaV1.InferOutput<TReferenceSchema>,
  ): Promise<ExperimentalWorkflowSnapshot<TInput, TState> | null>;
  /**
   * Atomically persists one transition. Workflow step replay may deliver the
   * exact same input again after the first call committed but its response was
   * lost. That replay must return the same successor snapshot (or the same
   * terminal `null`), not treat the already-applied CAS as a new mismatch.
   */
  advance(
    input: ExperimentalWorkflowAdvance<StandardJSONSchemaV1.InferOutput<TReferenceSchema>>,
  ): Promise<ExperimentalWorkflowSnapshot<TInput, TState> | null>;
}

/** Configured sentinel retained as a live authored module at runtime. */
export interface ExperimentalWorkflowDefinition<
  TReferenceSchema extends ExperimentalWorkflowReferenceSchema,
  TInput extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> extends ExperimentalWorkflowConfig<TReferenceSchema, TInput, TState> {
  readonly kind: "eve:enable-workflow-tool";
  /** Starts this reference, or adopts the controller that already owns it. */
  start(
    reference: StandardJSONSchemaV1.InferInput<TReferenceSchema>,
    context: ExperimentalWorkflowControlContext,
  ): Promise<ExperimentalWorkflowStartResult>;
  /** Stops the current controller and waits until it has settled. */
  stop(
    input: ExperimentalWorkflowStopInput<StandardJSONSchemaV1.InferInput<TReferenceSchema>>,
    context: ExperimentalWorkflowControlContext,
  ): Promise<ExperimentalWorkflowStopResult>;
}
