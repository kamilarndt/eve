import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  extractVercelCredentialBrokering,
  resolveVercelCredentialPolicy,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isSandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";

function requiredError(): Error {
  const error = new Error("auth required");
  error.name = "ConnectionAuthorizationRequiredError";
  return error;
}

afterEach(() => vi.unstubAllEnvs());

describe("Vercel sandbox route auth", () => {
  it("rejects the removed credential map and function policy APIs", () => {
    expect(() =>
      extractVercelCredentialBrokering({
        credentials: {},
        networkPolicy: "deny-all",
      } as never),
    ).toThrow(/separate `credentials` map was removed/);
    expect(() =>
      extractVercelCredentialBrokering({ networkPolicy: () => "deny-all" } as never),
    ).toThrow(/function-form `networkPolicy` was removed/);
  });

  it("requires an explicit backend resolution mode", () => {
    expect(() =>
      extractVercelCredentialBrokering({
        networkPolicy: {
          allow: {
            "api.example.com": [
              {
                auth: { getToken: async () => ({ token: "secret" }) },
                transform: () => [],
              },
            ],
          },
        },
      }),
    ).toThrow(/`credentialResolution` is required/);
  });

  it("inherits eager mode and builds native transforms", async () => {
    const getToken = vi.fn(async () => ({ token: "secret" }));
    const { brokering } = extractVercelCredentialBrokering({
      credentialResolution: "eager",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: { getToken },
              match: { method: ["POST"] },
              transform: ({ token }: { token: string }) => [
                { headers: { authorization: `Bearer ${token}` } },
              ],
            },
          ],
        },
      },
    });

    expect(brokering?.eagerRuleIds).toEqual(["r0-0"]);
    expect(brokering?.clearedPolicy).toEqual({ allow: {}, subnets: undefined });
    await expect(resolveVercelCredentialPolicy(brokering!, "session")).resolves.toMatchObject({
      policy: {
        allow: {
          "api.example.com": [
            {
              match: { method: ["POST"] },
              transform: [{ headers: { authorization: "Bearer secret" } }],
            },
          ],
        },
      },
    });
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("supports per-rule overrides and mixed native rules", () => {
    const { brokering } = extractVercelCredentialBrokering({
      authProxyBaseUrl: "https://eve.example.com",
      credentialResolution: "on-request",
      networkPolicy: {
        allow: {
          "public.example.com": [],
          "api.example.com": [
            { match: { method: ["GET"] }, transform: [] },
            {
              auth: { getToken: async () => ({ token: "eager" }) },
              credentialResolution: "eager",
              transform: () => [],
            },
            {
              auth: { getToken: async () => ({ token: "lazy" }) },
              transform: () => [],
            },
          ],
        },
      },
    });

    expect(brokering?.eagerRuleIds).toEqual(["r1-1"]);
    expect(brokering?.clearedPolicy).toEqual({
      allow: {
        "public.example.com": [],
        "api.example.com": [{ match: { method: ["GET"] }, transform: [] }],
      },
      subnets: undefined,
    });
    expect(brokering?.buildPolicy(new Map(), "eve-sandbox:name")).toEqual({
      allow: {
        "public.example.com": [],
        "api.example.com": [
          { match: { method: ["GET"] }, transform: [] },
          {
            forwardURL: "https://eve.example.com/eve/v1/sandbox/egress/r1-2/eve-sandbox%3Aname",
          },
        ],
      },
      subnets: undefined,
    });
  });

  it("does not resolve an unused on-request rule", () => {
    const getToken = vi.fn(async () => ({ token: "unused" }));
    const { brokering } = extractVercelCredentialBrokering({
      authProxyBaseUrl: "https://eve.example.com",
      credentialResolution: "on-request",
      networkPolicy: {
        allow: {
          "api.example.com": [{ auth: { getToken }, transform: () => [] }],
        },
      },
    });

    expect(brokering?.eagerRuleIds).toEqual([]);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("uses the public auth proxy origin for on-request authorization callbacks", async () => {
    const startAuthorization = vi.fn(async () => ({
      challenge: { url: "https://provider.example/authorize" },
    }));
    const { brokering } = extractVercelCredentialBrokering({
      authProxyBaseUrl: "https://public.example.com",
      credentialResolution: "on-request",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                completeAuthorization: async () => ({ token: "secret" }),
                getToken: async () => {
                  throw requiredError();
                },
                principalType: "user",
                startAuthorization,
              },
              transform: () => [],
            },
          ],
        },
      },
    });
    const context = new ContextContainer();
    context.set(SessionIdKey, "session");
    context.set(CallbackBaseUrlKey, "https://protected-preview.example.com");
    context.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user",
    });

    const error = await contextStorage.run(
      context,
      async () =>
        await resolveVercelCredentialPolicy(brokering!, "sandbox", ["r0-0"]).catch(
          (caught) => caught,
        ),
    );

    expect(isSandboxAuthorizationInterrupt(error)).toBe(true);
    if (!isSandboxAuthorizationInterrupt(error)) throw error;
    expect(error.signal.challenges[0]?.hookUrl).toBe(
      "https://public.example.com/eve/v1/connections/sandbox%3Asandbox%3Ar0-0/callback/session%3Aauth",
    );
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl:
          "https://public.example.com/eve/v1/connections/sandbox%3Asandbox%3Ar0-0/callback/session%3Aauth",
      }),
    );
  });

  it("reports demanded rules whose credentials remain unavailable", async () => {
    const { brokering } = extractVercelCredentialBrokering({
      credentialResolution: "eager",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                getToken: async () => {
                  throw new Error("provider unavailable");
                },
              },
              transform: () => [],
            },
          ],
        },
      },
    });

    await expect(resolveVercelCredentialPolicy(brokering!, "sandbox")).resolves.toMatchObject({
      unresolvedRuleIds: ["r0-0"],
    });
  });

  it("uses the current Vercel deployment URL for preview self-callbacks", () => {
    vi.stubEnv("VERCEL_URL", "preview.example.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "production.example.vercel.app");
    const { brokering } = extractVercelCredentialBrokering({
      credentialResolution: "on-request",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: { getToken: async () => ({ token: "fake" }) },
              transform: () => [],
            },
          ],
        },
      },
    });

    expect(brokering?.clearedPolicy).toEqual({
      allow: {},
      subnets: undefined,
    });
    expect(brokering?.buildPolicy(new Map(), "sandbox-name")).toEqual({
      allow: {
        "api.example.com": [
          {
            forwardURL:
              "https://preview.example.vercel.app/eve/v1/sandbox/egress/r0-0/sandbox-name",
          },
        ],
      },
      subnets: undefined,
    });
  });

  it("rejects authored forwardURL alongside managed auth", () => {
    expect(() =>
      extractVercelCredentialBrokering({
        authProxyBaseUrl: "https://eve.example.com",
        credentialResolution: "on-request",
        networkPolicy: {
          allow: {
            "api.example.com": [
              { forwardURL: "https://author.example.com" },
              { auth: { getToken: async () => ({ token: "secret" }) }, transform: () => [] },
            ],
          },
        },
      }),
    ).toThrow(/authored `forwardURL`/);
  });

  it("parks eager interactive authorization through the callback lifecycle", async () => {
    const { brokering } = extractVercelCredentialBrokering({
      credentialResolution: "eager",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                completeAuthorization: async () => ({ token: "secret" }),
                getToken: async () => {
                  throw requiredError();
                },
                principalType: "user",
                startAuthorization: async () => ({
                  challenge: { url: "https://example.com/auth" },
                }),
              },
              transform: () => [],
            },
          ],
        },
      },
    });
    const context = new ContextContainer();
    context.set(SessionIdKey, "session");
    context.set(CallbackBaseUrlKey, "https://app.example");
    context.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user",
    });

    const error = await contextStorage.run(
      context,
      async () =>
        await resolveVercelCredentialPolicy(brokering!, "sandbox").catch((caught) => caught),
    );
    expect(isSandboxAuthorizationInterrupt(error)).toBe(true);
  });

  it("propagates a terminal missing-principal authorization failure", async () => {
    const { brokering } = extractVercelCredentialBrokering({
      credentialResolution: "eager",
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                completeAuthorization: async () => ({ token: "secret" }),
                getToken: async () => {
                  throw requiredError();
                },
                principalType: "user",
                startAuthorization: async () => ({ challenge: {} }),
              },
              transform: () => [],
            },
          ],
        },
      },
    });
    const context = new ContextContainer();
    context.set(SessionIdKey, "session");
    context.set(AuthKey, null);

    await expect(
      contextStorage.run(context, async () => resolveVercelCredentialPolicy(brokering!, "sandbox")),
    ).rejects.toMatchObject({ reason: "principal_required", retryable: false });
  });
});
