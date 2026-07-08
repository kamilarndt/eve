import type { ModelMessage } from "ai";

import { createLogger, logError } from "#internal/logging.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import type { AlsContext } from "#context/container.js";
import { createActionResultEvent } from "#protocol/message.js";
import type {
  RuntimeToolCallActionRequest,
  RuntimeToolResultActionResult,
} from "#runtime/actions/types.js";
import { toError } from "#shared/errors.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { type AuthorizationSignal, isAuthorizationSignal } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ApprovedActionBatch } from "#harness/input-requests.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { resolveExecutedToolModelOutput, wrapToolExecute } from "#harness/tools.js";
import type { HarnessEmitFn, HarnessToolMap } from "#harness/types.js";

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResponsePart = ToolMessage["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

const log = createLogger("harness.approved-tool-execution");

/** One approved tool call the harness executed (or failed) at resume time. */
export interface ExecutedApprovedToolCall {
  /** `action.result` projection, attributed to the parked batch's turn. */
  readonly actionResult: RuntimeToolResultActionResult;
  /** Durable transcript closure for the call's `tool_use` id. */
  readonly part: ToolResultPart;
}

/** Outcome of executing one resolved approval batch's approved calls. */
export interface ApprovedToolExecutionOutcome {
  readonly executed: readonly ExecutedApprovedToolCall[];
}

/**
 * Closes one resolved approval batch: executes the approved calls, appends
 * their durable results to the transcript, and emits `action.result` events
 * against the originating turn's stream coordinates. Returns the closed
 * transcript plus the first {@link AuthorizationSignal} an executed tool
 * raised, so the caller can park exactly like in-stream execution.
 *
 * Dynamic tools take precedence over authored tools of the same name,
 * mirroring the toolset override order used for model calls.
 */
export async function closeApprovedActionBatch(input: {
  readonly abortSignal?: AbortSignal;
  readonly batch: ApprovedActionBatch;
  readonly ctx: AlsContext | undefined;
  readonly emit?: HarnessEmitFn;
  readonly messages: readonly ModelMessage[];
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly authorizationSignal?: AuthorizationSignal;
  readonly messages: ModelMessage[];
}> {
  const { batch, ctx } = input;

  const { executed } = await executeApprovedToolCalls({
    abortSignal: input.abortSignal,
    calls: batch.calls,
    messages: input.messages,
    resolveTool: (toolName) => {
      const dynamicDefinition =
        ctx === undefined
          ? undefined
          : buildDynamicTools(ctx).find((definition) => definition.name === toolName);
      return dynamicDefinition ?? input.tools.get(toolName);
    },
  });

  if (executed.length === 0) {
    return { messages: [...input.messages] };
  }

  const messages = appendExecutedToolResults(
    input.messages,
    executed.map((outcome) => outcome.part),
  );

  if (input.emit !== undefined && batch.event !== undefined) {
    for (const outcome of executed) {
      await input.emit(
        createActionResultEvent({
          result: outcome.actionResult,
          sequence: batch.event.sequence,
          stepIndex: batch.event.stepIndex,
          turnId: batch.event.turnId,
        }),
      );
    }
  }

  return {
    authorizationSignal: findStashedAuthorizationSignal(ctx, executed),
    messages,
  };
}

/**
 * Reads back the first authorization signal stashed by `wrapToolExecute`
 * during resume-time execution.
 */
function findStashedAuthorizationSignal(
  ctx: AlsContext | undefined,
  executed: readonly ExecutedApprovedToolCall[],
): AuthorizationSignal | undefined {
  if (ctx === undefined) {
    return undefined;
  }
  for (const outcome of executed) {
    const stashed = readToolInterrupt(ctx, outcome.actionResult.callId);
    if (stashed !== undefined && isAuthorizationSignal(stashed)) {
      return stashed;
    }
  }
  return undefined;
}

/**
 * Executes approved tool calls at resume time, in batch order, so the parked
 * `tool_use` obligations are closed by the harness itself — durably and
 * before any model request is assembled — instead of being delegated to the
 * AI SDK's last-message approval scan and stream capture.
 *
 * Every approved call yields exactly one terminal closure — no exceptions:
 * the tool's real output, an `error-text` result when `execute` throws, an
 * `error-text` result when the approved tool no longer resolves, and an
 * `error-text` result when the tool has no local `execute` (nothing else in
 * the pipeline reliably closes an execute-less call, and an unclosed call is
 * a guaranteed provider rejection). A tool that signals an authorization
 * park keeps its existing `wrapToolExecute` semantics: the redacted pending
 * output closes the call and the full signal is stashed for the caller's
 * park detector.
 */
export async function executeApprovedToolCalls(input: {
  readonly abortSignal?: AbortSignal;
  readonly calls: readonly RuntimeToolCallActionRequest[];
  readonly messages: readonly ModelMessage[];
  readonly resolveTool: (toolName: string) => HarnessToolDefinition | undefined;
}): Promise<ApprovedToolExecutionOutcome> {
  const executed: ExecutedApprovedToolCall[] = [];

  for (const call of input.calls) {
    const definition = input.resolveTool(call.toolName);

    if (definition === undefined) {
      executed.push(
        buildErrorOutcome(call, new Error(`Tool "${call.toolName}" is no longer available.`)),
      );
      continue;
    }

    const execute = wrapToolExecute(definition);
    if (execute === undefined) {
      executed.push(
        buildErrorOutcome(
          call,
          new Error(`Tool "${call.toolName}" has no local execution and cannot run.`),
        ),
      );
      continue;
    }

    try {
      const output = await execute(call.input, {
        abortSignal: input.abortSignal,
        messages: [...input.messages],
        toolCallId: call.callId,
      });

      executed.push({
        actionResult: createRuntimeToolResultFromValue({
          callId: call.callId,
          output,
          toolName: call.toolName,
        }),
        part: {
          output: await resolveExecutedToolModelOutput({
            definition,
            output,
            toolCallId: call.callId,
          }),
          toolCallId: call.callId,
          toolName: call.toolName,
          type: "tool-result",
        },
      });
    } catch (error) {
      logError(log, "approved tool execution failed", error, {
        toolCallId: call.callId,
        toolName: call.toolName,
      });
      executed.push(buildErrorOutcome(call, toError(error)));
    }
  }

  return { executed };
}

function buildErrorOutcome(
  call: RuntimeToolCallActionRequest,
  error: Error,
): ExecutedApprovedToolCall {
  return {
    actionResult: createRuntimeToolResultFromValue({
      callId: call.callId,
      isError: true,
      output: error,
      toolName: call.toolName,
    }),
    part: {
      output: { type: "error-text", value: error.message },
      toolCallId: call.callId,
      toolName: call.toolName,
      type: "tool-result",
    },
  };
}

/**
 * Merges resume-time closures into the trailing tool message (the one
 * carrying the approval responses) so every `tool_use` and its result stay
 * within adjacent messages, as providers require. Appends a new tool message
 * when the transcript does not end in one.
 */
export function appendExecutedToolResults(
  messages: readonly ModelMessage[],
  parts: readonly ToolResultPart[],
): ModelMessage[] {
  if (parts.length === 0) {
    return [...messages];
  }

  const last = messages.at(-1);
  if (last !== undefined && last.role === "tool" && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { ...last, content: [...last.content, ...parts] }];
  }

  return [...messages, { content: [...parts], role: "tool" }];
}
