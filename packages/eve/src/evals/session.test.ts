import { describe, expect, it, vi } from "vitest";

import { MessageResponse } from "#client/message-response.js";
import { ClientSession } from "#client/session.js";
import type { SessionState } from "#client/types.js";
import { EvalSessionDriver } from "#evals/session.js";
import { createSessionWaitingEvent, createTurnCancelledEvent } from "#protocol/message.js";

function createClientSession(state: SessionState): ClientSession {
  return new ClientSession(
    {
      host: "https://example.com",
      maxReconnectAttempts: 0,
      preserveCompletedSessions: false,
      resolveHeaders: async () => new Headers(),
    },
    state,
  );
}

describe("EvalSessionDriver cancellation", () => {
  it("retains a cancellable active turn and records its cancellation boundary", async () => {
    const cancelTurn = vi.fn().mockResolvedValue(undefined);
    const events = [
      createTurnCancelledEvent({ sequence: 0, turnId: "turn-0" }),
      createSessionWaitingEvent(),
    ];
    const session = createClientSession({
      continuationToken: "eve:session-1",
      sessionId: "session-1",
      streamIndex: 0,
    });
    vi.spyOn(session, "send").mockResolvedValue(
      new MessageResponse({
        cancel: cancelTurn,
        continuationToken: "eve:session-1",
        createStream: async function* () {
          yield* events;
        },
        sessionId: "session-1",
      }),
    );
    const driver = new EvalSessionDriver({ session });

    const active = await driver.start("slow work");
    await active.cancel();
    const turn = await active.result();

    expect(cancelTurn).toHaveBeenCalledTimes(1);
    expect(turn.status).toBe("cancelled");
    expect(turn.expectOk()).toBe(turn);
    expect(driver.events).toEqual(events);
  });

  it("delegates whole-session cancellation to the TypeScript client", async () => {
    const cancelSession = vi.fn().mockResolvedValue(undefined);
    const session = createClientSession({
      continuationToken: "eve:session-1",
      sessionId: "session-1",
      streamIndex: 0,
    });
    vi.spyOn(session, "cancel").mockImplementation(cancelSession);

    await new EvalSessionDriver({ session }).cancel();

    expect(cancelSession).toHaveBeenCalledTimes(1);
  });
});
