import type {
  AgentDefinition,
  ConsoleRecord,
  PrototypeScenario,
  RunSession,
  ScenarioId,
  SourceFile,
  TimelineEvent,
} from "@ui/model/devtools-model";

const revision = "a81f2c9";
const activeSession = "session-8d2f1c";

const authoredSource = `import { defineTool } from "eve";
import { z } from "zod";

import { weatherClient } from "../../connections/weather";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
    units: z.enum(["celsius", "fahrenheit"]),
  }),
  execute: async ({ city, units }) => {
    console.info("Fetching forecast", { city, units });

    const forecast = await weatherClient.current({
      city,
      units,
    });

    return {
      city,
      condition: forecast.condition,
      temperature: forecast.temperature,
      units,
    };
  },
});`;

const sourceFiles: readonly SourceFile[] = [
  {
    breakpointLines: [15],
    content: authoredSource,
    id: "agent/tools/get_weather.ts",
    language: "TypeScript",
    loaded: true,
    path: "agent/tools/get_weather.ts",
    revision,
  },
  {
    breakpointLines: [],
    content: `import { defineHook } from "eve";\n\nexport default defineHook({\n  beforeRun({ sessionId }) {\n    console.debug("Starting run", sessionId);\n  },\n});`,
    id: "agent/hooks/audit.ts",
    language: "TypeScript",
    loaded: true,
    path: "agent/hooks/audit.ts",
    revision,
  },
  {
    breakpointLines: [],
    content: `You are a concise weather agent.\n\nAlways name the requested city and temperature unit.`,
    id: "agent/instructions.md",
    language: "Markdown",
    loaded: false,
    path: "agent/instructions.md",
    revision,
  },
];

const agentDefinitions: readonly AgentDefinition[] = [
  definition("instructions", "Instructions", "group", "Resolved instructions."),
  definition(
    "instructions-active",
    "Instructions",
    "instructions",
    "The active system instructions.",
    {
      parentId: "instructions",
      source: { line: 1, path: "agent/instructions.md" },
    },
  ),
  definition("model", "Model & Routing", "model", "The model selected for this agent.", {
    config: {
      model: "anthropic/claude-haiku-4.5",
      provider: "Vercel AI Gateway",
    },
  }),
  definition("tools", "Tools", "group", "3 resolved tools."),
  definition("tools-authored", "Authored", "group", "Authored tools.", { parentId: "tools" }),
  definition("tool-weather", "get_weather", "tool", "Get the current weather for a city.", {
    parentId: "tools-authored",
    source: { line: 6, path: "agent/tools/get_weather.ts" },
    config: { approval: "never", input: ["city", "units"] },
  }),
  definition("tool-forecast", "get_forecast", "tool", "Get a 5-day forecast.", {
    parentId: "tools-authored",
    source: { line: 5, path: "agent/tools/get_forecast.ts" },
  }),
  definition("tools-framework", "Framework", "group", "Framework tools.", {
    parentId: "tools",
  }),
  definition("tool-question", "ask_question", "tool", "Ask the user for input.", {
    parentId: "tools-framework",
    provenance: "framework",
  }),
  definition("skills", "Skills", "group", "1 loaded skill."),
  definition("skill-travel", "travel-planning", "skill", "Guidance for weather-aware trips.", {
    parentId: "skills",
    source: { line: 1, path: "agent/skills/travel-planning/SKILL.md" },
  }),
  definition("connections", "Connections", "group", "1 configured connection."),
  definition("connection-weather", "weather", "connection", "Weather data provider.", {
    parentId: "connections",
    config: { auth: "Configured", scope: "Read only" },
  }),
  definition("channels", "Channels", "group", "2 message channels."),
  definition("channels-authored", "Authored", "group", "Authored channels.", {
    parentId: "channels",
  }),
  definition("channel-slack", "slack", "channel", "Slack channel adapter.", {
    parentId: "channels-authored",
  }),
  definition("channels-framework", "Framework", "group", "Framework channels.", {
    parentId: "channels",
  }),
  definition("channel-eve", "eve", "channel", "Default Eve session channel.", {
    parentId: "channels-framework",
    provenance: "framework",
  }),
  definition("schedules", "Schedules", "group", "1 recurring schedule."),
  definition("schedule-brief", "morning-brief", "schedule", "Weekday weather briefing.", {
    parentId: "schedules",
    config: { cron: "0 7 * * 1-5", timezone: "Europe/Berlin" },
  }),
  definition("hooks", "Hooks", "group", "1 runtime hook."),
  definition("hook-audit", "audit", "hook", "Records local run lifecycle events.", {
    parentId: "hooks",
    source: { line: 3, path: "agent/hooks/audit.ts" },
  }),
  definition("subagents", "Subagents", "group", "1 declared subagent."),
  definition("subagent-research", "researcher", "subagent", "Researches climate context.", {
    parentId: "subagents",
  }),
  definition("sandbox", "Sandbox", "sandbox", "Local sandbox configuration.", {
    config: { backend: "Docker", workspace: "/workspace" },
  }),
  definition("workspace", "Workspace", "workspace", "Resolved app and artifact paths.", {
    config: { root: "~/weather-agent", revision },
  }),
];

const runs: readonly RunSession[] = [
  {
    activity: "Now",
    childCount: 1,
    id: activeSession,
    label: "Berlin weather",
    revision,
    status: "running",
    trigger: "message",
  },
  {
    activity: "12 min",
    id: "session-519a20",
    label: "Morning brief",
    revision,
    status: "completed",
    trigger: "schedule",
  },
  {
    activity: "1 hr",
    id: "session-a02e77",
    label: "Trip packing advice",
    pendingAction: { kind: "question", name: "ask_question" },
    revision: "79bc102",
    status: "waiting",
    trigger: "channel",
  },
  {
    activity: "Now",
    id: "session-c421d9",
    label: "Climate context",
    parentId: activeSession,
    revision,
    status: "completed",
    trigger: "subagent",
  },
];

const completeEvents: readonly TimelineEvent[] = [
  event("evt-1", "user", "User Message", "What is the weather in Berlin?", "10:42:11", {
    input: { message: "What is the weather in Berlin?" },
  }),
  event("evt-2", "model", "Model Call", "anthropic/claude-haiku-4.5", "10:42:12", {
    duration: "1.2 s",
    input: { messages: 3, tools: ["get_weather", "get_forecast"] },
    output: { actions: 1, finishReason: "tool-calls", tokens: 1842 },
  }),
  event("evt-3", "action", "Action", "get_weather", "10:42:13", {
    duration: "48 ms",
    input: { city: "Berlin", units: "celsius" },
    output: { city: "Berlin", condition: "Cloudy", temperature: 18, units: "celsius" },
    source: { line: 15, path: "agent/tools/get_weather.ts" },
  }),
  event("evt-4", "checkpoint", "Checkpoint Saved", "State committed at step 1", "10:42:13", {
    duration: "7 ms",
  }),
  event("evt-5", "subagent", "Subagent", "researcher completed climate context", "10:42:14", {
    depth: 1,
    duration: "806 ms",
    output: { sessionId: "session-c421d9", status: "completed" },
  }),
  event("evt-6", "assistant", "Assistant", "Berlin is cloudy and 18 C right now.", "10:42:15", {
    duration: "620 ms",
    output: { text: "Berlin is cloudy and 18 C right now." },
  }),
];

const logs: readonly ConsoleRecord[] = [
  {
    coordinates: coordinates("evt-3"),
    id: "log-1",
    level: "info",
    message: 'Fetching forecast { city: "Berlin", units: "celsius" }',
    source: { line: 13, path: "agent/tools/get_weather.ts" },
    stream: "console",
    timestamp: "10:42:13.041",
  },
  {
    coordinates: coordinates("evt-3"),
    id: "log-2",
    level: "debug",
    message: "weather.current completed in 42 ms",
    source: { line: 15, path: "agent/tools/get_weather.ts" },
    stream: "stdout",
    timestamp: "10:42:13.089",
  },
  {
    id: "log-3",
    level: "info",
    message: "Runtime revision a81f2c9 is ready",
    stream: "system",
    timestamp: "10:42:08.612",
  },
];

export const scenarioOptions: readonly { readonly id: ScenarioId; readonly label: string }[] = [
  { id: "empty", label: "Empty / Ready" },
  { id: "running", label: "Streaming Action" },
  { id: "paused", label: "Paused Breakpoint" },
  { id: "crashed", label: "Runtime Crash" },
  { id: "stress", label: "Dense History" },
];

export function createPrototypeScenario(id: ScenarioId): PrototypeScenario {
  switch (id) {
    case "empty":
      return {
        agent: agentDefinitions,
        debugger: { callStack: [], scope: [] },
        description: "Ready runtime with no sessions yet.",
        events: [],
        id,
        label: "Empty / Ready",
        logs: [logs[2]!],
        runs: [],
        runtime: runtime("ready", "Waiting for the first session"),
        selectedAgentId: "tool-weather",
        selectedSourceId: sourceFiles[0]!.id,
        sources: sourceFiles,
      };
    case "paused":
      return pausedScenario();
    case "crashed":
      return crashedScenario();
    case "stress":
      return stressScenario();
    case "running":
      return runningScenario();
  }
}

function runningScenario(): PrototypeScenario {
  const action = completeEvents[2]!;
  const runningAction: TimelineEvent = {
    ...action,
    duration: "2.8 s",
    output: undefined,
    raw: { ...asRecord(action.raw), status: "running" },
    status: "running",
  };
  return {
    agent: agentDefinitions,
    debugger: { callStack: [], scope: [] },
    description: "A tool action is currently executing.",
    events: [completeEvents[0]!, completeEvents[1]!, runningAction],
    id: "running",
    label: "Streaming Action",
    logs: logs.slice(0, 2),
    runs,
    runtime: runtime("running", "get_weather is executing"),
    selectedAgentId: "tool-weather",
    selectedEventId: runningAction.id,
    selectedRunId: activeSession,
    selectedSourceId: sourceFiles[0]!.id,
    sources: sourceFiles,
  };
}

function pausedScenario(): PrototypeScenario {
  const action = completeEvents[2]!;
  const pausedAction: TimelineEvent = {
    ...action,
    duration: "Paused 14 s",
    output: undefined,
    raw: { ...asRecord(action.raw), status: "paused" },
    status: "waiting",
  };
  return {
    agent: agentDefinitions,
    debugger: {
      authoredFrameId: "frame-1",
      callStack: [
        {
          active: true,
          functionName: "execute",
          id: "frame-1",
          location: { line: 15, path: "agent/tools/get_weather.ts" },
          sourceKind: "authored",
        },
        {
          functionName: "runAction",
          id: "frame-2",
          location: { line: 284, path: "eve://runtime/action-runner.ts" },
          sourceKind: "framework",
        },
        {
          functionName: "executeStep",
          id: "frame-3",
          location: { line: 119, path: "eve://workflow/turn.ts" },
          sourceKind: "framework",
        },
      ],
      executionLine: 15,
      pauseReason: "Paused on breakpoint",
      scope: [
        { name: "city", type: "string", value: '"Berlin"' },
        { name: "units", type: "string", value: '"celsius"' },
        { name: "forecast", type: "undefined", value: "undefined" },
      ],
    },
    description: "Authored TypeScript is paused with correlated console output.",
    events: [completeEvents[0]!, completeEvents[1]!, pausedAction],
    id: "paused",
    label: "Paused Breakpoint",
    logs,
    runs: runs.map((run) =>
      run.id === activeSession ? { ...run, status: "waiting" as const } : run,
    ),
    runtime: runtime("paused", "Breakpoint in get_weather"),
    selectedAgentId: "tool-weather",
    selectedEventId: pausedAction.id,
    selectedRunId: activeSession,
    selectedSourceId: sourceFiles[0]!.id,
    sources: sourceFiles,
  };
}

function crashedScenario(): PrototypeScenario {
  const failure = event(
    "evt-crash",
    "failure",
    "Runtime Crashed",
    "Worker exited unexpectedly with code 1",
    "10:42:16",
    {
      output: { code: 1, signal: null },
      status: "failed",
    },
  );
  const crashLog: ConsoleRecord = {
    id: "log-crash",
    level: "error",
    message: "TypeError: Cannot read properties of undefined (reading 'temperature')",
    source: { line: 22, path: "agent/tools/get_weather.ts" },
    stream: "stderr",
    timestamp: "10:42:16.002",
  };
  return {
    agent: agentDefinitions,
    debugger: { callStack: [], scope: [] },
    description: "The runtime crashed while cached run data remains inspectable.",
    events: [...completeEvents.slice(0, 3), failure],
    id: "crashed",
    label: "Runtime Crash",
    logs: [...logs, crashLog],
    runs: runs.map((run) =>
      run.id === activeSession ? { ...run, status: "failed" as const } : run,
    ),
    runtime: runtime("crashed", "Runtime unavailable; cached data remains"),
    selectedAgentId: "tool-weather",
    selectedEventId: failure.id,
    selectedRunId: activeSession,
    selectedSourceId: sourceFiles[0]!.id,
    sources: sourceFiles,
  };
}

function stressScenario(): PrototypeScenario {
  const stressRuns = Array.from(
    { length: 26 },
    (_, index): RunSession => ({
      activity: index === 0 ? "Now" : `${index * 3} min`,
      id: `session-${String(index + 1).padStart(2, "0")}-long-identifier-${index * 947}`,
      label:
        index % 4 === 0
          ? "A very long weather investigation across several European capitals"
          : `Weather investigation ${index + 1}`,
      revision: index > 20 ? "79bc102" : revision,
      status: index % 7 === 0 ? "failed" : index % 3 === 0 ? "waiting" : "completed",
      trigger: index % 5 === 0 ? "schedule" : index % 4 === 0 ? "channel" : "message",
    }),
  );
  const selectedRun = stressRuns[0]!;
  const stressEvents = Array.from({ length: 80 }, (_, index): TimelineEvent => {
    const template = completeEvents[index % completeEvents.length]!;
    return {
      ...template,
      coordinates: { ...template.coordinates, session: selectedRun.id, step: String(index + 1) },
      id: `stress-event-${index + 1}`,
      replayed: index < 24,
      sessionId: selectedRun.id,
      summary:
        index % 11 === 0
          ? "Large structured payload with a deliberately long summary that tests truncation and alignment"
          : template.summary,
      time: `10:${String(20 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
    };
  });
  return {
    agent: agentDefinitions,
    debugger: { callStack: [], scope: [] },
    description: "Dense sessions, replayed records, and long content.",
    events: stressEvents,
    id: "stress",
    label: "Dense History",
    logs: Array.from({ length: 90 }, (_, index) => ({
      ...logs[index % logs.length]!,
      id: `stress-log-${index}`,
      timestamp: `10:42:${String(index % 60).padStart(2, "0")}.${String(index * 7).padStart(3, "0")}`,
    })),
    runs: stressRuns,
    runtime: runtime("ready", "80 retained events across 26 sessions"),
    selectedAgentId: "tool-weather",
    selectedEventId: stressEvents.at(-1)?.id,
    selectedRunId: selectedRun.id,
    selectedSourceId: sourceFiles[0]!.id,
    sources: sourceFiles,
  };
}

function runtime(status: PrototypeScenario["runtime"]["status"], statusDetail: string) {
  return {
    agentName: "weather-agent",
    debuggerConnected: true,
    inspectorOwned: status === "paused",
    observationCount: status === "crashed" ? 17 : 42,
    revision,
    runtimePort: 4310,
    status,
    statusDetail,
  } satisfies PrototypeScenario["runtime"];
}

function event(
  id: string,
  kind: TimelineEvent["kind"],
  label: string,
  summary: string,
  time: string,
  options: Partial<TimelineEvent> = {},
): TimelineEvent {
  const status = options.status ?? (kind === "wait" ? "waiting" : "completed");
  return {
    coordinates: coordinates(id),
    id,
    kind,
    label,
    raw: { id, kind, status, summary },
    sessionId: activeSession,
    status,
    summary,
    time,
    ...options,
  };
}

function coordinates(id: string) {
  return {
    action: id === "evt-3" ? "call_7" : undefined,
    revision,
    session: activeSession,
    step: id === "evt-1" ? undefined : "1",
    turn: "3",
  };
}

function definition(
  id: string,
  label: string,
  kind: AgentDefinition["kind"],
  description: string,
  options: {
    readonly config?: Readonly<Record<string, unknown>>;
    readonly parentId?: string;
    readonly provenance?: AgentDefinition["provenance"];
    readonly source?: AgentDefinition["source"];
  } = {},
): AgentDefinition {
  return {
    config: options.config ?? {},
    description,
    id,
    kind,
    label,
    parentId: options.parentId,
    provenance: options.provenance ?? (kind === "group" ? "runtime" : "authored"),
    source: options.source,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
