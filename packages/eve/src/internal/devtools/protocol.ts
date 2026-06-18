import type { DevInspectorRequest } from "#cli/dev/inspector.js";

export const DEVTOOLS_CONTROL_VERSION = 1;
export const DEVTOOLS_OBSERVATION_VERSION = 1;
export const DEVTOOLS_RUNTIME_CHILD_COMMAND = "__devtools-runtime-child";
export const DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV = "EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG";

export interface DevToolsRuntimeChildConfig {
  readonly appRoot: string;
  readonly host?: string;
  readonly inspectNetwork?: boolean;
  readonly inspector?: DevInspectorRequest;
  readonly port?: number;
  readonly runtimeInstanceId: string;
}

export interface DevControlMessage<TType extends string, TData> {
  readonly data: TData;
  readonly runtimeInstanceId: string;
  readonly type: TType;
  readonly version: typeof DEVTOOLS_CONTROL_VERSION;
}

export type RuntimeChildControlMessage =
  | DevControlMessage<"inspector.opened", { readonly url: string }>
  | DevControlMessage<
      "runtime.ready",
      {
        readonly pid: number;
        readonly revision?: string;
        readonly url: string;
      }
    >
  | DevControlMessage<"runtime.stopped", Record<string, never>>
  | DevControlMessage<
      "runtime.startup-failed",
      {
        readonly message: string;
      }
    >;

export type SupervisorControlMessage = DevControlMessage<"runtime.shutdown", Record<string, never>>;

export interface DevToolsObservationRecord<TType extends string = string, TData = unknown> {
  readonly at: string;
  readonly data: TData;
  readonly recordId: string;
  readonly runtimeInstanceId: string;
  readonly schemaVersion: typeof DEVTOOLS_OBSERVATION_VERSION;
  readonly sequence: number;
  readonly type: TType;
}

export function createDevControlMessage<TType extends string, TData>(input: {
  readonly data: TData;
  readonly runtimeInstanceId: string;
  readonly type: TType;
}): DevControlMessage<TType, TData> {
  return {
    data: input.data,
    runtimeInstanceId: input.runtimeInstanceId,
    type: input.type,
    version: DEVTOOLS_CONTROL_VERSION,
  };
}
