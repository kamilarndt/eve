import { Braces, ExternalLink, FileCode2 } from "lucide-react";

import { CoordinatesStrip } from "@ui/components/coordinates-strip";
import { EmptyState } from "@ui/components/empty-state";
import { StatusIndicator } from "@ui/components/status-indicator";
import { StructuredValue } from "@ui/components/structured-value";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";

export function RunDetails() {
  const controller = useDevToolsController();
  const event = controller.selectedEvent;
  if (event === undefined) {
    return (
      <EmptyState
        description="Select an event to inspect its input, output, source, and raw record."
        title="Select an Event"
      />
    );
  }
  const source = event.source;

  function revealSource(): void {
    if (source === undefined) return;
    controller.selectSource(source.path);
    controller.selectPanel("sources");
  }

  return (
    <div className="details-content">
      <div className="details-header">
        <div className="details-icon" data-kind={event.kind}>
          <Braces aria-hidden="true" size={15} />
        </div>
        <div>
          <span className="details-eyebrow">{event.kind}</span>
          <h2>{event.label}</h2>
        </div>
        <StatusIndicator status={event.status} />
      </div>
      <p className="details-summary">{event.summary}</p>
      {event.input !== undefined && (
        <section className="details-section">
          <h3>Input</h3>
          <StructuredValue value={event.input} />
        </section>
      )}
      {event.output !== undefined && (
        <section className="details-section">
          <h3>Output</h3>
          <StructuredValue value={event.output} />
        </section>
      )}
      {source !== undefined && (
        <section className="details-section">
          <h3>Execution</h3>
          <button className="source-reference" onClick={revealSource} type="button">
            <FileCode2 aria-hidden="true" size={14} />
            <span>{source.path}</span>
            <span>:{source.line}</span>
            <ExternalLink aria-hidden="true" size={12} />
          </button>
        </section>
      )}
      <section className="details-section">
        <h3>Coordinates</h3>
        <CoordinatesStrip coordinates={event.coordinates} />
      </section>
      <details className="raw-record">
        <summary>Raw Record</summary>
        <StructuredValue value={event.raw} />
      </details>
    </div>
  );
}
