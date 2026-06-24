import { defineEval } from "eve/evals";

export default defineEval({
  description: "Cancelling an active session makes the next message start a new session.",
  async test(t) {
    const active = await t.start(
      "Draft a complete post-incident review for a multi-region payments outage. Include the timeline, customer impact, contributing factors, detection gaps, remediation, follow-up owners, and prevention work.",
    );
    const cancelledResult = active.result();

    await t.sleep(2_000);
    await t.cancel();

    const cancelled = await cancelledResult;
    if (cancelled.status !== "cancelled") {
      throw new Error(`Expected a cancelled turn, received ${cancelled.status}.`);
    }
    if (!cancelled.events.some((event) => event.type === "turn.cancelled")) {
      throw new Error("The cancelled session did not emit turn.cancelled.");
    }
    if (!cancelled.events.some((event) => event.type === "session.cancelled")) {
      throw new Error("The cancelled session did not emit session.cancelled.");
    }

    const restarted = await t.send("Reply with exactly: new session started");
    restarted.expectOk();
    if (t.sessionId === active.sessionId) {
      throw new Error("The next message reused the cancelled session.");
    }

    t.didNotFail();
  },
});
