import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  GitBranch,
  PauseCircle,
  Sparkles,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { StatusIndicator } from "@ui/components/status-indicator";
import type { TimelineEvent, TimelineEventKind } from "@ui/model/devtools-model";

const eventIcons: Readonly<Record<TimelineEventKind, LucideIcon>> = {
  action: Wrench,
  assistant: Bot,
  checkpoint: CheckCircle2,
  failure: CircleAlert,
  model: Sparkles,
  subagent: GitBranch,
  system: CircleAlert,
  user: UserRound,
  wait: PauseCircle,
};

interface TimelineRowProps {
  readonly event: TimelineEvent;
  readonly onSelect: () => void;
  readonly selected: boolean;
}

export function TimelineRow({ event, onSelect, selected }: TimelineRowProps) {
  const Icon = eventIcons[event.kind];
  const duration = event.duration ?? "—";
  return (
    <div role="listitem">
      <button
        aria-current={selected || undefined}
        className="timeline-row"
        data-depth={event.depth ?? 0}
        data-kind={event.kind}
        data-selected={selected || undefined}
        onClick={onSelect}
        type="button"
      >
        <span className="timeline-rail">
          <span className="timeline-node">
            <Icon aria-hidden="true" size={14} strokeWidth={1.9} />
          </span>
        </span>
        <span className="timeline-copy">
          <span className="timeline-title">
            {event.label}
            {event.replayed && <span className="provenance-label">Replayed</span>}
          </span>
          <span className="timeline-summary">{event.summary}</span>
        </span>
        <span
          aria-label={event.duration === undefined ? "No duration" : `Duration ${event.duration}`}
          className="timeline-duration"
          data-empty={event.duration === undefined || undefined}
        >
          {duration}
        </span>
        <span className="timeline-time">{event.time}</span>
        <StatusIndicator compact status={event.status} />
        <ChevronDown aria-hidden="true" className="timeline-disclosure" size={13} />
      </button>
    </div>
  );
}
