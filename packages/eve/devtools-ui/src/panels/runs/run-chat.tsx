import { Bot, Brain, LoaderCircle, MessageSquare } from "lucide-react";
import type { Ref } from "react";
import { Streamdown } from "streamdown";

import { EmptyState } from "@ui/components/empty-state";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import type { ChatMessage, ChatMessagePart } from "@ui/model/devtools-model";
import { ChatTool } from "@ui/panels/runs/chat-tool";

export function RunChat({ scrollRef }: { readonly scrollRef?: Ref<HTMLDivElement> }) {
  const controller = useDevToolsController();
  const messages = controller.chatMessages.filter(
    (message) =>
      message.sessionId === controller.selectedRunId ||
      (controller.selectedRunId === undefined && message.optimistic === true),
  );
  const selectedRun = controller.scenario.runs.find((run) => run.id === controller.selectedRunId);
  const lastMessage = messages.at(-1);
  const showPending =
    (controller.isSendingMessage || selectedRun?.status === "running") &&
    (lastMessage === undefined || lastMessage.role === "user");

  if (controller.selectedRunId === undefined && !controller.isSendingMessage) {
    return (
      <EmptyState
        action={
          <button className="button button-primary" onClick={controller.startSession} type="button">
            <MessageSquare aria-hidden="true" size={15} />
            New Session
          </button>
        }
        description="Create a session to chat with your agent and watch its work stream in."
        title="Run Your Agent"
      />
    );
  }

  if (messages.length === 0 && !showPending) {
    return (
      <EmptyState
        description="This session is ready for its first message. Use the composer below to begin."
        title="No Messages Yet"
      />
    );
  }

  return (
    <div aria-label="Run chat" aria-live="polite" className="run-chat" ref={scrollRef} role="log">
      <div className="run-chat-content">
        {messages.map((message) => (
          <ChatMessageView key={message.id} message={message} />
        ))}
        {showPending && <PendingAssistantMessage />}
      </div>
    </div>
  );
}

function ChatMessageView({ message }: { readonly message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="chat-system-message" data-status={message.status}>
        {message.parts.map((part, index) =>
          part.type === "text" ? <span key={index}>{part.text}</span> : null,
        )}
      </div>
    );
  }

  return (
    <article
      className="chat-message"
      data-optimistic={message.optimistic || undefined}
      data-role={message.role}
      data-status={message.status}
    >
      {message.role === "assistant" && (
        <span className="chat-avatar">
          <Bot aria-hidden="true" size={14} />
        </span>
      )}
      <div className="chat-message-content">
        {message.parts.map((part, index) => (
          <ChatPart
            key={part.type === "tool" ? part.callId : `${part.type}-${index}`}
            part={part}
          />
        ))}
      </div>
    </article>
  );
}

function ChatPart({ part }: { readonly part: ChatMessagePart }) {
  if (part.type === "tool") return <ChatTool part={part} />;
  if (part.type === "reasoning") {
    return (
      <details className="chat-reasoning" open={part.state === "streaming" || undefined}>
        <summary>
          <Brain aria-hidden="true" size={13} />
          {part.state === "streaming" ? "Thinking…" : "Reasoning"}
        </summary>
        <Streamdown className="chat-reasoning-content" isAnimating={part.state === "streaming"}>
          {part.text}
        </Streamdown>
      </details>
    );
  }
  if (part.text.length === 0 && part.state !== "streaming") return null;
  return (
    <Streamdown className="chat-markdown" isAnimating={part.state === "streaming"}>
      {part.text}
    </Streamdown>
  );
}

function PendingAssistantMessage() {
  return (
    <div className="chat-message chat-message-pending" data-role="assistant" role="status">
      <span className="chat-avatar">
        <Bot aria-hidden="true" size={14} />
      </span>
      <span className="chat-pending-label">
        <LoaderCircle aria-hidden="true" className="chat-pending-spinner" size={13} />
        Thinking…
      </span>
    </div>
  );
}
