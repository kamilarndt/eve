import { describe, expect, it } from "vitest";

import {
  MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS,
  getNextExperimentalWorkflowDueAt,
  parseExperimentalWorkflowCadence,
} from "#execution/experimental-workflow-cadence.js";

describe("parseExperimentalWorkflowCadence", () => {
  it.each([
    [{ kind: "after-completion", delaySeconds: Number.NaN }, "delaySeconds"],
    [{ kind: "after-completion", delaySeconds: -1 }, "delaySeconds"],
    [{ kind: "after-completion", delaySeconds: 0 }, "delaySeconds"],
    [{ kind: "after-completion", delaySeconds: 1.5 }, "delaySeconds"],
    [
      {
        kind: "after-completion",
        delaySeconds: MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS + 1,
      },
      "delaySeconds",
    ],
    [
      {
        kind: "fixed-rate",
        anchorAt: "not-an-instant",
        intervalSeconds: 8 * 60 * 60,
        missed: "skip",
      },
      "anchorAt",
    ],
    [
      {
        kind: "fixed-rate",
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalSeconds: 0,
        missed: "skip",
      },
      "intervalSeconds",
    ],
    [
      {
        kind: "fixed-rate",
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalSeconds: 1.5,
        missed: "skip",
      },
      "intervalSeconds",
    ],
    [
      {
        kind: "fixed-rate",
        anchorAt: "2026-01-01T00:00:00.000Z",
        intervalSeconds: MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS + 1,
        missed: "skip",
      },
      "intervalSeconds",
    ],
    [
      {
        kind: "daily-times",
        timeZone: "Mars/Olympus_Mons",
        times: ["16:00"],
        missed: "skip",
      },
      "timeZone",
    ],
    [
      {
        kind: "daily-times",
        timeZone: "America/New_York",
        times: [],
        missed: "skip",
      },
      "times",
    ],
    [
      {
        kind: "daily-times",
        timeZone: "America/New_York",
        times: ["24:00"],
        missed: "skip",
      },
      "times[0]",
    ],
  ])("rejects an invalid cadence field", (cadence, field) => {
    expect(() => parseExperimentalWorkflowCadence(cadence)).toThrow(field);
  });

  it("allows duplicate daily times without changing the authored cadence", () => {
    const cadence = {
      kind: "daily-times",
      timeZone: "America/New_York",
      times: ["20:00", "16:00", "16:00"],
      missed: "skip",
    };

    expect(parseExperimentalWorkflowCadence(cadence)).toEqual(cadence);
  });

  it.each([
    { kind: "after-completion", delaySeconds: 10, jitter: true },
    {
      kind: "fixed-rate",
      anchorAt: "2026-01-01T00:00:00.000Z",
      intervalSeconds: 8 * 60 * 60,
      missed: "skip",
      catchUp: false,
    },
    {
      kind: "daily-times",
      timeZone: "America/New_York",
      times: ["16:00"],
      missed: "skip",
      locale: "en-US",
    },
  ])("rejects unknown cadence fields instead of accepting schema drift", (cadence) => {
    expect(() => parseExperimentalWorkflowCadence(cadence)).toThrow("unknown key");
  });
});

describe("getNextExperimentalWorkflowDueAt", () => {
  it("waits ten seconds after the preceding iteration completes", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: { kind: "after-completion", delaySeconds: 10 },
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("2026-01-01T00:00:10.000Z");
  });

  it("computes a representable due time at the maximum accepted duration", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: {
          kind: "after-completion",
          delaySeconds: MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS,
        },
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("2126-01-02T00:00:00.000Z");
  });

  it("skips elapsed slots on an anchored eight-hour fixed rate", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: {
          kind: "fixed-rate",
          anchorAt: "2026-01-01T00:00:00.000Z",
          intervalSeconds: 8 * 60 * 60,
          missed: "skip",
        },
        completedAt: "2026-01-02T01:00:00.000Z",
      }),
    ).toBe("2026-01-02T08:00:00.000Z");
  });

  it("keeps 16:00 and 20:00 on the New York wall clock across the spring gap", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: {
          kind: "daily-times",
          timeZone: "America/New_York",
          times: ["20:00", "16:00"],
          missed: "skip",
        },
        // 20:30 EST on March 7, before clocks advance overnight.
        completedAt: "2026-03-08T01:30:00.000Z",
      }),
    ).toBe("2026-03-08T20:00:00.000Z");
  });

  it("keeps 16:00 and 20:00 on the New York wall clock across the fall fold", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: {
          kind: "daily-times",
          timeZone: "America/New_York",
          times: ["20:00", "16:00"],
          missed: "skip",
        },
        // 20:30 EDT on October 31, before clocks repeat an hour overnight.
        completedAt: "2026-11-01T00:30:00.000Z",
      }),
    ).toBe("2026-11-01T21:00:00.000Z");
  });

  it("skips a nonexistent New York wall time during the spring gap", () => {
    expect(
      getNextExperimentalWorkflowDueAt({
        cadence: {
          kind: "daily-times",
          timeZone: "America/New_York",
          times: ["02:30"],
          missed: "skip",
        },
        // 01:00 EST, before the clock jumps from 01:59 to 03:00.
        completedAt: "2026-03-08T06:00:00.000Z",
      }),
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  it("uses the first repeated New York wall time once during the fall fold", () => {
    const cadence = {
      kind: "daily-times",
      timeZone: "America/New_York",
      times: ["01:30"],
      missed: "skip",
    };

    expect(
      getNextExperimentalWorkflowDueAt({
        cadence,
        // 01:00 EDT, before 01:30 occurs for the first time.
        completedAt: "2026-11-01T05:00:00.000Z",
      }),
    ).toBe("2026-11-01T05:30:00.000Z");

    expect(
      getNextExperimentalWorkflowDueAt({
        cadence,
        // The first 01:30 occurrence; the repeated EST occurrence is skipped.
        completedAt: "2026-11-01T05:30:00.000Z",
      }),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  it("rejects a completion time that is not an ISO instant", () => {
    expect(() =>
      getNextExperimentalWorkflowDueAt({
        cadence: { kind: "after-completion", delaySeconds: 10 },
        completedAt: "January 1, 2026",
      }),
    ).toThrow("completedAt");
  });
});
