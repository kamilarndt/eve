import { describe, expect, it } from "vitest";

import {
  ActiveHarnessSessionKey,
  setActiveHarnessSession,
} from "#context/active-harness-session-key.js";
import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import type { HarnessSession } from "#harness/types.js";

describe("ActiveHarnessSessionKey", () => {
  it("makes the current harness session available without serializing it", () => {
    const ctx = new ContextContainer();
    const session = {
      agent: { system: "test" },
      continuationToken: "session-1",
      history: [{ role: "user", content: "hello" }],
      sessionId: "session-1",
    } as HarnessSession;

    setActiveHarnessSession(ctx, session);

    expect(ctx.require(ActiveHarnessSessionKey)).toBe(session);
    expect(serializeContext(ctx)).not.toHaveProperty(ActiveHarnessSessionKey.name);
  });
});
