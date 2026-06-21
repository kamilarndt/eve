import { Check, Copy } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ThreePaneLayout } from "@ui/components/three-pane-layout";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { RunComposer } from "@ui/panels/runs/run-composer";
import { RunChat } from "@ui/panels/runs/run-chat";
import { RunDetails } from "@ui/panels/runs/run-details";
import { RunNavigator } from "@ui/panels/runs/run-navigator";
import { RunTimeline } from "@ui/panels/runs/run-timeline";

export function RunsPanel() {
  const controller = useDevToolsController();
  const [copiedSessionId, setCopiedSessionId] = useState<string>();
  const [view, setView] = useState<"chat" | "timeline">("chat");
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const timelineTabRef = useRef<HTMLButtonElement>(null);
  const run = controller.scenario.runs.find(
    (candidate) => candidate.id === controller.selectedRunId,
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRunKey =
    controller.selectedRunId === undefined ? "draft" : `session:${controller.selectedRunId}`;
  const activeViewKey = `${activeRunKey}:${view}`;
  const activatedRunKey = useRef<string | null>(null);
  const pendingFocusRunKey = useRef<string | null>(null);
  const eventCount = controller.events.filter(
    (event) => event.sessionId === controller.selectedRunId,
  ).length;
  const messageCount = controller.chatMessages.filter(
    (message) =>
      message.sessionId === controller.selectedRunId ||
      (controller.selectedRunId === undefined && message.optimistic === true),
  ).length;

  useEffect(() => {
    if (copiedSessionId === undefined) return;
    const timeout = window.setTimeout(() => setCopiedSessionId(undefined), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copiedSessionId]);

  useLayoutEffect(() => {
    if (activatedRunKey.current !== activeViewKey) {
      activatedRunKey.current = activeViewKey;
      pendingFocusRunKey.current = activeViewKey;
    }

    if (scrollRef.current !== null) {
      activateRunsView(null, scrollRef.current);
    }
    if (pendingFocusRunKey.current === activeViewKey && composerRef.current !== null) {
      const focused = activateRunsView(composerRef.current, null);
      if (focused) pendingFocusRunKey.current = null;
    }
  }, [
    activeViewKey,
    controller.chatMessages,
    controller.isSendingMessage,
    controller.scenario.runtime.status,
    eventCount,
    run?.status,
  ]);

  function handleViewKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextView = view === "chat" ? "timeline" : "chat";
    setView(nextView);
    (nextView === "chat" ? chatTabRef : timelineTabRef).current?.focus();
  }

  async function copySessionId(): Promise<void> {
    if (run === undefined) return;
    try {
      await navigator.clipboard.writeText(run.id);
      setCopiedSessionId(run.id);
    } catch {
      setCopiedSessionId(undefined);
    }
  }

  const sessionIdCopied = run !== undefined && copiedSessionId === run.id;

  return (
    <section aria-label="Runs" className="panel-view">
      <header className="panel-toolbar runs-toolbar">
        <div className="toolbar-context">
          <span>Runs</span>
          {run !== undefined && <span className="toolbar-separator">/</span>}
          {run !== undefined && <strong>{run.label}</strong>}
          {run !== undefined && (
            <button
              aria-label={
                sessionIdCopied ? `Copied session ID ${run.id}` : `Copy session ID ${run.id}`
              }
              className="session-id-copy"
              onClick={() => void copySessionId()}
              title={sessionIdCopied ? "Session ID copied" : "Copy session ID"}
              type="button"
            >
              <code>{run.id}</code>
              {sessionIdCopied ? (
                <Check aria-hidden="true" size={12} />
              ) : (
                <Copy aria-hidden="true" size={12} />
              )}
            </button>
          )}
        </div>
      </header>
      <div className="panel-workspace">
        <ThreePaneLayout
          details={<RunDetails />}
          detailsLabel="Event Details"
          navigator={<RunNavigator />}
          navigatorLabel="Sessions"
          primary={
            <div className="run-primary">
              <div className="timeline-header">
                <div aria-label="Run view" className="run-view-tabs" role="tablist">
                  <button
                    aria-controls="run-chat-panel"
                    aria-selected={view === "chat"}
                    data-active={view === "chat" || undefined}
                    id="run-chat-tab"
                    onKeyDown={handleViewKeyDown}
                    onClick={() => setView("chat")}
                    ref={chatTabRef}
                    role="tab"
                    tabIndex={view === "chat" ? 0 : -1}
                    type="button"
                  >
                    Chat
                  </button>
                  <button
                    aria-controls="run-timeline-panel"
                    aria-selected={view === "timeline"}
                    data-active={view === "timeline" || undefined}
                    id="run-timeline-tab"
                    onKeyDown={handleViewKeyDown}
                    onClick={() => setView("timeline")}
                    ref={timelineTabRef}
                    role="tab"
                    tabIndex={view === "timeline" ? 0 : -1}
                    type="button"
                  >
                    Timeline
                  </button>
                  <span className="timeline-record-count">
                    {view === "chat"
                      ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}`
                      : `${eventCount} ${eventCount === 1 ? "record" : "records"}`}
                  </span>
                </div>
                {view === "timeline" && (
                  <>
                    <span className="timeline-column-label">Duration</span>
                    <span className="timeline-column-label">Time</span>
                  </>
                )}
              </div>
              {view === "chat" ? (
                <div
                  aria-labelledby="run-chat-tab"
                  className="run-view-panel"
                  id="run-chat-panel"
                  role="tabpanel"
                >
                  <RunChat scrollRef={scrollRef} />
                </div>
              ) : (
                <div
                  aria-labelledby="run-timeline-tab"
                  className="run-view-panel"
                  id="run-timeline-panel"
                  role="tabpanel"
                >
                  <RunTimeline scrollRef={scrollRef} />
                </div>
              )}
              <RunComposer inputRef={composerRef} />
            </div>
          }
        />
      </div>
    </section>
  );
}

export function activateRunsView(
  composer: Pick<HTMLTextAreaElement, "disabled" | "focus"> | null,
  timeline: Pick<HTMLDivElement, "scrollHeight" | "scrollTop"> | null,
): boolean {
  if (timeline !== null) timeline.scrollTop = timeline.scrollHeight;
  if (composer === null || composer.disabled) return false;
  composer.focus({ preventScroll: true });
  return true;
}
