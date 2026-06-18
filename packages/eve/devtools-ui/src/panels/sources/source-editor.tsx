import { FileQuestion } from "lucide-react";

import { EmptyState } from "@ui/components/empty-state";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";

export function SourceEditor() {
  const controller = useDevToolsController();
  const source = controller.selectedSource;
  if (source === undefined) {
    return (
      <EmptyState
        action={<FileQuestion aria-hidden="true" size={18} />}
        description="Select an authored source file to inspect its current revision."
        title="Open a Source File"
      />
    );
  }

  const authoredFrame = controller.scenario.debugger.callStack.find(
    (frame) => frame.id === controller.scenario.debugger.authoredFrameId,
  );
  const executionLine =
    authoredFrame?.location.path === source.path ? authoredFrame.location.line : -1;
  const parentPath = source.path.split("/").slice(0, -1).join("/");
  const debuggable = /\.[cm]?[jt]sx?$/u.test(source.path);
  return (
    <div className="source-editor">
      <div className="editor-tabs" role="tablist">
        <button aria-selected="true" role="tab" type="button">
          <span className="language-dot" />
          {source.path.split("/").at(-1)}
          <span className="tab-path">{parentPath}</span>
        </button>
      </div>
      <div className="editor-breadcrumbs">
        {source.path.split("/").map((part, index) => (
          <span key={`${part}-${index}`}>{part}</span>
        ))}
      </div>
      <div aria-label={`${source.path} source code`} className="code-surface">
        {source.content.split("\n").map((line, index) => {
          const lineNumber = index + 1;
          const breakpoint = source.breakpointLines.includes(lineNumber);
          const executing = executionLine === lineNumber;
          return (
            <div
              className="code-line"
              data-breakpoint={breakpoint || undefined}
              data-executing={executing || undefined}
              key={lineNumber}
            >
              <button
                aria-label={
                  debuggable
                    ? `${breakpoint ? "Remove" : "Add"} breakpoint at line ${lineNumber}`
                    : `Line ${lineNumber}`
                }
                className="breakpoint-gutter"
                disabled={!debuggable}
                onClick={() => controller.toggleBreakpoint(lineNumber)}
                type="button"
              >
                {breakpoint && <span />}
              </button>
              <span className="line-number">{lineNumber}</span>
              <code>{line || " "}</code>
              {executing && <span className="execution-label">Paused</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
