import { ThreePaneLayout } from "@ui/components/three-pane-layout";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { AgentNavigator } from "@ui/panels/agent/agent-navigator";
import { AgentOverview } from "@ui/panels/agent/agent-overview";
import { AgentProvenance } from "@ui/panels/agent/agent-provenance";
import { formatRevision } from "@ui/components/revision";

export function AgentPanel() {
  const controller = useDevToolsController();
  return (
    <section aria-label="Agent" className="panel-view">
      <header className="panel-toolbar">
        <div className="toolbar-context">
          <span>Agent</span>
          <span className="toolbar-separator">/</span>
          <strong>{controller.selectedAgent?.label ?? "Resolved Definition"}</strong>
          <span className="revision-label" title={controller.scenario.runtime.revision}>
            rev {formatRevision(controller.scenario.runtime.revision)}
          </span>
        </div>
      </header>
      <div className="panel-workspace">
        <ThreePaneLayout
          details={<AgentProvenance />}
          detailsLabel="Definition Details"
          navigator={<AgentNavigator />}
          navigatorLabel="Resolved Agent"
          primary={<AgentOverview />}
        />
      </div>
    </section>
  );
}
