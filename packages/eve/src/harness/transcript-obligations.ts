import type { ModelMessage } from "ai";

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResponsePart = ToolMessage["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/**
 * Synthetic result recorded for a local tool call that reached a model call
 * without a terminal result. Phrased for the model: the call must be treated
 * as never executed.
 */
export const INTERRUPTED_TOOL_CALL_RESULT =
  "Tool execution did not complete: the call was interrupted before a result was recorded. Treat this call as not executed.";

/** One tool call the reconciler closed with a synthetic result. */
export interface RepairedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * Enforces the transcript-closure invariant on an assembled model request:
 * every non-provider-executed `tool-call` must have a terminal `tool-result`
 * before the transcript reaches a provider, or the provider rejects the
 * replay (Anthropic: `tool_use` ids without `tool_result` blocks; OpenAI
 * Responses: `No tool output found for function call`).
 *
 * Dangling calls are closed durably with a synthetic error result placed in
 * the message immediately after the assistant message that carries the call
 * (merged into an existing tool message, or inserted as a new one), so the
 * repair satisfies provider adjacency rules. This also heals sessions whose
 * durable history was already poisoned by a missed closure.
 *
 * There are no exemptions: the harness closes every parked local call at
 * resume (see `approved-tool-execution.ts`), so anything still dangling here
 * is an orphan nothing else will close.
 */
export function reconcileToolTranscript(messages: readonly ModelMessage[]): {
  readonly messages: ModelMessage[];
  readonly repaired: readonly RepairedToolCall[];
} {
  const closedCallIds = collectClosedCallIds(messages);

  const repaired: RepairedToolCall[] = [];
  const result: ModelMessage[] = [];
  let pendingClosures: ToolResultPart[] = [];

  const flushPendingClosures = (next: ModelMessage | undefined): ModelMessage | undefined => {
    if (pendingClosures.length === 0) {
      return next;
    }
    const closures = pendingClosures;
    pendingClosures = [];
    if (next !== undefined && next.role === "tool" && Array.isArray(next.content)) {
      return { ...next, content: [...closures, ...next.content] };
    }
    result.push({ content: closures, role: "tool" });
    return next;
  };

  for (const message of messages) {
    const merged = flushPendingClosures(message);
    if (merged !== undefined) {
      result.push(merged);
    }

    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) {
        continue;
      }
      if (closedCallIds.has(part.toolCallId)) {
        continue;
      }

      closedCallIds.add(part.toolCallId);
      repaired.push({ toolCallId: part.toolCallId, toolName: part.toolName });
      pendingClosures.push({
        output: { type: "error-text", value: INTERRUPTED_TOOL_CALL_RESULT },
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      });
    }
  }

  flushPendingClosures(undefined);

  return { messages: result, repaired };
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
