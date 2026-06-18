import { CirclePause, Play, StepForward, Undo2, Redo2 } from "lucide-react";

import { IconButton } from "@ui/components/icon-button";
import { ThreePaneLayout } from "@ui/components/three-pane-layout";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { DebuggerSidebar } from "@ui/panels/sources/debugger-sidebar";
import { SourceEditor } from "@ui/panels/sources/source-editor";
import { SourceNavigator } from "@ui/panels/sources/source-navigator";

export function SourcesPanel() {
  const controller = useDevToolsController();
  const paused = controller.scenario.runtime.status === "paused";
  const topFrame = controller.scenario.debugger.callStack[0];
  const authoredFrame = controller.scenario.debugger.callStack.find(
    (frame) => frame.id === controller.scenario.debugger.authoredFrameId,
  );
  const pauseEvent = controller.events.findLast(
    (event) =>
      event.sessionId === controller.selectedRunId &&
      event.source?.path === authoredFrame?.location.path,
  );
  return (
    <section aria-label="Sources" className="panel-view">
      <header className="panel-toolbar debugger-toolbar">
        <div className="debugger-controls">
          <IconButton
            icon={paused ? Play : CirclePause}
            label={paused ? "Resume Script Execution" : "Pause Script Execution"}
            onClick={() => controller.debuggerCommand(paused ? "resume" : "pause")}
            shortcut="F8"
          />
          <IconButton
            disabled={!paused}
            icon={StepForward}
            label="Step Over"
            onClick={() => controller.debuggerCommand("stepOver")}
            shortcut="F10"
          />
          <IconButton
            disabled={!paused}
            icon={Undo2}
            label="Step Into"
            onClick={() => controller.debuggerCommand("stepInto")}
            shortcut="F11"
          />
          <IconButton
            disabled={!paused}
            icon={Redo2}
            label="Step Out"
            onClick={() => controller.debuggerCommand("stepOut")}
            shortcut="Shift+F11"
          />
        </div>
        <div className="toolbar-context source-context">
          <span>{controller.selectedSource?.path ?? "Sources"}</span>
          {controller.selectedSource?.loaded && <span className="loaded-label">Loaded</span>}
        </div>
      </header>
      {paused && (
        <div className="pause-strip">
          <CirclePause aria-hidden="true" size={14} />
          <strong>Paused on breakpoint</strong>
          <span>
            {topFrame?.functionName ?? "execution"} at {topFrame?.location.path ?? "source"}:
            {topFrame?.location.line ?? "?"}
          </span>
          {authoredFrame !== undefined && authoredFrame.id !== topFrame?.id && (
            <span>
              Viewing {authoredFrame.location.path}:{authoredFrame.location.line}
            </span>
          )}
          {pauseEvent !== undefined && (
            <span className="pause-coordinates">
              session {pauseEvent.coordinates.session} / turn {pauseEvent.coordinates.turn ?? "?"}
              {pauseEvent.coordinates.action === undefined
                ? ""
                : ` / action ${pauseEvent.coordinates.action}`}
            </span>
          )}
        </div>
      )}
      <div className="compact-source-advisory" role="note">
        Source debugging works best in a wider window.
      </div>
      <div className="panel-workspace">
        <ThreePaneLayout
          details={<DebuggerSidebar />}
          detailsLabel="Debugger"
          navigator={<SourceNavigator />}
          navigatorLabel="Sources"
          primary={<SourceEditor />}
        />
      </div>
    </section>
  );
}
