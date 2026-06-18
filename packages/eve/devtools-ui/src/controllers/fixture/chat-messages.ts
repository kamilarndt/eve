import type { ChatMessage, ChatMessagePart, TimelineEvent } from "@ui/model/devtools-model";

interface MutableChatMessage {
  readonly id: string;
  readonly parts: ChatMessagePart[];
  readonly role: ChatMessage["role"];
  readonly sessionId: string;
  status: ChatMessage["status"];
}

export function projectFixtureChatMessages(
  events: readonly TimelineEvent[],
): readonly ChatMessage[] {
  const messages: MutableChatMessage[] = [];
  const currentAssistant = new Map<string, MutableChatMessage>();

  const ensureAssistant = (event: TimelineEvent): MutableChatMessage => {
    const existing = currentAssistant.get(event.sessionId);
    if (existing !== undefined) return existing;
    const message: MutableChatMessage = {
      id: `${event.id}:assistant`,
      parts: [],
      role: "assistant",
      sessionId: event.sessionId,
      status: event.status === "running" ? "streaming" : "complete",
    };
    messages.push(message);
    currentAssistant.set(event.sessionId, message);
    return message;
  };

  for (const event of events) {
    switch (event.kind) {
      case "user":
        currentAssistant.delete(event.sessionId);
        messages.push({
          id: `${event.id}:user`,
          parts: [{ eventId: event.id, state: "done", text: event.summary, type: "text" }],
          role: "user",
          sessionId: event.sessionId,
          status: "complete",
        });
        break;
      case "assistant": {
        const message = ensureAssistant(event);
        message.parts.push({
          eventId: event.id,
          state: event.status === "running" ? "streaming" : "done",
          text: event.summary,
          type: "text",
        });
        message.status = event.status === "running" ? "streaming" : "complete";
        break;
      }
      case "action":
      case "subagent": {
        const message = ensureAssistant(event);
        const callId = event.coordinates.action ?? event.id;
        const index = message.parts.findIndex(
          (part) => part.type === "tool" && part.callId === callId,
        );
        const part: ChatMessagePart = {
          callId,
          eventId: event.id,
          input: event.input,
          kind: event.kind === "subagent" ? "subagent" : "tool",
          name: event.summary,
          output: event.output,
          state:
            event.status === "failed"
              ? "failed"
              : event.status === "waiting"
                ? "approval"
                : event.status === "running"
                  ? "running"
                  : "completed",
          type: "tool",
        };
        if (index === -1) message.parts.push(part);
        else message.parts[index] = part;
        message.status = event.status === "running" ? "streaming" : message.status;
        break;
      }
      case "failure":
        currentAssistant.delete(event.sessionId);
        messages.push({
          id: `${event.id}:failure`,
          parts: [{ eventId: event.id, state: "done", text: event.summary, type: "text" }],
          role: "system",
          sessionId: event.sessionId,
          status: "failed",
        });
        break;
    }
  }

  return messages;
}
