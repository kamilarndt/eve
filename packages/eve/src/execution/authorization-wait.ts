import { sleep } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";

/** Waits for an authorization callback or projects the shared timeout callback shape. */
export async function waitForAuthorizationDelivery(input: {
  readonly consumeNext: () => void;
  readonly deadline?: number;
  readonly getNext: () => Promise<IteratorResult<HookPayload>>;
  readonly names: readonly string[];
}): Promise<DeliverHookPayload | null> {
  while (true) {
    const pendingDelivery = input.getNext().then((next) => ({ kind: "delivery", next }) as const);
    const resolution =
      input.deadline === undefined
        ? await pendingDelivery
        : await Promise.race([
            pendingDelivery,
            sleep(new Date(input.deadline)).then(() => ({ kind: "timeout" }) as const),
          ]);

    if (resolution.kind === "timeout") {
      return {
        kind: "deliver",
        payloads: input.names.map((connectionName) => ({
          authorizationCallback: {
            callback: {
              method: "TIMEOUT",
              params: {
                error: "authorization_timeout",
                error_description: "Authorization timed out.",
              },
            },
            connectionName,
          },
        })),
      };
    }
    input.consumeNext();
    if (resolution.next.done) return null;
    if (resolution.next.value.kind === "deliver" && resolution.next.value.payloads.length > 0) {
      return resolution.next.value;
    }
  }
}
