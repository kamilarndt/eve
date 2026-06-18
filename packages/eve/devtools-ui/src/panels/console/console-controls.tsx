import { Search } from "lucide-react";

import type { ConsoleScope, ConsoleView } from "@ui/panels/console/console-view";

interface ConsoleControlsProps {
  readonly compact?: boolean;
  readonly view: ConsoleView;
}

const levels = ["all", "info", "warn", "error", "debug"] as const;

export function ConsoleControls({ compact = false, view }: ConsoleControlsProps) {
  return (
    <div className="console-controls" data-compact={compact || undefined}>
      <select
        aria-label="Console context"
        className="compact-select"
        onChange={(event) => view.setScope(event.target.value as ConsoleScope)}
        value={view.scope}
      >
        <option value="runtime">All Runtime</option>
        <option disabled={view.selectedSessionId === undefined} value="session">
          {view.selectedSessionId === undefined
            ? "No Selected Session"
            : `Session · ${view.selectedSessionTitle ?? "Session"}`}
        </option>
        <option disabled={view.selectedActionId === undefined} value="action">
          {view.selectedActionId === undefined
            ? "No Selected Action"
            : `Action · ${view.selectedActionId}`}
        </option>
      </select>
      <label className="console-filter">
        <Search aria-hidden="true" size={14} />
        <span className="sr-only">Filter console records</span>
        <input
          onChange={(event) => view.setQuery(event.target.value)}
          placeholder="Filter output..."
          type="search"
          value={view.query}
        />
      </label>
      <div aria-label="Log level" className="severity-control" role="group">
        {levels.map((level) => (
          <button
            aria-pressed={view.level === level}
            data-active={view.level === level || undefined}
            key={level}
            onClick={() => view.setLevel(level)}
            type="button"
          >
            {level}
          </button>
        ))}
      </div>
      <button
        className="console-clear"
        onClick={view.clearRecords}
        title="Clear the local Console view"
        type="button"
      >
        Clear
      </button>
    </div>
  );
}
