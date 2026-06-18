import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { resolvePackageRoot } from "#internal/application/package.js";
import type { DevToolsObservationRecord } from "#internal/devtools/protocol.js";
import { isDevToolsConsoleContext } from "#internal/devtools/console-correlation.js";
import { createDevToolsDebuggerDomain } from "./domains/debugger/debugger-domain.js";
import { createDevToolsLogsDomain } from "./domains/logs/logs-domain.js";
import { createDevToolsRunsDomain } from "./domains/runs/runs-domain.js";
import { createDevToolsRuntimeDomain } from "./domains/runtime/runtime-domain.js";
import { createDevToolsSourcesDomain } from "./domains/sources/sources-domain.js";
import { createDevToolsEventHub } from "./event-hub.js";
import {
  createDevToolsCapability,
  isAllowedDevToolsRequest,
  isDevToolsAuthorized,
  setDevToolsSecurityHeaders,
} from "./host/auth.js";
import { createDevToolsAssetServer, type DevToolsAssetServer } from "./host/assets.js";
import { DevToolsApiError } from "./host/errors.js";
import { registerDevToolsRoutes } from "./host/routes.js";
import { createDevToolsRouter, sendDevToolsJson } from "./host/router.js";
import { startDevToolsServer } from "./host/server.js";
import type { DevToolsHostHandle, DevToolsRuntimeState } from "./host/types.js";
import { resolveDevToolsDiscoveryPath, writeDevToolsDiscovery } from "./discovery.js";
import { registerDevToolsDiscoveryCleanup } from "./process-cleanup.js";

const SSE_REPLAY_LIMIT = 1_000;

export type {
  DevToolsHostHandle,
  DevToolsLogInput,
  DevToolsRuntimeState,
  DevToolsRuntimeStatus,
} from "./host/types.js";

export async function startDevToolsHost(input: {
  readonly appRoot: string;
  readonly browserCapability?: string;
  readonly getRuntimeState: () => DevToolsRuntimeState;
  readonly updateRuntimeState?: (patch: Partial<DevToolsRuntimeState>) => void;
}): Promise<DevToolsHostHandle> {
  const browserCapability = input.browserCapability ?? createDevToolsCapability();
  const eventHub = createDevToolsEventHub({ replayLimit: SSE_REPLAY_LIMIT });
  const runtime = createDevToolsRuntimeDomain({
    eventHub,
    getState: input.getRuntimeState,
    updateState: input.updateRuntimeState ?? (() => {}),
  });
  const logs = createDevToolsLogsDomain({ eventHub });
  const sources = createDevToolsSourcesDomain({
    appRoot: input.appRoot,
    eventHub,
    getRevision: () => runtime.getInternalState().revision,
  });
  const debuggerDomain = createDevToolsDebuggerDomain({ eventHub, logs, runtime, sources });
  const runs = createDevToolsRunsDomain({
    assertInteractive: () => runtime.assertInteractive(),
    eventHub,
  });
  const assets = createDevToolsAssetServer(join(resolvePackageRoot(), "dist", "devtools-ui"));
  const router = createDevToolsRouter();
  const discoveryPath = resolveDevToolsDiscoveryPath(input.appRoot);
  const routeStreams = registerDevToolsRoutes({
    assets,
    debuggerDomain,
    eventHub,
    logs,
    router,
    runs,
    runtime,
    sources,
  });
  const server = await startDevToolsServer({
    async handleRequest(req, res, port) {
      await handleHttpRequest({ assets, browserCapability, port, req, res, router }).catch(
        (error) => {
          sendHttpError(res, error);
        },
      );
    },
    handleUpgrade(req, socket, port) {
      debuggerDomain.handleUpgrade(req, socket, port);
    },
  });
  const url = server.url;
  const discoveryCleanup = registerDevToolsDiscoveryCleanup(discoveryPath);
  const revisionRefresh = setInterval(() => {
    debuggerDomain.syncInspector();
    void runtime.refreshRevision().catch(() => {});
  }, 1_000);
  revisionRefresh.unref();

  const handle: DevToolsHostHandle = {
    appendLog: (logInput) => logs.append(logInput),
    appendObservation(record: DevToolsObservationRecord) {
      if (record.type === "runtime.console.context" && isDevToolsConsoleContext(record.data)) {
        debuggerDomain.correlateConsole(record.data);
      }
      eventHub.publish("observation.record", () => ({ record }));
    },
    browserCapability,
    browserUrl: `${url}#token=${browserCapability}`,
    async close() {
      clearInterval(revisionRefresh);
      discoveryCleanup.close();
      routeStreams.close();
      debuggerDomain.close();
      logs.close();
      eventHub.close();
      await server.close();
      await rm(discoveryPath, { force: true });
    },
    async syncRuntimeState() {
      debuggerDomain.syncInspector();
      await runtime.refreshRevision();
      await handle.writeDiscovery();
    },
    url,
    async writeDiscovery() {
      await writeDevToolsDiscovery({
        appRoot: input.appRoot,
        browserCapability,
        devtoolsUrl: `${url}#token=${browserCapability}`,
        runtimeState: runtime.getInternalState(),
      });
    },
  };

  try {
    debuggerDomain.syncInspector();
    await handle.writeDiscovery();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

async function handleHttpRequest(input: {
  readonly assets: DevToolsAssetServer;
  readonly browserCapability: string;
  readonly port: number;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly router: ReturnType<typeof createDevToolsRouter>;
}): Promise<void> {
  setDevToolsSecurityHeaders(input.res, input.port);
  const pathname = new URL(input.req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== "/api/v1/health") {
    if (!isAllowedDevToolsRequest(input.req, input.port)) {
      throw new DevToolsApiError(403, "forbidden", "Origin or Host is not allowed.");
    }
    if (
      !input.assets.isAssetPath(pathname) &&
      !isDevToolsAuthorized(input.req, input.browserCapability)
    ) {
      throw new DevToolsApiError(401, "unauthorized", "Missing or invalid DevTools capability.");
    }
  }
  if (!(await input.router.handle(input.req, input.res))) {
    throw new DevToolsApiError(404, "not_found", "Not found.");
  }
}

function sendHttpError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof DevToolsApiError) {
    sendDevToolsJson(res, error.status, { code: error.code, error: error.message, ok: false });
    return;
  }
  sendDevToolsJson(res, 500, {
    code: "internal_error",
    error: "Internal DevTools host error.",
    ok: false,
  });
}
