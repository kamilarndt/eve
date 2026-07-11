import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { requestWorkflowRunCancellation } from "#execution/workflow-runtime.js";
import { getPendingLocalSubagentSessions } from "#harness/runtime-actions.js";

/** Cooperatively cancels local child runs recorded on a parked action batch. */
export async function cancelPendingLocalSubagentsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly cancelled: number; readonly settled: boolean }> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const children = getPendingLocalSubagentSessions(durable.state);
  const results = await Promise.allSettled(
    children.map((child) => requestWorkflowRunCancellation(child.sessionId)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to cancel local subagent sessions ${children.map((child) => `"${child.sessionId}"`).join(", ")}.`,
    );
  }

  return {
    cancelled: children.length,
    settled: results.every((result) => result.status === "fulfilled" && result.value),
  };
}
