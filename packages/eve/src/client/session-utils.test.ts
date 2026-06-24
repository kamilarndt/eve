import { describe, expect, it } from "vitest";

import { advanceSession, deriveResultStatus } from "#client/session-utils.js";
import {
  createSessionCancelledEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
} from "#protocol/message.js";

describe("client cancellation boundaries", () => {
  it("reports turn cancellation while preserving the waiting session cursor", () => {
    const events = [
      createTurnCancelledEvent({ sequence: 1, turnId: "turn-1" }),
      createSessionWaitingEvent(),
    ];

    expect(deriveResultStatus(events)).toBe("cancelled");
    expect(
      advanceSession({
        continuationToken: "eve:session-1",
        events,
        session: { sessionId: "session-1", streamIndex: 4 },
        sessionId: "session-1",
      }),
    ).toEqual({
      continuationToken: "eve:session-1",
      sessionId: "session-1",
      streamIndex: 6,
    });
  });

  it("reports session cancellation and clears the resumable cursor", () => {
    const events = [createSessionCancelledEvent("session-1")];

    expect(deriveResultStatus(events)).toBe("cancelled");
    expect(
      advanceSession({
        continuationToken: "eve:session-1",
        events,
        session: { sessionId: "session-1", streamIndex: 4 },
        sessionId: "session-1",
      }),
    ).toEqual({ streamIndex: 0 });
  });
});
