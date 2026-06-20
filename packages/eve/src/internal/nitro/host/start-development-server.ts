import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";

import { build as buildNitro, createDevServer, prepare } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { createApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import {
  parseDevelopmentProcessId,
  readActiveDevelopmentProcess,
  readDevelopmentServerMetadata,
  resolveDevelopmentProcessIdPath,
  resolveDevelopmentServerMetadataPath,
  writeDevelopmentServerMetadata,
} from "#internal/nitro/host/development-server-metadata.js";
import { createNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { prepareApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  pruneLocalSandboxTemplatesInBackground,
  stopDevelopmentSandboxResources,
} from "#execution/sandbox/bindings/local.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import {
  clearInitializedDevelopmentSandboxBackendNames,
  createDevelopmentSandboxRunId,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
  getInitializedDevelopmentSandboxBackendNames,
} from "#execution/sandbox/development-run.js";
import type {
  DevelopmentServerHandle,
  DevelopmentServerOptions,
} from "#internal/nitro/host/types.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { pruneDevelopmentRuntimeArtifactsSnapshotsInBackground } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_PORT,
  MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS,
} from "#internal/nitro/host/ports.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { eveDevArguments } from "#setup/primitives/index.js";
import { devBootPhase } from "#internal/dev-boot-progress.js";
import {
  LocalDevelopmentAuthServer,
  type LocalDevelopmentAuthServerHandle,
} from "#internal/local-development-auth.js";

const MAX_ALLOWED_DEVELOPMENT_SERVER_PORT = 65_535;
const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const PORT_ENV = "PORT";
const DEFAULT_DEVELOPMENT_SERVER_HOST = "127.0.0.1";
const IPV6_LOOPBACK_HOSTNAME = "[::1]";
const DEVELOPMENT_SERVER_URL_PLACEHOLDER = "http://localhost:PORT";
let activeDevelopmentServerOwner: symbol | undefined;

type CleanupTask = () => void | Promise<void>;

async function runCleanupTasksInOrder(tasks: readonly CleanupTask[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Failed to close the development server.");
}

function claimDevelopmentServerProcess(): symbol {
  if (activeDevelopmentServerOwner !== undefined) {
    throw new Error("A development server is already active in this process.");
  }
  const owner = Symbol("eve-development-server");
  activeDevelopmentServerOwner = owner;
  return owner;
}

function releaseDevelopmentServerProcess(owner: symbol): void {
  if (activeDevelopmentServerOwner === owner) {
    activeDevelopmentServerOwner = undefined;
  }
}

/**
 * Hostnames Nitro/srvx surface when listening on an IPv6 wildcard interface.
 * They are valid bind targets but invalid as connect targets.
 */
const IPV6_WILDCARD_LISTEN_HOSTNAMES: ReadonlySet<string> = new Set(["[::]", "::"]);

/**
 * Rewrites a server URL whose hostname is a wildcard listen address into a
 * loopback URL on the same address family.
 */
export function normalizeDevelopmentServerClientUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (IPV6_WILDCARD_LISTEN_HOSTNAMES.has(url.hostname)) {
    url.hostname = IPV6_LOOPBACK_HOSTNAME;
    return url.toString();
  }

  if (url.hostname === "0.0.0.0") {
    url.hostname = DEFAULT_DEVELOPMENT_SERVER_HOST;
    return url.toString();
  }

  return serverUrl;
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

type NitroDevelopmentServer = ReturnType<typeof createDevServer>;
type NitroDevelopmentServerUpgrade = NitroDevelopmentServer["upgrade"];

function resolveDevelopmentServerPort(port: number | string | undefined): number {
  const resolvedPort =
    typeof port === "string" ? Number(port) : (port ?? DEFAULT_DEVELOPMENT_SERVER_PORT);

  if (
    !Number.isInteger(resolvedPort) ||
    resolvedPort < 0 ||
    resolvedPort > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT
  ) {
    throw new Error(
      `Invalid development server port "${String(port)}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return resolvedPort;
}

function readEnvironmentPort(): number | undefined {
  const raw = process.env[PORT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT) {
    throw new Error(
      `Invalid ${PORT_ENV} environment variable "${raw}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return parsed;
}

function formatKillCommand(processId: number): string {
  if (process.platform === "win32") {
    return `taskkill /PID ${processId}`;
  }

  return `kill ${processId}`;
}

async function detectDevelopmentCommandPackageManager(
  appRoot: string,
): Promise<PackageManagerKind> {
  try {
    return (await detectPackageManager(appRoot)).kind;
  } catch {
    return "pnpm";
  }
}

async function formatDevelopmentServerConnectCommand(
  appRoot: string,
  serverUrl: string,
): Promise<string> {
  const packageManager = await detectDevelopmentCommandPackageManager(appRoot);
  return [packageManager, ...eveDevArguments(packageManager), serverUrl].join(" ");
}

async function writeDevelopmentProcessId(appRoot: string): Promise<() => Promise<void>> {
  const processIdPath = resolveDevelopmentProcessIdPath(appRoot);
  const metadataPath = resolveDevelopmentServerMetadataPath(appRoot);
  const activeProcess = await readActiveDevelopmentProcess(appRoot);

  if (activeProcess !== undefined) {
    const connectUrl = activeProcess.url ?? DEVELOPMENT_SERVER_URL_PLACEHOLDER;
    const connectCommand = await formatDevelopmentServerConnectCommand(appRoot, connectUrl);
    throw new Error(
      [
        `A dev server is already running for this eve agent (pid ${activeProcess.processId}).`,
        `To connect to the existing instance, run: ${connectCommand}`,
        `To stop it, run: ${formatKillCommand(activeProcess.processId)}`,
      ].join("\n"),
    );
  }

  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(processIdPath, `${process.pid}\n`, "utf8");

  return async () => {
    let currentProcessId: number | undefined;

    try {
      currentProcessId = parseDevelopmentProcessId(await readFile(processIdPath, "utf8"));
    } catch {
      currentProcessId = undefined;
    }

    if (currentProcessId === process.pid) {
      const removals = await Promise.allSettled([
        rm(metadataPath, { force: true }),
        rm(processIdPath, { force: true }),
      ]);
      const errors = removals.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      throwCleanupErrors(errors);
      return;
    }

    const metadata = await readDevelopmentServerMetadata(appRoot);
    if (metadata?.processId === process.pid) {
      await rm(metadataPath, { force: true });
    }
  };
}

function resolveDevelopmentServerPorts(input: {
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}): readonly [number, ...number[]] {
  const resolvedPort = resolveDevelopmentServerPort(input.port);

  if (resolvedPort === 0 || !input.retryOnAddressInUse) {
    return [resolvedPort];
  }

  const ports: number[] = [];

  for (let offset = 0; offset < MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS; offset += 1) {
    const candidate = resolvedPort + offset;

    if (candidate > 65_535) {
      break;
    }

    ports.push(candidate);
  }

  return ports as [number, ...number[]];
}

function installWorkflowLocalQueueEnvironment(serverUrl: string): () => void {
  const previousWorkflowLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
  const previousPort = process.env[PORT_ENV];
  const url = new URL(normalizeDevelopmentServerClientUrl(serverUrl));

  process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = url.origin;
  if (url.port) {
    process.env[PORT_ENV] = url.port;
  }

  return () => {
    if (previousWorkflowLocalBaseUrl === undefined) {
      delete process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
    } else {
      process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = previousWorkflowLocalBaseUrl;
    }

    if (previousPort === undefined) {
      delete process.env[PORT_ENV];
    } else {
      process.env[PORT_ENV] = previousPort;
    }
  };
}

function attachTemporarySocketErrorHandler(socket: Socket): () => void {
  // Keep early socket failures from becoming uncaught EventEmitter errors
  // while Nitro/httpxy installs its own upgrade-path listeners.
  const onSocketError = () => {};

  socket.once("error", onSocketError);

  return () => {
    socket.off("error", onSocketError);
  };
}

function shouldProxyDevelopmentServerWebSocketUpgrades(nitro: Nitro): boolean {
  return nitro.options.features.websocket === true || nitro.options.experimental.websocket === true;
}

function guardDevelopmentServerWebSocketUpgrades(
  nitro: Nitro,
  devServer: NitroDevelopmentServer,
): void {
  const originalUpgrade = devServer.upgrade.bind(devServer) as NitroDevelopmentServerUpgrade;
  const websocketEnabled = shouldProxyDevelopmentServerWebSocketUpgrades(nitro);
  const guardedUpgrade: NitroDevelopmentServerUpgrade = async (
    req: IncomingMessage,
    socket: Socket,
    head: unknown,
  ) => {
    if (!websocketEnabled) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      return;
    }

    const removeSocketErrorHandler = attachTemporarySocketErrorHandler(socket);

    try {
      await originalUpgrade(req, socket, head);
    } catch {
      if (!socket.destroyed) {
        socket.destroy();
      }
    } finally {
      removeSocketErrorHandler();
    }
  };

  devServer.upgrade = guardedUpgrade;
}

async function listenForDevelopmentServer(input: {
  readonly devServer: NitroDevelopmentServer;
  readonly host?: string;
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}) {
  const ports = resolveDevelopmentServerPorts({
    port: input.port,
    retryOnAddressInUse: input.retryOnAddressInUse,
  });
  let lastError: unknown;

  for (const port of ports) {
    const server = input.devServer.listen({
      hostname: input.host,
      port,
      silent: true,
    });

    try {
      await server.ready();
      return server;
    } catch (error) {
      lastError = error;
      await server.close().catch(() => {});

      if (!isAddressInUseError(error)) {
        throw error;
      }

      if (!input.retryOnAddressInUse) {
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to start Nitro dev server after ${ports.length} attempts. Tried ports ${ports.join(", ")}.`,
    {
      cause: lastError,
    },
  );
}

/**
 * Starts the development Nitro server for an eve application.
 *
 * Authored schedules are never registered with Nitro's cron scheduler in
 * dev mode. To fire one authored schedule on demand, `POST` the dev-only
 * `/eve/v1/dev/schedules/:scheduleId` route — the handler returns
 * `{ scheduleId, sessionIds }` so callers can subscribe to the existing
 * per-session stream route.
 */
export async function startDevelopmentServer(
  rootDir: string,
  options: DevelopmentServerOptions = {},
): Promise<DevelopmentServerHandle> {
  const processOwner = claimDevelopmentServerProcess();
  const previousEveDev = process.env[EVE_DEV_ENV_FLAG];
  const previousDevelopmentSandboxRunId = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  let developmentSandboxRunId: string;
  try {
    developmentSandboxRunId = createDevelopmentSandboxRunId();
  } catch (error) {
    releaseDevelopmentServerProcess(processOwner);
    throw error;
  }
  let nitro: Nitro | undefined;
  let devServer: NitroDevelopmentServer | undefined;
  let localAuthServer: LocalDevelopmentAuthServerHandle | undefined;
  let restoreWorkflowLocalQueueEnvironment: (() => void) | undefined;
  let authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  let removeDevelopmentProcessId: (() => Promise<void>) | undefined;
  let cleanupPromise: Promise<unknown[]> | undefined;

  const cleanup = (): Promise<unknown[]> => {
    cleanupPromise ??= runCleanupTasksInOrder([
      async () => await authoredSourceWatcher?.close(),
      async () => await devServer?.close(),
      async () => await nitro?.close(),
      async () => await removeDevelopmentProcessId?.(),
      async () => await localAuthServer?.dispose(),
      async () =>
        await stopDevelopmentSandboxResources({
          backendNames: getInitializedDevelopmentSandboxBackendNames(developmentSandboxRunId),
          devRunId: developmentSandboxRunId,
          log: (message) => console.warn(`[eve:dev] ${message}`),
        }),
      () => clearInitializedDevelopmentSandboxBackendNames(developmentSandboxRunId),
      () => restoreWorkflowLocalQueueEnvironment?.(),
      () => restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId),
      () => restoreEnvironmentValue(EVE_DEV_ENV_FLAG, previousEveDev),
      () => releaseDevelopmentServerProcess(processOwner),
    ]);
    return cleanupPromise;
  };

  try {
    // Marks this process tree as an `eve dev` session so runtime features
    // that must never run in production can gate on it.
    process.env[EVE_DEV_ENV_FLAG] = "1";
    process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = developmentSandboxRunId;
    loadDevelopmentEnvironmentFiles(rootDir);
    const preparedHost = await devBootPhase(
      "compiling agent",
      () => prepareApplicationHost(rootDir, { dev: true }),
      options.onBootProgress,
    );
    removeDevelopmentProcessId = await writeDevelopmentProcessId(preparedHost.appRoot);
    const localAuthServerResult = await LocalDevelopmentAuthServer.start(preparedHost.appRoot);
    if (!localAuthServerResult.ok) {
      const cause = localAuthServerResult.error.cause;
      if (cause instanceof Error) throw cause;
      throw new Error("Failed to start local development auth.", { cause });
    }
    localAuthServer = localAuthServerResult.value;
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground(preparedHost.appRoot);
    const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(
      createNitroArtifactsConfig({
        appRoot: preparedHost.appRoot,
        dev: true,
      }),
    );
    startDevelopmentSandboxPrewarmInBackground({
      appRoot: preparedHost.appRoot,
      compiledArtifactsSource,
    });
    pruneLocalSandboxTemplatesInBackground(preparedHost.appRoot);
    const activeNitro = await devBootPhase(
      "creating dev server",
      () => createApplicationNitro(preparedHost, true),
      options.onBootProgress,
    );
    nitro = activeNitro;
    devServer = createDevServer(activeNitro);
    const activeDevServer = devServer;
    guardDevelopmentServerWebSocketUpgrades(activeNitro, devServer);
    const hostname =
      options.host ?? activeNitro.options.devServer.hostname ?? DEFAULT_DEVELOPMENT_SERVER_HOST;
    const requestedPort = options.port ?? readEnvironmentPort();
    const retryOnAddressInUse = requestedPort === undefined;
    const server = await devBootPhase(
      "binding port",
      () =>
        listenForDevelopmentServer({
          devServer: activeDevServer,
          host: hostname,
          port: requestedPort,
          retryOnAddressInUse,
        }),
      options.onBootProgress,
    );

    if (!server.url) {
      throw new Error("Nitro dev server did not expose a URL.");
    }

    const serverUrl = normalizeDevelopmentServerClientUrl(server.url);
    await writeDevelopmentServerMetadata({
      appRoot: preparedHost.appRoot,
      localAuth: localAuthServer.metadata,
      serverUrl,
    });
    restoreWorkflowLocalQueueEnvironment = installWorkflowLocalQueueEnvironment(serverUrl);
    await devBootPhase(
      "building dev bundle",
      async () => {
        await prepare(activeNitro);
        await buildNitro(activeNitro);
      },
      options.onBootProgress,
    );

    authoredSourceWatcher = await devBootPhase(
      "starting file watcher",
      async () => {
        const { startAuthoredSourceWatcher } =
          await import("#internal/nitro/host/dev-authored-source-watcher.js");
        return startAuthoredSourceWatcher({ nitro: activeNitro, preparedHost });
      },
      options.onBootProgress,
    );
    if (restoreWorkflowLocalQueueEnvironment === undefined) {
      throw new Error("Workflow local queue environment was not initialized.");
    }

    return {
      async close() {
        throwCleanupErrors(await cleanup());
      },
      localAuth: localAuthServer.metadata,
      url: serverUrl,
    };
  } catch (error) {
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Development server startup failed and cleanup was incomplete.",
      { cause: error },
    );
  }
}

function restoreDevelopmentSandboxRunId(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    return;
  }
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = previous;
}

function restoreEnvironmentValue(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}
