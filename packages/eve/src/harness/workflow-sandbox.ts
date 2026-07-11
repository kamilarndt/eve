import { jsonSchema, type ToolSet } from "ai";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import { workflowToolDescription } from "#harness/workflow-tool-description.js";
import {
  createWorkflowSandboxTool,
  readWorkflowSandboxResolution,
  requestWorkflowSandboxInterrupt,
  type WorkflowSandboxContinuationSecurity,
  type WorkflowSandboxLifecycle,
  WORKFLOW_TOOL_NAME,
} from "#shared/workflow-sandbox.js";

interface WorkflowToolSet {
  readonly hostTools: ToolSet;
  readonly modelTools: ToolSet;
}

const WORKFLOW_RUNTIME_ACTION_ERROR_RESOLUTION_KIND =
  "eve.workflow-runtime-action-error-resolution";

interface WorkflowRuntimeActionErrorResolution {
  readonly kind: typeof WORKFLOW_RUNTIME_ACTION_ERROR_RESOLUTION_KIND;
  readonly message: string;
  readonly output: unknown;
}

/** Marks a child failure so replay rejects the saved agent call instead of returning it. */
export function createWorkflowRuntimeActionErrorResolution(
  output: unknown,
): WorkflowRuntimeActionErrorResolution {
  const serialized = typeof output === "string" ? output : JSON.stringify(output);
  return {
    kind: WORKFLOW_RUNTIME_ACTION_ERROR_RESOLUTION_KIND,
    message: serialized ?? String(output),
    output,
  };
}

/**
 * Adds the dynamic `Workflow` tool while leaving every ordinary model tool
 * untouched. Only subagent and remote-agent runtime actions enter the sandbox.
 */
export async function applyWorkflowTool(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly lifecycle?: WorkflowSandboxLifecycle;
  readonly maxSubagents?: number;
  readonly tools: ToolSet;
}): Promise<WorkflowToolSet> {
  const hostTools = createWorkflowHostTools(input.harnessTools, Object.keys(input.tools));

  if (Object.keys(hostTools).length === 0) {
    return { hostTools, modelTools: input.tools };
  }

  const workflowTool = await createWorkflowSandboxTool({
    continuationSecurity: input.continuationSecurity,
    hostTools,
    lifecycle: input.lifecycle,
  });
  const generated = typeof workflowTool.description === "string" ? workflowTool.description : "";
  const framing = workflowToolDescription(Object.keys(hostTools), {
    maxSubagents: input.maxSubagents,
  });
  const apiReference = workflowApiReference(generated);
  const modelTools: Record<string, ToolSet[string]> = { ...input.tools };
  modelTools[WORKFLOW_TOOL_NAME] = {
    ...workflowTool,
    description: apiReference.length > 0 ? `${framing}\n\n${apiReference}` : framing,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        js: {
          type: "string",
          description:
            "Complete JavaScript orchestration program. Call only the agents listed in the Workflow description and return one JSON-serializable result.",
        },
      },
      required: ["js"],
      additionalProperties: false,
    }),
  } as ToolSet[string];

  return {
    hostTools,
    modelTools: modelTools as ToolSet,
  };
}

function workflowApiReference(generatedDescription: string): string {
  const marker = "Tools:\n";
  const start = generatedDescription.indexOf(marker);
  if (start < 0) return generatedDescription;
  return `Available agent API:\n${generatedDescription.slice(start + marker.length)}`;
}

/** Rebuilds the subagent-only host surface used to resume a parked workflow. */
export function buildWorkflowHostTools(input: { readonly tools: HarnessToolMap }): ToolSet {
  return createWorkflowHostTools(input.tools, input.tools.keys(), false);
}

/** Host surface for saved programs, where failed child results reject the agent call. */
export function buildDetachedWorkflowHostTools(input: { readonly tools: HarnessToolMap }): ToolSet {
  return createWorkflowHostTools(input.tools, input.tools.keys(), true);
}

function createWorkflowHostTools(
  tools: HarnessToolMap,
  names: Iterable<string>,
  throwErrorResolutions = false,
): ToolSet {
  const hostTools: Record<string, ToolSet[string]> = {};

  for (const name of names) {
    const tool = tools.get(name);
    if (tool?.runtimeAction !== undefined) {
      if (throwErrorResolutions && tool.runtimeAction.kind === "remote-agent-call") {
        continue;
      }
      hostTools[name] = createWorkflowRuntimeActionHostTool(tool, throwErrorResolutions);
    }
  }

  return hostTools as ToolSet;
}

function createWorkflowRuntimeActionHostTool(
  harnessTool: HarnessToolDefinition,
  throwErrorResolutions: boolean,
): ToolSet[string] {
  return {
    description: harnessTool.description,
    inputSchema: harnessTool.inputSchema,
    execute: async (toolInput: unknown, options: unknown) => {
      const resolution = readWorkflowSandboxResolution(options);
      if (throwErrorResolutions && isWorkflowRuntimeActionErrorResolution(resolution)) {
        throw new Error(resolution.message, { cause: resolution.output });
      }
      if (resolution !== undefined) return resolution;

      return requestWorkflowSandboxInterrupt({
        kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
        runtimeAction: harnessTool.runtimeAction,
        toolInput,
        toolName: harnessTool.name,
      });
    },
  } as ToolSet[string];
}

function isWorkflowRuntimeActionErrorResolution(
  value: unknown,
): value is WorkflowRuntimeActionErrorResolution {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === WORKFLOW_RUNTIME_ACTION_ERROR_RESOLUTION_KIND &&
    typeof Reflect.get(value, "message") === "string"
  );
}
