import { AlertTriangle, CheckCircle2, FileCode2, GitCommitHorizontal, Info } from "lucide-react";

import { EmptyState } from "@ui/components/empty-state";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { formatRevision } from "@ui/components/revision";

export function AgentProvenance() {
  const controller = useDevToolsController();
  const definition = controller.selectedAgent;
  if (definition === undefined) {
    return (
      <EmptyState
        description="Source and runtime provenance appear for the selected definition."
        title="No Selection"
      />
    );
  }
  return (
    <div className="details-content">
      <div className="details-header">
        <div className="details-icon">
          <Info aria-hidden="true" size={15} />
        </div>
        <div>
          <span className="details-eyebrow">Definition</span>
          <h2>Provenance</h2>
        </div>
      </div>
      <section className="details-section">
        <h3>Resolution</h3>
        <div className="fact-row">
          <CheckCircle2 aria-hidden="true" size={14} />
          <span>Loaded as {definition.provenance}</span>
        </div>
      </section>
      <section className="details-section">
        <h3>Source</h3>
        {definition.source === undefined ? (
          <p className="muted-copy">Runtime-owned definition</p>
        ) : (
          <div className="fact-row mono">
            <FileCode2 aria-hidden="true" size={14} />
            <span>
              {definition.source.path}:{definition.source.line}
            </span>
          </div>
        )}
      </section>
      <section className="details-section">
        <h3>Revision</h3>
        <div className="fact-row mono">
          <GitCommitHorizontal aria-hidden="true" size={14} />
          <span title={controller.scenario.runtime.revision}>
            {formatRevision(controller.scenario.runtime.revision)}
          </span>
        </div>
      </section>
      {controller.scenario.runtime.diagnostics?.length ? (
        <section className="diagnostic-warning" role="status">
          <AlertTriangle aria-hidden="true" size={14} />
          <div>
            <strong>Runtime Diagnostics</strong>
            {controller.scenario.runtime.diagnostics.map((message) => (
              <span key={message}>{message}</span>
            ))}
          </div>
        </section>
      ) : (
        <section className="diagnostic-success">
          <CheckCircle2 aria-hidden="true" size={14} />
          <div>
            <strong>No Diagnostics</strong>
            <span>Eve resolved this definition without warnings.</span>
          </div>
        </section>
      )}
    </div>
  );
}
