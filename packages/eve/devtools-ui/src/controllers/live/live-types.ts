export interface LiveRuntimeState {
  readonly revision?: string;
  readonly runtimeInstanceId: string;
  readonly runtimePid?: number;
  readonly runtimeUrl?: string;
  readonly status: "starting" | "ready" | "paused" | "crashed" | "stopped";
}

export interface LiveRun {
  readonly createdAt: string;
  readonly eventCount: number;
  readonly pendingAction?: {
    readonly kind: "approval" | "authorization" | "question";
    readonly name: string;
  };
  readonly retainedEventCount: number;
  readonly sessionId: string;
  readonly status: "running" | "waiting" | "completed" | "failed";
  readonly title?: string;
  readonly updatedAt: string;
}

export interface LiveRunEvent {
  readonly cursor: string;
  readonly event: {
    readonly data?: unknown;
    readonly meta?: unknown;
    readonly type: string;
  };
  readonly sessionId: string;
}

export interface LiveDebuggerState {
  readonly connected: boolean;
  readonly controllerAttached: boolean;
  readonly pause?: unknown;
}

export interface LiveSourceEntry {
  readonly id: string;
  readonly kind: "authored";
  readonly loaded: boolean;
  readonly path: string;
  readonly revision?: string;
  readonly scripts: readonly {
    readonly scriptId: string;
    readonly sourceMapUrl?: string;
    readonly url: string;
  }[];
}

export interface LiveLogEntry {
  readonly cursor: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly source?: {
    readonly column?: number;
    readonly line?: number;
    readonly path?: string;
    readonly url?: string;
  };
  readonly stream: "console" | "stderr" | "stdout" | "system";
  readonly timestamp: string;
}

export interface BootstrapResponse {
  readonly agent?: unknown;
  readonly debugger: LiveDebuggerState;
  readonly diagnostics?: readonly { readonly message: string }[];
  readonly runs: readonly LiveRun[];
  readonly runtime: LiveRuntimeState;
  readonly schemaVersion: number;
}

export interface DevToolsStreamEvent {
  readonly data: unknown;
  readonly event: string;
  readonly id: string;
}
