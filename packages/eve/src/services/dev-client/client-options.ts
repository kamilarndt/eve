import type { ClientOptions } from "#client/index.js";
import { EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER } from "#protocol/local-dev-auth.js";

import type { DevelopmentCredentialGate } from "./credential-gate.js";

/**
 * Builds anonymous {@link ClientOptions} for a development target. Locality is
 * not an authorization decision, so remote URLs receive no ambient Vercel
 * credentials through this default path. A caller that has already matched a
 * local dev server to this app may opt into that server's process-scoped user
 * credential.
 */
export function resolveDevelopmentClientOptions(
  serverUrl: string,
  input: { readonly resolveLocalUserCredential?: () => string | undefined } = {},
): ClientOptions {
  const resolveLocalUserCredential = input.resolveLocalUserCredential;
  if (resolveLocalUserCredential === undefined) return { host: serverUrl };

  return {
    headers: (): Readonly<Record<string, string>> => {
      const token = resolveLocalUserCredential()?.trim();
      return token === undefined || token.length === 0
        ? {}
        : { [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: token };
    },
    host: serverUrl,
  };
}

/** Builds non-redirecting client options backed by one verified credential gate. */
export function resolveRemoteDevelopmentClientOptions(input: {
  readonly credentials: DevelopmentCredentialGate;
  readonly serverUrl: string;
}): ClientOptions {
  const serverOrigin = new URL(input.serverUrl).origin;
  if (input.credentials.serverOrigin !== serverOrigin) {
    throw new Error(
      `Credential gate origin ${input.credentials.serverOrigin} does not match client origin ${serverOrigin}.`,
    );
  }
  return {
    auth: { vercelOidc: { token: () => input.credentials.resolveToken() } },
    headers: input.credentials.resolveBypassHeaders,
    host: input.serverUrl,
    redirect: "manual",
  };
}
