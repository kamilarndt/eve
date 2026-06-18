import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { DevInspectorRequest } from "#cli/dev/inspector.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import {
  acquireDevelopmentServerLease,
  writeDevelopmentServerMetadata,
} from "#internal/nitro/host/start-development-server.js";
import {
  DEVTOOLS_RUNTIME_CHILD_COMMAND,
  DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV,
  DEVTOOLS_CONTROL_VERSION,
  DEVTOOLS_OBSERVATION_VERSION,
  createDevControlMessage,
  type DevToolsObservationRecord,
  type DevToolsRuntimeChildConfig,
  type RuntimeChildControlMessage,
  type SupervisorControlMessage,
} from "#internal/devtools/protocol.js";
import {
  startDevToolsHost,
  type DevToolsLogInput,
  type DevToolsRuntimeState,
} from "#internal/devtools/host.js";
import type { DevelopmentServerHandle } from "#internal/nitro/host/types.js";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_OBSERVATION_LINE_BYTES = 1024 * 1024;
const NETWORK_INSPECTION_NODE_ARG = "--experimental-network-inspection";
const NODE_INSPECTOR_STATUS_LINES = new Set([
  "Debugger attached.",
  "For help, see: https://nodejs.org/en/docs/inspector",
  "Waiting for the debugger to disconnect...",
]);

export interface DevToolsSupervisorOptions {
  readonly host?: string;
  readonly inspectNetwork?: boolean;
  readonly inspector?: DevInspectorRequest;
  readonly port?: number;
}

export interface DevToolsSupervisorHandle extends DevelopmentServerHandle {
  readonly devtoolsUrl: string;
  readonly inspectorUrl?: string;
  readonly runtimeInstanceId: string;
  readonly runtimePid?: number;
}

interface RuntimeReadyState {
  readonly inspectorUrl?: string;
  readonly revision?: string;
  readonly runtimePid?: number;
  readonly runtimeUrl?: string;
}

export async function startDevToolsSupervisor(
  appRoot: string,
  options: DevToolsSupervisorOptions = {},
): Promise<DevToolsSupervisorHandle> {
  const releaseDevelopmentLease = await acquireDevelopmentServerLease(appRoot);
  const runtimeInstanceId = randomUUID();
  let runtimeState: DevToolsRuntimeState = {
    runtimeInstanceId,
    status: "starting",
  };
  let host: Awaited<ReturnType<typeof startDevToolsHost>>;
  let child: ChildProcess;
  try {
    host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => runtimeState,
      updateRuntimeState(patch) {
        runtimeState = { ...runtimeState, ...patch };
      },
    });
    child = spawnRuntimeChild({
      appRoot,
      host: options.host,
      inspectNetwork: options.inspectNetwork,
      inspector: options.inspector,
      port: options.port,
      runtimeInstanceId,
    });
  } catch (error) {
    await releaseDevelopmentLease();
    throw error;
  }
  pipeRuntimeChildLogs(child, host.appendLog);
  pipeRuntimeChildObservations(child, runtimeInstanceId, host.appendObservation, host.appendLog);

  let ready: Required<Pick<RuntimeReadyState, "runtimeUrl">> & RuntimeReadyState;
  try {
    ready = await waitForRuntimeReady(child, runtimeInstanceId, {
      onInspectorOpened(url) {
        runtimeState = {
          ...runtimeState,
          inspectorUrl: url,
          status: isPausingInspector(options.inspector) ? "paused" : runtimeState.status,
        };
        void host.syncRuntimeState().catch(() => {});
      },
    });
  } catch (error) {
    await host.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await releaseDevelopmentLease();
    throw error;
  }

  runtimeState = {
    inspectorUrl: ready.inspectorUrl,
    revision: ready.revision,
    runtimeInstanceId,
    runtimePid: ready.runtimePid,
    runtimeUrl: ready.runtimeUrl,
    status: "ready",
  };
  try {
    await host.syncRuntimeState();
    await writeDevelopmentServerMetadata(appRoot, ready.runtimeUrl, {
      devtoolsUrl: host.url,
      runtimeInstanceId,
      runtimePid: ready.runtimePid,
    });
  } catch (error) {
    await closeRuntimeChild(child, runtimeInstanceId).catch(() => {});
    await host.close().catch(() => {});
    await releaseDevelopmentLease();
    throw error;
  }
  let closing = false;
  child.once("exit", (code, signal) => {
    runtimeState = {
      ...runtimeState,
      inspectorUrl: undefined,
      status: closing ? "stopped" : "crashed",
    };
    host.appendLog({
      message: `Runtime child exited (code ${String(code)}, signal ${String(signal)}).`,
      stream: "system",
    });
    if (!closing) {
      void host.syncRuntimeState().catch(() => {});
    }
  });

  return {
    async close() {
      closing = true;
      try {
        await closeRuntimeChild(child, runtimeInstanceId);
      } finally {
        try {
          await host.close();
        } finally {
          await releaseDevelopmentLease();
        }
      }
    },
    devtoolsUrl: host.browserUrl,
    inspectorUrl: ready.inspectorUrl,
    runtimeInstanceId,
    runtimePid: ready.runtimePid,
    url: ready.runtimeUrl,
  };
}

function spawnRuntimeChild(config: DevToolsRuntimeChildConfig): ChildProcess {
  const packageRoot = resolvePackageRoot();
  const eveBinPath = join(packageRoot, "bin", "eve.js");
  const nodeArgs = config.inspectNetwork === true ? [NETWORK_INSPECTION_NODE_ARG] : [];

  return spawn(process.execPath, [...nodeArgs, eveBinPath, DEVTOOLS_RUNTIME_CHILD_COMMAND], {
    cwd: config.appRoot,
    env: {
      ...process.env,
      [DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV]: JSON.stringify(config),
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
}

function isPausingInspector(inspector: DevInspectorRequest | undefined): boolean {
  return inspector?.mode === "inspect-brk" || inspector?.mode === "inspect-wait";
}

function pipeRuntimeChildObservations(
  child: ChildProcess,
  runtimeInstanceId: string,
  appendObservation: (input: DevToolsObservationRecord) => void,
  appendLog: (input: DevToolsLogInput) => void,
): void {
  const stream = child.stdio?.[3] as Readable | null | undefined;
  if (stream === null || stream === undefined || typeof stream.on !== "function") {
    return;
  }

  let pending = "";
  let warned = false;
  const warnMalformed = () => {
    if (warned) return;
    warned = true;
    appendLog({
      message: "Dropped malformed DevTools observation record.",
      stream: "system",
    });
  };

  const parseLine = (line: string) => {
    if (line.trim().length === 0) {
      return;
    }

    const record = parseDevToolsObservationRecord(line, runtimeInstanceId);
    if (record === undefined) {
      warnMalformed();
      return;
    }

    appendObservation(record);
  };

  stream.on("data", (chunk: unknown) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(pending, "utf8") > MAX_OBSERVATION_LINE_BYTES) {
      pending = "";
      warnMalformed();
      return;
    }

    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      parseLine(line);
    }
  });
  stream.once("end", () => {
    parseLine(pending);
    pending = "";
  });
  stream.once("error", (error) => {
    appendLog({
      message: `DevTools observation pipe closed: ${error instanceof Error ? error.message : String(error)}`,
      stream: "system",
    });
  });
}

function parseDevToolsObservationRecord(
  line: string,
  runtimeInstanceId: string,
): DevToolsObservationRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Partial<DevToolsObservationRecord>;
  if (
    record.schemaVersion !== DEVTOOLS_OBSERVATION_VERSION ||
    record.runtimeInstanceId !== runtimeInstanceId ||
    typeof record.recordId !== "string" ||
    typeof record.at !== "string" ||
    typeof record.type !== "string" ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0 ||
    !("data" in record)
  ) {
    return undefined;
  }

  return record as DevToolsObservationRecord;
}

function pipeRuntimeChildLogs(
  child: ChildProcess,
  appendLog: (input: DevToolsLogInput) => void,
): void {
  const pending: Record<"stderr" | "stdout", string> = {
    stderr: "",
    stdout: "",
  };

  const appendChunk = (stream: "stderr" | "stdout", chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (stream === "stdout") process.stdout.write(text);
    pending[stream] += text;
    const lines = pending[stream].split(/\r?\n/u);
    pending[stream] = lines.pop() ?? "";
    for (const line of lines) {
      if (stream === "stderr" && isNodeInspectorStatusLine(line)) continue;
      if (stream === "stderr") process.stderr.write(`${line}\n`);
      if (line.length > 0) appendLog({ message: line, stream });
    }
  };

  child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));
  child.once("exit", () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (pending[stream].length > 0) {
        const line = pending[stream];
        if (stream === "stderr" && isNodeInspectorStatusLine(line)) {
          pending[stream] = "";
          continue;
        }
        if (stream === "stderr") process.stderr.write(line);
        appendLog({ message: line, stream });
        pending[stream] = "";
      }
    }
  });
}

function isNodeInspectorStatusLine(line: string): boolean {
  return NODE_INSPECTOR_STATUS_LINES.has(line) || line.startsWith("Debugger listening on ws://");
}

function waitForRuntimeReady(
  child: ChildProcess,
  runtimeInstanceId: string,
  hooks: {
    readonly onInspectorOpened?: (url: string) => void;
  } = {},
): Promise<Required<Pick<RuntimeReadyState, "runtimeUrl">> & RuntimeReadyState> {
  return new Promise((resolve, reject) => {
    const state: RuntimeReadyState = {};
    let settled = false;

    const cleanup = () => {
      child.off("error", handleError);
      child.off("exit", handleExit);
      child.off("message", handleMessage);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = (
      readyState: Required<Pick<RuntimeReadyState, "runtimeUrl">> & RuntimeReadyState,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...state, ...readyState });
    };

    const handleError = (error: Error) => {
      settleReject(error);
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settleReject(
        new Error(
          `DevTools runtime child exited before it was ready (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    };

    const handleMessage = (rawMessage: unknown) => {
      const message = parseRuntimeChildMessage(rawMessage, runtimeInstanceId);
      if (message === undefined) {
        return;
      }

      switch (message.type) {
        case "inspector.opened":
          Object.assign(state, { inspectorUrl: message.data.url });
          hooks.onInspectorOpened?.(message.data.url);
          break;
        case "runtime.ready":
          settleResolve({
            runtimePid: message.data.pid,
            runtimeUrl: message.data.url,
            revision: message.data.revision,
          });
          break;
        case "runtime.startup-failed":
          settleReject(new Error(message.data.message));
          break;
      }
    };

    child.once("error", handleError);
    child.once("exit", handleExit);
    child.on("message", handleMessage);
  });
}

async function closeRuntimeChild(child: ChildProcess, runtimeInstanceId: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await sendSupervisorMessage(child, {
    ...createDevControlMessage({
      data: {},
      runtimeInstanceId,
      type: "runtime.shutdown",
    }),
  });

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, CHILD_SHUTDOWN_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function sendSupervisorMessage(
  child: ChildProcess,
  message: SupervisorControlMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof child.send !== "function") {
      reject(new Error("DevTools runtime child does not have an IPC channel."));
      return;
    }

    child.send(message, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseRuntimeChildMessage(
  rawMessage: unknown,
  runtimeInstanceId: string,
): RuntimeChildControlMessage | undefined {
  if (rawMessage === null || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    return undefined;
  }

  const message = rawMessage as Partial<RuntimeChildControlMessage>;
  if (
    message.version !== DEVTOOLS_CONTROL_VERSION ||
    message.runtimeInstanceId !== runtimeInstanceId ||
    typeof message.type !== "string" ||
    message.data === null ||
    typeof message.data !== "object"
  ) {
    return undefined;
  }

  if (message.type === "inspector.opened" && typeof message.data.url === "string") {
    return message as RuntimeChildControlMessage;
  }

  if (
    message.type === "runtime.ready" &&
    typeof message.data.url === "string" &&
    typeof message.data.pid === "number"
  ) {
    return message as RuntimeChildControlMessage;
  }

  if (message.type === "runtime.startup-failed" && typeof message.data.message === "string") {
    return message as RuntimeChildControlMessage;
  }

  return undefined;
}
