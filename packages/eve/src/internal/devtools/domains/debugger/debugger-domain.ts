import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { DevToolsEventHub } from "#internal/devtools/event-hub.js";
import { createDevToolsCapability } from "#internal/devtools/host/auth.js";
import type { DevToolsLogsDomain } from "#internal/devtools/domains/logs/logs-domain.js";
import type { DevToolsRuntimeDomain } from "#internal/devtools/domains/runtime/runtime-domain.js";
import type { DevToolsSourcesDomain } from "#internal/devtools/domains/sources/sources-domain.js";
import {
  fingerprintRemoteConsoleArguments,
  type DevToolsConsoleContext,
  normalizeConsoleType,
} from "#internal/devtools/console-correlation.js";
import {
  connectInspectorWebSocket,
  DEBUGGER_TICKET_TTL_MS,
  handleDebuggerUpgrade,
  type InspectorRelaySocket,
} from "#internal/devtools/debugger-relay.js";

const MAX_DEBUGGER_TICKETS = 32;

export interface DevToolsDebuggerDomain {
  close(): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, expectedPort: number): boolean;
  mintTicket(): { readonly expiresInMs: number; readonly ticket: string };
  correlateConsole(input: DevToolsConsoleContext): void;
  snapshot(): {
    readonly connected: boolean;
    readonly controllerAttached: boolean;
    readonly pause?: unknown;
  };
  syncInspector(): void;
}

export function createDevToolsDebuggerDomain(input: {
  readonly eventHub: DevToolsEventHub;
  readonly logs: DevToolsLogsDomain;
  readonly runtime: DevToolsRuntimeDomain;
  readonly sources: DevToolsSourcesDomain;
}): DevToolsDebuggerDomain {
  const debuggerSockets = new Set<Duplex>();
  const tickets = new Map<string, number>();
  let connectedUrl: string | undefined;
  let controllerAttached = false;
  let observer: InspectorRelaySocket | undefined;
  let observerConnected = false;
  let pause: unknown;

  const closeObserver = () => {
    observer?.close();
    observer = undefined;
    observerConnected = false;
    connectedUrl = undefined;
  };

  const syncInspector = () => {
    const inspectorUrl = input.runtime.getInternalState().inspectorUrl;
    if (inspectorUrl === undefined) {
      closeObserver();
      return;
    }
    if (inspectorUrl === connectedUrl && observer !== undefined) return;
    closeObserver();
    connectedUrl = inspectorUrl;
    observer = connectInspectorWebSocket(inspectorUrl, {
      onClose() {
        observerConnected = false;
        observer = undefined;
        connectedUrl = undefined;
        input.eventHub.publish("debugger.connection", () => ({ connected: false }));
      },
      onMessage: handleInspectorMessage,
      onOpen() {
        observerConnected = true;
        observer?.send(JSON.stringify({ id: 1_000_000_001, method: "Runtime.enable" }));
        observer?.send(JSON.stringify({ id: 1_000_000_002, method: "Debugger.enable" }));
        input.eventHub.publish("debugger.connection", () => ({ connected: true }));
      },
    });
  };

  const handleInspectorMessage = (message: string) => {
    let payload: { method?: string; params?: Record<string, unknown> };
    try {
      payload = JSON.parse(message) as typeof payload;
    } catch {
      return;
    }

    const params = payload.params ?? {};
    switch (payload.method) {
      case "Debugger.paused":
        pause = params;
        input.runtime.update({ status: "paused" });
        input.eventHub.publish("debugger.paused", () => ({ pause: params }));
        break;
      case "Debugger.resumed":
        pause = undefined;
        if (input.runtime.getInternalState().status === "paused") {
          input.runtime.update({ status: "ready" });
        }
        input.eventHub.publish("debugger.resumed", () => ({}));
        break;
      case "Debugger.scriptParsed": {
        const scriptId = params.scriptId;
        const url = params.url;
        if (typeof scriptId === "string" && typeof url === "string") {
          input.sources.recordScript({
            revision: input.runtime.getInternalState().revision,
            scriptId,
            sourceMapUrl: typeof params.sourceMapURL === "string" ? params.sourceMapURL : undefined,
            url,
          });
        }
        break;
      }
      case "Runtime.consoleAPICalled":
        appendConsoleRecord(params);
        break;
      case "Runtime.exceptionThrown":
        appendExceptionRecord(params);
        break;
    }
  };

  const appendConsoleRecord = (params: Record<string, unknown>) => {
    const type = typeof params.type === "string" ? params.type : "log";
    const args = Array.isArray(params.args) ? params.args : [];
    input.logs.appendConsole(
      {
        fields: { arguments: args.map(formatRemoteObject) },
        level: type === "error" ? "error" : type === "warning" ? "warn" : "info",
        message: args.map(formatRemoteObject).join(" "),
        source: resolveAuthoredSource(params.stackTrace, input.sources),
        stream: "console",
      },
      consoleCorrelationKey(type, fingerprintRemoteConsoleArguments(args)),
    );
  };

  const appendExceptionRecord = (params: Record<string, unknown>) => {
    const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
    input.logs.append({
      fields: { exception: details.exception },
      level: "error",
      message:
        typeof details.text === "string" ? details.text : formatRemoteObject(details.exception),
      source: resolveAuthoredSource(details.stackTrace, input.sources),
      stream: "console",
    });
  };

  return {
    close() {
      closeObserver();
      for (const socket of debuggerSockets) socket.destroy();
      debuggerSockets.clear();
      tickets.clear();
    },
    handleUpgrade(req, socket, expectedPort) {
      syncInspector();
      const accepted = handleDebuggerUpgrade({
        debuggerTickets: tickets,
        expectedPort,
        getDebuggerOwned: () => controllerAttached,
        inspectorUrl: input.runtime.getInternalState().inspectorUrl,
        req,
        setDebuggerOwned(owned) {
          controllerAttached = owned;
          input.eventHub.publish("debugger.controller", () => ({ attached: owned }));
        },
        socket,
      });
      if (accepted) {
        debuggerSockets.add(socket);
        socket.once("close", () => debuggerSockets.delete(socket));
      }
      return accepted;
    },
    correlateConsole(consoleContext) {
      input.logs.correlateConsole(
        consoleCorrelationKey(consoleContext.type, consoleContext.fingerprint),
        consoleContext.coordinates === undefined ? {} : { coordinates: consoleContext.coordinates },
      );
    },
    mintTicket() {
      pruneTickets(tickets);
      if (tickets.size >= MAX_DEBUGGER_TICKETS) {
        const oldest = tickets.keys().next().value as string | undefined;
        if (oldest !== undefined) tickets.delete(oldest);
      }
      const ticket = createDevToolsCapability();
      tickets.set(ticket, Date.now() + DEBUGGER_TICKET_TTL_MS);
      return { expiresInMs: DEBUGGER_TICKET_TTL_MS, ticket };
    },
    snapshot() {
      return { connected: observerConnected, controllerAttached, pause };
    },
    syncInspector,
  };
}

function pruneTickets(tickets: Map<string, number>): void {
  const now = Date.now();
  for (const [ticket, expiresAt] of tickets) {
    if (expiresAt < now) tickets.delete(ticket);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatRemoteObject(value: unknown): string {
  if (!isRecord(value)) return String(value ?? "");
  if ("value" in value) {
    return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  }
  if (typeof value.description === "string") return value.description;
  if (typeof value.type === "string") return value.type;
  return "[value]";
}

function resolveAuthoredSource(
  value: unknown,
  sources: DevToolsSourcesDomain,
):
  | {
      readonly column?: number;
      readonly line?: number;
      readonly path?: string;
      readonly url?: string;
    }
  | undefined {
  if (!isRecord(value) || !Array.isArray(value.callFrames)) return undefined;
  const frames = value.callFrames.filter(isRecord);
  for (const frame of frames) {
    if (
      typeof frame.scriptId !== "string" ||
      typeof frame.lineNumber !== "number" ||
      typeof frame.columnNumber !== "number"
    ) {
      continue;
    }
    const original = sources.originalLocation({
      columnNumber: frame.columnNumber,
      lineNumber: frame.lineNumber,
      scriptId: frame.scriptId,
    });
    if (original !== undefined) {
      return { column: original.column, line: original.line, path: original.sourceId };
    }
  }
  const frame = frames.find((candidate) => typeof candidate.url === "string");
  if (frame === undefined || typeof frame.url !== "string") return undefined;
  return {
    column: typeof frame.columnNumber === "number" ? frame.columnNumber + 1 : undefined,
    line: typeof frame.lineNumber === "number" ? frame.lineNumber + 1 : undefined,
    url: frame.url,
  };
}

function consoleCorrelationKey(type: string, fingerprint: string): string {
  return `${normalizeConsoleType(type)}:${fingerprint}`;
}
