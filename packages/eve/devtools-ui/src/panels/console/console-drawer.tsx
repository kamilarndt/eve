import { ChevronDown, Maximize2, TerminalSquare } from "lucide-react";

import { IconButton } from "@ui/components/icon-button";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { ConsoleControls } from "@ui/panels/console/console-controls";
import { ConsolePrompt } from "@ui/panels/console/console-prompt";
import { ConsoleRecords } from "@ui/panels/console/console-records";
import type { ConsoleView } from "@ui/panels/console/console-view";

interface ConsoleDrawerProps {
  readonly view: ConsoleView;
}

export function ConsoleDrawer({ view }: ConsoleDrawerProps) {
  const controller = useDevToolsController();
  if (!controller.consoleOpen || controller.panel === "console") return null;
  return (
    <section aria-label="Console drawer" className="console-drawer">
      <header>
        <div>
          <TerminalSquare aria-hidden="true" size={14} />
          <strong>Console</strong>
          <span>
            {view.records.length}/{controller.scenario.logs.length}
          </span>
        </div>
        <ConsoleControls compact view={view} />
        <div>
          <IconButton
            icon={Maximize2}
            label="Open Console Panel"
            onClick={() => controller.selectPanel("console")}
          />
          <IconButton
            icon={ChevronDown}
            label="Collapse Console"
            onClick={controller.toggleConsole}
          />
        </div>
      </header>
      <ConsoleRecords compact records={view.records} />
      <ConsolePrompt
        onEvaluate={controller.evaluateExpression}
        runtimeStatus={controller.scenario.runtime.status}
      />
    </section>
  );
}
