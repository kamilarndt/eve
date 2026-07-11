import type { HarnessToolMap } from "#harness/types.js";
import { buildDetachedWorkflowHostTools } from "#harness/workflow-sandbox.js";
import type { JsonValue } from "#shared/json.js";
import type { ExperimentalWorkflowProgram } from "#shared/experimental-workflow-definition.js";
import {
  continueWorkflowSandboxInterrupt,
  runWorkflowSandboxProgram,
  unwrapWorkflowSandboxResult,
  type WorkflowSandboxContinuationSecurity,
  type WorkflowSandboxInterrupt,
  type WorkflowSandboxLifecycle,
} from "#shared/workflow-sandbox.js";

export interface WorkflowProgramContext {
  readonly input: JsonValue;
  readonly iteration: number;
  readonly scheduledAt: string;
  readonly state?: JsonValue;
}

export async function continueWorkflowProgram(input: {
  readonly abortSignal?: AbortSignal;
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly lifecycle?: WorkflowSandboxLifecycle;
  readonly resolution: unknown;
  readonly tools: HarnessToolMap;
}): Promise<
  | { readonly output: unknown; readonly status: "completed" }
  | { readonly interrupt: WorkflowSandboxInterrupt; readonly status: "interrupted" }
> {
  const continuation: Mutable<Parameters<typeof continueWorkflowSandboxInterrupt>[0]> = {
    continuationSecurity: input.continuationSecurity,
    interrupt: input.interrupt,
    lifecycle: input.lifecycle,
    resolution: input.resolution,
    tools: buildDetachedWorkflowHostTools({ tools: input.tools }),
  };
  if (input.abortSignal !== undefined) continuation.abortSignal = input.abortSignal;
  const result = await continueWorkflowSandboxInterrupt(continuation);
  return await unwrapWorkflowSandboxResult(result, input.continuationSecurity);
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

/** Runs one saved dynamic-workflow program against the existing agents-only host surface. */
export async function executeWorkflowProgram(input: {
  readonly abortSignal?: AbortSignal;
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly context: WorkflowProgramContext;
  readonly lifecycle?: WorkflowSandboxLifecycle;
  readonly outerToolCallId: string;
  readonly program: ExperimentalWorkflowProgram;
  readonly tools: HarnessToolMap;
}): Promise<
  | { readonly output: unknown; readonly status: "completed" }
  | { readonly interrupt: WorkflowSandboxInterrupt; readonly status: "interrupted" }
> {
  const result = await runWorkflowSandboxProgram({
    abortSignal: input.abortSignal,
    continuationSecurity: input.continuationSecurity,
    hostTools: buildDetachedWorkflowHostTools({ tools: input.tools }),
    js: bindWorkflowProgramContext(input.program.js, input.context),
    lifecycle: input.lifecycle,
    outerToolCallId: input.outerToolCallId,
  });
  return await unwrapWorkflowSandboxResult(result, input.continuationSecurity);
}

export function bindWorkflowProgramContext(js: string, context: WorkflowProgramContext): string {
  const state = context.state === undefined ? "undefined" : JSON.stringify(context.state);
  return [
    `const input = ${JSON.stringify(context.input)};`,
    `const state = ${state};`,
    `const iteration = ${JSON.stringify(context.iteration)};`,
    `const scheduledAt = ${JSON.stringify(context.scheduledAt)};`,
    js,
  ].join("\n");
}
