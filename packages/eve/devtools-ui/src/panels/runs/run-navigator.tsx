import { Plus, Search } from "lucide-react";
import { useState } from "react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { usePaneNavigation } from "@ui/components/three-pane-layout";
import { RunRow } from "@ui/panels/runs/run-row";

export function RunNavigator() {
  const controller = useDevToolsController();
  const paneNavigation = usePaneNavigation();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.toLocaleLowerCase().trim();
  const runs = controller.scenario.runs.filter(
    (run) =>
      normalizedQuery.length === 0 ||
      run.label.toLocaleLowerCase().includes(normalizedQuery) ||
      run.id.toLocaleLowerCase().includes(normalizedQuery),
  );
  return (
    <div className="navigator-content">
      <div className="pane-heading">
        <div>
          <h2>Sessions</h2>
          <span>{controller.scenario.runs.length}</span>
        </div>
        <button
          aria-label="New Session"
          className="button button-primary button-compact"
          onClick={() => {
            controller.startSession();
            paneNavigation.showPrimary();
          }}
          type="button"
        >
          <Plus aria-hidden="true" size={12} />
          New
        </button>
      </div>
      <label className="search-field">
        <Search aria-hidden="true" size={14} />
        <span className="sr-only">Search sessions</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions..."
          type="search"
          value={query}
        />
      </label>
      <div className="session-list" role="list">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            paused={
              controller.selectedRunId === run.id && controller.scenario.runtime.status === "paused"
            }
            run={run}
            selected={controller.selectedRunId === run.id}
            onSelect={() => {
              controller.selectRun(run.id);
              paneNavigation.showPrimary();
            }}
          />
        ))}
      </div>
    </div>
  );
}
