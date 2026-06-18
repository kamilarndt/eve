import { AlertCircle, Bug, CircleAlert, Info, MessageSquare, TerminalSquare } from "lucide-react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import type { ConsoleRecord as ConsoleRecordModel } from "@ui/model/devtools-model";
import { resolveConsoleSessionTitle } from "@ui/panels/console/console-view";

interface ConsoleRecordProps {
  readonly record: ConsoleRecordModel;
}

export function ConsoleRecord({ record }: ConsoleRecordProps) {
  const controller = useDevToolsController();
  const sessionTitle =
    record.coordinates === undefined
      ? undefined
      : resolveConsoleSessionTitle(controller.scenario.runs, record.coordinates.session);
  const Icon =
    record.level === "error"
      ? AlertCircle
      : record.level === "warn"
        ? CircleAlert
        : record.level === "debug"
          ? Bug
          : record.stream === "system"
            ? TerminalSquare
            : Info;

  function revealSource(): void {
    if (record.source === undefined) return;
    controller.selectSource(record.source.path);
    controller.selectPanel("sources");
  }

  function revealRun(): void {
    if (record.coordinates === undefined) return;
    controller.selectRun(record.coordinates.session);
    controller.selectPanel("runs");
  }

  return (
    <div className="console-record" data-level={record.level} role="row">
      <span className="console-severity" role="cell">
        <Icon aria-hidden="true" size={14} />
      </span>
      <span className="console-timestamp" role="cell">
        {record.timestamp}
      </span>
      <code className="console-message" role="cell">
        {record.message}
      </code>
      <span className="console-stream" role="cell">
        {record.stream}
      </span>
      <span className="console-session" role="cell">
        {record.coordinates !== undefined && (
          <button
            aria-label={`Session: ${sessionTitle}`}
            onClick={revealRun}
            title={`Reveal session “${sessionTitle}” in Runs`}
            type="button"
          >
            <MessageSquare aria-hidden="true" size={11} />
            <span>{sessionTitle}</span>
          </button>
        )}
        {record.coordinates === undefined && <span>Runtime</span>}
      </span>
      <span className="console-links" role="cell">
        {record.source !== undefined && (
          <button onClick={revealSource} title="Reveal in Sources" type="button">
            {record.source.path.split("/").at(-1)}:{record.source.line}
          </button>
        )}
        {record.coordinates?.action !== undefined && <span>{record.coordinates.action}</span>}
        {record.source === undefined && record.coordinates?.action === undefined && (
          <span>Process</span>
        )}
      </span>
    </div>
  );
}
