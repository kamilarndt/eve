export type PanelId = "runs" | "agent" | "sources" | "console";
export type ScenarioId = "empty" | "running" | "paused" | "crashed" | "stress";
export type Theme = "dark" | "light";
export type RuntimeStatus = "starting" | "ready" | "running" | "paused" | "crashed" | "stopped";
export type RecordStatus = "completed" | "failed" | "info" | "running" | "waiting";

export interface Coordinates {
  readonly action?: string;
  readonly revision: string;
  readonly session: string;
  readonly step?: string;
  readonly turn?: string;
}

export interface RuntimeSnapshot {
  readonly agentName: string;
  readonly debuggerConnected: boolean;
  readonly diagnostics?: readonly string[];
  readonly inspectorOwned: boolean;
  readonly observationCount: number;
  readonly revision: string;
  readonly runtimePort: number;
  readonly status: RuntimeStatus;
  readonly statusDetail: string;
}

export interface RunSession {
  readonly activity: string;
  readonly childCount?: number;
  readonly id: string;
  readonly label: string;
  readonly parentId?: string;
  readonly pendingAction?: {
    readonly kind: "approval" | "authorization" | "question";
    readonly name: string;
  };
  readonly revision: string;
  readonly status: RecordStatus;
  readonly trigger: "channel" | "message" | "schedule" | "subagent";
}

export interface ChatMessage {
  readonly id: string;
  readonly optimistic?: true;
  readonly parts: readonly ChatMessagePart[];
  readonly role: "assistant" | "system" | "user";
  readonly sessionId: string;
  readonly status: "complete" | "failed" | "streaming";
}

export type ChatMessagePart =
  | {
      readonly eventId?: string;
      readonly state: "done" | "streaming";
      readonly stepIndex?: number;
      readonly text: string;
      readonly type: "reasoning" | "text";
    }
  | {
      readonly callId: string;
      readonly error?: string;
      readonly eventId?: string;
      readonly input?: unknown;
      readonly kind: "load-skill" | "subagent" | "tool";
      readonly name: string;
      readonly output?: unknown;
      readonly state: "approval" | "completed" | "denied" | "failed" | "running";
      readonly type: "tool";
    };

export type TimelineEventKind =
  | "action"
  | "assistant"
  | "checkpoint"
  | "failure"
  | "model"
  | "subagent"
  | "system"
  | "user"
  | "wait";

export interface TimelineEvent {
  readonly coordinates: Coordinates;
  readonly depth?: number;
  readonly duration?: string;
  readonly id: string;
  readonly input?: unknown;
  readonly kind: TimelineEventKind;
  readonly label: string;
  readonly output?: unknown;
  readonly raw: unknown;
  readonly replayed?: boolean;
  readonly sessionId: string;
  readonly source?: SourceLocation;
  readonly status: RecordStatus;
  readonly summary: string;
  readonly time: string;
}

export interface AgentDefinition {
  readonly config: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly id: string;
  readonly kind:
    | "channel"
    | "connection"
    | "group"
    | "hook"
    | "instructions"
    | "model"
    | "sandbox"
    | "schedule"
    | "skill"
    | "subagent"
    | "tool"
    | "workspace";
  readonly label: string;
  readonly parentId?: string;
  readonly provenance: "authored" | "framework" | "runtime";
  readonly source?: SourceLocation;
}

export interface SourceLocation {
  readonly column?: number;
  readonly line: number;
  readonly path: string;
}

export interface SourceFile {
  readonly breakpointLines: readonly number[];
  readonly content: string;
  readonly id: string;
  readonly language: string;
  readonly loaded: boolean;
  readonly path: string;
  readonly revision: string;
  readonly scripts?: readonly {
    readonly scriptId: string;
    readonly sourceMapUrl?: string;
    readonly url: string;
  }[];
}

export interface ScopeValue {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface StackFrame {
  readonly active?: boolean;
  readonly functionName: string;
  readonly id: string;
  readonly location: SourceLocation;
  readonly sourceKind: "authored" | "dependency" | "framework" | "generated" | "internal";
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

export interface DebuggerSnapshot {
  readonly authoredFrameId?: string;
  readonly callStack: readonly StackFrame[];
  readonly executionLine?: number;
  readonly pauseReason?: string;
  readonly scope: readonly ScopeValue[];
}

export interface ConsoleRecord {
  readonly coordinates?: Coordinates;
  readonly count?: number;
  readonly id: string;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly source?: SourceLocation;
  readonly stream: "console" | "stderr" | "stdout" | "system";
  readonly timestamp: string;
}

export interface PrototypeScenario {
  readonly agent: readonly AgentDefinition[];
  readonly debugger: DebuggerSnapshot;
  readonly description: string;
  readonly events: readonly TimelineEvent[];
  readonly id: ScenarioId;
  readonly label: string;
  readonly logs: readonly ConsoleRecord[];
  readonly runs: readonly RunSession[];
  readonly runtime: RuntimeSnapshot;
  readonly selectedAgentId?: string;
  readonly selectedEventId?: string;
  readonly selectedRunId?: string;
  readonly selectedSourceId?: string;
  readonly sources: readonly SourceFile[];
}
