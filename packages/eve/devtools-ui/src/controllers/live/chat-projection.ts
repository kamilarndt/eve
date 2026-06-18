import type { LiveRunEvent } from "@ui/controllers/live/live-types";
import type { ChatMessage, ChatMessagePart } from "@ui/model/devtools-model";

interface MutableChatMessage {
  id: string;
  parts: ChatMessagePart[];
  role: ChatMessage["role"];
  sessionId: string;
  status: ChatMessage["status"];
}

export function projectChatMessages(events: readonly LiveRunEvent[]): readonly ChatMessage[] {
  const messages: MutableChatMessage[] = [];
  const assistantByTurn = new Map<string, MutableChatMessage>();
  const toolsByCall = new Map<
    string,
    { readonly message: MutableChatMessage; readonly partIndex: number }
  >();

  const ensureAssistant = (sessionId: string, turnId: string): MutableChatMessage => {
    const existing = assistantByTurn.get(turnId);
    if (existing !== undefined) return existing;
    const message: MutableChatMessage = {
      id: `${turnId}:assistant`,
      parts: [],
      role: "assistant",
      sessionId,
      status: "streaming",
    };
    messages.push(message);
    assistantByTurn.set(turnId, message);
    return message;
  };

  for (const envelope of events) {
    const { event } = envelope;
    const data = isRecord(event.data) ? event.data : {};
    const turnId = stringValue(data.turnId) ?? `cursor-${envelope.cursor}`;
    const eventId = `event-${envelope.cursor}`;
    const stepIndex = numberValue(data.stepIndex);

    switch (event.type) {
      case "message.received":
        messages.push({
          id: `${turnId}:user`,
          parts: [
            {
              eventId,
              state: "done",
              text: stringValue(data.message) ?? "",
              type: "text",
            },
          ],
          role: "user",
          sessionId: envelope.sessionId,
          status: "complete",
        });
        break;
      case "reasoning.appended":
      case "reasoning.completed": {
        const message = ensureAssistant(envelope.sessionId, turnId);
        upsertChatPart(message, {
          eventId,
          state: event.type === "reasoning.completed" ? "done" : "streaming",
          stepIndex,
          text:
            stringValue(
              event.type === "reasoning.completed" ? data.reasoning : data.reasoningSoFar,
            ) ?? "",
          type: "reasoning",
        });
        break;
      }
      case "message.appended":
      case "message.completed": {
        const message = ensureAssistant(envelope.sessionId, turnId);
        const completedText = event.type === "message.completed" ? data.message : undefined;
        if (completedText === null) {
          completeLastTextPart(message, eventId);
        } else {
          upsertChatPart(message, {
            eventId,
            state: event.type === "message.completed" ? "done" : "streaming",
            stepIndex,
            text:
              stringValue(event.type === "message.completed" ? completedText : data.messageSoFar) ??
              "",
            type: "text",
          });
        }
        if (event.type === "message.completed") {
          message.status = data.finishReason === "tool-calls" ? "streaming" : "complete";
        }
        break;
      }
      case "actions.requested": {
        const message = ensureAssistant(envelope.sessionId, turnId);
        for (const action of recordArray(data.actions)) {
          addChatTool(message, toolsByCall, action, eventId, "running");
        }
        break;
      }
      case "input.requested": {
        const message = ensureAssistant(envelope.sessionId, turnId);
        for (const request of recordArray(data.requests)) {
          const action = isRecord(request.action) ? request.action : {};
          addChatTool(message, toolsByCall, action, eventId, "approval");
        }
        break;
      }
      case "action.result": {
        const result = isRecord(data.result) ? data.result : {};
        const callId = stringValue(result.callId);
        if (callId === undefined) break;
        const existing = toolsByCall.get(callId);
        const descriptor = describeChatAction(result);
        const currentPart =
          existing === undefined ? undefined : existing.message.parts[existing.partIndex];
        const state =
          data.status === "failed" ? "failed" : data.status === "rejected" ? "denied" : "completed";
        const part: ChatMessagePart = {
          callId,
          error: stringValue(isRecord(data.error) ? data.error.message : undefined),
          eventId,
          input: currentPart?.type === "tool" ? currentPart.input : undefined,
          kind: descriptor.kind,
          name: descriptor.name,
          output: result.output,
          state,
          type: "tool",
        };
        if (existing === undefined) {
          const message = ensureAssistant(envelope.sessionId, turnId);
          const partIndex = message.parts.push(part) - 1;
          toolsByCall.set(callId, { message, partIndex });
          message.status = "streaming";
        } else {
          existing.message.parts[existing.partIndex] = part;
          existing.message.status = "streaming";
        }
        break;
      }
      case "subagent.called": {
        const callId = stringValue(data.callId);
        if (callId === undefined || toolsByCall.has(callId)) break;
        const message = ensureAssistant(envelope.sessionId, turnId);
        addChatTool(message, toolsByCall, data, eventId, "running");
        break;
      }
      case "subagent.completed": {
        const callId = stringValue(data.callId);
        const existing = callId === undefined ? undefined : toolsByCall.get(callId);
        if (callId === undefined || existing === undefined) break;
        const current = existing.message.parts[existing.partIndex];
        if (current?.type !== "tool") break;
        existing.message.parts[existing.partIndex] = {
          ...current,
          eventId,
          output: data.output,
          state: "completed",
        };
        break;
      }
      case "turn.completed": {
        const message = assistantByTurn.get(turnId);
        if (message !== undefined) message.status = "complete";
        break;
      }
      case "session.failed":
      case "step.failed":
      case "turn.failed":
        messages.push({
          id: `${eventId}:failure`,
          parts: [
            {
              eventId,
              state: "done",
              text: stringValue(data.message) ?? "The run failed.",
              type: "text",
            },
          ],
          role: "system",
          sessionId: envelope.sessionId,
          status: "failed",
        });
        break;
    }
  }

  return messages;
}

export function mergeChatMessages(
  current: readonly ChatMessage[],
  sessionId: string,
  incoming: readonly ChatMessage[],
): readonly ChatMessage[] {
  const optimistic = current.filter(
    (message) => message.sessionId === sessionId && message.optimistic === true,
  );
  return [
    ...current.filter((message) => message.sessionId !== sessionId),
    ...incoming,
    ...optimistic,
  ];
}

function upsertChatPart(message: MutableChatMessage, next: ChatMessagePart): void {
  const index = message.parts.findIndex((part) => chatPartKey(part) === chatPartKey(next));
  if (index === -1) {
    message.parts.push(next);
  } else {
    message.parts[index] = next;
  }
  message.status = next.type === "text" && next.state === "done" ? "complete" : "streaming";
}

function completeLastTextPart(message: MutableChatMessage, eventId: string): void {
  const index = message.parts.findLastIndex((part) => part.type === "text");
  const part = message.parts[index];
  if (part?.type !== "text") return;
  message.parts[index] = { ...part, eventId, state: "done" };
  message.status = "complete";
}

function chatPartKey(part: ChatMessagePart): string {
  return part.type === "tool" ? `tool:${part.callId}` : `${part.type}:${part.stepIndex ?? 0}`;
}

function addChatTool(
  message: MutableChatMessage,
  toolsByCall: Map<string, { readonly message: MutableChatMessage; readonly partIndex: number }>,
  action: Readonly<Record<string, unknown>>,
  eventId: string,
  state: "approval" | "running",
): void {
  const callId = stringValue(action.callId);
  if (callId === undefined) return;
  const descriptor = describeChatAction(action);
  const part: ChatMessagePart = {
    callId,
    eventId,
    input: action.input,
    kind: descriptor.kind,
    name: descriptor.name,
    state,
    type: "tool",
  };
  message.status = "streaming";
  const existing = toolsByCall.get(callId);
  if (existing !== undefined) {
    existing.message.parts[existing.partIndex] = part;
    return;
  }
  const partIndex = message.parts.push(part) - 1;
  toolsByCall.set(callId, { message, partIndex });
}

function describeChatAction(value: Readonly<Record<string, unknown>>): {
  readonly kind: "load-skill" | "subagent" | "tool";
  readonly name: string;
} {
  const kind = stringValue(value.kind);
  if (kind === "load-skill" || kind === "load-skill-result") {
    return { kind: "load-skill", name: stringValue(value.name) ?? "load_skill" };
  }
  if (
    kind === "subagent-call" ||
    kind === "remote-agent-call" ||
    kind === "subagent-result" ||
    value.childSessionId !== undefined
  ) {
    return {
      kind: "subagent",
      name:
        stringValue(value.subagentName) ??
        stringValue(value.remoteAgentName) ??
        stringValue(value.name) ??
        "subagent",
    };
  }
  return {
    kind: "tool",
    name: stringValue(value.toolName) ?? stringValue(value.name) ?? "tool",
  };
}

function recordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
