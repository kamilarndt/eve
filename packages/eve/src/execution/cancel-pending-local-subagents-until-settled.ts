import { sleep } from "#compiled/@workflow/core/index.js";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelPendingLocalSubagentsStep } from "#execution/cancel-pending-local-subagents-step.js";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Keeps workflow ownership until every recorded local descendant is terminal. */
export async function cancelPendingLocalSubagentsUntilSettled(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly cancelled: number }> {
  let delayMs = INITIAL_RETRY_DELAY_MS;
  while (true) {
    try {
      const result = await cancelPendingLocalSubagentsStep(input);
      if (result.settled) return { cancelled: result.cancelled };
    } catch {}
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
  }
}
