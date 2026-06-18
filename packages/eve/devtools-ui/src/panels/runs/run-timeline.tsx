import { LoaderCircle, MessageSquare } from "lucide-react";
import type { Ref } from "react";

import { EmptyState } from "@ui/components/empty-state";
import { StatusIndicator } from "@ui/components/status-indicator";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { TimelineRow } from "@ui/panels/runs/timeline-row";

export function RunTimeline({ scrollRef }: { readonly scrollRef?: Ref<HTMLDivElement> }) {
  const controller = useDevToolsController();
  const events = controller.events.filter((event) => event.sessionId === controller.selectedRunId);

  if (controller.isSendingMessage && events.length === 0) {
    return (
      <div className="timeline" ref={scrollRef} role="list" aria-label="Run timeline">
        <PendingTimelineRow creatingSession={controller.selectedRunId === undefined} />
      </div>
    );
  }

  if (controller.selectedRunId === undefined) {
    return (
      <EmptyState
        action={
          <button className="button button-primary" onClick={controller.startSession} type="button">
            <MessageSquare aria-hidden="true" size={15} />
            New Session
          </button>
        }
        description="Create a session to send a message and inspect its durable execution."
        title="Run Your Agent"
      />
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        description="This session is ready for its first message. Use the composer below to begin."
        title="No Events Yet"
      />
    );
  }

  return (
    <div className="timeline" ref={scrollRef} role="list" aria-label="Run timeline">
      {events.map((event) => (
        <TimelineRow
          event={event}
          key={event.id}
          onSelect={() => controller.selectEvent(event.id)}
          selected={controller.selectedEvent?.id === event.id}
        />
      ))}
      {controller.isSendingMessage && <PendingTimelineRow creatingSession={false} />}
    </div>
  );
}

function PendingTimelineRow({ creatingSession }: { readonly creatingSession: boolean }) {
  return (
    <div role="listitem">
      <div className="timeline-row timeline-row-pending" role="status">
        <span className="timeline-rail">
          <span className="timeline-node">
            <LoaderCircle
              aria-hidden="true"
              className="timeline-loading-icon"
              size={14}
              strokeWidth={1.9}
            />
          </span>
        </span>
        <span className="timeline-copy">
          <span className="timeline-title">
            {creatingSession ? "Starting run" : "Sending message"}
          </span>
          <span className="timeline-summary">
            {creatingSession
              ? "Creating the session and waiting for runtime events…"
              : "Waiting for runtime events…"}
          </span>
        </span>
        <span aria-label="No duration" className="timeline-duration" data-empty>
          —
        </span>
        <span className="timeline-time">Now</span>
        <StatusIndicator compact status="running" />
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
