import { useEffect, useMemo, useRef, useState } from "react";

import type { DevToolsController } from "@ui/controllers/devtools-controller";
import { projectFixtureChatMessages } from "@ui/controllers/fixture/chat-messages";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { deriveSessionTitle } from "@ui/controllers/fixture/session-title";
import type {
  PanelId,
  RunSession,
  ScenarioId,
  Theme,
  TimelineEvent,
} from "@ui/model/devtools-model";

const panelIds = new Set<PanelId>(["runs", "agent", "sources", "console"]);
const scenarioIds = new Set<ScenarioId>(["empty", "running", "paused", "crashed", "stress"]);

export function useFixtureController(): DevToolsController {
  const initial = useMemo(readInitialState, []);
  const [scenarioId, setScenarioId] = useState<ScenarioId>(initial.scenario);
  const [panel, setPanel] = useState<PanelId>(initial.panel);
  const [theme, setThemeState] = useState<Theme>(initial.theme);
  const [scenario, setScenarioData] = useState(() => createPrototypeScenario(initial.scenario));
  const [events, setEvents] = useState<readonly TimelineEvent[]>(scenario.events);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(scenario.selectedRunId);
  const [selectedEventId, setSelectedEventId] = useState(scenario.selectedEventId);
  const [selectedAgentId, setSelectedAgentId] = useState(scenario.selectedAgentId);
  const [selectedSourceId, setSelectedSourceId] = useState(scenario.selectedSourceId);
  const [consoleOpen, setConsoleOpen] = useState(scenario.id === "paused");
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<string>();
  const sendTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (sendTimer.current !== undefined) window.clearTimeout(sendTimer.current);
    },
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
  }, [theme]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", scenarioId);
    url.searchParams.set("panel", panel);
    url.searchParams.set("theme", theme);
    window.history.replaceState(null, "", url);
  }, [panel, scenarioId, theme]);

  useEffect(() => {
    if (toast === undefined) return;
    const timeout = window.setTimeout(() => setToast(undefined), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function setScenario(id: ScenarioId): void {
    if (sendTimer.current !== undefined) window.clearTimeout(sendTimer.current);
    sendTimer.current = undefined;
    const next = createPrototypeScenario(id);
    setScenarioId(id);
    setScenarioData(next);
    setEvents(next.events);
    setSelectedRunId(next.selectedRunId);
    setSelectedEventId(next.selectedEventId);
    setSelectedAgentId(next.selectedAgentId);
    setSelectedSourceId(next.selectedSourceId);
    setConsoleOpen(id === "paused");
    if (id === "paused") setPanel("sources");
    setDraft("");
    setIsSendingMessage(false);
  }

  function setTheme(nextTheme: Theme): void {
    setThemeState(nextTheme);
  }

  function sendMessage(): void {
    const message = draft.trim();
    if (message.length === 0 || isSendingMessage) return;
    setIsSendingMessage(true);
    const sessionId = selectedRunId ?? `session-fixture-${Date.now()}`;
    const nextEvent: TimelineEvent = {
      coordinates: {
        revision: scenario.runtime.revision,
        session: sessionId,
        turn: "4",
      },
      id: `fixture-message-${Date.now()}`,
      input: { message },
      kind: "user",
      label: "User Message",
      raw: { data: { message }, type: "message.created" },
      sessionId,
      status: "completed",
      summary: message,
      time: new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date()),
    };
    setScenarioData((current) => ({
      ...current,
      runs:
        selectedRunId === undefined
          ? [
              {
                activity: "Now",
                id: sessionId,
                label: deriveSessionTitle(message),
                revision: current.runtime.revision,
                status: "waiting",
                trigger: "message",
              },
              ...current.runs,
            ]
          : current.runs.map((run) =>
              run.id === sessionId && run.label === "Untitled session"
                ? { ...run, label: deriveSessionTitle(message) }
                : run,
            ),
    }));
    setEvents((current) => [...current, nextEvent]);
    setSelectedRunId(sessionId);
    setSelectedEventId(nextEvent.id);
    setDraft("");
    setToast("Fixture message added");
    sendTimer.current = window.setTimeout(() => {
      sendTimer.current = undefined;
      setIsSendingMessage(false);
    }, 700);
  }

  function startSession(): void {
    const id = `session-fixture-${Date.now()}`;
    const nextRun: RunSession = {
      activity: "Now",
      id,
      label: "Untitled session",
      revision: scenario.runtime.revision,
      status: "waiting",
      trigger: "message",
    };
    setScenarioData((current) => ({ ...current, runs: [nextRun, ...current.runs] }));
    setSelectedRunId(id);
    setSelectedEventId(undefined);
    setToast("Fixture session created");
  }

  function evaluateExpression(expression: string): void {
    const activeEvent = events.find((event) => event.id === selectedEventId);
    const result = fixtureEvaluationResult(expression, scenario, selectedRunId);
    setScenarioData((current) => ({
      ...current,
      logs: [
        ...current.logs,
        {
          coordinates:
            selectedRunId === undefined
              ? undefined
              : {
                  action: activeEvent?.coordinates.action,
                  revision: current.runtime.revision,
                  session: selectedRunId,
                  step: activeEvent?.coordinates.step,
                  turn: activeEvent?.coordinates.turn,
                },
          id: `fixture-evaluation-${Date.now()}`,
          level: "info",
          message: `› ${expression}\n${result}`,
          stream: "console",
          timestamp: new Intl.DateTimeFormat(undefined, {
            fractionalSecondDigits: 3,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(new Date()),
        },
      ],
    }));
  }

  function toggleBreakpoint(line: number): void {
    if (selectedSourceId === undefined) return;
    setScenarioData((current) => ({
      ...current,
      sources: current.sources.map((source) =>
        source.id !== selectedSourceId
          ? source
          : {
              ...source,
              breakpointLines: source.breakpointLines.includes(line)
                ? source.breakpointLines.filter((candidate) => candidate !== line)
                : [...source.breakpointLines, line],
            },
      ),
    }));
  }

  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const chatMessages = useMemo(() => projectFixtureChatMessages(events), [events]);
  const selectedAgent = scenario.agent.find((definition) => definition.id === selectedAgentId);
  const selectedSource = scenario.sources.find((source) => source.id === selectedSourceId);

  return {
    chatMessages,
    clearToast: () => setToast(undefined),
    connectionStatus: "connected",
    consoleOpen,
    debuggerCommand(command) {
      setScenario(command === "resume" ? "running" : "paused");
    },
    draft,
    evaluateExpression,
    events,
    isFixture: true,
    isSendingMessage,
    panel,
    scenario,
    selectAgent: setSelectedAgentId,
    selectedAgent,
    selectEvent: setSelectedEventId,
    selectedEvent,
    selectPanel: setPanel,
    selectRun(id) {
      setSelectedRunId(id);
      const firstEvent = events.find((event) => event.sessionId === id);
      setSelectedEventId(firstEvent?.id);
    },
    selectedRunId,
    selectSource: setSelectedSourceId,
    selectedSource,
    sendMessage,
    setDraft,
    setScenario,
    setTheme,
    startSession,
    theme,
    toast,
    toggleBreakpoint,
    toggleConsole: () => setConsoleOpen((open) => !open),
  };
}

function fixtureEvaluationResult(
  expression: string,
  scenario: ReturnType<typeof createPrototypeScenario>,
  selectedRunId: string | undefined,
): string {
  if (expression === "runtime.status") return JSON.stringify(scenario.runtime.status);
  if (expression === "runtime.revision") return JSON.stringify(scenario.runtime.revision);
  if (expression === "session.id") {
    return selectedRunId === undefined ? "undefined" : JSON.stringify(selectedRunId);
  }
  return scenario.debugger.scope.find((entry) => entry.name === expression)?.value ?? "undefined";
}

function readInitialState(): {
  readonly panel: PanelId;
  readonly scenario: ScenarioId;
  readonly theme: Theme;
} {
  const params = new URLSearchParams(window.location.search);
  const requestedPanel = params.get("panel") as PanelId | null;
  const requestedScenario = params.get("scenario") as ScenarioId | null;
  const requestedTheme = params.get("theme") as Theme | null;
  return {
    panel: requestedPanel !== null && panelIds.has(requestedPanel) ? requestedPanel : "runs",
    scenario:
      requestedScenario !== null && scenarioIds.has(requestedScenario)
        ? requestedScenario
        : "running",
    theme:
      requestedTheme === "dark" || requestedTheme === "light"
        ? requestedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
  };
}
