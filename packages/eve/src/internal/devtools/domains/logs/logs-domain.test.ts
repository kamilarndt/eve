import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevToolsEventHub } from "#internal/devtools/event-hub.js";
import { createDevToolsLogsDomain } from "./logs-domain.js";

describe("createDevToolsLogsDomain", () => {
  afterEach(() => vi.useRealTimers());

  it("normalizes, redacts, bounds, and cursors log entries", () => {
    const eventHub = createDevToolsEventHub({ replayLimit: 10 });
    const logs = createDevToolsLogsDomain({ dedupeWindowMs: 0, eventHub, limit: 2 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logs.append({
      fields: {
        circular,
        nested: { authorization: "Bearer secret", safe: true },
      },
      message: "first",
      stream: "stdout",
    });
    logs.append({ message: "warning", stream: "stderr" });
    logs.append({ level: "debug", message: "last", stream: "system" });

    expect(logs.list(0)).toMatchObject({
      entries: [
        { cursor: "2", level: "error", message: "warning" },
        { cursor: "3", level: "debug", message: "last" },
      ],
      nextCursor: "3",
    });
    expect(logs.list(2).entries).toMatchObject([{ cursor: "3" }]);

    const replay = eventHub.replayAfter("0");
    expect(replay.events[0]).toMatchObject({
      data: {
        entry: {
          fields: {
            circular: { self: "[circular]" },
            nested: { authorization: "[redacted]", safe: true },
          },
        },
      },
      event: "log.entry",
    });
  });

  it("truncates oversized messages on a valid UTF-8 boundary", () => {
    const eventHub = createDevToolsEventHub({ replayLimit: 1 });
    const logs = createDevToolsLogsDomain({ dedupeWindowMs: 0, eventHub });

    logs.append({ message: "🙂".repeat(5_000), stream: "stdout" });

    const [entry] = logs.list(0).entries;
    expect(entry?.message.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(entry?.message ?? "", "utf8")).toBeLessThanOrEqual(16_387);
    expect(entry?.message).not.toContain("�");
  });

  it("keeps one source-linked console record for mirrored stdout in either order", () => {
    vi.useFakeTimers();
    const logs = createDevToolsLogsDomain({
      dedupeWindowMs: 50,
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });
    const consoleRecord = {
      message: "[eve:dev] authored artifacts updated.",
      source: { line: 1, url: "file:///app/watcher.js" },
      stream: "console" as const,
    };

    logs.append(consoleRecord);
    logs.append({ message: consoleRecord.message, stream: "stdout" });
    logs.append({ message: "rebuild failed", stream: "stderr" });
    logs.append({ ...consoleRecord, level: "error", message: "rebuild failed" });
    vi.advanceTimersByTime(50);

    expect(logs.list(0).entries).toMatchObject([
      { message: consoleRecord.message, source: consoleRecord.source, stream: "console" },
      { level: "error", message: "rebuild failed", stream: "console" },
    ]);
  });

  it("preserves repeated same-stream and unmatched raw records", () => {
    vi.useFakeTimers();
    const logs = createDevToolsLogsDomain({
      dedupeWindowMs: 50,
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    logs.append({ message: "same", stream: "stdout" });
    logs.append({ message: "same", stream: "stdout" });
    expect(logs.list(0).entries).toHaveLength(0);
    vi.advanceTimersByTime(50);

    expect(logs.list(0).entries).toMatchObject([
      { message: "same", stream: "stdout" },
      { message: "same", stream: "stdout" },
    ]);
  });

  it("correlates inspector console records with session context in either arrival order", () => {
    vi.useFakeTimers();
    const logs = createDevToolsLogsDomain({
      dedupeWindowMs: 50,
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    logs.appendConsole({ message: "first", stream: "console" }, 'log:[["string","first"]]');
    logs.correlateConsole('log:[["string","first"]]', {
      coordinates: { session: "session-1", turn: "turn-1" },
    });
    logs.correlateConsole('warning:[["string","second"]]', {
      coordinates: { session: "session-2", turn: "turn-2" },
    });
    logs.appendConsole(
      { level: "warn", message: "second", stream: "console" },
      'warning:[["string","second"]]',
    );

    expect(logs.list(0).entries).toMatchObject([
      {
        fields: { coordinates: { session: "session-1", turn: "turn-1" } },
        message: "first",
      },
      {
        fields: { coordinates: { session: "session-2", turn: "turn-2" } },
        message: "second",
      },
    ]);
  });
});
