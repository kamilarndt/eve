import type { RecordStatus, RuntimeStatus } from "@ui/model/devtools-model";

interface StatusIndicatorProps {
  readonly compact?: boolean;
  readonly label?: string;
  readonly status: RecordStatus | RuntimeStatus;
}

export function StatusIndicator({ compact = false, label, status }: StatusIndicatorProps) {
  const visibleLabel = label ?? statusLabel(status);
  return (
    <span className="status-indicator" data-compact={compact || undefined} data-status={status}>
      <span aria-hidden="true" className="status-dot" />
      {!compact && <span>{visibleLabel}</span>}
      {compact && <span className="sr-only">{visibleLabel}</span>}
    </span>
  );
}

function statusLabel(status: StatusIndicatorProps["status"]): string {
  switch (status) {
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "info":
      return "Info";
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "crashed":
      return "Crashed";
    case "stopped":
      return "Stopped";
    case "waiting":
      return "Waiting";
  }
}
