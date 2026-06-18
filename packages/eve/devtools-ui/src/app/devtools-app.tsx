import {
  Activity,
  Bot,
  ChevronDown,
  Command,
  FileCode2,
  Moon,
  PanelBottom,
  Sun,
  TerminalSquare,
  Triangle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { CommandMenu } from "@ui/components/command-menu";
import { IconButton } from "@ui/components/icon-button";
import { StatusIndicator } from "@ui/components/status-indicator";
import { formatRevision } from "@ui/components/revision";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { scenarioOptions } from "@ui/controllers/fixture/scenarios";
import type { PanelId, ScenarioId } from "@ui/model/devtools-model";
import { AgentPanel } from "@ui/panels/agent/agent-panel";
import { ConsoleDrawer } from "@ui/panels/console/console-drawer";
import { ConsolePanel } from "@ui/panels/console/console-panel";
import { useConsoleView } from "@ui/panels/console/use-console-view";
import { RunsPanel } from "@ui/panels/runs/runs-panel";
import { SourcesPanel } from "@ui/panels/sources/sources-panel";

const panels: readonly {
  readonly icon: LucideIcon;
  readonly id: PanelId;
  readonly label: string;
}[] = [
  { icon: Activity, id: "runs", label: "Runs" },
  { icon: TerminalSquare, id: "console", label: "Console" },
  { icon: Bot, id: "agent", label: "Agent" },
  { icon: FileCode2, id: "sources", label: "Sources" },
];

export function DevToolsApp() {
  const controller = useDevToolsController();
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const consoleView = useConsoleView({
    records: controller.scenario.logs,
    selectedActionId: controller.selectedEvent?.coordinates.action,
    selectedSessionId: controller.selectedRunId,
    selectedSessionTitle: controller.scenario.runs.find(
      (run) => run.id === controller.selectedRunId,
    )?.label,
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandMenuOpen((open) => !open);
        return;
      }
      if (event.key === "F8") {
        event.preventDefault();
        controller.debuggerCommand(
          controller.scenario.runtime.status === "paused" ? "resume" : "pause",
        );
        return;
      }
      if (event.key === "F10") {
        event.preventDefault();
        if (controller.scenario.runtime.status === "paused") {
          controller.debuggerCommand("stepOver");
        }
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        if (controller.scenario.runtime.status === "paused") {
          controller.debuggerCommand(event.shiftKey ? "stepOut" : "stepInto");
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (commandMenuOpen) {
          setCommandMenuOpen(false);
          return;
        }
        controller.toggleConsole();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        controller.toggleConsole();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandMenuOpen, controller]);

  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = panels.findIndex(({ id }) => id === controller.panel);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = panels[(current + direction + panels.length) % panels.length];
    if (next === undefined) return;
    controller.selectPanel(next.id);
    const tab = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `[data-panel-id="${next.id}"]`,
    );
    tab?.focus();
  }

  return (
    <div className="devtools-app">
      <header className="global-bar">
        <div className="agent-identity">
          <span className="eve-mark">
            <Triangle aria-hidden="true" fill="currentColor" size={14} />
          </span>
          <span className="product-name">Eve</span>
          <span className="identity-slash">/</span>
          <strong>{controller.scenario.runtime.agentName}</strong>
        </div>
        <nav aria-label="DevTools panels" className="panel-tabs" role="tablist">
          {panels.map(({ icon: Icon, id, label }) => (
            <button
              aria-controls={`${id}-panel`}
              aria-selected={controller.panel === id}
              data-active={controller.panel === id || undefined}
              data-panel-id={id}
              key={id}
              onKeyDown={handlePanelKeyDown}
              onClick={() => controller.selectPanel(id)}
              role="tab"
              tabIndex={controller.panel === id ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" size={14} />
              {label}
            </button>
          ))}
        </nav>
        <div className="global-actions">
          {controller.isFixture && (
            <label className="prototype-select">
              <span>Preview</span>
              <select
                aria-label="Preview scenario"
                onChange={(event) => controller.setScenario(event.target.value as ScenarioId)}
                value={controller.scenario.id}
              >
                {scenarioOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={12} />
            </label>
          )}
          <StatusIndicator status={controller.scenario.runtime.status} />
          <IconButton
            icon={controller.theme === "dark" ? Sun : Moon}
            label={`Use ${controller.theme === "dark" ? "Light" : "Dark"} Theme`}
            onClick={() => controller.setTheme(controller.theme === "dark" ? "light" : "dark")}
          />
          <button
            aria-label="Open Command Menu"
            className="command-button"
            onClick={() => setCommandMenuOpen(true)}
            title="Command Menu (Ctrl+K)"
            type="button"
          >
            <Command aria-hidden="true" size={13} />
            <span>Ctrl K</span>
          </button>
        </div>
      </header>
      {controller.connectionStatus !== "connected" && (
        <div className="connection-banner" data-status={controller.connectionStatus} role="status">
          {connectionMessage(controller.connectionStatus)}
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        Runtime {controller.scenario.runtime.status}.
        {controller.selectedRunId === undefined
          ? " No session selected."
          : ` Session ${controller.selectedRunId} selected.`}
      </div>
      {controller.scenario.runtime.status === "crashed" && (
        <div className="runtime-banner" role="alert">
          <span>
            <strong>Runtime crashed.</strong> Cached runs and logs remain available.
          </span>
          <div>
            {controller.isFixture && (
              <button
                className="button button-secondary button-small"
                onClick={() => controller.setScenario("running")}
                type="button"
              >
                Restart Runtime
              </button>
            )}
            <button
              className="button button-tertiary button-small"
              onClick={() => controller.selectPanel("console")}
              type="button"
            >
              Open Crash Logs
            </button>
          </div>
        </div>
      )}
      <div
        aria-label={`${panels.find(({ id }) => id === controller.panel)?.label ?? "DevTools"} panel`}
        className="application-workspace"
        id={`${controller.panel}-panel`}
        role="tabpanel"
      >
        {controller.panel === "runs" && <RunsPanel />}
        {controller.panel === "agent" && <AgentPanel />}
        {controller.panel === "sources" && <SourcesPanel />}
        {controller.panel === "console" && <ConsolePanel view={consoleView} />}
      </div>
      <ConsoleDrawer view={consoleView} />
      <footer className="status-bar">
        <div>
          <span>Local</span>
          <span>
            revision{" "}
            <code title={controller.scenario.runtime.revision}>
              {formatRevision(controller.scenario.runtime.revision)}
            </code>
          </span>
          <span>
            runtime <code>:{controller.scenario.runtime.runtimePort}</code>
          </span>
          <span>
            {controller.scenario.runtime.debuggerConnected
              ? "inspector connected"
              : "inspector disconnected"}
          </span>
          <span>{controller.events.length + controller.scenario.logs.length} records</span>
        </div>
        <button onClick={controller.toggleConsole} type="button">
          <PanelBottom aria-hidden="true" size={13} />
          Console
          <span>Ctrl `</span>
        </button>
      </footer>
      {controller.toast !== undefined && (
        <button className="toast" onClick={controller.clearToast} type="button">
          {controller.toast}
        </button>
      )}
      {commandMenuOpen && <CommandMenu onClose={() => setCommandMenuOpen(false)} />}
    </div>
  );
}

function connectionMessage(
  status: ReturnType<typeof useDevToolsController>["connectionStatus"],
): string {
  switch (status) {
    case "connecting":
      return "Connecting to the local Eve runtime…";
    case "disconnected":
      return "Connection lost. DevTools is reconnecting…";
    case "unauthorized":
      return "This DevTools URL is missing or has an invalid local capability.";
    case "connected":
      return "Connected";
  }
}
