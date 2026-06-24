import { defineEval } from "eve/evals";

export default defineEval({
  description: "Cancelling an active turn preserves its session for the next message.",
  async test(t) {
    const active = await t.start(
      "Prepare a production migration plan for moving a high-traffic payments service from a monolith to an event-driven architecture. Include the target design, data migration, rollout phases, observability, failure modes, rollback, security, staffing, and timeline.",
    );
    const cancelledResult = active.result();

    await t.sleep(2_000);
    await active.cancel();

    const cancelled = await cancelledResult;
    if (cancelled.status !== "cancelled") {
      throw new Error(`Expected a cancelled turn, received ${cancelled.status}.`);
    }
    if (!cancelled.events.some((event) => event.type === "turn.cancelled")) {
      throw new Error("The cancelled turn did not emit turn.cancelled.");
    }
    if (!cancelled.events.some((event) => event.type === "session.waiting")) {
      throw new Error("Turn cancellation did not leave the session waiting.");
    }

    const followUp = await t.send("Reply with exactly: session continued");
    followUp.expectOk();
    if (t.sessionId !== active.sessionId) {
      throw new Error("The follow-up did not reuse the turn-cancelled session.");
    }

    t.didNotFail();
  },
});
