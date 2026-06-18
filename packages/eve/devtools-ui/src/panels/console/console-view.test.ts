import { describe, expect, it } from "vitest";

import type { ConsoleRecord } from "@ui/model/devtools-model";
import { filterConsoleRecords, resolveConsoleSessionTitle } from "@ui/panels/console/console-view";

const records: readonly ConsoleRecord[] = [
  {
    coordinates: { action: "call-1", revision: "rev-1", session: "session-1" },
    id: "log-1",
    level: "info",
    message: "Fetching Berlin",
    stream: "console",
    timestamp: "10:00:00",
  },
  {
    coordinates: { action: "call-2", revision: "rev-1", session: "session-2" },
    id: "log-2",
    level: "error",
    message: "Paris failed",
    stream: "stderr",
    timestamp: "10:00:01",
  },
];

describe("filterConsoleRecords", () => {
  it("filters by selected session, level, and searchable context", () => {
    expect(
      filterConsoleRecords({
        level: "info",
        query: "session-1",
        records,
        scope: "session",
        sessionId: "session-1",
      }).map((record) => record.id),
    ).toEqual(["log-1"]);
  });

  it("keeps locally cleared records out of the view", () => {
    expect(
      filterConsoleRecords({
        clearedIds: new Set(["log-1"]),
        level: "all",
        query: "",
        records,
        scope: "runtime",
      }).map((record) => record.id),
    ).toEqual(["log-2"]);
  });
});

describe("resolveConsoleSessionTitle", () => {
  it("uses the session title without exposing an unresolved id", () => {
    const runs = [{ id: "wrun_123", label: "Berlin weather" }];

    expect(resolveConsoleSessionTitle(runs, "wrun_123")).toBe("Berlin weather");
    expect(resolveConsoleSessionTitle(runs, "wrun_missing")).toBe("Session");
  });
});
