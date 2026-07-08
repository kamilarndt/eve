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
 * Walks the messages, finds every non-provider-executed `tool-call` without
 * a `tool-result`, and — when `resolveClosure` supplies an output for it —
 * records that closure in the message immediately after the assistant
 * message carrying the call (merged into an existing tool message, or
 * inserted as a new one), satisfying provider adjacency rules. Calls whose
 * closure resolves to `undefined` are left dangling, so legitimately open
 * obligations (parked approvals, pending runtime actions) pass through
 * untouched.
 *
 * Every transcript closure the harness synthesizes goes through here: the
 * step-time closure of invalid-input tool calls (detailed, model-actionable
 * error text) and the request-assembly guard
 * {@link reconcileToolTranscript} (generic interrupted text).
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

      const call: DanglingToolCall = { toolCallId: part.toolCallId, toolName: part.toolName };
      const output = resolveClosure(call);
      if (output === undefined) {
        continue;
      }

      closedCallIds.add(part.toolCallId);
      closed.push(call);
      pendingClosures.push({
        output,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      });
    }
  }

  flushPendingClosures(undefined);

  return { closed, messages: result };
}

/**
 * Enforces the transcript-closure invariant on an assembled model request:
 * every non-provider-executed `tool-call` must have a terminal `tool-result`
 * before the transcript reaches a provider, or the provider rejects the
 * replay (Anthropic: `tool_use` ids without `tool_result` blocks; OpenAI
 * Responses: `No tool output found for function call`).
 *
 * Dangling calls are closed durably with a synthetic error result via
 * {@link closeDanglingToolCalls}. This also heals sessions whose durable
 * history was already poisoned by a missed closure.
 *
 * There are no exemptions: the harness closes every parked local call at
 * resume (see `approved-tool-execution.ts`) and every invalid-input call at
 * step time (see `handleStepResult` in `tool-loop.ts`), so anything still
 * dangling here is an orphan nothing else will close.
 */
export function reconcileToolTranscript(messages: readonly ModelMessage[]): {
  readonly messages: ModelMessage[];
  readonly repaired: readonly DanglingToolCall[];
} {
  const { closed, messages: reconciled } = closeDanglingToolCalls(messages, () => ({
    type: "error-text",
    value: INTERRUPTED_TOOL_CALL_RESULT,
  }));

  return { messages: reconciled, repaired: closed };
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
