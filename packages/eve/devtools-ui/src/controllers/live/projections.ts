import type {
  AgentDefinition,
  ConsoleRecord,
  DebuggerSnapshot,
  PrototypeScenario,
  RunSession,
  SourceFile,
  SourceLocation,
  StackFrame,
  TimelineEvent,
  TimelineEventKind,
} from "@ui/model/devtools-model";
import type {
  BootstrapResponse,
  LiveLogEntry,
  LiveRun,
  LiveRunEvent,
  LiveSourceEntry,
} from "@ui/controllers/live/live-types";

export function createLiveScenario(bootstrap?: BootstrapResponse): PrototypeScenario {
  const runtime = bootstrap?.runtime;
  const agent = projectAgent(bootstrap?.agent);
  return {
    agent,
    debugger: projectPause(bootstrap?.debugger.pause),
    description: "Live local Eve runtime.",
    events: [],
    id: "empty",
    label: "Live Runtime",
    logs: [],
    runs: bootstrap?.runs.map((run) => projectRun(run)) ?? [],
    runtime: {
      agentName: agentName(bootstrap?.agent),
      debuggerConnected: bootstrap?.debugger.connected ?? false,
      diagnostics: diagnosticMessages(bootstrap),
      inspectorOwned: bootstrap?.debugger.controllerAttached ?? false,
      observationCount: 0,
      revision: runtime?.revision ?? "unknown",
      runtimePort: runtimePort(runtime?.runtimeUrl),
      status: runtime?.status ?? "starting",
      statusDetail: runtime?.status ?? "Starting",
    },
    selectedAgentId: agent.find((definition) => definition.kind !== "group")?.id,
    sources: [],
  };
}

function diagnosticMessages(bootstrap: BootstrapResponse | undefined): readonly string[] {
  if (bootstrap === undefined) return [];
  const messages = bootstrap.diagnostics?.map((diagnostic) => diagnostic.message) ?? [];
  const agent = isRecord(bootstrap.agent) ? bootstrap.agent : undefined;
  const diagnostics = isRecord(agent?.diagnostics) ? agent.diagnostics : undefined;
  const errors = numberValue(diagnostics?.discoveryErrors) ?? 0;
  const warnings = numberValue(diagnostics?.discoveryWarnings) ?? 0;
  if (errors > 0 || warnings > 0) {
    messages.push(
      `Agent discovery reported ${errors} ${errors === 1 ? "error" : "errors"} and ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`,
    );
  }
  return messages;
}

export function projectRun(run: LiveRun, title?: string): RunSession {
  return {
    activity: relativeActivity(run.updatedAt),
    id: run.sessionId,
    label: title ?? run.title ?? "Untitled session",
    pendingAction: run.pendingAction,
    revision: "current",
    status: run.status,
    trigger: "message",
  };
}

export function projectSource(source: LiveSourceEntry, content = ""): SourceFile {
  return {
    breakpointLines: [],
    content,
    id: source.id,
    language: languageForPath(source.path),
    loaded: source.loaded,
    path: source.path,
    revision: source.revision ?? "unknown",
    scripts: source.scripts,
  };
}

export function projectLog(entry: LiveLogEntry): ConsoleRecord {
  const fields = entry.fields;
  const coordinates = isRecord(fields?.coordinates) ? fields.coordinates : undefined;
  const session = stringValue(coordinates?.session) ?? stringValue(fields?.sessionId);
  return {
    coordinates:
      session === undefined
        ? undefined
        : {
            action: stringValue(coordinates?.action) ?? stringValue(fields?.actionId),
            revision: stringValue(coordinates?.revision) ?? "unknown",
            session,
            step: stringValue(coordinates?.step),
            turn: stringValue(coordinates?.turn),
          },
    id: `log-${entry.cursor}`,
    level: entry.level,
    message: entry.message,
    source: projectLogSource(entry.source),
    stream: entry.stream,
    timestamp: formatTimestamp(entry.timestamp, true),
  };
}

export function projectTimelineEvent(
  envelope: LiveRunEvent,
  revision: string,
  sourceByTool: ReadonlyMap<string, SourceLocation>,
): TimelineEvent | undefined {
  const event = envelope.event;
  if (event.type === "message.appended" || event.type === "reasoning.appended") return undefined;
  const data = isRecord(event.data) ? event.data : {};
  const action = firstAction(data);
  const result = isRecord(data.result) ? data.result : undefined;
  const actionId =
    stringValue(action?.callId) ?? stringValue(result?.callId) ?? stringValue(data.callId);
  const toolName =
    stringValue(action?.toolName) ??
    stringValue(action?.subagentName) ??
    stringValue(result?.toolName) ??
    stringValue(result?.subagentName) ??
    stringValue(data.name);
  const projection = eventProjection(event.type, data, toolName);
  const at = isRecord(event.meta) ? stringValue(event.meta.at) : undefined;
  return {
    coordinates: {
      action: actionId,
      revision,
      session: envelope.sessionId,
      step: numberString(data.stepIndex),
      turn: stringValue(data.turnId) ?? numberString(data.sequence),
    },
    id: `event-${envelope.cursor}`,
    input: projection.input,
    kind: projection.kind,
    label: projection.label,
    output: projection.output,
    raw: event,
    sessionId: envelope.sessionId,
    source: toolName === undefined ? undefined : sourceByTool.get(toolName),
    status: projection.status,
    summary: projection.summary,
    time: formatTimestamp(at),
  };
}

export function mergeTimelineEvents(
  current: readonly TimelineEvent[],
  sessionId: string,
  incoming: readonly TimelineEvent[],
): readonly TimelineEvent[] {
  const sessionEvents = new Map(
    current
      .filter((event) => event.sessionId === sessionId)
      .map((event) => [event.id, event] as const),
  );
  for (const event of incoming) sessionEvents.set(event.id, event);
  return [...current.filter((event) => event.sessionId !== sessionId), ...sessionEvents.values()];
}

export function projectPause(
  value: unknown,
  sources: readonly SourceFile[] = [],
  locationsByFrame: ReadonlyMap<string, SourceLocation> = new Map(),
): DebuggerSnapshot {
  const pause = isRecord(value) ? value : undefined;
  const frames = Array.isArray(pause?.callFrames) ? pause.callFrames.filter(isRecord) : [];
  const callStack = frames.map((frame, index) => {
    const location = isRecord(frame.location) ? frame.location : {};
    const url = stringValue(frame.url) ?? "";
    const frameId = stringValue(frame.callFrameId) ?? `frame-${index}`;
    const authoredLocation =
      locationsByFrame.get(frameId) ??
      (() => {
        const path = sourcePathForUrl(url, sources);
        return path === undefined
          ? undefined
          : ({
              column: numberValue(location.columnNumber),
              line: (numberValue(location.lineNumber) ?? 0) + 1,
              path,
            } satisfies SourceLocation);
      })();
    const unresolvedSourceKind = classifyFrameSource(url);
    const sourceKind: StackFrame["sourceKind"] =
      authoredLocation === undefined ? unresolvedSourceKind : "authored";
    return {
      active: index === 0,
      functionName: stringValue(frame.functionName) || "(anonymous)",
      id: frameId,
      location:
        authoredLocation ??
        ({
          column: numberValue(location.columnNumber),
          line: (numberValue(location.lineNumber) ?? 0) + 1,
          path: frameSourceLabel(unresolvedSourceKind, url),
        } satisfies SourceLocation),
      sourceKind,
    };
  });
  const authoredFrame = callStack.find((frame) => frame.sourceKind === "authored");
  return {
    authoredFrameId: authoredFrame?.id,
    callStack,
    executionLine: authoredFrame?.location.line,
    pauseReason: pause === undefined ? undefined : pauseReason(pause),
    scope: [],
  };
}

export function classifyFrameSource(
  url: string,
): Exclude<DebuggerSnapshot["callStack"][number]["sourceKind"], "authored"> {
  const normalized = url.replaceAll("\\", "/");
  if (normalized.startsWith("node:")) return "internal";
  if (normalized.includes("/node_modules/eve/") || normalized.includes("/packages/eve/")) {
    return "framework";
  }
  if (normalized.includes("/node_modules/")) return "dependency";
  return "generated";
}

function frameSourceLabel(
  sourceKind: Exclude<DebuggerSnapshot["callStack"][number]["sourceKind"], "authored">,
  url: string,
): string {
  const label = {
    dependency: "Dependency source",
    framework: "Eve framework",
    generated: "Generated source",
    internal: "Node internal",
  }[sourceKind];
  if (url === "") return label;
  const path = sourcePathFromUrl(url);
  return path === url ? label : `${label} · ${path}`;
}

export function projectAgent(value: unknown): readonly AgentDefinition[] {
  if (!isRecord(value)) return [];
  const definitions: AgentDefinition[] = [];
  const addGroup = (id: string, label: string) => {
    definitions.push({
      config: {},
      description: `${label} resolved by Eve for this runtime revision.`,
      id,
      kind: "group",
      label,
      provenance: "runtime",
    });
  };
  const addDefinition = (input: {
    readonly config: unknown;
    readonly description?: string;
    readonly id: string;
    readonly kind: Exclude<AgentDefinition["kind"], "group">;
    readonly label: string;
    readonly origin?: unknown;
    readonly parentId: string;
    readonly source?: SourceLocation;
  }) => {
    definitions.push({
      config: isRecord(input.config) ? input.config : { value: input.config },
      description: input.description ?? `${input.label} resolved by Eve.`,
      id: input.id,
      kind: input.kind,
      label: input.label,
      parentId: input.parentId,
      provenance:
        input.origin === "framework"
          ? "framework"
          : input.origin === "runtime"
            ? "runtime"
            : "authored",
      source: input.source,
    });
  };

  const agent = isRecord(value.agent) ? value.agent : {};
  const sourcePrefix = agentSourcePrefix(agent);
  addGroup("identity", "Agent");
  addDefinition({
    config: agent,
    description: stringValue(agent.description),
    id: "agent:identity",
    kind: "workspace",
    label: stringValue(agent.name) ?? "Agent",
    origin: "runtime",
    parentId: "identity",
    source: projectAgentSource(agent.configSource, sourcePrefix),
  });
  addDefinition({
    config: agent.model,
    id: "agent:model",
    kind: "model",
    label: stringValue(isRecord(agent.model) ? agent.model.id : undefined) ?? "Model & Routing",
    origin: "runtime",
    parentId: "identity",
    source: projectAgentSource(
      isRecord(agent.model) ? agent.model.source : undefined,
      sourcePrefix,
    ),
  });
  addCollection(
    definitions,
    value,
    "instructions",
    "Instructions",
    "instructions",
    "instructions",
    sourcePrefix,
  );
  addCollection(definitions, value, "tools", "Tools", "tool", "tools", sourcePrefix);
  addCollection(definitions, value, "skills", "Skills", "skill", "skills", sourcePrefix);
  addCollection(
    definitions,
    value,
    "connections",
    "Connections",
    "connection",
    "connections",
    sourcePrefix,
  );
  addCollection(definitions, value, "channels", "Channels", "channel", "channels", sourcePrefix);
  addCollection(
    definitions,
    value,
    "schedules",
    "Schedules",
    "schedule",
    "schedules",
    sourcePrefix,
  );
  addCollection(definitions, value, "hooks", "Hooks", "hook", "hooks", sourcePrefix);
  addCollection(
    definitions,
    value,
    "subagents",
    "Subagents",
    "subagent",
    "subagents",
    sourcePrefix,
  );
  if (value.sandbox !== null && value.sandbox !== undefined) {
    addGroup("sandbox", "Sandbox");
    addDefinition({
      config: value.sandbox,
      id: "sandbox:active",
      kind: "sandbox",
      label: "Sandbox",
      parentId: "sandbox",
      source: projectAgentSource(value.sandbox, sourcePrefix),
    });
  }
  return definitions;
}

export function sourceLocationsByTool(
  definitions: readonly AgentDefinition[],
): ReadonlyMap<string, SourceLocation> {
  const locations = new Map<string, SourceLocation>();
  for (const definition of definitions) {
    if (definition.kind === "tool" && definition.source !== undefined) {
      locations.set(definition.label, definition.source);
    }
  }
  return locations;
}

function addCollection(
  target: AgentDefinition[],
  root: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  kind: Exclude<AgentDefinition["kind"], "group">,
  groupId: string,
  sourcePrefix: string,
): void {
  const entries = collectionEntries(root[key], key);
  if (entries.length === 0) return;
  target.push({
    config: {},
    description: `${label} resolved by Eve for this runtime revision.`,
    id: groupId,
    kind: "group",
    label,
    provenance: "runtime",
  });
  const grouped =
    shouldGroupByProvenance(key) &&
    entries.some((entry) => collectionEntryProvenance(entry) === "authored") &&
    entries.some((entry) => collectionEntryProvenance(entry) === "framework");
  const provenances = grouped ? (["authored", "framework"] as const) : ([undefined] as const);
  for (const provenance of provenances) {
    if (provenance !== undefined) {
      target.push(provenanceFolder(groupId, label, provenance));
    }
    for (const [index, entry] of entries.entries()) {
      const entryProvenance = collectionEntryProvenance(entry);
      if (provenance !== undefined && provenance !== entryProvenance) continue;
      const name = definitionName(entry, `${label.slice(0, -1)} ${index + 1}`);
      target.push({
        config: entry,
        description: stringValue(entry.description) ?? `${name} resolved by Eve.`,
        id: `${kind}:${name}:${index}`,
        kind,
        label: name,
        parentId: provenance === undefined ? groupId : `${groupId}:${provenance}`,
        provenance: entryProvenance,
        source: projectAgentSource(entry, sourcePrefix),
      });
    }
  }
}

function shouldGroupByProvenance(key: string): boolean {
  return key === "instructions" || key === "tools" || key === "channels" || key === "subagents";
}

function provenanceFolder(
  groupId: string,
  groupLabel: string,
  provenance: "authored" | "framework",
): AgentDefinition {
  return {
    config: {},
    description: `${titleCase(provenance)} ${groupLabel.toLocaleLowerCase()} resolved by Eve.`,
    id: `${groupId}:${provenance}`,
    kind: "group",
    label: titleCase(provenance),
    parentId: groupId,
    provenance: "runtime",
  };
}

function collectionEntryProvenance(
  entry: Readonly<Record<string, unknown>>,
): "authored" | "framework" {
  return entry.origin === "framework" ? "framework" : "authored";
}

function collectionEntries(value: unknown, key: string): Readonly<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (key === "instructions") {
    return [value.static, ...(Array.isArray(value.dynamic) ? value.dynamic : [])].filter(isRecord);
  }
  if (key === "tools" || key === "channels") {
    return Array.isArray(value.available) ? value.available.filter(isRecord) : [];
  }
  if (key === "skills") {
    return [
      ...(Array.isArray(value.static) ? value.static : []),
      ...(Array.isArray(value.dynamic) ? value.dynamic : []),
    ].filter(isRecord);
  }
  if (key === "subagents") {
    return Array.isArray(value.local) ? value.local.filter(isRecord) : [];
  }
  return [];
}

function eventProjection(
  type: string,
  data: Readonly<Record<string, unknown>>,
  toolName: string | undefined,
): {
  readonly input?: unknown;
  readonly kind: TimelineEventKind;
  readonly label: string;
  readonly output?: unknown;
  readonly status: TimelineEvent["status"];
  readonly summary: string;
} {
  switch (type) {
    case "message.received":
      return {
        kind: "user",
        label: "User Message",
        status: "completed",
        summary: stringValue(data.message) ?? "User message",
      };
    case "step.started":
      return {
        kind: "model",
        label: "Model Call",
        status: "running",
        summary: `Step ${numberString(data.stepIndex) ?? ""}`.trim(),
      };
    case "step.completed":
      return {
        kind: "model",
        label: "Model Call Completed",
        output: data.usage,
        status: "completed",
        summary: stringValue(data.finishReason) ?? "Model call completed",
      };
    case "actions.requested":
      return {
        input: data.actions,
        kind: "action",
        label: "Action Requested",
        status: "running",
        summary: toolName ?? "Runtime action",
      };
    case "action.result":
      return {
        kind: "action",
        label: "Action Result",
        output: data.result,
        status: data.status === "failed" ? "failed" : "completed",
        summary: toolName ?? "Runtime action completed",
      };
    case "message.completed":
      return {
        kind: "assistant",
        label: "Assistant",
        output: data,
        status: "completed",
        summary: stringValue(data.message) ?? "Assistant message completed",
      };
    case "session.waiting":
      return {
        kind: "wait",
        label: "Waiting for Input",
        status: "waiting",
        summary: "Ready for the next user message",
      };
    case "session.completed":
      return {
        kind: "checkpoint",
        label: "Session Completed",
        status: "completed",
        summary: "Session completed",
      };
    case "session.failed":
    case "step.failed":
    case "turn.failed":
      return {
        kind: "failure",
        label: "Failure",
        output: data,
        status: "failed",
        summary: stringValue(data.message) ?? type,
      };
    case "subagent.called":
    case "subagent.started":
    case "subagent.completed":
      return {
        kind: "subagent",
        label: "Subagent",
        output: data,
        status: type.endsWith("completed") ? "completed" : "running",
        summary: toolName ?? stringValue(data.subagentName) ?? "Subagent",
      };
    default:
      return {
        kind: "system",
        label: titleCase(type),
        output: data,
        status: "completed",
        summary: type,
      };
  }
}

function firstAction(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  return Array.isArray(data.actions) ? data.actions.find(isRecord) : undefined;
}

function projectAgentSource(value: unknown, prefix: string): SourceLocation | undefined {
  if (!isRecord(value)) return undefined;
  const path = stringValue(value.logicalPath) ?? stringValue(value.entryPath);
  if (path === undefined) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const appRelative =
    prefix === "" || normalized === prefix || normalized.startsWith(`${prefix}/`)
      ? normalized
      : `${prefix}/${normalized}`;
  return { line: 1, path: appRelative };
}

function agentSourcePrefix(agent: Readonly<Record<string, unknown>>): string {
  const appRoot = stringValue(agent.appRoot)?.replaceAll("\\", "/").replace(/\/$/u, "");
  const agentRoot = stringValue(agent.agentRoot)?.replaceAll("\\", "/").replace(/\/$/u, "");
  if (appRoot === undefined || agentRoot === undefined || agentRoot === appRoot) return "";
  return agentRoot.startsWith(`${appRoot}/`) ? agentRoot.slice(appRoot.length + 1) : "";
}

function projectLogSource(value: LiveLogEntry["source"]): SourceLocation | undefined {
  if (value === undefined) return undefined;
  const path = value.path ?? (value.url === undefined ? undefined : sourcePathFromUrl(value.url));
  if (path === undefined) return undefined;
  return { column: value.column, line: value.line ?? 1, path };
}

function sourcePathForUrl(url: string, sources: readonly SourceFile[]): string | undefined {
  return sources.find((source) => source.scripts?.some((script) => script.url === url))?.path;
}

function sourcePathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname).replace(/^.*\/(agent\/)/u, "$1");
  } catch {
    return url;
  }
}

function agentName(value: unknown): string {
  return isRecord(value) && isRecord(value.agent) && typeof value.agent.name === "string"
    ? value.agent.name
    : "Eve Agent";
}

function runtimePort(runtimeUrl: string | undefined): number {
  if (runtimeUrl === undefined) return 0;
  try {
    return Number(new URL(runtimeUrl).port);
  } catch {
    return 0;
  }
}

function relativeActivity(timestamp: string): string {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min`;
  return `${Math.floor(elapsed / 3_600_000)} hr`;
}

function formatTimestamp(value: string | undefined, milliseconds = false): string {
  if (value === undefined) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    fractionalSecondDigits: milliseconds ? 3 : undefined,
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function languageForPath(path: string): string {
  return path.split(".").at(-1) ?? "text";
}

function pauseReason(pause: Readonly<Record<string, unknown>>): string {
  const reason = stringValue(pause.reason);
  return reason === "other" || reason === undefined ? "Paused on breakpoint" : `Paused: ${reason}`;
}

function definitionName(entry: Readonly<Record<string, unknown>>, fallback: string): string {
  return (
    stringValue(entry.name) ??
    stringValue(entry.connectionName) ??
    stringValue(entry.slug) ??
    fallback
  );
}

function titleCase(value: string): string {
  return value
    .split(/[.-]/u)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function numberString(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
