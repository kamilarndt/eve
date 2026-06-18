import { CirclePause, FileCode2 } from "lucide-react";

import { CoordinatesStrip } from "@ui/components/coordinates-strip";
import { EmptyState } from "@ui/components/empty-state";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { usePaneNavigation } from "@ui/components/three-pane-layout";
import { DebuggerSection } from "@ui/panels/sources/debugger-section";
import type { StackFrame } from "@ui/model/devtools-model";

export function DebuggerSidebar() {
  const controller = useDevToolsController();
  const paneNavigation = usePaneNavigation();
  const debuggerState = controller.scenario.debugger;
  const topFrame = debuggerState.callStack[0];
  const authoredFrame = debuggerState.callStack.find(
    (frame) => frame.id === debuggerState.authoredFrameId,
  );
  const pauseEvent = controller.events.findLast(
    (event) =>
      event.sessionId === controller.selectedRunId &&
      event.source?.path === authoredFrame?.location.path,
  );

  if (controller.scenario.runtime.status !== "paused") {
    return (
      <EmptyState
        action={<CirclePause aria-hidden="true" size={18} />}
        description="Set a breakpoint in authored code or pause the runtime to inspect call frames and values."
        title="Running"
      />
    );
  }

  return (
    <div className="debugger-sidebar">
      <div className="pause-summary">
        <CirclePause aria-hidden="true" size={16} />
        <div>
          <strong>{debuggerState.pauseReason}</strong>
          <span>
            {topFrame?.location.path}:{topFrame?.location.line}
          </span>
          {authoredFrame !== undefined && authoredFrame.id !== topFrame?.id && (
            <span>
              Viewing {authoredFrame.location.path}:{authoredFrame.location.line}
            </span>
          )}
        </div>
      </div>
      <DebuggerSection title="Call Stack">
        <div className="call-stack">
          {debuggerState.callStack.map((frame) => {
            const source = controller.scenario.sources.find(
              (candidate) => candidate.path === frame.location.path,
            );
            return (
              <button
                data-active={frame.active || undefined}
                disabled={source === undefined}
                key={frame.id}
                onClick={() => {
                  if (source === undefined) return;
                  controller.selectSource(source.id);
                  paneNavigation.showPrimary();
                }}
                type="button"
              >
                <FileCode2 aria-hidden="true" size={13} />
                <span>
                  <strong>{frame.functionName}</strong>
                  <small>
                    {frame.sourceKind !== "authored" && `${sourceKindLabel(frame.sourceKind)} · `}
                    {frame.location.path}:{frame.location.line}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </DebuggerSection>
      <DebuggerSection title="Scope">
        <div className="scope-list">
          {debuggerState.scope.map((value) => (
            <div key={value.name}>
              <span>{value.name}</span>
              <code>{value.value}</code>
              <small>{value.type}</small>
            </div>
          ))}
        </div>
      </DebuggerSection>
      {pauseEvent !== undefined && (
        <DebuggerSection title="Eve Context">
          <CoordinatesStrip coordinates={pauseEvent.coordinates} />
          <button
            className="button button-secondary full-width"
            onClick={() => controller.selectPanel("runs")}
            type="button"
          >
            Reveal in Runs
          </button>
        </DebuggerSection>
      )}
      <DebuggerSection title="Breakpoints">
        {controller.scenario.sources.flatMap((source) =>
          source.breakpointLines.map((line) => (
            <button
              className="breakpoint-list"
              key={`${source.id}:${line}`}
              onClick={() => {
                controller.selectSource(source.id);
                paneNavigation.showPrimary();
              }}
              type="button"
            >
              <span className="breakpoint-marker" />
              <span>
                {source.path.split("/").at(-1)}:{line}
              </span>
            </button>
          )),
        )}
        {controller.scenario.sources.every((source) => source.breakpointLines.length === 0) && (
          <span className="muted-copy">No breakpoints set.</span>
        )}
      </DebuggerSection>
    </div>
  );
}

function sourceKindLabel(kind: StackFrame["sourceKind"]): string {
  return {
    authored: "Authored",
    dependency: "Dependency",
    framework: "Framework",
    generated: "Generated",
    internal: "Node internal",
  }[kind];
}
