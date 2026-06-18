import { FileCode2 } from "lucide-react";

import { EmptyState } from "@ui/components/empty-state";
import { StructuredValue } from "@ui/components/structured-value";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { formatRevision } from "@ui/components/revision";

export function AgentOverview() {
  const controller = useDevToolsController();
  const definition = controller.selectedAgent;
  if (definition === undefined) {
    return (
      <EmptyState
        description="Select a resolved definition to inspect its configuration and source."
        title="Select a Definition"
      />
    );
  }
  const source = definition.source;

  function revealSource(): void {
    if (source === undefined) return;
    controller.selectSource(source.path);
    controller.selectPanel("sources");
  }

  return (
    <div className="agent-overview">
      <header className="overview-header">
        <span className="details-eyebrow">{definition.kind}</span>
        <h1>{definition.label}</h1>
        <p>{definition.description}</p>
        {source !== undefined && (
          <button className="button button-secondary" onClick={revealSource} type="button">
            <FileCode2 aria-hidden="true" size={14} />
            Reveal in Sources
          </button>
        )}
      </header>
      <section className="overview-section">
        <h2>Active Configuration</h2>
        {Object.keys(definition.config).length > 0 ? (
          <StructuredValue value={definition.config} />
        ) : (
          <p className="muted-copy">This definition has no additional configuration.</p>
        )}
      </section>
      <section className="overview-section">
        <h2>Runtime Identity</h2>
        <dl className="description-list">
          <div>
            <dt>Definition ID</dt>
            <dd>{definition.id}</dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>{definition.provenance}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd title={controller.scenario.runtime.revision}>
              {formatRevision(controller.scenario.runtime.revision)}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
