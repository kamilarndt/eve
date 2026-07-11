import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import {
  MAX_EXPERIMENTAL_WORKFLOW_PROGRAM_BYTES,
  assertExperimentalWorkflowDefinitionSourceId,
  parseExperimentalWorkflowReference,
  parseExperimentalWorkflowSnapshot,
} from "#runtime/experimental-workflow-boundary.js";
import type { ResolvedExperimentalWorkflowDefinition } from "#runtime/types.js";

describe("assertExperimentalWorkflowDefinitionSourceId", () => {
  it("accepts the same configured definition across deployments", () => {
    expect(() =>
      assertExperimentalWorkflowDefinitionSourceId({
        actualSourceId: "module:agent/tools/workflow.ts",
        expectedSourceId: "module:agent/tools/workflow.ts",
      }),
    ).not.toThrow();
  });

  it("rejects a replacement definition before it can reinterpret the saved reference", () => {
    expect(() =>
      assertExperimentalWorkflowDefinitionSourceId({
        actualSourceId: "module:agent/tools/replacement.ts",
        expectedSourceId: "module:agent/tools/workflow.ts",
      }),
    ).toThrow(
      'definition changed from "module:agent/tools/workflow.ts" to "module:agent/tools/replacement.ts"',
    );
  });
});

describe("parseExperimentalWorkflowReference", () => {
  it("returns the JSON value produced by the reference schema transform", async () => {
    const definition = definitionWithValidation((value) => ({
      value: { generation: 7, workflowId: String(value) },
    }));

    await expect(parseExperimentalWorkflowReference(definition, 42)).resolves.toEqual({
      generation: 7,
      workflowId: "42",
    });
  });

  it("reports Standard Schema validation issues", async () => {
    const definition = definitionWithValidation(() => ({
      issues: [{ message: "Expected a workflow id", path: ["workflowId"] }],
    }));

    await expect(parseExperimentalWorkflowReference(definition, {})).rejects.toThrow(
      "workflowId: Expected a workflow id",
    );
  });

  it("rejects a JSON Schema converter that cannot validate runtime input", async () => {
    const definition = definitionWithValidation(undefined);

    await expect(parseExperimentalWorkflowReference(definition, "wf_123")).rejects.toThrow(
      "must implement Standard Schema validation",
    );
  });

  it.each([
    ["Date", new Date("2026-01-01T00:00:00.000Z")],
    ["Map", new Map([["workflowId", "wf_123"]])],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a transformed %s because it cannot cross a workflow boundary", async (_, output) => {
    const definition = definitionWithValidation(() => ({ value: output }));

    await expect(parseExperimentalWorkflowReference(definition, "wf_123")).rejects.toThrow(
      "JSON-serializable",
    );
  });
});

describe("parseExperimentalWorkflowSnapshot", () => {
  it.each([
    {
      cadence: { kind: "after-completion", delaySeconds: 10 },
      dueAt: "2026-01-01T00:00:00.000Z",
      input: { prompt: "check status" },
      iteration: 0,
      program: { js: "return input.prompt" },
    },
    {
      cadence: {
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalSeconds: 8 * 60 * 60,
        kind: "fixed-rate",
        missed: "skip",
      },
      dueAt: "2026-01-01T08:00:00.000Z",
      input: ["east", "west"],
      iteration: 4,
      program: { js: "return input.length" },
      state: { cursor: "page_2" },
    },
    {
      cadence: {
        kind: "daily-times",
        missed: "skip",
        times: ["16:00", "20:00"],
        timeZone: "America/New_York",
      },
      dueAt: "2026-03-08T20:00:00.000Z",
      input: null,
      iteration: 9,
      program: { js: "return state" },
      state: false,
    },
  ])("accepts and preserves a valid snapshot", (snapshot) => {
    expect(parseExperimentalWorkflowSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    ["snapshot", null],
    ["cadence", snapshotWith({ cadence: { kind: "after-completion", delaySeconds: -1 } })],
    ["dueAt", snapshotWith({ dueAt: "tomorrow" })],
    ["dueAt", snapshotWith({ dueAt: "2026-02-30T12:00:00.000Z" })],
    ["input", snapshotWith({ input: new Date("2026-01-01T00:00:00.000Z") })],
    ["iteration", snapshotWith({ iteration: -1 })],
    ["iteration", snapshotWith({ iteration: 1.5 })],
    ["program", snapshotWith({ program: {} })],
    ["program.js", snapshotWith({ program: { js: 42 } })],
    ["program.js", snapshotWith({ program: { js: "   " } })],
    [
      "program.js",
      snapshotWith({ program: { js: "x".repeat(MAX_EXPERIMENTAL_WORKFLOW_PROGRAM_BYTES + 1) } }),
    ],
    ["state", snapshotWith({ state: new Map([["cursor", "page_2"]]) })],
  ])("rejects an invalid %s", (field, snapshot) => {
    expect(() => parseExperimentalWorkflowSnapshot(snapshot)).toThrow(field);
  });

  it("rejects unknown snapshot fields instead of silently persisting schema drift", () => {
    expect(() => parseExperimentalWorkflowSnapshot(snapshotWith({ ownerId: "user_123" }))).toThrow(
      'Unknown key "ownerId"',
    );
  });
});

function definitionWithValidation(
  validate: ((value: unknown) => unknown) | undefined,
): ResolvedExperimentalWorkflowDefinition {
  const referenceSchema = z.json();
  // Boundary coverage deliberately forges the validator of an otherwise real
  // JSON schema so runtime-invalid outputs can exercise the defensive parser.
  Object.defineProperty(referenceSchema["~standard"], "validate", {
    configurable: true,
    enumerable: true,
    value: validate,
    writable: true,
  });

  return {
    advance: async () => null,
    load: async () => null,
    logicalPath: "tools/workflow.ts",
    referenceSchema,
    sourceId: "module:tools/workflow.ts",
    sourceKind: "module",
  };
}

function snapshotWith(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    cadence: { kind: "after-completion", delaySeconds: 10 },
    dueAt: "2026-01-01T00:00:00.000Z",
    input: { prompt: "check status" },
    iteration: 0,
    program: { js: "return input.prompt" },
    ...overrides,
  };
}
