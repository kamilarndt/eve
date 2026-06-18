import type { DevToolsObservationRecord } from "#internal/devtools/protocol.js";

export type DevToolsRuntimeStatus = "starting" | "ready" | "paused" | "crashed" | "stopped";

export interface DevToolsRuntimeState {
  readonly inspectorUrl?: string;
  readonly revision?: string;
  readonly runtimeInstanceId: string;
  readonly runtimePid?: number;
  readonly runtimeUrl?: string;
  readonly status: DevToolsRuntimeStatus;
}

export type DevToolsLogStream = "console" | "stderr" | "stdout" | "system";

export interface DevToolsLogInput {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly level?: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly source?: {
    readonly column?: number;
    readonly line?: number;
    readonly path?: string;
    readonly url?: string;
  };
  readonly stream: DevToolsLogStream;
}

export interface DevToolsHostHandle {
  readonly browserUrl: string;
  readonly browserCapability: string;
  readonly url: string;
  appendLog(input: DevToolsLogInput): void;
  appendObservation(input: DevToolsObservationRecord): void;
  close(): Promise<void>;
  syncRuntimeState(): Promise<void>;
  writeDiscovery(): Promise<void>;
}
