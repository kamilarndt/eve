import { describe, expect, it } from "vitest";

import { consumeAuthorizationCallbacks } from "#execution/authorization-resume.js";
import {
  createPendingAuthorizationState,
  getPendingAuthorization,
  setPendingAuthorization,
} from "#harness/authorization.js";
import type { HarnessSession } from "#harness/types.js";

function sessionWithPending(names: readonly string[]): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "session-1",
    state: setPendingAuthorization(
      { retained: true },
      createPendingAuthorizationState(
        names.map((name) => ({
          challenge: { url: `https://${name}.example.com` },
          hookUrl: `https://eve.example.com/${name}`,
          name,
        })),
        1_000,
      ),
    ),
  };
}

describe("consumeAuthorizationCallbacks", () => {
  it("consumes the matching challenge, preserves the rest, and hides callbacks from adapters", () => {
    const result = consumeAuthorizationCallbacks({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { method: "GET", params: { code: "oauth-code" } },
              connectionName: "linear",
            },
          },
          { message: "queued user message" },
        ],
      },
      session: sessionWithPending(["linear", "notion"]),
    });

    expect(result.authorizations).toEqual([
      { authorization: { url: "https://linear.example.com" }, name: "linear" },
    ]);
    expect(result.delivery).toEqual({
      kind: "deliver",
      payloads: [{ message: "queued user message" }],
    });
    expect(
      getPendingAuthorization(result.session.state)?.challenges.map((entry) => entry.name),
    ).toEqual(["notion"]);
    expect(result.results).toEqual([
      {
        callback: { method: "GET", params: { code: "oauth-code" } },
        hookUrl: "https://eve.example.com/linear",
        name: "linear",
      },
    ]);
  });

  it("deletes the pending batch when its final callback arrives", () => {
    const result = consumeAuthorizationCallbacks({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { method: "GET", params: {} },
              connectionName: "linear",
            },
          },
        ],
      },
      session: sessionWithPending(["linear"]),
    });

    expect(result.delivery).toBeUndefined();
    expect(getPendingAuthorization(result.session.state)).toBeUndefined();
    expect(result.session.state).toEqual({ retained: true });
  });

  it("uses only the first callback when a delivery repeats the same connection", () => {
    const result = consumeAuthorizationCallbacks({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { method: "GET", params: { code: "first" } },
              connectionName: "linear",
            },
          },
          {
            authorizationCallback: {
              callback: { method: "GET", params: { code: "duplicate" } },
              connectionName: "linear",
            },
          },
        ],
      },
      session: sessionWithPending(["linear"]),
    });

    expect(result.results).toEqual([
      {
        callback: { method: "GET", params: { code: "first" } },
        hookUrl: "https://eve.example.com/linear",
        name: "linear",
      },
    ]);
    expect(result.delivery).toBeUndefined();
  });
});
