import {
  parseExperimentalWorkflowCadence,
  parseExperimentalWorkflowIsoInstant,
} from "#execution/experimental-workflow-cadence.js";
import type { ResolvedExperimentalWorkflowDefinition } from "#runtime/types.js";
import type { ExperimentalWorkflowSnapshot } from "#shared/experimental-workflow-definition.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/** Persisted program bound: 256 KiB of UTF-8 JavaScript per iteration. */
export const MAX_EXPERIMENTAL_WORKFLOW_PROGRAM_BYTES = 256 * 1_024;

/** Prevents an existing controller from reinterpreting its reference after a definition replacement. */
export function assertExperimentalWorkflowDefinitionSourceId(input: {
  readonly actualSourceId: string;
  readonly expectedSourceId: string;
}): void {
  if (input.actualSourceId === input.expectedSourceId) return;

  throw new Error(
    `ExperimentalWorkflow definition changed from "${input.expectedSourceId}" to "${input.actualSourceId}" while this controller was running. Start a new controller with the current definition after migrating its persisted reference.`,
  );
}

/** Applies a configured workflow's Standard Schema and proves its output can be persisted. */
export async function parseExperimentalWorkflowReference(
  definition: ResolvedExperimentalWorkflowDefinition,
  value: unknown,
): Promise<JsonValue> {
  const standard = definition.referenceSchema["~standard"];
  const validate = Reflect.get(standard, "validate");
  if (typeof validate !== "function") {
    throw new TypeError(
      "Configured ExperimentalWorkflow referenceSchema must implement Standard Schema validation.",
    );
  }

  const outcome: unknown = await Reflect.apply(validate, standard, [value]);
  if (!isRecord(outcome)) {
    throw new TypeError(
      "Configured ExperimentalWorkflow referenceSchema returned an invalid validation result.",
    );
  }

  const issues = outcome.issues;
  if (issues !== undefined) {
    throw new TypeError(`Invalid ExperimentalWorkflow reference: ${formatIssues(issues)}`);
  }
  if (!("value" in outcome)) {
    throw new TypeError(
      "Configured ExperimentalWorkflow referenceSchema returned an invalid validation result.",
    );
  }

  try {
    return parseJsonValue(outcome.value);
  } catch (error) {
    throw new TypeError(
      "Invalid ExperimentalWorkflow reference: transformed output must be JSON-serializable.",
      { cause: error },
    );
  }
}

/** Proves an app-owned load/advance result is safe to execute and persist durably. */
export function parseExperimentalWorkflowSnapshot(value: unknown): ExperimentalWorkflowSnapshot {
  const snapshot = requireRecord(value, "snapshot", [
    "cadence",
    "dueAt",
    "input",
    "iteration",
    "program",
    "state",
  ]);
  const cadence = parseExperimentalWorkflowCadence(snapshot.cadence);
  const dueAt = requireIsoInstant(snapshot.dueAt, "dueAt");
  const iteration = requireIteration(snapshot.iteration);
  const programRecord = requireRecord(snapshot.program, "program", ["js"]);
  const js = requireProgramJavaScript(programRecord.js);
  const input = requireJsonValue(snapshot.input, "input");
  const state =
    snapshot.state === undefined ? undefined : requireJsonValue(snapshot.state, "state");

  return state === undefined
    ? { cadence, dueAt, input, iteration, program: { js } }
    : { cadence, dueAt, input, iteration, program: { js }, state };
}

function formatIssues(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "referenceSchema rejected the value.";
  }

  return value
    .map((issue) => {
      if (!isRecord(issue) || typeof issue.message !== "string") {
        return "referenceSchema rejected the value";
      }
      const path = formatIssuePath(issue.path);
      return path === undefined ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatIssuePath(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  return value
    .map((segment) => {
      if (!isRecord(segment)) return String(segment);
      return "key" in segment ? String(segment.key) : String(segment);
    })
    .join(".");
}

function requireRecord(
  value: unknown,
  field: string,
  knownKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value) || !isPlainObject(value)) {
    throw invalidField(field, "must be a plain object");
  }

  const knownKeySet = new Set(knownKeys);
  for (const key of Object.keys(value)) {
    if (!knownKeySet.has(key)) {
      throw new TypeError(`Invalid ExperimentalWorkflow ${field}. Unknown key "${key}".`);
    }
  }

  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidField(field, "must be a string");
  }
  return value;
}

function requireProgramJavaScript(value: unknown): string {
  const js = requireString(value, "program.js");
  if (js.trim().length === 0) {
    throw invalidField("program.js", "must not be empty");
  }
  const bytes = new TextEncoder().encode(js).byteLength;
  if (bytes > MAX_EXPERIMENTAL_WORKFLOW_PROGRAM_BYTES) {
    throw invalidField(
      "program.js",
      `must be at most ${String(MAX_EXPERIMENTAL_WORKFLOW_PROGRAM_BYTES)} UTF-8 bytes`,
    );
  }
  return js;
}

function requireIsoInstant(value: unknown, field: string): string {
  const instant = requireString(value, field);
  parseExperimentalWorkflowIsoInstant(instant, field);
  return instant;
}

function requireIteration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidField("iteration", "must be a non-negative safe integer");
  }
  return value;
}

function requireJsonValue(value: unknown, field: string): JsonValue {
  try {
    return parseJsonValue(value);
  } catch (error) {
    throw new TypeError(`Invalid ExperimentalWorkflow ${field}: must be JSON-serializable.`, {
      cause: error,
    });
  }
}

function invalidField(field: string, expectation: string): TypeError {
  return new TypeError(`Invalid ExperimentalWorkflow ${field}: ${expectation}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
