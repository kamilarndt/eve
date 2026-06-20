import {
  LocalDevelopmentAuthServer,
  type LocalDevelopmentAuthCreateError,
  type LocalDevelopmentUserGrantHandle,
} from "#internal/local-development-auth.js";
import type { LocalDevelopmentAuthMetadata } from "#protocol/local-dev-auth.js";

/** Temporary per-TUI credential for one authenticated local development user. */
export interface LocalDevelopmentUserCredential {
  readonly token: string | undefined;
  /** Re-resolves server ownership and rotates the grant only when identity is disproved. */
  refresh(options?: { readonly forceIdentity?: boolean }): Promise<void>;
  /** Revokes the grant currently owned by this TUI. */
  dispose(): Promise<void>;
}

export type LocalDevelopmentUserIdentityResolution =
  | { readonly status: "authenticated"; readonly identity: { readonly id: string } }
  | { readonly status: "logged-out" | "cli-missing" | "unavailable" };

const IDENTITY_CACHE_TTL_MS = 30_000;
const UNAVAILABLE_IDENTITY_CACHE_TTL_MS = 1_000;

/**
 * Creates one local TUI credential. The server registry owns the principal
 * mapping; requests carry only the temporary token that addresses it.
 */
export function createLocalDevelopmentUserCredential(input: {
  readonly appRoot: string;
  /** Resolves the active server so an attached TUI can survive a server restart. */
  readonly resolveServer: () => Promise<LocalDevelopmentAuthMetadata | undefined>;
  readonly resolveIdentity: () => Promise<LocalDevelopmentUserIdentityResolution>;
}): LocalDevelopmentUserCredential {
  type CredentialState =
    | { readonly kind: "empty" }
    | {
        readonly kind: "active";
        readonly grant: LocalDevelopmentUserGrantHandle;
        readonly serverInstanceId: string;
        readonly userId: string;
      }
    | { readonly kind: "revoking"; readonly grant: LocalDevelopmentUserGrantHandle };

  let state: CredentialState = { kind: "empty" };
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let refreshTail = Promise.resolve();
  let cachedIdentity: LocalDevelopmentUserIdentityResolution | undefined;
  let identityCacheExpiresAt = 0;

  const revokeCurrentGrant = async (): Promise<void> => {
    if (state.kind === "empty") return;
    if (state.kind === "active") state = { kind: "revoking", grant: state.grant };
    const revoking = state;
    await revoking.grant.dispose();
    if (state === revoking) state = { kind: "empty" };
  };

  const resolveIdentity = async (
    force: boolean,
  ): Promise<LocalDevelopmentUserIdentityResolution> => {
    if (!force && cachedIdentity !== undefined && Date.now() < identityCacheExpiresAt) {
      return cachedIdentity;
    }

    try {
      cachedIdentity = await input.resolveIdentity();
    } catch {
      cachedIdentity = { status: "unavailable" };
    }
    identityCacheExpiresAt =
      Date.now() +
      (cachedIdentity.status === "unavailable"
        ? UNAVAILABLE_IDENTITY_CACHE_TTL_MS
        : IDENTITY_CACHE_TTL_MS);
    return cachedIdentity;
  };

  const refreshOnce = async (forceIdentity: boolean): Promise<void> => {
    if (disposed) return;

    let server: LocalDevelopmentAuthMetadata | undefined;
    try {
      server = await input.resolveServer();
    } catch {
      server = undefined;
    }
    if (disposed || server === undefined) return;
    const identity = await resolveIdentity(forceIdentity);
    if (disposed) return;

    if (state.kind === "active" && state.serverInstanceId !== server.serverInstanceId) {
      await revokeCurrentGrant();
    }

    if (identity.status === "logged-out") {
      await revokeCurrentGrant();
      return;
    }
    if (identity.status !== "authenticated") return;

    const userId = identity.identity.id.trim();
    if (userId.length === 0) return;
    if (
      state.kind === "active" &&
      state.serverInstanceId === server.serverInstanceId &&
      state.userId === userId
    ) {
      return;
    }

    await revokeCurrentGrant();
    if (disposed) return;

    const authServer = LocalDevelopmentAuthServer.writer({
      appRoot: input.appRoot,
      metadata: server,
    });
    const createdGrant = await authServer.create({ userId });
    if (!createdGrant.ok) throw toLocalDevelopmentAuthCreateError(createdGrant.error);
    const nextGrant = createdGrant.value;
    if (disposed) {
      await nextGrant.dispose();
      return;
    }

    state = {
      kind: "active",
      grant: nextGrant,
      serverInstanceId: server.serverInstanceId,
      userId,
    };
  };

  return {
    get token() {
      return state.kind === "active" ? state.grant.token : undefined;
    },
    async refresh(options) {
      const refresh = refreshTail.then(() => refreshOnce(options?.forceIdentity === true));
      refreshTail = refresh.catch(() => {});
      await refresh;
    },
    async dispose() {
      if (disposePromise === undefined) {
        disposed = true;
        disposePromise = (async () => {
          await refreshTail;
          await revokeCurrentGrant();
        })().catch((error: unknown) => {
          disposePromise = undefined;
          throw error;
        });
      }
      await disposePromise;
    },
  };
}

function toLocalDevelopmentAuthCreateError(error: LocalDevelopmentAuthCreateError): Error {
  if (error.kind === "io" && error.cause instanceof Error) return error.cause;
  if (error.kind === "invalid-user-id") {
    return new Error("The Vercel CLI returned an invalid user id.");
  }
  return new Error("Failed to allocate a unique local development user credential.");
}
