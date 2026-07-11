import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { HarnessSession } from "#harness/types.js";

/** Full mutable session available only while a harness model/tool call is active. */
export const ActiveHarnessSessionKey = new ContextKey<HarnessSession>(
  "eve.internalActiveHarnessSession",
);

/** Publishes the current harness session as virtual, non-durable context. */
export function setActiveHarnessSession(ctx: AlsContext, session: HarnessSession): void {
  ctx.setVirtualContext(ActiveHarnessSessionKey, session);
}
