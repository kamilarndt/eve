import { ClientError } from "#client/client-error.js";
import { Client, type MessageResponse } from "#client/index.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import type { DevToolsEventHub } from "#internal/devtools/event-hub.js";
import { DevToolsApiError } from "#internal/devtools/host/errors.js";

const DEFAULT_EVENT_LIMIT = 5_000;
const DEFAULT_RUN_LIMIT = 200;

export type DevToolsRunStatus = "running" | "waiting" | "completed" | "failed";

export interface DevToolsPendingAction {
  readonly kind: "approval" | "authorization" | "question";
  readonly name: string;
}

export interface DevToolsRunSnapshot {
  readonly createdAt: string;
  readonly eventCount: number;
  readonly pendingAction?: DevToolsPendingAction;
  readonly retainedEventCount: number;
  readonly sessionId: string;
  readonly status: DevToolsRunStatus;
  readonly title: string;
  readonly updatedAt: string;
}

export interface DevToolsRunEvent {
  readonly cursor: string;
  readonly event: HandleMessageStreamEvent;
  readonly sessionId: string;
}

interface MutableRun {
  continuationToken?: string;
  readonly createdAt: string;
  readonly events: DevToolsRunEvent[];
  eventCount: number;
  pendingAction?: DevToolsPendingAction;
  sessionId: string;
  status: DevToolsRunStatus;
  readonly title: string;
  streamIndex: number;
  updatedAt: string;
}

export interface DevToolsRunsDomain {
  continue(sessionId: string, message: string): Promise<DevToolsRunSnapshot>;
  create(message: string): Promise<DevToolsRunSnapshot>;
  events(
    sessionId: string,
    afterCursor: number,
  ): {
    readonly events: readonly DevToolsRunEvent[];
    readonly nextCursor: string;
    readonly run: DevToolsRunSnapshot;
  };
  get(sessionId: string): DevToolsRunSnapshot;
  list(): readonly DevToolsRunSnapshot[];
}

export function createDevToolsRunsDomain(input: {
  readonly assertInteractive: () => string;
  readonly eventHub: DevToolsEventHub;
  readonly eventLimit?: number;
  readonly runLimit?: number;
}): DevToolsRunsDomain {
  const runs = new Map<string, MutableRun>();
  const eventLimit = input.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const runLimit = input.runLimit ?? DEFAULT_RUN_LIMIT;

  const startPump = (run: MutableRun, response: MessageResponse) => {
    void pumpRunEvents(response, (event) => appendEvent(run, event)).catch((error) => {
      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      input.eventHub.publish("run.stream-failed", () => ({
        error: error instanceof Error ? error.message : String(error),
        run: snapshot(run),
        sessionId: run.sessionId,
      }));
    });
  };

  const appendEvent = (run: MutableRun, event: HandleMessageStreamEvent) => {
    input.eventHub.publish("run.event", (cursor) => {
      const runEvent = { cursor, event, sessionId: run.sessionId };
      run.events.push(runEvent);
      if (run.events.length > eventLimit) run.events.shift();
      run.eventCount += 1;
      run.streamIndex += 1;
      run.pendingAction = reducePendingAction(run.pendingAction, event);
      run.status = reduceRunStatus(run.status, event);
      run.updatedAt = new Date().toISOString();
      return { event, run: snapshot(run), sessionId: run.sessionId };
    });
  };

  return {
    async continue(sessionId, message) {
      const run = requireRun(runs, sessionId);
      if (run.status !== "waiting") {
        throw new DevToolsApiError(
          409,
          "run_not_waiting",
          `Run cannot accept another message while ${run.status}.`,
        );
      }

      const runtimeUrl = input.assertInteractive();
      const pendingAction = run.pendingAction;
      run.pendingAction = undefined;
      run.status = "running";
      run.updatedAt = new Date().toISOString();
      try {
        const response = await new Client(resolveDevelopmentClientOptions(runtimeUrl))
          .session({
            continuationToken: run.continuationToken,
            sessionId,
            streamIndex: run.streamIndex,
          })
          .send({ message });
        run.continuationToken = response.continuationToken ?? run.continuationToken;
        input.eventHub.publish("run.updated", () => ({ run: snapshot(run) }));
        startPump(run, response);
        return snapshot(run);
      } catch (error) {
        run.pendingAction = pendingAction;
        run.status = "waiting";
        run.updatedAt = new Date().toISOString();
        throw runtimeRequestError(error);
      }
    },
    async create(message) {
      pruneRuns(runs, runLimit);
      const runtimeUrl = input.assertInteractive();
      let response: MessageResponse;
      try {
        response = await new Client(resolveDevelopmentClientOptions(runtimeUrl))
          .session()
          .send({ message });
      } catch (error) {
        throw runtimeRequestError(error);
      }
      const now = new Date().toISOString();
      const run: MutableRun = {
        continuationToken: response.continuationToken,
        createdAt: now,
        eventCount: 0,
        events: [],
        sessionId: response.sessionId,
        status: "running",
        streamIndex: 0,
        title: deriveRunTitle(message),
        updatedAt: now,
      };
      runs.set(run.sessionId, run);
      input.eventHub.publish("run.registered", () => ({ run: snapshot(run) }));
      startPump(run, response);
      return snapshot(run);
    },
    events(sessionId, afterCursor) {
      const run = requireRun(runs, sessionId);
      const oldest = run.events[0] === undefined ? undefined : Number(run.events[0].cursor);
      if (oldest !== undefined && afterCursor > 0 && afterCursor < oldest - 1) {
        throw new DevToolsApiError(
          409,
          "cursor_expired",
          "The requested run cursor is older than retained history.",
        );
      }
      return {
        events: run.events.filter((event) => Number(event.cursor) > afterCursor),
        nextCursor: run.events.at(-1)?.cursor ?? String(afterCursor),
        run: snapshot(run),
      };
    },
    get(sessionId) {
      return snapshot(requireRun(runs, sessionId));
    },
    list() {
      return [...runs.values()].reverse().map(snapshot);
    },
  };
}

function runtimeRequestError(error: unknown): unknown {
  if (!(error instanceof ClientError)) return error;
  return new DevToolsApiError(
    error.status >= 400 && error.status < 500 ? error.status : 502,
    "runtime_request_failed",
    error.message,
  );
}

function pruneRuns(runs: Map<string, MutableRun>, limit: number): void {
  while (runs.size >= limit) {
    const removable = [...runs.values()].find(
      (run) => run.status === "completed" || run.status === "failed",
    );
    if (removable === undefined) {
      throw new DevToolsApiError(
        503,
        "run_capacity_reached",
        "The DevTools run index is full of active runs.",
      );
    }
    runs.delete(removable.sessionId);
  }
}

function requireRun(runs: Map<string, MutableRun>, sessionId: string): MutableRun {
  const run = runs.get(sessionId);
  if (run === undefined) {
    throw new DevToolsApiError(404, "run_not_found", "Run was not found.");
  }
  return run;
}

function snapshot(run: MutableRun): DevToolsRunSnapshot {
  return {
    createdAt: run.createdAt,
    eventCount: run.eventCount,
    pendingAction: run.pendingAction,
    retainedEventCount: run.events.length,
    sessionId: run.sessionId,
    status: run.status,
    title: run.title,
    updatedAt: run.updatedAt,
  };
}

function reducePendingAction(
  current: DevToolsPendingAction | undefined,
  event: HandleMessageStreamEvent,
): DevToolsPendingAction | undefined {
  switch (event.type) {
    case "input.requested": {
      const request = event.data.requests[0];
      if (request === undefined) return current;
      return {
        kind:
          request.action.toolName === "ask_question" || request.display !== "confirmation"
            ? "question"
            : "approval",
        name: request.action.toolName,
      };
    }
    case "authorization.required":
      return { kind: "authorization", name: event.data.name };
    case "authorization.completed":
    case "session.completed":
    case "session.failed":
      return undefined;
    default:
      return current;
  }
}

function deriveRunTitle(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47).trimEnd()}…`;
}

function reduceRunStatus(
  current: DevToolsRunStatus,
  event: HandleMessageStreamEvent,
): DevToolsRunStatus {
  switch (event.type) {
    case "session.waiting":
      return "waiting";
    case "session.completed":
      return "completed";
    case "session.failed":
    case "step.failed":
    case "turn.failed":
      return "failed";
    default:
      return current;
  }
}

async function pumpRunEvents(
  response: MessageResponse,
  append: (event: HandleMessageStreamEvent) => void,
): Promise<void> {
  for await (const event of response) append(event);
}
