import type { HandleMessageStreamEvent } from "eve/client";

interface BashLatencyMeasurement {
  readonly callId: string;
  readonly clientCompletedAtMs: number;
  readonly clientStartedAtMs: number;
  readonly completedAtMs: number;
  readonly label: string;
  readonly query: string;
  readonly receivedAtMs: number;
  readonly requestedAt: string | undefined;
  readonly resultAt: string | undefined;
}

interface BashResultEvent {
  readonly callId: string;
  readonly observedAt: string | undefined;
  readonly output: unknown;
}

interface BashLatencyTraceCall {
  readonly callId: string;
  readonly clientDurationMs: number;
  readonly completedAtMs: number;
  readonly label: string;
  readonly observedLatencyMs: number | null;
  readonly query: string;
  readonly receivedAtMs: number;
  readonly requestedAt: string | null;
  readonly resultAt: string | null;
}

export function bashCurlLatencyCallsMatch(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly expectedRequests: readonly { readonly label: string; readonly query: string }[];
}): boolean {
  const measurements = bashLatencyMeasurements(input.events);
  const expectedQueryByLabel = new Map(
    input.expectedRequests.map((request) => [request.label, request.query]),
  );

  return (
    measurements.length === input.expectedRequests.length &&
    expectedQueryByLabel.size === input.expectedRequests.length &&
    new Set(measurements.map((measurement) => measurement.label)).size ===
      input.expectedRequests.length &&
    measurements.every(
      (measurement) =>
        expectedQueryByLabel.get(measurement.label) === measurement.query &&
        measurement.clientStartedAtMs < measurement.clientCompletedAtMs &&
        measurement.receivedAtMs < measurement.completedAtMs,
    )
  );
}

export function formatBashCurlLatencyTrace(events: readonly HandleMessageStreamEvent[]): string {
  const calls = bashLatencyMeasurements(events).map((measurement) => ({
    callId: measurement.callId,
    clientDurationMs: measurement.clientCompletedAtMs - measurement.clientStartedAtMs,
    completedAtMs: measurement.completedAtMs,
    label: measurement.label,
    observedLatencyMs: durationMs(measurement.requestedAt, measurement.resultAt),
    query: measurement.query,
    receivedAtMs: measurement.receivedAtMs,
    requestedAt: measurement.requestedAt ?? null,
    resultAt: measurement.resultAt ?? null,
  }));

  return JSON.stringify({
    calls,
    kind: "bash-curl-latency-trace",
    timing: summarizeBashLatency(calls),
  });
}

function bashLatencyMeasurements(
  events: readonly HandleMessageStreamEvent[],
): readonly BashLatencyMeasurement[] {
  const requestedAtByCallId = new Map<string, string | undefined>();
  for (const event of events) {
    if (event.type !== "actions.requested") continue;

    for (const action of event.data.actions) {
      if (action.kind === "tool-call" && action.toolName === "bash") {
        requestedAtByCallId.set(action.callId, event.meta?.at);
      }
    }
  }

  return bashResultEvents(events).flatMap((result) => {
    const parsed = parseBashLatencyMeasurement(result.output);
    if (parsed === undefined) return [];

    return [
      {
        ...parsed,
        callId: result.callId,
        requestedAt: requestedAtByCallId.get(result.callId),
        resultAt: result.observedAt,
      },
    ];
  });
}

function bashResultEvents(events: readonly HandleMessageStreamEvent[]): readonly BashResultEvent[] {
  return events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== "bash") return [];

    return [
      {
        callId: event.data.result.callId,
        observedAt: event.meta?.at,
        output: event.data.result.output,
      },
    ];
  });
}

function parseBashLatencyMeasurement(
  value: unknown,
): Omit<BashLatencyMeasurement, "callId" | "requestedAt" | "resultAt"> | undefined {
  const stdout = readStringField(value, "stdout");
  if (stdout === undefined) return undefined;

  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line);
    const clientStartedAtMs = readFiniteNumberField(parsed, "clientStartedAtMs");
    const clientCompletedAtMs = readFiniteNumberField(parsed, "clientCompletedAtMs");
    const server = readField(parsed, "server");
    const label = readStringField(server, "label");
    const query = readStringField(server, "query");
    const receivedAtMs = readFiniteNumberField(server, "receivedAtMs");
    const completedAtMs = readFiniteNumberField(server, "completedAtMs");

    if (
      clientStartedAtMs !== undefined &&
      clientCompletedAtMs !== undefined &&
      completedAtMs !== undefined &&
      label !== undefined &&
      query !== undefined &&
      receivedAtMs !== undefined
    ) {
      return {
        clientCompletedAtMs,
        clientStartedAtMs,
        completedAtMs,
        label,
        query,
        receivedAtMs,
      };
    }
  }

  return undefined;
}

/**
 * Uses host-clock stream timestamps for observed latency and the sandbox's
 * own duration for the eager estimate. The clocks never mix as absolute
 * values, only as a request-relative duration.
 */
function summarizeBashLatency(calls: readonly BashLatencyTraceCall[]): {
  readonly currentCompletionFromFirstRequestMs: number | null;
  readonly currentFirstResultFromFirstRequestMs: number | null;
  readonly estimatedEagerCompletionFromFirstRequestMs: number | null;
  readonly estimatedEagerFirstResultFromFirstRequestMs: number | null;
  readonly maxObservedLatencyMs: number | null;
  readonly minObservedLatencyMs: number | null;
  readonly potentialCompletionHeadroomMs: number | null;
  readonly potentialFirstResultHeadroomMs: number | null;
} {
  const firstRequestAtMs = minimum(
    calls.map((call) => eventTimestampMs(call.requestedAt)).filter(isDefined),
  );
  if (firstRequestAtMs === undefined) {
    return {
      currentCompletionFromFirstRequestMs: null,
      currentFirstResultFromFirstRequestMs: null,
      estimatedEagerCompletionFromFirstRequestMs: null,
      estimatedEagerFirstResultFromFirstRequestMs: null,
      maxObservedLatencyMs: null,
      minObservedLatencyMs: null,
      potentialCompletionHeadroomMs: null,
      potentialFirstResultHeadroomMs: null,
    };
  }

  const observedResultTimesMs = calls
    .map((call) => eventTimestampMs(call.resultAt))
    .filter(isDefined);
  const estimatedEagerResultTimesMs = calls.flatMap((call) => {
    const requestedAtMs = eventTimestampMs(call.requestedAt);
    return requestedAtMs === undefined ? [] : [requestedAtMs + call.clientDurationMs];
  });
  const observedLatenciesMs = calls.map((call) => call.observedLatencyMs).filter(isDefined);
  const currentFirstResultFromFirstRequestMs = relativeTo(
    minimum(observedResultTimesMs),
    firstRequestAtMs,
  );
  const currentCompletionFromFirstRequestMs = relativeTo(
    maximum(observedResultTimesMs),
    firstRequestAtMs,
  );
  const estimatedEagerFirstResultFromFirstRequestMs = relativeTo(
    minimum(estimatedEagerResultTimesMs),
    firstRequestAtMs,
  );
  const estimatedEagerCompletionFromFirstRequestMs = relativeTo(
    maximum(estimatedEagerResultTimesMs),
    firstRequestAtMs,
  );

  return {
    currentCompletionFromFirstRequestMs,
    currentFirstResultFromFirstRequestMs,
    estimatedEagerCompletionFromFirstRequestMs,
    estimatedEagerFirstResultFromFirstRequestMs,
    maxObservedLatencyMs: maximum(observedLatenciesMs) ?? null,
    minObservedLatencyMs: minimum(observedLatenciesMs) ?? null,
    potentialCompletionHeadroomMs: difference(
      currentCompletionFromFirstRequestMs,
      estimatedEagerCompletionFromFirstRequestMs,
    ),
    potentialFirstResultHeadroomMs: difference(
      currentFirstResultFromFirstRequestMs,
      estimatedEagerFirstResultFromFirstRequestMs,
    ),
  };
}

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function durationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  const startedAtMs = eventTimestampMs(startedAt);
  const completedAtMs = eventTimestampMs(completedAt);
  return startedAtMs === undefined || completedAtMs === undefined
    ? null
    : completedAtMs - startedAtMs;
}

function eventTimestampMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function maximum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

function minimum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, field);
}

function readFiniteNumberField(value: unknown, field: string): number | undefined {
  const candidate = readField(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  const candidate = readField(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}

function relativeTo(value: number | undefined, origin: number): number | null {
  return value === undefined ? null : value - origin;
}
