import { createWriteStream } from "node:fs";

import { openDevInspector, type DevInspectorHandle } from "#cli/dev/inspector.js";
import {
  DEVTOOLS_CONTROL_VERSION,
  DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV,
  createDevControlMessage,
  type DevToolsRuntimeChildConfig,
  type SupervisorControlMessage,
} from "#internal/devtools/protocol.js";
import {
  createDevObservationSink,
  type DevObservationSink,
} from "#internal/devtools/observation.js";
import { readDevelopmentRuntimeArtifactsRevision } from "#internal/nitro/dev-runtime-artifacts.js";
import { startDevelopmentServer } from "#internal/nitro/host.js";
import type { DevelopmentServerHandle } from "#internal/nitro/host/types.js";
import { observeConsoleContext } from "#cli/dev/console-observation.js";

const DEFAULT_RUNTIME_INSPECTOR_HOST = "127.0.0.1";

export async function runDevToolsRuntimeChildFromEnvironment(): Promise<void> {
  const config = readRuntimeChildConfigFromEnvironment();
  const observation = createRuntimeObservationSink(config.runtimeInstanceId);
  const stopObservingConsole = observeConsoleContext(observation);
  let inspector: DevInspectorHandle | undefined;
  let server: DevelopmentServerHandle | undefined;

  try {
    observation.emit("runtime.child.started", () => ({ pid: process.pid }));
    inspector = await openDevInspector(
      config.inspector ?? {
        host: DEFAULT_RUNTIME_INSPECTOR_HOST,
        mode: "inspect",
        port: 0,
      },
    );
    sendRuntimeChildMessage({
      data: {
        url: inspector.url,
      },
      runtimeInstanceId: config.runtimeInstanceId,
      type: "inspector.opened",
    });
    const openedInspector = inspector;
    observation.emit("runtime.inspector.opened", () => ({
      mode: openedInspector.mode,
      url: openedInspector.url,
    }));

    if (inspector.mode === "inspect-wait" || inspector.mode === "inspect-brk") {
      inspector.waitForDebugger();
    }
    if (inspector.mode === "inspect-brk") {
      // oxlint-disable-next-line no-debugger
      debugger;
    }

    server = await startDevelopmentServer(config.appRoot, {
      developmentLease: "external",
      host: config.host,
      port: config.port,
      runtimeDebugging: true,
      writeDevelopmentServerMetadata: false,
    });
    const revision = readDevelopmentRuntimeArtifactsRevision(config.appRoot).revision;
    sendRuntimeChildMessage({
      data: {
        pid: process.pid,
        revision,
        url: server.url,
      },
      runtimeInstanceId: config.runtimeInstanceId,
      type: "runtime.ready",
    });
    const readyServer = server;
    observation.emit("runtime.server.ready", () => ({
      revision,
      url: readyServer.url,
    }));

    await waitForRuntimeShutdown(config.runtimeInstanceId);
  } catch (error) {
    observation.emit("runtime.startup_failed", () => ({
      message: error instanceof Error ? error.message : String(error),
    }));
    sendRuntimeChildMessage({
      data: {
        message: error instanceof Error ? error.message : String(error),
      },
      runtimeInstanceId: config.runtimeInstanceId,
      type: "runtime.startup-failed",
    });
    throw error;
  } finally {
    await server?.close().catch(() => {});
    inspector?.close();
    observation.emit("runtime.child.stopped", () => ({}));
    stopObservingConsole();
    sendRuntimeChildMessage({
      data: {},
      runtimeInstanceId: config.runtimeInstanceId,
      type: "runtime.stopped",
    });
  }
}

function createRuntimeObservationSink(runtimeInstanceId: string): DevObservationSink {
  return createDevObservationSink({
    enabled: true,
    runtimeInstanceId,
    warn: (message) => {
      console.warn(message);
    },
    writeLine: createObservationWriteLine(),
  });
}

function createObservationWriteLine(): (line: string) => Promise<void> {
  const stream = createWriteStream("", {
    autoClose: false,
    fd: 3,
  });
  let streamError: Error | undefined;
  stream.once("error", (error) => {
    streamError = error instanceof Error ? error : new Error(String(error));
  });

  return (line) =>
    new Promise<void>((resolve, reject) => {
      if (streamError !== undefined) {
        reject(streamError);
        return;
      }
      if (stream.destroyed) {
        reject(new Error("DevTools observation pipe is closed."));
        return;
      }

      stream.write(`${line}\n`, "utf8", (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
}

function readRuntimeChildConfigFromEnvironment(): DevToolsRuntimeChildConfig {
  const raw = process.env[DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(`${DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV} is required.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV}.`, { cause: error });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${DEVTOOLS_RUNTIME_CHILD_CONFIG_ENV} must be a JSON object.`);
  }

  const config = parsed as Partial<DevToolsRuntimeChildConfig>;
  if (typeof config.appRoot !== "string" || config.appRoot.length === 0) {
    throw new Error("Runtime child config must include appRoot.");
  }
  if (typeof config.runtimeInstanceId !== "string" || config.runtimeInstanceId.length === 0) {
    throw new Error("Runtime child config must include runtimeInstanceId.");
  }

  return config as DevToolsRuntimeChildConfig;
}

function sendRuntimeChildMessage<TType extends string, TData>(input: {
  readonly data: TData;
  readonly runtimeInstanceId: string;
  readonly type: TType;
}): void {
  process.send?.(createDevControlMessage(input));
}

function waitForRuntimeShutdown(runtimeInstanceId: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off("message", handleMessage);
      process.off("disconnect", finish);
      resolve();
    };
    const handleMessage = (rawMessage: unknown) => {
      const message = parseSupervisorMessage(rawMessage, runtimeInstanceId);
      if (message?.type !== "runtime.shutdown") {
        return;
      }

      finish();
    };

    process.on("message", handleMessage);
    process.once("disconnect", finish);
  });
}

function parseSupervisorMessage(
  rawMessage: unknown,
  runtimeInstanceId: string,
): SupervisorControlMessage | undefined {
  if (rawMessage === null || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    return undefined;
  }

  const message = rawMessage as Partial<SupervisorControlMessage>;
  if (
    message.version !== DEVTOOLS_CONTROL_VERSION ||
    message.runtimeInstanceId !== runtimeInstanceId ||
    message.type !== "runtime.shutdown" ||
    message.data === null ||
    typeof message.data !== "object"
  ) {
    return undefined;
  }

  return message as SupervisorControlMessage;
}
