import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGrant: vi.fn(),
}));

vi.mock("#internal/local-development-auth.js", () => ({
  LocalDevelopmentAuthServer: {
    writer: () => ({ create: mocks.createGrant }),
  },
}));

import { createLocalDevelopmentUserCredential } from "./local-user-credential.js";
import type { VercelUserIdentityResolution } from "#setup/vercel-project.js";

const server = {
  serverInstanceId: "a".repeat(32),
  version: 1,
} as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createLocalDevelopmentUserCredential", () => {
  it("rotates immutable grants when a forced identity refresh finds another user", async () => {
    let identity = authenticated("vercel-user-a");
    const firstGrant = grant("token-a");
    const secondGrant = grant("token-b");
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: secondGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => identity,
      resolveServer: async () => server,
    });

    expect(credential.token).toBeUndefined();
    await credential.refresh();
    expect(credential.token).toBe("token-a");

    await credential.refresh();
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);

    identity = authenticated("vercel-user-b");
    await credential.refresh({ forceIdentity: true });
    expect(credential.token).toBe("token-b");
    expect(firstGrant.dispose).toHaveBeenCalledOnce();

    await credential.dispose();
    expect(secondGrant.dispose).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "cli-missing"] as const)(
    "preserves the current grant when identity is %s",
    async (status) => {
      let identity: VercelUserIdentityResolution = authenticated("vercel-user-a");
      const firstGrant = grant("token-a");
      mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
      const credential = createLocalDevelopmentUserCredential({
        appRoot: "/tmp/eve-agent",
        resolveIdentity: async () => identity,
        resolveServer: async () => server,
      });
      await credential.refresh();

      identity = { status };
      await credential.refresh({ forceIdentity: true });

      expect(credential.token).toBe("token-a");
      expect(firstGrant.dispose).not.toHaveBeenCalled();
      await credential.dispose();
    },
  );

  it("revokes the current grant after confirmed logout", async () => {
    let identity: VercelUserIdentityResolution = authenticated("vercel-user-a");
    const firstGrant = grant("token-a");
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => identity,
      resolveServer: async () => server,
    });
    await credential.refresh();

    identity = { status: "logged-out" };
    await credential.refresh({ forceIdentity: true });

    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledOnce();
    await credential.dispose();
  });

  it("stops exposing a grant whose revocation failed and retries before replacing it", async () => {
    let identity: VercelUserIdentityResolution = authenticated("vercel-user-a");
    const firstGrant = grant("token-a");
    const replacementGrant = grant("token-b");
    firstGrant.dispose.mockRejectedValueOnce(new Error("revoke failed"));
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: replacementGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => identity,
      resolveServer: async () => server,
    });
    await credential.refresh();

    identity = authenticated("vercel-user-b");
    await expect(credential.refresh({ forceIdentity: true })).rejects.toThrow("revoke failed");
    expect(credential.token).toBeUndefined();
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);

    await credential.refresh({ forceIdentity: true });
    expect(credential.token).toBe("token-b");
    await credential.dispose();
  });

  it("does not retain the previous user's grant when creating its replacement fails", async () => {
    let identity = authenticated("vercel-user-a");
    const firstGrant = grant("token-a");
    const cause = new Error("write failed");
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: false, error: { kind: "io", cause } });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => identity,
      resolveServer: async () => server,
    });
    await credential.refresh();

    identity = authenticated("vercel-user-b");
    await expect(credential.refresh({ forceIdentity: true })).rejects.toThrow("write failed");

    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledOnce();
    await credential.dispose();
  });

  it("can retry disposal when revoking the current grant fails", async () => {
    const firstGrant = grant("token-a");
    firstGrant.dispose.mockRejectedValueOnce(new Error("revoke failed"));
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => authenticated("vercel-user-a"),
      resolveServer: async () => server,
    });
    await credential.refresh();

    await expect(credential.dispose()).rejects.toThrow("revoke failed");
    expect(credential.token).toBeUndefined();

    await credential.dispose();
    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledTimes(2);
  });

  it("preserves the rotated grant when a queued identity probe becomes unavailable", async () => {
    let identity: VercelUserIdentityResolution = authenticated("vercel-user-a");
    let finishRevocation: () => void = () => {};
    const firstGrant = grant("token-a");
    const secondGrant = grant("token-b");
    firstGrant.dispose.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishRevocation = resolve;
        }),
    );
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: secondGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity: async () => identity,
      resolveServer: async () => server,
    });
    await credential.refresh();

    identity = authenticated("vercel-user-b");
    const rotation = credential.refresh({ forceIdentity: true });
    await vi.waitFor(() => expect(firstGrant.dispose).toHaveBeenCalledOnce());
    identity = { status: "unavailable" };
    const unavailableRefresh = credential.refresh({ forceIdentity: true });
    finishRevocation();
    await Promise.all([rotation, unavailableRefresh]);

    expect(credential.token).toBe("token-b");
    expect(secondGrant.dispose).not.toHaveBeenCalled();
    await credential.dispose();
  });

  it("caches identity probes until a forced refresh", async () => {
    const resolveIdentity = vi.fn(async () => authenticated("vercel-user-a"));
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: grant("token-a") });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity,
      resolveServer: async () => server,
    });

    await credential.refresh();
    await credential.refresh();
    expect(resolveIdentity).toHaveBeenCalledOnce();

    await credential.refresh({ forceIdentity: true });
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    await credential.dispose();
  });

  it("waits for exact server metadata before probing identity", async () => {
    let activeServer: typeof server | undefined;
    const resolveIdentity = vi.fn(async () => authenticated("vercel-user-a"));
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: grant("token-a") });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity,
      resolveServer: async () => activeServer,
    });

    await credential.refresh();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(credential.token).toBeUndefined();

    activeServer = server;
    await credential.refresh();
    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(credential.token).toBe("token-a");
    await credential.dispose();
  });

  it("preserves an active grant while server metadata is temporarily unavailable", async () => {
    let activeServer: typeof server | undefined = server;
    const resolveIdentity = vi.fn(async () => authenticated("vercel-user-a"));
    const firstGrant = grant("token-a");
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveIdentity,
      resolveServer: async () => activeServer,
    });
    await credential.refresh();

    activeServer = undefined;
    await credential.refresh({ forceIdentity: true });

    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(credential.token).toBe("token-a");
    expect(firstGrant.dispose).not.toHaveBeenCalled();
    await credential.dispose();
  });
});

function authenticated(id: string) {
  return { identity: { id }, status: "authenticated" } as const;
}

function grant(token: string) {
  return { token, dispose: vi.fn(async () => {}) };
}
