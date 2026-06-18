import {
  CircleAlert,
  CirclePause,
  CircleQuestionMark,
  GitBranch,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Radio,
  ShieldQuestionMark,
  Timer,
} from "lucide-react";

import type { RunSession } from "@ui/model/devtools-model";

interface RunRowProps {
  readonly onSelect: () => void;
  readonly paused?: boolean;
  readonly run: RunSession;
  readonly selected: boolean;
}

export function RunRow({ onSelect, paused = false, run, selected }: RunRowProps) {
  const TriggerIcon =
    run.trigger === "schedule"
      ? Timer
      : run.trigger === "channel"
        ? Radio
        : run.trigger === "subagent"
          ? GitBranch
          : MessageSquare;
  return (
    <div role="listitem">
      <button
        aria-current={selected || undefined}
        className="session-row"
        data-child={run.parentId !== undefined || undefined}
        data-selected={selected || undefined}
        onClick={onSelect}
        type="button"
      >
        <TriggerIcon aria-hidden="true" className="session-trigger" size={14} />
        <span className="session-main">
          <span className="session-label">{run.label}</span>
        </span>
        <span className="session-meta">
          <span>{run.activity}</span>
          <RunStateIcon paused={paused} run={run} />
        </span>
      </button>
    </div>
  );
}

function RunStateIcon({ paused, run }: { readonly paused: boolean; readonly run: RunSession }) {
  if (paused) {
    return (
      <span className="session-state session-state-attention" title="Paused on a breakpoint">
        <CirclePause aria-hidden="true" size={12} />
        <span className="sr-only">Paused on a breakpoint</span>
      </span>
    );
  }

  if (run.status === "running") {
    return (
      <span className="session-state session-state-running" role="status" title="Agent is working">
        <LoaderCircle aria-hidden="true" className="session-loading-icon" size={12} />
        <span className="sr-only">Agent is working</span>
      </span>
    );
  }

  const pendingAction = run.pendingAction;
  if (pendingAction !== undefined) {
    const Icon =
      pendingAction.kind === "question"
        ? CircleQuestionMark
        : pendingAction.kind === "approval"
          ? ShieldQuestionMark
          : KeyRound;
    const label =
      pendingAction.kind === "question"
        ? `Waiting for a response: ${pendingAction.name}`
        : pendingAction.kind === "approval"
          ? `Approval required: ${pendingAction.name}`
          : `Authorization required: ${pendingAction.name}`;
    return (
      <span className="session-state session-state-attention" title={label}>
        <Icon aria-hidden="true" size={12} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  if (run.status === "failed") {
    return (
      <span className="session-state session-state-failed" title="Run failed">
        <CircleAlert aria-hidden="true" size={12} />
        <span className="sr-only">Run failed</span>
      </span>
    );
  }

  return null;
}
