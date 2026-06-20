import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { ConnectionAuthorizationFailedError } from "#public/connections/errors.js";
import {
  AuthorizationCompletionReporterKey,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import {
  completeScopedAuthorization,
  stampChallengeDisplayName,
} from "#runtime/connections/scoped-authorization.js";
import type {
  InteractiveAuthorizationDefinition,
  TokenResult,
} from "#runtime/connections/types.js";

function interactiveAuth(displayName?: string): InteractiveAuthorizationDefinition {
  const auth: InteractiveAuthorizationDefinition = {
    principalType: "user",
    async getToken(): Promise<TokenResult> {
      return { token: "tok" };
    },
    async startAuthorization() {
      return { challenge: { url: "https://idp.example/auth" } };
    },
    async completeAuthorization(): Promise<TokenResult> {
      return { token: "fresh" };
    },
  };
  if (displayName === undefined) return auth;
  return { ...auth, displayName };
}

describe("stampChallengeDisplayName", () => {
  it("prefers the definition-level displayName over the strategy's", () => {
    const challenge = { displayName: "Strategy Default", url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth("Salesforce"))).toEqual({
      displayName: "Salesforce",
      url: "https://idp.example/auth",
    });
  });

  it("keeps the strategy-stamped displayName when the definition has none", () => {
    const challenge = { displayName: "Salesforce", url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth())).toBe(challenge);
  });

  it("returns the same challenge object when nothing resolves", () => {
    const challenge = { url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth())).toBe(challenge);
  });
});

describe("completeScopedAuthorization", () => {
  it("records success only after completeAuthorization resolves", async () => {
    const ctx = new ContextContainer();
    const completions: unknown[] = [];
    ctx.setVirtualContext(AuthorizationCompletionReporterKey, async (result) => {
      completions.push(result);
    });
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    });
    ctx.set(PendingAuthorizationResultKey, [
      {
        callback: { method: "GET", params: { code: "oauth-code" } },
        hookUrl: "https://eve.example.com/callback",
        name: "linear",
      },
    ]);

    await contextStorage.run(ctx, async () => {
      await expect(
        completeScopedAuthorization({
          authorization: interactiveAuth(),
          connection: { url: "https://mcp.linear.app" },
          scope: "linear",
        }),
      ).resolves.toBe(true);
    });

    expect(completions).toEqual([{ name: "linear", outcome: "authorized" }]);
  });

  it("classifies an OAuth access_denied callback without calling the provider", async () => {
    let completionCalls = 0;
    const auth = {
      ...interactiveAuth(),
      async completeAuthorization(): Promise<TokenResult> {
        completionCalls += 1;
        return { token: "unexpected" };
      },
    };
    const ctx = new ContextContainer();
    const completions: unknown[] = [];
    ctx.setVirtualContext(AuthorizationCompletionReporterKey, async (result) => {
      completions.push(result);
    });
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    });
    ctx.set(PendingAuthorizationResultKey, [
      {
        callback: {
          method: "GET",
          params: { error: "access_denied", error_description: "User cancelled sign-in" },
        },
        hookUrl: "https://eve.example.com/callback",
        name: "linear",
      },
    ]);

    await expect(
      contextStorage.run(ctx, () =>
        completeScopedAuthorization({
          authorization: auth,
          connection: { url: "https://mcp.linear.app" },
          scope: "linear",
        }),
      ),
    ).rejects.toMatchObject({
      name: "ConnectionAuthorizationFailedError",
      reason: "access_denied",
    });
    expect(completionCalls).toBe(0);
    expect(completions).toEqual([
      { name: "linear", outcome: "declined", reason: "User cancelled sign-in" },
    ]);
  });

  it("reports a classified provider timeout as timed out", async () => {
    const ctx = authorizationContext({ code: "oauth-code" });
    const completions: unknown[] = [];
    ctx.setVirtualContext(AuthorizationCompletionReporterKey, async (result) => {
      completions.push(result);
    });
    const auth = {
      ...interactiveAuth(),
      async completeAuthorization(): Promise<TokenResult> {
        throw new ConnectionAuthorizationFailedError("linear", {
          message: "The provider authorization window expired.",
          reason: "authorization_timeout",
          retryable: false,
        });
      },
    };

    await expect(
      contextStorage.run(ctx, () =>
        completeScopedAuthorization({
          authorization: auth,
          connection: { url: "https://mcp.linear.app" },
          scope: "linear",
        }),
      ),
    ).rejects.toMatchObject({ reason: "authorization_timeout" });
    expect(completions).toEqual([
      {
        name: "linear",
        outcome: "timed-out",
        reason: "The provider authorization window expired.",
      },
    ]);
  });

  it("reports a classified provider denial as declined", async () => {
    const ctx = authorizationContext({ code: "oauth-code" });
    const completions: unknown[] = [];
    ctx.setVirtualContext(AuthorizationCompletionReporterKey, async (result) => {
      completions.push(result);
    });
    const auth = {
      ...interactiveAuth(),
      async completeAuthorization(): Promise<TokenResult> {
        throw new ConnectionAuthorizationFailedError("linear", {
          message: "The user denied access.",
          reason: "access_denied",
          retryable: false,
        });
      },
    };

    await expect(
      contextStorage.run(ctx, () =>
        completeScopedAuthorization({
          authorization: auth,
          connection: { url: "https://mcp.linear.app" },
          scope: "linear",
        }),
      ),
    ).rejects.toMatchObject({ reason: "access_denied" });
    expect(completions).toEqual([
      { name: "linear", outcome: "declined", reason: "The user denied access." },
    ]);
  });

  it("reports principal resolution failures after a callback", async () => {
    const ctx = new ContextContainer();
    const completions: unknown[] = [];
    ctx.setVirtualContext(AuthorizationCompletionReporterKey, async (result) => {
      completions.push(result);
    });
    ctx.set(PendingAuthorizationResultKey, [
      {
        callback: { method: "GET", params: { code: "oauth-code" } },
        hookUrl: "https://eve.example.com/callback",
        name: "linear",
      },
    ]);

    await expect(
      contextStorage.run(ctx, () =>
        completeScopedAuthorization({
          authorization: interactiveAuth(),
          connection: { url: "https://mcp.linear.app" },
          scope: "linear",
        }),
      ),
    ).rejects.toMatchObject({ reason: "principal_required" });
    expect(completions).toEqual([
      {
        name: "linear",
        outcome: "failed",
        reason: expect.stringContaining("no authenticated user principal"),
      },
    ]);
  });
});

function authorizationContext(params: Readonly<Record<string, string>>): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "user-1",
    principalType: "user",
  });
  ctx.set(PendingAuthorizationResultKey, [
    {
      callback: { method: "GET", params },
      hookUrl: "https://eve.example.com/callback",
      name: "linear",
    },
  ]);
  return ctx;
}
