import type { ActionResultStreamEvent, HandleMessageStreamEvent } from "eve/client";

type MatchingToolResultEvent = ActionResultStreamEvent & {
  readonly data: ActionResultStreamEvent["data"] & {
    readonly result: Extract<ActionResultStreamEvent["data"]["result"], { kind: "tool-result" }>;
  };
};

interface Interval {
  readonly completedAt: number;
  readonly key: string;
  readonly startedAt: number;
}

export interface MeasurementConfig {
  readonly expectedKeys: readonly string[];
  readonly keyField: string;
  readonly toolName: string;
}

export interface DsvConfig {
  readonly expectedKeys: readonly string[];
  readonly filePath: string;
  readonly keyColumn: string;
  readonly numericColumns?: readonly string[];
  readonly requiredColumns: readonly string[];
}

export function measurementLog(input: {
  readonly config: MeasurementConfig;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly scenario: string;
}): string {
  return JSON.stringify({
    kind: "natural-parallel-tool-measurement",
    scenario: input.scenario,
    metrics: measureToolUse(input.events, input.config),
  });
}

export function requestedEveryKey(input: {
  readonly config: MeasurementConfig;
  readonly events: readonly HandleMessageStreamEvent[];
}): boolean {
  const requested = requestedKeys(input.events, input.config);
  return input.config.expectedKeys.every((key) => requested.has(key.toLowerCase()));
}

export function writtenDsvMatches(input: {
  readonly config: DsvConfig;
  readonly events: readonly HandleMessageStreamEvent[];
}): boolean {
  const content = writtenFileContent(input.events, input.config.filePath);
  if (content === undefined) return false;

  const rows = parseDsv(content);
  if (rows.length !== input.config.expectedKeys.length) return false;
  const expectedKeys = new Set(input.config.expectedKeys.map((key) => key.toLowerCase()));
  const observedKeys = new Set<string>();

  for (const row of rows) {
    for (const column of input.config.requiredColumns) {
      if ((row[column]?.trim() ?? "").length === 0) return false;
    }

    const key = row[input.config.keyColumn]?.trim().toLowerCase();
    if (key === undefined || !expectedKeys.has(key)) return false;
    observedKeys.add(key);

    for (const column of input.config.numericColumns ?? []) {
      const raw = row[column]?.replaceAll(",", "").trim() ?? "";
      if (raw.length === 0 || !Number.isFinite(Number(raw))) return false;
    }
  }

  return observedKeys.size === expectedKeys.size;
}

export function expectedToolActionsSucceeded(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly toolNames: readonly string[];
}): boolean {
  const expectedToolNames = new Set(input.toolNames);

  return input.events.every((event) => {
    if (event.type !== "action.result") return true;
    if (event.data.result.kind !== "tool-result") return true;
    if (!expectedToolNames.has(event.data.result.toolName)) return true;

    const resultIsError = "isError" in event.data.result && event.data.result.isError === true;
    return event.data.status !== "failed" && !resultIsError;
  });
}

function measureToolUse(events: readonly HandleMessageStreamEvent[], config: MeasurementConfig) {
  const batchSizes = requestedBatchSizes(events, config.toolName);
  const intervals = resultIntervals(events, config);
  const requested = requestedKeys(events, config);
  const missingKeys = config.expectedKeys.filter((key) => !requested.has(key.toLowerCase()));
  const firstResultIndex = events.findIndex((event) =>
    isMatchingToolResultEvent(event, config.toolName),
  );

  return {
    allExecutionsOverlap: allIntervalsOverlap(intervals, config.expectedKeys.length),
    allRequestsBeforeFirstResult:
      firstResultIndex >= 0 &&
      config.expectedKeys.every((key) =>
        requestEventIndexForKey({ events, config, key, beforeIndex: firstResultIndex }),
      ),
    avgObservedDurationMs: avgIntervalDurationMs(intervals),
    batchSizes,
    coveredKeyCount: config.expectedKeys.length - missingKeys.length,
    expectedKeyCount: config.expectedKeys.length,
    maxObservedDurationMs: maxIntervalDurationMs(intervals),
    maxBatchSize: Math.max(0, ...batchSizes),
    maxObservedConcurrency: maxObservedConcurrency(intervals),
    minObservedDurationMs: minIntervalDurationMs(intervals),
    missingKeys,
    resultCount: intervals.length,
    toolCallCount: batchSizes.reduce((total, size) => total + size, 0),
    wallClockMs: wallClockMs(events),
  };
}

function requestedBatchSizes(
  events: readonly HandleMessageStreamEvent[],
  toolName: string,
): number[] {
  return events.flatMap((event) => {
    if (event.type !== "actions.requested") return [];
    const count = event.data.actions.filter(
      (action) => action.kind === "tool-call" && action.toolName === toolName,
    ).length;
    return count > 0 ? [count] : [];
  });
}

function requestedKeys(
  events: readonly HandleMessageStreamEvent[],
  config: MeasurementConfig,
): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== "actions.requested") continue;
    for (const action of event.data.actions) {
      if (action.kind !== "tool-call" || action.toolName !== config.toolName) continue;
      const key = readStringField(action.input, config.keyField);
      if (key !== undefined) keys.add(key.toLowerCase());
    }
  }
  return keys;
}

function resultIntervals(
  events: readonly HandleMessageStreamEvent[],
  config: MeasurementConfig,
): Interval[] {
  const intervals: Interval[] = [];
  for (const event of events) {
    if (!isMatchingToolResultEvent(event, config.toolName)) continue;
    const output = event.data.result.output;
    const key = readStringField(output, config.keyField);
    const startedAt = readFiniteNumberField(output, "executionStartedAt");
    const completedAt = readFiniteNumberField(output, "executionCompletedAt");
    if (key === undefined || startedAt === undefined || completedAt === undefined) continue;
    intervals.push({ completedAt, key, startedAt });
  }
  return intervals;
}

function isMatchingToolResultEvent(
  event: HandleMessageStreamEvent,
  toolName: string,
): event is MatchingToolResultEvent {
  return (
    event.type === "action.result" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === toolName
  );
}

function requestEventIndexForKey(input: {
  readonly beforeIndex: number;
  readonly config: MeasurementConfig;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly key: string;
}): boolean {
  const expected = input.key.toLowerCase();
  for (let index = 0; index < input.beforeIndex; index += 1) {
    const event = input.events[index];
    if (event === undefined || event.type !== "actions.requested") continue;
    for (const action of event.data.actions) {
      if (action.kind !== "tool-call" || action.toolName !== input.config.toolName) continue;
      if (readStringField(action.input, input.config.keyField)?.toLowerCase() === expected) {
        return true;
      }
    }
  }
  return false;
}

function writtenFileContent(
  events: readonly HandleMessageStreamEvent[],
  filePath: string,
): string | undefined {
  for (const event of events) {
    if (event.type !== "actions.requested") continue;
    for (const action of event.data.actions) {
      if (action.kind !== "tool-call" || action.toolName !== "write_file") continue;
      if (readStringField(action.input, "filePath") !== filePath) continue;
      const content = readStringField(action.input, "content");
      if (content !== undefined) return content;
    }
  }
  return undefined;
}

function parseDsv(content: string): Array<Record<string, string>> {
  const lines = content.trim().split(/\r?\n/u);
  const header = lines[0]?.split("\t") ?? [];
  if (header.length === 0) return [];

  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    const row: Record<string, string> = {};
    for (const [index, column] of header.entries()) {
      row[column] = values[index] ?? "";
    }
    return row;
  });
}

function allIntervalsOverlap(intervals: readonly Interval[], expectedCount: number): boolean {
  return (
    intervals.length === expectedCount &&
    Math.max(...intervals.map((interval) => interval.startedAt)) <
      Math.min(...intervals.map((interval) => interval.completedAt))
  );
}

function avgIntervalDurationMs(intervals: readonly Interval[]): number | undefined {
  if (intervals.length === 0) return undefined;
  const total = intervals.reduce(
    (sum, interval) => sum + interval.completedAt - interval.startedAt,
    0,
  );
  return total / intervals.length;
}

function maxIntervalDurationMs(intervals: readonly Interval[]): number | undefined {
  if (intervals.length === 0) return undefined;
  return Math.max(...intervals.map((interval) => interval.completedAt - interval.startedAt));
}

function minIntervalDurationMs(intervals: readonly Interval[]): number | undefined {
  if (intervals.length === 0) return undefined;
  return Math.min(...intervals.map((interval) => interval.completedAt - interval.startedAt));
}

function maxObservedConcurrency(intervals: readonly Interval[]): number {
  const points = intervals.flatMap((interval) => [
    { at: interval.startedAt, delta: 1 },
    { at: interval.completedAt, delta: -1 },
  ]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let max = 0;
  for (const point of points) {
    active += point.delta;
    max = Math.max(max, active);
  }
  return max;
}

function wallClockMs(events: readonly HandleMessageStreamEvent[]): number | undefined {
  const first = events.find((event) => event.type === "turn.started");
  const last = findLastTurnCompleted(events);
  const startedAt = parseEventTimestamp(first);
  const completedAt = parseEventTimestamp(last);
  if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) {
    return undefined;
  }
  return completedAt - startedAt;
}

function findLastTurnCompleted(
  events: readonly HandleMessageStreamEvent[],
): HandleMessageStreamEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn.completed") return event;
  }
  return undefined;
}

function parseEventTimestamp(event: HandleMessageStreamEvent | undefined): number | undefined {
  const timestamp = Date.parse(event?.meta?.at ?? "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readFiniteNumberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}
