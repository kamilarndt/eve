import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { ConsoleControls } from "@ui/panels/console/console-controls";
import { ConsolePrompt } from "@ui/panels/console/console-prompt";
import { ConsoleRecords } from "@ui/panels/console/console-records";
import type { ConsoleView } from "@ui/panels/console/console-view";

interface ConsolePanelProps {
  readonly view: ConsoleView;
}

export function ConsolePanel({ view }: ConsolePanelProps) {
  const controller = useDevToolsController();

  return (
    <section aria-label="Console" className="panel-view">
      <header className="panel-toolbar console-toolbar">
        <div className="toolbar-context">
          <strong>Console</strong>
        </div>
        <ConsoleControls view={view} />
      </header>
      <div className="console-workspace">
        <ConsoleRecords records={view.records} />
        <ConsolePrompt
          onEvaluate={controller.evaluateExpression}
          runtimeStatus={controller.scenario.runtime.status}
        />
      </div>
    </section>
  );
}
