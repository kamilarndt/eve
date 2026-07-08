import type { ModelMessage } from "ai";

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResponsePart = ToolMessage["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;
type ToolResultOutput = ToolResultPart["output"];

/**
 * Synthetic result recorded for a local tool call that reached a model call
 * without a terminal result. Phrased for the model: the call must be treated
 * as never executed.
 */
export const INTERRUPTED_TOOL_CALL_RESULT =
  "Tool execution did not complete: the call was interrupted before a result was recorded. Treat this call as not executed.";

/** One local tool call found without a terminal `tool-result`. */
export interface DanglingToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * The one primitive that closes a local `tool-call`'s transcript obligation.
 *
 * Providers reject a replayed `tool_use` without a `tool_result` (Anthropic:
 * `tool_use` ids without `tool_result` blocks; OpenAI Responses: `No tool
 * output found for function call`), so every non-provider-executed
 * `tool-call` must be closed before the transcript reaches a provider.
 *
 * Walks the messages, finds every local `tool-call` without a `tool-result`,
 * and — when `resolveClosure` supplies an output for it — records that
 * closure in the message immediately after the assistant message carrying
 * the call (merged into an existing tool message, or inserted as a new one),
 * satisfying provider adjacency rules. Calls whose closure resolves to
 * `undefined` are left dangling, so legitimately open obligations (parked
 * approvals, pending runtime actions) pass through untouched.
 *
 * Every transcript closure the harness synthesizes goes through here: the
 * step-time closure of invalid-input tool calls (detailed, model-actionable
 * error text) and the request-assembly guard in the tool loop, which closes
 * any remaining orphan with {@link INTERRUPTED_TOOL_CALL_RESULT} — durably,
 * so histories poisoned by a missed closure heal instead of replaying the
 * same provider rejection forever.
 */
export function closeDanglingToolCalls(
  messages: readonly ModelMessage[],
  resolveClosure: (call: DanglingToolCall) => ToolResultOutput | undefined,
): {
  readonly closed: readonly DanglingToolCall[];
  readonly messages: ModelMessage[];
} {
  const closedCallIds = collectClosedCallIds(messages);
  const closed: DanglingToolCall[] = [];
  const result: ModelMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as ModelMessage;
    result.push(message);

    const closures = collectClosures(message, closedCallIds, resolveClosure, closed);
    if (closures.length === 0) {
      continue;
    }

    // Providers require a call's result in the message immediately after the
    // assistant message that carries the call.
    const next = messages[index + 1];
    if (next !== undefined && next.role === "tool" && Array.isArray(next.content)) {
      result.push({ ...next, content: [...closures, ...next.content] });
      index += 1;
    } else {
      result.push({ content: closures, role: "tool" });
    }
  }

  return { closed, messages: result };
}

function collectClosures(
  message: ModelMessage,
  closedCallIds: Set<string>,
  resolveClosure: (call: DanglingToolCall) => ToolResultOutput | undefined,
  closed: DanglingToolCall[],
): ToolResultPart[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  const closures: ToolResultPart[] = [];
  for (const part of message.content) {
    if (part.type !== "tool-call" || part.providerExecuted === true) {
      continue;
    }
    if (closedCallIds.has(part.toolCallId)) {
      continue;
    }

    const call: DanglingToolCall = { toolCallId: part.toolCallId, toolName: part.toolName };
    const output = resolveClosure(call);
    if (output === undefined) {
      continue;
    }

    closedCallIds.add(part.toolCallId);
    closed.push(call);
    closures.push({
      output,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      type: "tool-result",
    });
  }

  return closures;
}

function collectClosedCallIds(messages: readonly ModelMessage[]): Set<string> {
  const callIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result") {
        callIds.add(part.toolCallId);
      }
    }
  }

  return callIds;
}
