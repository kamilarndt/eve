import type { IncomingMessage, ServerResponse } from "node:http";

import type { createDevToolsDebuggerDomain } from "#internal/devtools/domains/debugger/debugger-domain.js";
import type { createDevToolsLogsDomain } from "#internal/devtools/domains/logs/logs-domain.js";
import type { createDevToolsRunsDomain } from "#internal/devtools/domains/runs/runs-domain.js";
import type { createDevToolsRuntimeDomain } from "#internal/devtools/domains/runtime/runtime-domain.js";
import type { createDevToolsSourcesDomain } from "#internal/devtools/domains/sources/sources-domain.js";
import {
  parseCursor,
  type DevToolsEventHub,
  type DevToolsHubEvent,
} from "#internal/devtools/event-hub.js";
import { DEVTOOLS_DISCOVERY_SCHEMA_VERSION } from "#internal/devtools/discovery.js";
import type { DevToolsAssetServer } from "./assets.js";
import { DevToolsApiError } from "./errors.js";
import { type DevToolsRouter, readDevToolsJsonBody, sendDevToolsJson } from "./router.js";

export interface DevToolsRouteStreams {
  close(): void;
}

export function registerDevToolsRoutes(input: {
  readonly assets: DevToolsAssetServer;
  readonly debuggerDomain: ReturnType<typeof createDevToolsDebuggerDomain>;
  readonly eventHub: DevToolsEventHub;
  readonly logs: ReturnType<typeof createDevToolsLogsDomain>;
  readonly router: DevToolsRouter;
  readonly runs: ReturnType<typeof createDevToolsRunsDomain>;
  readonly runtime: ReturnType<typeof createDevToolsRuntimeDomain>;
  readonly sources: ReturnType<typeof createDevToolsSourcesDomain>;
}): DevToolsRouteStreams {
  const schemaVersion = DEVTOOLS_DISCOVERY_SCHEMA_VERSION;
  const sseResponses = new Set<ServerResponse>();

  input.router.add("GET", "/", async ({ res }) => input.assets.sendIndex(res));
  input.router.add("GET", "/index.html", async ({ res }) => input.assets.sendIndex(res));
  input.router.add("GET", "/assets/:assetName", async ({ params, res }) =>
    input.assets.sendStaticAsset(res, params.assetName!),
  );

  input.router.add("GET", "/api/v1/health", ({ res }) => {
    sendDevToolsJson(res, 200, {
      ok: true,
      runtime: { status: input.runtime.getInternalState().status },
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/bootstrap", async ({ res }) => {
    await input.runtime.refreshRevision();
    sendDevToolsJson(res, 200, {
      ...(await input.runtime.getAgentSnapshot()),
      debugger: input.debuggerDomain.snapshot(),
      runs: input.runs.list(),
      runtime: input.runtime.getPublicState(),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/agent", async ({ res }) => {
    await input.runtime.refreshRevision();
    sendDevToolsJson(res, 200, {
      ...(await input.runtime.getAgentSnapshot()),
      runtime: input.runtime.getPublicState(),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/sources", async ({ res }) => {
    sendDevToolsJson(res, 200, { schemaVersion, sources: await input.sources.list() });
  });
  input.router.add("GET", "/api/v1/sources/resolve", ({ res, url }) => {
    const scriptId = url.searchParams.get("scriptId");
    const lineNumber = Number(url.searchParams.get("line"));
    const columnNumber = Number(url.searchParams.get("column"));
    if (
      scriptId === null ||
      !Number.isInteger(lineNumber) ||
      lineNumber < 0 ||
      !Number.isInteger(columnNumber) ||
      columnNumber < 0
    ) {
      throw new DevToolsApiError(400, "invalid_generated_location", "Invalid CDP location.");
    }
    sendDevToolsJson(res, 200, {
      location: input.sources.originalLocation({ columnNumber, lineNumber, scriptId }),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/sources/:sourceId", async ({ params, res }) => {
    sendDevToolsJson(res, 200, {
      ...(await input.sources.get(params.sourceId!)),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/sources/:sourceId/locations", async ({ params, res, url }) => {
    const line = Number(url.searchParams.get("line"));
    sendDevToolsJson(res, 200, {
      locations: await input.sources.locations(params.sourceId!, line),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/logs", ({ res, url }) => {
    sendDevToolsJson(res, 200, {
      ...input.logs.list(parseCursor(url.searchParams.get("cursor"))),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/debugger/state", ({ res }) => {
    sendDevToolsJson(res, 200, { debugger: input.debuggerDomain.snapshot(), schemaVersion });
  });
  input.router.add("POST", "/api/v1/debugger/tickets", ({ res }) => {
    if (input.runtime.getInternalState().inspectorUrl === undefined) {
      throw new DevToolsApiError(503, "inspector_unavailable", "Runtime inspector is not ready.");
    }
    sendDevToolsJson(res, 200, { ...input.debuggerDomain.mintTicket(), schemaVersion });
  });
  input.router.add("GET", "/api/v1/events", ({ req, res }) => {
    openSse(req, res, input.eventHub, sseResponses);
  });
  input.router.add("GET", "/api/v1/runs", ({ res }) => {
    sendDevToolsJson(res, 200, { runs: input.runs.list(), schemaVersion });
  });
  input.router.add("POST", "/api/v1/runs", async ({ req, res }) => {
    const message = requireMessage(await readDevToolsJsonBody(req));
    sendDevToolsJson(res, 202, { run: await input.runs.create(message), schemaVersion });
  });
  input.router.add("GET", "/api/v1/runs/:sessionId/events", ({ params, res, url }) => {
    sendDevToolsJson(res, 200, {
      ...input.runs.events(params.sessionId!, parseCursor(url.searchParams.get("cursor"))),
      schemaVersion,
    });
  });
  input.router.add("POST", "/api/v1/runs/:sessionId/messages", async ({ params, req, res }) => {
    const message = requireMessage(await readDevToolsJsonBody(req));
    sendDevToolsJson(res, 202, {
      run: await input.runs.continue(params.sessionId!, message),
      schemaVersion,
    });
  });
  input.router.add("GET", "/api/v1/runs/:sessionId", ({ params, res }) => {
    sendDevToolsJson(res, 200, { run: input.runs.get(params.sessionId!), schemaVersion });
  });

  return {
    close() {
      for (const response of sseResponses) response.end();
      sseResponses.clear();
    },
  };
}

function requireMessage(body: unknown): string {
  const message =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { message?: unknown }).message
      : undefined;
  if (typeof message !== "string" || message.trim() === "") {
    throw new DevToolsApiError(400, "invalid_message", "Expected a non-empty message.");
  }
  return message;
}

function openSse(
  req: IncomingMessage,
  res: ServerResponse,
  eventHub: DevToolsEventHub,
  responses: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n");
  responses.add(res);
  const replay = eventHub.replayAfter(
    typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined,
  );
  if (replay.stale) {
    writeSse(res, {
      data: { reason: "cursor_expired", refetch: true },
      event: "stream.reset",
      id: eventHub.latestId,
    });
  } else {
    for (const event of replay.events) writeSse(res, event);
  }
  const unsubscribe = eventHub.subscribe((event) => writeSse(res, event));
  req.once("close", () => {
    responses.delete(res);
    unsubscribe();
  });
}

function writeSse(res: ServerResponse, event: DevToolsHubEvent): boolean {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  return !res.destroyed && !res.writableEnded;
}
