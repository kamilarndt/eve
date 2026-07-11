import type { CompiledExperimentalWorkflowDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { normalizeJsonSchemaDefinition } from "#internal/json-schema.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ExperimentalWorkflowReferenceSchema } from "#shared/experimental-workflow-definition.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedExperimentalWorkflowDefinition } from "#runtime/types.js";

/** Reattaches the configured workflow's live persistence callbacks. */
export async function resolveExperimentalWorkflowDefinition(
  definition: CompiledExperimentalWorkflowDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedExperimentalWorkflowDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "configured ExperimentalWorkflow",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(resolvedExportValue, describe(definition));
    if (resolvedRecord.kind !== "eve:enable-workflow-tool") {
      throw new Error(describe(definition));
    }
    const referenceSchema = expectStandardJsonSchema(
      resolvedRecord.referenceSchema,
      describe(definition),
    );
    normalizeJsonSchemaDefinition(referenceSchema);

    return {
      advance: expectFunction<ResolvedExperimentalWorkflowDefinition["advance"]>(
        resolvedRecord.advance,
        describe(definition),
      ),
      exportName: definition.exportName,
      load: expectFunction<ResolvedExperimentalWorkflowDefinition["load"]>(
        resolvedRecord.load,
        describe(definition),
      ),
      logicalPath: definition.logicalPath,
      referenceSchema,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve configured ExperimentalWorkflow from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function expectStandardJsonSchema(
  value: unknown,
  message: string,
): ExperimentalWorkflowReferenceSchema {
  if (!isStandardJsonSchema(value)) throw new Error(message);
  return value;
}

function isStandardJsonSchema(value: unknown): value is ExperimentalWorkflowReferenceSchema {
  if (typeof value !== "object" || value === null || !("~standard" in value)) return false;
  const standard = Reflect.get(value, "~standard");
  if (typeof standard !== "object" || standard === null) return false;
  const jsonSchema = Reflect.get(standard, "jsonSchema");
  return (
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "vendor") === "string" &&
    typeof Reflect.get(standard, "validate") === "function" &&
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    typeof Reflect.get(jsonSchema, "input") === "function" &&
    typeof Reflect.get(jsonSchema, "output") === "function"
  );
}

function describe(definition: CompiledExperimentalWorkflowDefinition): string {
  return `Expected the configured ExperimentalWorkflow export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" to provide referenceSchema, load(), and advance().`;
}
