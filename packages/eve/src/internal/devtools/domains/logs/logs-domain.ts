import type { DevToolsEventHub } from "#internal/devtools/event-hub.js";
import type { DevToolsLogInput, DevToolsLogStream } from "#internal/devtools/host/types.js";

const DEFAULT_LOG_LIMIT = 2_000;
const DEFAULT_LOG_DEDUPE_WINDOW_MS = 50;
const MAX_LOG_FIELDS_BYTES = 64 * 1024;
const MAX_LOG_MESSAGE_BYTES = 16 * 1024;

export interface DevToolsLogEntry {
  readonly cursor: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly source?: DevToolsLogInput["source"];
  readonly stream: DevToolsLogStream;
  readonly timestamp: string;
}

export interface DevToolsLogsDomain {
  append(input: DevToolsLogInput): void;
  appendConsole(input: DevToolsLogInput, correlationKey: string): void;
  close(): void;
  correlateConsole(correlationKey: string, fields: Readonly<Record<string, unknown>>): void;
  list(afterCursor: number): {
    readonly entries: readonly DevToolsLogEntry[];
    readonly nextCursor: string;
  };
}

export function createDevToolsLogsDomain(input: {
  readonly dedupeWindowMs?: number;
  readonly eventHub: DevToolsEventHub;
  readonly limit?: number;
}): DevToolsLogsDomain {
  const entries: DevToolsLogEntry[] = [];
  const limit = input.limit ?? DEFAULT_LOG_LIMIT;
  const dedupeWindowMs = input.dedupeWindowMs ?? DEFAULT_LOG_DEDUPE_WINDOW_MS;
  const pendingRaw: PendingRawLog[] = [];
  const pendingConsole: PendingConsoleLog[] = [];
  const pendingConsoleContexts: PendingConsoleContext[] = [];
  const recentConsole: RecentConsoleLog[] = [];

  const appendEntry = (logInput: DevToolsLogInput, timestamp: string) => {
    input.eventHub.publish("log.entry", (cursor) => {
      const entry: DevToolsLogEntry = {
        cursor,
        fields: sanitizeFields(logInput.fields),
        level: logInput.level ?? levelForStream(logInput.stream),
        message: truncateLogMessage(logInput.message),
        source: logInput.source,
        stream: logInput.stream,
        timestamp,
      };
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      return { entry };
    });
  };

  const flushPending = (pending: PendingRawLog) => {
    const index = pendingRaw.indexOf(pending);
    if (index === -1) return;
    pendingRaw.splice(index, 1);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    appendEntry(pending.input, pending.timestamp);
  };

  const appendConsoleEntry = (logInput: DevToolsLogInput, timestamp: string) => {
    const pendingIndex = pendingRaw.findLastIndex(
      (pending) => pending.input.message === logInput.message,
    );
    if (pendingIndex !== -1) {
      const pending = pendingRaw[pendingIndex]!;
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      pendingRaw.splice(pendingIndex, 1);
    } else if (dedupeWindowMs > 0) {
      recentConsole.push({
        expiresAt: Date.now() + dedupeWindowMs,
        message: logInput.message,
      });
    }
    appendEntry(logInput, timestamp);
  };

  const flushPendingConsole = (
    pending: PendingConsoleLog,
    fields?: Readonly<Record<string, unknown>>,
  ) => {
    const index = pendingConsole.indexOf(pending);
    if (index === -1) return;
    pendingConsole.splice(index, 1);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    appendConsoleEntry(
      fields === undefined
        ? pending.input
        : { ...pending.input, fields: { ...fields, ...pending.input.fields } },
      pending.timestamp,
    );
  };

  const discardPendingConsoleContext = (pending: PendingConsoleContext) => {
    const index = pendingConsoleContexts.indexOf(pending);
    if (index === -1) return;
    pendingConsoleContexts.splice(index, 1);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
  };

  return {
    append(logInput) {
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      pruneRecentConsole(recentConsole, now);
      if (logInput.stream === "console") {
        appendConsoleEntry(logInput, timestamp);
        return;
      }
      if (logInput.stream !== "stdout" && logInput.stream !== "stderr") {
        appendEntry(logInput, timestamp);
        return;
      }
      const consoleIndex = recentConsole.findIndex(
        (candidate) => candidate.message === logInput.message,
      );
      if (consoleIndex !== -1) {
        recentConsole.splice(consoleIndex, 1);
        return;
      }
      if (dedupeWindowMs <= 0) {
        appendEntry(logInput, timestamp);
        return;
      }
      const pending: PendingRawLog = {
        input: logInput,
        timestamp,
      };
      pending.timeout = setTimeout(() => flushPending(pending), dedupeWindowMs);
      pending.timeout.unref?.();
      pendingRaw.push(pending);
      if (pendingRaw.length > limit) flushPending(pendingRaw[0]!);
    },
    appendConsole(logInput, correlationKey) {
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      pruneRecentConsole(recentConsole, now);
      const contextIndex = pendingConsoleContexts.findIndex(
        (pending) => pending.correlationKey === correlationKey,
      );
      if (contextIndex !== -1) {
        const context = pendingConsoleContexts[contextIndex]!;
        discardPendingConsoleContext(context);
        appendConsoleEntry(
          { ...logInput, fields: { ...context.fields, ...logInput.fields } },
          timestamp,
        );
        return;
      }
      if (dedupeWindowMs <= 0) {
        appendConsoleEntry(logInput, timestamp);
        return;
      }
      const pending: PendingConsoleLog = { correlationKey, input: logInput, timestamp };
      pending.timeout = setTimeout(() => flushPendingConsole(pending), dedupeWindowMs);
      pending.timeout.unref?.();
      pendingConsole.push(pending);
      if (pendingConsole.length > limit) flushPendingConsole(pendingConsole[0]!);
    },
    close() {
      while (pendingConsole.length > 0) flushPendingConsole(pendingConsole[0]!);
      while (pendingConsoleContexts.length > 0) {
        discardPendingConsoleContext(pendingConsoleContexts[0]!);
      }
      while (pendingRaw.length > 0) flushPending(pendingRaw[0]!);
      recentConsole.length = 0;
    },
    correlateConsole(correlationKey, fields) {
      const consoleIndex = pendingConsole.findIndex(
        (pending) => pending.correlationKey === correlationKey,
      );
      if (consoleIndex !== -1) {
        flushPendingConsole(pendingConsole[consoleIndex]!, fields);
        return;
      }
      if (dedupeWindowMs <= 0) return;
      const pending: PendingConsoleContext = { correlationKey, fields };
      pending.timeout = setTimeout(() => discardPendingConsoleContext(pending), dedupeWindowMs);
      pending.timeout.unref?.();
      pendingConsoleContexts.push(pending);
      if (pendingConsoleContexts.length > limit) {
        discardPendingConsoleContext(pendingConsoleContexts[0]!);
      }
    },
    list(afterCursor) {
      return {
        entries: entries.filter((entry) => Number(entry.cursor) > afterCursor),
        nextCursor: entries.at(-1)?.cursor ?? String(afterCursor),
      };
    },
  };
}

interface PendingRawLog {
  readonly input: DevToolsLogInput;
  timeout?: ReturnType<typeof setTimeout>;
  readonly timestamp: string;
}

interface PendingConsoleLog {
  readonly correlationKey: string;
  readonly input: DevToolsLogInput;
  timeout?: ReturnType<typeof setTimeout>;
  readonly timestamp: string;
}

interface PendingConsoleContext {
  readonly correlationKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
  timeout?: ReturnType<typeof setTimeout>;
}

interface RecentConsoleLog {
  readonly expiresAt: number;
  readonly message: string;
}

function pruneRecentConsole(records: RecentConsoleLog[], now: number): void {
  let index = 0;
  while (index < records.length) {
    if (records[index]!.expiresAt <= now) records.splice(index, 1);
    else index += 1;
  }
}

function levelForStream(stream: DevToolsLogStream): DevToolsLogEntry["level"] {
  return stream === "stderr" ? "error" : stream === "system" ? "info" : "info";
}

function sanitizeFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (fields === undefined) return undefined;
  const sanitized = sanitizeValue(fields, new WeakSet(), 0) as Readonly<Record<string, unknown>>;
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= MAX_LOG_FIELDS_BYTES) {
      return sanitized;
    }
  } catch {
    // sanitizeValue is defensive, but logging must remain best-effort for arbitrary callers.
  }
  return { truncated: true };
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return truncateLogMessage(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map((entry) => sanitizeValue(entry, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result = Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        /authorization|cookie|password|secret|token|api[-_]?key/iu.test(key)
          ? "[redacted]"
          : sanitizeValue(entry, seen, depth + 1),
      ]),
  );
  seen.delete(value);
  return result;
}

function truncateLogMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_LOG_MESSAGE_BYTES) return message;
  let end = MAX_LOG_MESSAGE_BYTES;
  const buffer = Buffer.from(message);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}…`;
}
