import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DevToolsController } from "@ui/controllers/devtools-controller";
import { deriveSessionTitle } from "@ui/controllers/fixture/session-title";
import { DevToolsApiClient, DevToolsApiError } from "@ui/controllers/live/api-client";
import { CdpClient } from "@ui/controllers/live/cdp-client";
import { mergeChatMessages, projectChatMessages } from "@ui/controllers/live/chat-projection";
import type {
  BootstrapResponse,
  DevToolsStreamEvent,
  LiveLogEntry,
  LiveRun,
  LiveRunEvent,
  LiveSourceEntry,
} from "@ui/controllers/live/live-types";
import {
  createLiveScenario,
  mergeTimelineEvents,
  projectLog,
  projectPause,
  projectRun,
  projectSource,
  projectTimelineEvent,
  sourceLocationsByTool,
} from "@ui/controllers/live/projections";
import type {
  ConsoleRecord,
  ChatMessage,
  PanelId,
  PrototypeScenario,
  RunSession,
  ScopeValue,
  SourceFile,
  SourceLocation,
  Theme,
  TimelineEvent,
} from "@ui/model/devtools-model";

const draftSessionId = "devtools-draft-session";

export function useLiveController(capability: string): DevToolsController {
  const api = useMemo(() => new DevToolsApiClient(capability), [capability]);
  const initial = useMemo(readInitialState, []);
  const [connectionStatus, setConnectionStatus] =
    useState<DevToolsController["connectionStatus"]>("connecting");
  const [chatMessages, setChatMessages] = useState<readonly ChatMessage[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [events, setEvents] = useState<readonly TimelineEvent[]>([]);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [panel, setPanel] = useState<PanelId>(initial.panel);
  const [scenario, setScenarioData] = useState<PrototypeScenario>(() => createLiveScenario());
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [theme, setThemeState] = useState<Theme>(initial.theme);
  const [toast, setToast] = useState<string>();
  const authoredPauseResolved = useRef(false);
  const breakpointIds = useRef(new Map<string, readonly string[]>());
  const breakpointIntents = useRef(new Set<string>());
  const cdp = useRef<CdpClient | undefined>(undefined);
  const pendingMessage = useRef<
    | {
        readonly accepted: boolean;
        readonly afterCursor: number;
        readonly sessionId?: string;
      }
    | undefined
  >(undefined);
  const optimisticMessage = useRef<
    | {
        readonly id: string;
        readonly message: string;
        readonly afterCursor: number;
        sessionId: string;
      }
    | undefined
  >(undefined);
  const pauseRef = useRef<unknown>(undefined);
  const revisionRef = useRef(scenario.runtime.revision);
  const runCursors = useRef(new Map<string, number>());
  const runEvents = useRef(new Map<string, Map<string, LiveRunEvent>>());
  const selectedRunIdRef = useRef(selectedRunId);
  const sourceByTool = useRef(sourceLocationsByTool([]));
  const sourcesRef = useRef<readonly SourceFile[]>([]);
  const titles = useRef(new Map<string, string>());

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    sourcesRef.current = scenario.sources;
    sourceByTool.current = sourceLocationsByTool(scenario.agent);
    revisionRef.current = scenario.runtime.revision;
  }, [scenario.agent, scenario.runtime.revision, scenario.sources]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
  }, [theme]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("panel", panel);
    url.searchParams.set("theme", theme);
    window.history.replaceState(null, "", url);
  }, [panel, theme]);

  useEffect(() => {
    if (toast === undefined) return;
    const timeout = window.setTimeout(() => setToast(undefined), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const applyBootstrap = useCallback((bootstrap: BootstrapResponse) => {
    pauseRef.current = bootstrap.debugger.pause;
    if (isBreakpointPause(bootstrap.debugger.pause)) setPanel("sources");
    const next = createLiveScenario(bootstrap);
    sourceByTool.current = sourceLocationsByTool(next.agent);
    setScenarioData((current) => ({
      ...next,
      debugger:
        next.runtime.status === "paused" && current.runtime.status === "paused"
          ? current.debugger
          : {
              ...next.debugger,
              scope: next.runtime.status === "paused" ? current.debugger.scope : [],
            },
      logs: current.logs,
      runs: bootstrap.runs.map((run) => projectRun(run, titles.current.get(run.sessionId))),
      sources: current.sources,
    }));
    setSelectedAgentId((current) => current ?? next.selectedAgentId);
    setSelectedRunId((current) => current ?? bootstrap.runs[0]?.sessionId);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const bootstrap = await api.get<BootstrapResponse>("/api/v1/bootstrap");
    applyBootstrap(bootstrap);
    return bootstrap;
  }, [api, applyBootstrap]);

  const refreshLogs = useCallback(async () => {
    const response = await api.get<{
      readonly entries: readonly LiveLogEntry[];
      readonly nextCursor: string;
    }>("/api/v1/logs?cursor=0");
    setScenarioData((current) => ({ ...current, logs: response.entries.map(projectLog) }));
  }, [api]);

  const refreshRuns = useCallback(async () => {
    const response = await api.get<{ readonly runs: readonly LiveRun[] }>("/api/v1/runs");
    setScenarioData((current) => ({
      ...current,
      runs: response.runs.map((run) => projectRun(run, titles.current.get(run.sessionId))),
    }));
  }, [api]);

  const refreshRunEvents = useCallback(
    async (sessionId: string) => {
      if (sessionId === draftSessionId) {
        setEvents((current) => current.filter((event) => event.sessionId !== draftSessionId));
        return;
      }
      const response = await api.get<{ readonly events: readonly LiveRunEvent[] }>(
        `/api/v1/runs/${encodeURIComponent(sessionId)}/events?cursor=0`,
      );
      const retainedEvents = runEvents.current.get(sessionId) ?? new Map<string, LiveRunEvent>();
      for (const event of response.events) retainedEvents.set(event.cursor, event);
      runEvents.current.set(sessionId, retainedEvents);
      const allRunEvents = [...retainedEvents.values()].sort(
        (left, right) => Number(left.cursor) - Number(right.cursor),
      );
      const projected = response.events
        .map((event) => projectTimelineEvent(event, revisionRef.current, sourceByTool.current))
        .filter((event): event is TimelineEvent => event !== undefined);
      const projectedMessages = projectChatMessages(allRunEvents);
      const optimistic = optimisticMessage.current;
      const confirmedOptimistic =
        optimistic !== undefined &&
        optimistic.sessionId === sessionId &&
        hasConfirmedChatMessage(projectedMessages, optimistic.message, optimistic.afterCursor)
          ? optimistic
          : undefined;
      if (confirmedOptimistic !== undefined) optimisticMessage.current = undefined;
      const firstMessage = projected.find((event) => event.kind === "user")?.summary;
      if (firstMessage !== undefined)
        titles.current.set(sessionId, deriveSessionTitle(firstMessage));
      const latestCursor = response.events.reduce(
        (latest, event) => Math.max(latest, Number(event.cursor) || 0),
        0,
      );
      runCursors.current.set(
        sessionId,
        Math.max(runCursors.current.get(sessionId) ?? 0, latestCursor),
      );
      setEvents((current) => mergeTimelineEvents(current, sessionId, projected));
      setChatMessages((current) =>
        mergeChatMessages(
          confirmedOptimistic === undefined
            ? current
            : current.filter((message) => message.id !== confirmedOptimistic.id),
          sessionId,
          projectedMessages,
        ),
      );
      setScenarioData((current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id === sessionId && firstMessage !== undefined
            ? { ...run, label: deriveSessionTitle(firstMessage) }
            : run,
        ),
      }));
      setSelectedEventId((current) => current ?? projected.at(-1)?.id);
      const pending = pendingMessage.current;
      if (
        pending?.accepted === true &&
        pending.sessionId === sessionId &&
        projected.some((event) => timelineEventCursor(event) > pending.afterCursor)
      ) {
        pendingMessage.current = undefined;
        setIsSendingMessage(false);
      }
    },
    [api],
  );

  const bindBreakpoint = useCallback(
    async (source: SourceFile, line: number) => {
      const debuggerClient = cdp.current;
      if (debuggerClient === undefined || !source.loaded) return;
      const key = breakpointKey(source.id, line);
      if (breakpointIds.current.has(key)) return;
      const response = await api.get<{
        readonly locations: readonly {
          readonly columnNumber: number;
          readonly lineNumber: number;
          readonly scriptId: string;
        }[];
      }>(
        `/api/v1/sources/${encodeURIComponent(source.id)}/locations?line=${encodeURIComponent(line)}`,
      );
      const ids: string[] = [];
      for (const location of response.locations) {
        const bound = await debuggerClient.command<{ readonly breakpointId: string }>(
          "Debugger.setBreakpoint",
          { location },
        );
        ids.push(bound.breakpointId);
      }
      if (ids.length === 0) throw new Error(`No loaded script maps to ${source.path}:${line}.`);
      breakpointIds.current.set(key, ids);
    },
    [api],
  );

  const applyPauseSnapshot = useCallback(
    (debuggerState: PrototypeScenario["debugger"], sources: readonly SourceFile[]) => {
      setScenarioData((current) => ({
        ...current,
        debugger: debuggerState,
        runtime: { ...current.runtime, status: "paused" },
      }));
      const authoredFrame = debuggerState.callStack.find(
        (frame) => frame.id === debuggerState.authoredFrameId,
      );
      const source = sources.find(
        (candidate) =>
          candidate.id === authoredFrame?.location.path ||
          candidate.path === authoredFrame?.location.path,
      );
      if (source !== undefined) setSelectedSourceId(source.id);
      authoredPauseResolved.current = source !== undefined;
    },
    [],
  );

  const refreshSources = useCallback(async () => {
    const response = await api.get<{ readonly sources: readonly LiveSourceEntry[] }>(
      "/api/v1/sources",
    );
    const previous = new Map(sourcesRef.current.map((source) => [source.id, source]));
    const nextSources = response.sources.map((entry) => {
      const existing = previous.get(entry.id);
      return {
        ...projectSource(entry, existing?.content),
        breakpointLines: existing?.breakpointLines ?? [],
      };
    });
    sourcesRef.current = nextSources;
    setScenarioData((current) => ({ ...current, sources: nextSources }));
    setSelectedSourceId((current) => current ?? response.sources[0]?.id);
    for (const intent of breakpointIntents.current) {
      const parsed = parseBreakpointKey(intent);
      const source = nextSources.find((candidate) => candidate.id === parsed.sourceId);
      if (source !== undefined) void bindBreakpoint(source, parsed.line).catch(() => {});
    }
    const pause = pauseRef.current;
    const debuggerClient = cdp.current;
    if (pause !== undefined && debuggerClient !== undefined && !authoredPauseResolved.current) {
      void hydratePause(api, debuggerClient, pause, nextSources)
        .then((snapshot) => applyPauseSnapshot(snapshot, nextSources))
        .catch(() => {});
    }
  }, [api, applyPauseSnapshot, bindBreakpoint]);

  const loadSource = useCallback(
    async (sourceId: string) => {
      const response = await api.get<{
        readonly content: string;
        readonly source: LiveSourceEntry;
      }>(`/api/v1/sources/${encodeURIComponent(sourceId)}`);
      setScenarioData((current) => ({
        ...current,
        sources: current.sources.map((source) =>
          source.id === sourceId
            ? {
                ...projectSource(response.source, response.content),
                breakpointLines: source.breakpointLines,
              }
            : source,
        ),
      }));
    },
    [api],
  );

  useEffect(() => {
    const abort = new AbortController();
    async function initialize(): Promise<void> {
      try {
        const bootstrap = await refreshBootstrap();
        await Promise.all([refreshLogs(), refreshSources()]);
        const firstRunId = bootstrap.runs[0]?.sessionId;
        if (firstRunId !== undefined) await refreshRunEvents(firstRunId);
        setConnectionStatus("connected");
      } catch (error) {
        setConnectionStatus(
          error instanceof DevToolsApiError && error.status === 401
            ? "unauthorized"
            : "disconnected",
        );
      }
    }
    void initialize();

    void api
      .subscribe({
        onConnectionChange(connected) {
          setConnectionStatus(connected ? "connected" : "disconnected");
        },
        onEvent(event) {
          handleStreamEvent(event, {
            refreshBootstrap,
            refreshLogs,
            refreshRunEvents,
            refreshRuns,
            refreshSources,
            selectedRunId: () => selectedRunIdRef.current,
          });
        },
        signal: abort.signal,
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        setConnectionStatus(
          error instanceof DevToolsApiError && error.status === 401
            ? "unauthorized"
            : "disconnected",
        );
      });
    return () => abort.abort();
  }, [api, refreshBootstrap, refreshLogs, refreshRunEvents, refreshRuns, refreshSources]);

  useEffect(() => {
    if (!scenario.runtime.debuggerConnected || cdp.current !== undefined) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void CdpClient.connect(api)
      .then((client) => {
        if (!active) {
          client.close();
          return;
        }
        cdp.current = client;
        unsubscribe = client.onEvent((method, params) => {
          if (method === "Debugger.paused") {
            pauseRef.current = params;
            authoredPauseResolved.current = false;
            if (isBreakpointPause(params)) setPanel("sources");
            void hydratePause(api, client, params, sourcesRef.current)
              .then((snapshot) => applyPauseSnapshot(snapshot, sourcesRef.current))
              .catch(() => {});
          }
          if (method === "Debugger.resumed") {
            pauseRef.current = undefined;
            authoredPauseResolved.current = false;
            setScenarioData((current) => ({
              ...current,
              debugger: { callStack: [], scope: [] },
              runtime: { ...current.runtime, status: "ready" },
            }));
          }
          if (method === "Debugger.scriptParsed") void refreshSources();
        });
        void api
          .get<{ readonly debugger: { readonly pause?: unknown } }>("/api/v1/debugger/state")
          .then((response) => {
            if (response.debugger.pause !== undefined) {
              pauseRef.current = response.debugger.pause;
              return hydratePause(api, client, response.debugger.pause, sourcesRef.current).then(
                (snapshot) => applyPauseSnapshot(snapshot, sourcesRef.current),
              );
            }
          })
          .catch(() => {});
        for (const intent of breakpointIntents.current) {
          const parsed = parseBreakpointKey(intent);
          const source = sourcesRef.current.find((candidate) => candidate.id === parsed.sourceId);
          if (source !== undefined) void bindBreakpoint(source, parsed.line).catch(() => {});
        }
      })
      .catch(() => setToast("Debugger controller is unavailable"));
    return () => {
      active = false;
      unsubscribe?.();
      cdp.current?.close();
      cdp.current = undefined;
    };
  }, [api, applyPauseSnapshot, bindBreakpoint, refreshSources, scenario.runtime.debuggerConnected]);

  useEffect(() => {
    if (selectedRunId !== undefined) void refreshRunEvents(selectedRunId).catch(() => {});
  }, [refreshRunEvents, selectedRunId]);

  useEffect(() => {
    if (selectedSourceId === undefined) return;
    const source = scenario.sources.find((candidate) => candidate.id === selectedSourceId);
    if (source !== undefined && source.content === "") {
      void loadSource(selectedSourceId).catch(() => {});
    }
  }, [loadSource, scenario.sources, selectedSourceId]);

  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const selectedAgent = scenario.agent.find((definition) => definition.id === selectedAgentId);
  const selectedSource = scenario.sources.find((source) => source.id === selectedSourceId);

  return {
    chatMessages,
    clearToast: () => setToast(undefined),
    connectionStatus,
    consoleOpen,
    debuggerCommand(command) {
      const method = {
        pause: "Debugger.pause",
        resume: "Debugger.resume",
        stepInto: "Debugger.stepInto",
        stepOut: "Debugger.stepOut",
        stepOver: "Debugger.stepOver",
      }[command];
      void cdp.current?.command(method).catch((error) => setToast(errorMessage(error)));
    },
    draft,
    async evaluateExpression(expression) {
      const client = cdp.current;
      if (client === undefined) {
        setToast("Debugger controller is unavailable");
        return;
      }
      try {
        const callFrameId = scenario.debugger.callStack[0]?.id;
        const response = await client.command<{ readonly result?: unknown }>(
          callFrameId === undefined ? "Runtime.evaluate" : "Debugger.evaluateOnCallFrame",
          callFrameId === undefined
            ? { expression, generatePreview: true, returnByValue: true }
            : { callFrameId, expression, generatePreview: true, returnByValue: true },
        );
        const record = evaluationRecord(expression, response.result, selectedRunId, scenario);
        setScenarioData((current) => ({ ...current, logs: [...current.logs, record] }));
      } catch (error) {
        setToast(errorMessage(error));
      }
    },
    events,
    isFixture: false,
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
      setSelectedEventId(undefined);
    },
    selectedRunId,
    selectSource(id) {
      setSelectedSourceId(id);
      void loadSource(id).catch((error) => setToast(errorMessage(error)));
    },
    selectedSource,
    async sendMessage() {
      const message = draft.trim();
      if (message.length === 0 || isSendingMessage) return;
      const continuingSessionId =
        selectedRunId === undefined || selectedRunId === draftSessionId ? undefined : selectedRunId;
      const afterCursor =
        continuingSessionId === undefined ? 0 : (runCursors.current.get(continuingSessionId) ?? 0);
      const submissionId = globalThis.crypto.randomUUID();
      const optimisticSessionId = continuingSessionId ?? draftSessionId;
      const optimisticId = `optimistic:${submissionId}:user`;
      optimisticMessage.current = {
        id: optimisticId,
        message,
        afterCursor,
        sessionId: optimisticSessionId,
      };
      setChatMessages((current) => [
        ...current,
        createOptimisticChatMessage(message, submissionId, optimisticSessionId),
      ]);
      pendingMessage.current = {
        accepted: false,
        afterCursor,
        sessionId: continuingSessionId,
      };
      setIsSendingMessage(true);
      try {
        const response =
          selectedRunId === undefined || selectedRunId === draftSessionId
            ? await api.post<{ readonly run: LiveRun }>("/api/v1/runs", { message })
            : await api.post<{ readonly run: LiveRun }>(
                `/api/v1/runs/${encodeURIComponent(selectedRunId)}/messages`,
                { message },
              );
        pendingMessage.current = {
          accepted: true,
          afterCursor: pendingMessage.current?.afterCursor ?? 0,
          sessionId: response.run.sessionId,
        };
        if (optimisticMessage.current?.id === optimisticId) {
          optimisticMessage.current.sessionId = response.run.sessionId;
        }
        setChatMessages((current) =>
          current.map((candidate) =>
            candidate.id === optimisticId
              ? { ...candidate, sessionId: response.run.sessionId }
              : candidate,
          ),
        );
        titles.current.set(response.run.sessionId, deriveSessionTitle(message));
        setSelectedRunId(response.run.sessionId);
        setDraft("");
        await refreshRuns();
        await refreshRunEvents(response.run.sessionId);
      } catch (error) {
        if (optimisticMessage.current?.id === optimisticId) optimisticMessage.current = undefined;
        setChatMessages((current) =>
          current.map((candidate) =>
            candidate.id === optimisticId ? { ...candidate, status: "failed" } : candidate,
          ),
        );
        pendingMessage.current = undefined;
        setIsSendingMessage(false);
        setToast(errorMessage(error));
      }
    },
    setDraft,
    setScenario() {},
    setTheme: setThemeState,
    startSession() {
      const nextRun: RunSession = {
        activity: "Now",
        id: draftSessionId,
        label: "Untitled session",
        revision: scenario.runtime.revision,
        status: "waiting",
        trigger: "message",
      };
      setScenarioData((current) => ({
        ...current,
        runs: [nextRun, ...current.runs.filter((run) => run.id !== draftSessionId)],
      }));
      setSelectedRunId(draftSessionId);
      setSelectedEventId(undefined);
      setEvents((current) => current.filter((event) => event.sessionId !== draftSessionId));
      setChatMessages((current) =>
        current.filter((message) => message.sessionId !== draftSessionId),
      );
    },
    theme,
    toast,
    toggleBreakpoint(line) {
      const source = selectedSource;
      if (source === undefined) return;
      const key = breakpointKey(source.id, line);
      const removing = source.breakpointLines.includes(line);
      setScenarioData((current) => ({
        ...current,
        sources: current.sources.map((candidate) =>
          candidate.id === source.id
            ? {
                ...candidate,
                breakpointLines: removing
                  ? candidate.breakpointLines.filter((value) => value !== line)
                  : [...candidate.breakpointLines, line],
              }
            : candidate,
        ),
      }));
      if (removing) {
        breakpointIntents.current.delete(key);
        const boundIds = breakpointIds.current.get(key) ?? [];
        breakpointIds.current.delete(key);
        for (const breakpointId of boundIds) {
          void cdp.current
            ?.command("Debugger.removeBreakpoint", { breakpointId })
            .catch((error) => setToast(errorMessage(error)));
        }
      } else {
        breakpointIntents.current.add(key);
        void bindBreakpoint(source, line).catch((error) => setToast(errorMessage(error)));
      }
    },
    toggleConsole: () => setConsoleOpen((open) => !open),
  };
}

function readInitialState(): { readonly panel: PanelId; readonly theme: Theme } {
  const params = new URLSearchParams(window.location.search);
  const requestedPanel = params.get("panel");
  const requestedTheme = params.get("theme");
  return {
    panel:
      requestedPanel === "agent" ||
      requestedPanel === "sources" ||
      requestedPanel === "console" ||
      requestedPanel === "runs"
        ? requestedPanel
        : "runs",
    theme:
      requestedTheme === "dark" || requestedTheme === "light"
        ? requestedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
  };
}

function handleStreamEvent(
  event: DevToolsStreamEvent,
  input: {
    readonly refreshBootstrap: () => Promise<unknown>;
    readonly refreshLogs: () => Promise<unknown>;
    readonly refreshRunEvents: (sessionId: string) => Promise<unknown>;
    readonly refreshRuns: () => Promise<unknown>;
    readonly refreshSources: () => Promise<unknown>;
    readonly selectedRunId: () => string | undefined;
  },
): void {
  const safely = (promise: Promise<unknown>) => void promise.catch(() => {});
  if (event.event.startsWith("run.")) {
    safely(input.refreshRuns());
    const selectedRunId = input.selectedRunId();
    if (selectedRunId !== undefined) safely(input.refreshRunEvents(selectedRunId));
  } else if (event.event === "log.entry") {
    safely(input.refreshLogs());
  } else if (event.event.startsWith("source.")) {
    safely(input.refreshSources());
  } else if (event.event.startsWith("runtime.") || event.event.startsWith("debugger.")) {
    safely(input.refreshBootstrap());
  } else if (event.event === "stream.reset") {
    safely(
      Promise.all([
        input.refreshBootstrap(),
        input.refreshLogs(),
        input.refreshRuns(),
        input.refreshSources(),
      ]),
    );
  }
}

async function hydratePause(
  api: DevToolsApiClient,
  client: CdpClient,
  params: unknown,
  sources: readonly SourceFile[],
): Promise<PrototypeScenario["debugger"]> {
  const pause = isRecord(params) ? params : {};
  const frames = Array.isArray(pause.callFrames) ? pause.callFrames.filter(isRecord) : [];
  const firstFrame = frames[0];
  const locationsByFrame = new Map<string, SourceLocation>();
  await Promise.all(
    frames.map(async (frame) => {
      const frameId = typeof frame.callFrameId === "string" ? frame.callFrameId : undefined;
      const location = isRecord(frame.location) ? frame.location : undefined;
      const scriptId = typeof location?.scriptId === "string" ? location.scriptId : undefined;
      const line = typeof location?.lineNumber === "number" ? location.lineNumber : undefined;
      const column = typeof location?.columnNumber === "number" ? location.columnNumber : undefined;
      if (frameId === undefined || scriptId === undefined || line === undefined) return;
      try {
        const response = await api.get<{
          readonly location?: {
            readonly column: number;
            readonly line: number;
            readonly sourceId: string;
          };
        }>(
          `/api/v1/sources/resolve?scriptId=${encodeURIComponent(scriptId)}&line=${encodeURIComponent(line)}&column=${encodeURIComponent(column ?? 0)}`,
        );
        if (response.location !== undefined) {
          locationsByFrame.set(frameId, {
            column: response.location.column,
            line: response.location.line,
            path: response.location.sourceId,
          });
        }
      } catch {
        // Generated frames without authored source-map entries remain visible as-is.
      }
    }),
  );
  const scopeChain = Array.isArray(firstFrame?.scopeChain)
    ? firstFrame.scopeChain.filter(isRecord).filter((item) => item.type !== "global")
    : [];
  const scope: ScopeValue[] = [];
  for (const item of scopeChain.slice(0, 3)) {
    const object = isRecord(item.object) ? item.object : undefined;
    const objectId = typeof object?.objectId === "string" ? object.objectId : undefined;
    if (objectId === undefined) continue;
    let response: { readonly result?: readonly unknown[] };
    try {
      response = await client.command("Runtime.getProperties", {
        generatePreview: true,
        objectId,
        ownProperties: true,
      });
    } catch {
      continue;
    }
    for (const property of response.result?.filter(isRecord).slice(0, 100) ?? []) {
      const value = isRecord(property.value) ? property.value : {};
      scope.push({
        name: typeof property.name === "string" ? property.name : "value",
        type: typeof value.type === "string" ? value.type : "unknown",
        value: remoteObjectText(value),
      });
    }
  }
  return { ...projectPause(params, sources, locationsByFrame), scope };
}

function evaluationRecord(
  expression: string,
  result: unknown,
  selectedRunId: string | undefined,
  scenario: PrototypeScenario,
): ConsoleRecord {
  return {
    coordinates:
      selectedRunId === undefined
        ? undefined
        : {
            revision: scenario.runtime.revision,
            session: selectedRunId,
          },
    id: `evaluation-${Date.now()}`,
    level: "info",
    message: `› ${expression}\n${remoteObjectText(isRecord(result) ? result : {})}`,
    stream: "console",
    timestamp: new Intl.DateTimeFormat(undefined, {
      fractionalSecondDigits: 3,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date()),
  };
}

function remoteObjectText(value: Readonly<Record<string, unknown>>): string {
  if ("value" in value) return JSON.stringify(value.value);
  if (typeof value.description === "string") return value.description;
  if (typeof value.type === "string") return value.type;
  return "undefined";
}

function breakpointKey(sourceId: string, line: number): string {
  return `${sourceId}:${line}`;
}

function parseBreakpointKey(key: string): { readonly line: number; readonly sourceId: string } {
  const separator = key.lastIndexOf(":");
  return { line: Number(key.slice(separator + 1)), sourceId: key.slice(0, separator) };
}

function timelineEventCursor(event: TimelineEvent): number {
  const parsed = Number(event.id.startsWith("event-") ? event.id.slice("event-".length) : 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function chatMessageText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function chatMessageCursor(message: ChatMessage): number {
  for (const part of message.parts) {
    if (part.type !== "text" || part.eventId === undefined) continue;
    const parsed = Number(
      part.eventId.startsWith("event-") ? part.eventId.slice("event-".length) : 0,
    );
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}

export function hasConfirmedChatMessage(
  messages: readonly ChatMessage[],
  text: string,
  afterCursor: number,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      chatMessageCursor(message) > afterCursor &&
      chatMessageText(message) === text,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBreakpointPause(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.reason === "breakpoint") return true;
  return Array.isArray(value.hitBreakpoints) && value.hitBreakpoints.length > 0;
}

export function createOptimisticChatMessage(
  message: string,
  submissionId: string,
  sessionId: string,
): ChatMessage {
  return {
    id: `optimistic:${submissionId}:user`,
    optimistic: true,
    parts: [{ state: "done", text: message, type: "text" }],
    role: "user",
    sessionId,
    status: "streaming",
  };
}
