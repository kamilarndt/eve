import { createHash } from "node:crypto";

import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import {
  type HandleMessageStreamEvent,
  type TimedHandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";

/**
 * Creates an event stamper scoped to one workflow step invocation.
 *
 * The workflow step ID is stable across retries. Event content keeps IDs
 * stable when independent emissions change order, while the per-content
 * occurrence distinguishes intentionally repeated identical events.
 */
export function createStepEventStamper(
  stepId = getStepMetadata().stepId,
): (event: HandleMessageStreamEvent) => TimedHandleMessageStreamEvent {
  const occurrences = new Map<string, number>();

  return (event) => {
    const { meta: _meta, ...logicalEvent } = event;
    const content = JSON.stringify(logicalEvent, sortJsonObjectKeys);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);

    const id = createHash("sha256")
      .update(stepId)
      .update("\0")
      .update(content)
      .update("\0")
      .update(String(occurrence))
      .digest("base64url");

    return timestampHandleMessageStreamEvent(event, `evt_${id}`);
  };
}

function sortJsonObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}
