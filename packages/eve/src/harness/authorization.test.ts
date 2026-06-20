import { describe, expect, it } from "vitest";

import {
  consumePendingAuthorization,
  createPendingAuthorizationState,
  getPendingAuthorization,
  setPendingAuthorization,
} from "#harness/authorization.js";

const challenge = (name: string, expiresAt?: string) => ({
  challenge: expiresAt === undefined ? {} : { expiresAt },
  hookUrl: `https://eve.example.com/callback/${name}`,
  name,
});

describe("pending authorization state", () => {
  it("uses the earliest provider expiry as the durable deadline", () => {
    const pending = createPendingAuthorizationState(
      [
        challenge("linear", "2026-06-21T19:05:00.000Z"),
        challenge("notion", "2026-06-21T19:03:00.000Z"),
      ],
      Date.parse("2026-06-21T19:00:00.000Z"),
    );

    expect(pending.deadline).toBe(Date.parse("2026-06-21T19:03:00.000Z"));
  });

  it("ignores invalid provider expiry values", () => {
    const now = Date.parse("2026-06-21T19:00:00.000Z");
    const pending = createPendingAuthorizationState([challenge("linear", "not-a-date")], now);

    expect(pending.deadline).toBe(now + 10 * 60 * 1_000);
  });

  it("removes only callback-matched challenges and deletes an empty batch", () => {
    const original = setPendingAuthorization(
      { retained: true },
      createPendingAuthorizationState([challenge("linear"), challenge("notion")], 1_000),
    );

    const partial = consumePendingAuthorization(original, ["linear"]);
    expect(partial.consumed.map((entry) => entry.name)).toEqual(["linear"]);
    expect(
      getPendingAuthorization(partial.sessionState)?.challenges.map((entry) => entry.name),
    ).toEqual(["notion"]);

    const complete = consumePendingAuthorization(partial.sessionState, ["notion"]);
    expect(complete.sessionState).toEqual({ retained: true });
    expect(getPendingAuthorization(complete.sessionState)).toBeUndefined();
  });
});
