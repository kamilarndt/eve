interface LocalSubagentChild {
  readonly cancel: () => Promise<void>;
  readonly sessionId: string;
}

/** Waits for every sibling cancellation before reporting any failures. */
export async function cancelLocalSubagentChildren(
  children: readonly LocalSubagentChild[],
): Promise<void> {
  const settlements = await Promise.allSettled(children.map((child) => child.cancel()));
  const failures = settlements.flatMap((settlement, index) =>
    settlement.status === "rejected"
      ? [{ reason: settlement.reason, sessionId: children[index]!.sessionId }]
      : [],
  );
  if (failures.length === 0) return;

  throw new AggregateError(
    failures.map((failure) => failure.reason),
    `Failed to cancel local subagent sessions: ${failures
      .map((failure) => `"${failure.sessionId}"`)
      .join(", ")}.`,
  );
}
