import { CheckCircle2, ChevronDown, CircleAlert, Clock3, LoaderCircle, Wrench } from "lucide-react";

import { StructuredValue } from "@ui/components/structured-value";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import type { ChatMessagePart } from "@ui/model/devtools-model";

type ChatToolPart = Extract<ChatMessagePart, { readonly type: "tool" }>;

export function ChatTool({ part }: { readonly part: ChatToolPart }) {
  const controller = useDevToolsController();
  const status = toolStatus(part.state);
  const StatusIcon = status.icon;
  return (
    <details className="chat-tool" data-state={part.state}>
      <summary
        onClick={() => {
          if (part.eventId !== undefined) controller.selectEvent(part.eventId);
        }}
      >
        <span className="chat-tool-icon">
          <Wrench aria-hidden="true" size={13} />
        </span>
        <span className="chat-tool-name">{part.name}</span>
        <span className="chat-tool-status">
          <StatusIcon
            aria-hidden="true"
            className={part.state === "running" ? "chat-tool-spinner" : undefined}
            size={12}
          />
          {status.label}
        </span>
        <ChevronDown aria-hidden="true" className="chat-tool-disclosure" size={13} />
      </summary>
      <div className="chat-tool-content">
        {part.input !== undefined && (
          <section>
            <h3>Input</h3>
            <StructuredValue value={part.input} />
          </section>
        )}
        {part.output !== undefined && (
          <section>
            <h3>Output</h3>
            <StructuredValue value={part.output} />
          </section>
        )}
        {part.error !== undefined && (
          <section>
            <h3>Error</h3>
            <p className="chat-tool-error">{part.error}</p>
          </section>
        )}
      </div>
    </details>
  );
}

function toolStatus(state: ChatToolPart["state"]): {
  readonly icon: typeof CheckCircle2;
  readonly label: string;
} {
  switch (state) {
    case "approval":
      return { icon: Clock3, label: "Needs input" };
    case "completed":
      return { icon: CheckCircle2, label: "Completed" };
    case "denied":
      return { icon: CircleAlert, label: "Denied" };
    case "failed":
      return { icon: CircleAlert, label: "Failed" };
    case "running":
      return { icon: LoaderCircle, label: "Running" };
  }
}
