import { oidc as oidcAuth, type ClientOptions, type HeadersValue } from "#client/index.js";

import type { DevelopmentCredentialGate } from "./credential-gate.js";

/**
 * Builds anonymous {@link ClientOptions} for a development target. Locality is
 * not an authorization decision, so remote URLs receive no ambient Vercel
 * credentials through this default path.
 */
export function resolveDevelopmentClientOptions(
  serverUrl: string,
  input: { readonly headers?: HeadersValue } = {},
): ClientOptions {
  return input.headers === undefined
    ? { host: serverUrl }
    : { headers: input.headers, host: serverUrl };
}

/** Builds non-redirecting client options backed by one verified credential gate. */
export function resolveRemoteDevelopmentClientOptions(input: {
  readonly credentials: DevelopmentCredentialGate;
  readonly headers?: HeadersValue;
  readonly serverUrl: string;
}): ClientOptions {
  const serverOrigin = new URL(input.serverUrl).origin;
  if (input.credentials.serverOrigin !== serverOrigin) {
    throw new Error(
      `Credential gate origin ${input.credentials.serverOrigin} does not match client origin ${serverOrigin}.`,
    );
  }
  return {
    auth: oidcAuth(() => input.credentials.resolveToken()),
    headers: mergeRemoteDevelopmentHeaders(input.headers, input.credentials.resolveBypassHeaders),
    host: input.serverUrl,
    redirect: "manual",
  };
}

function mergeRemoteDevelopmentHeaders(
  headers: HeadersValue | undefined,
  resolveBypassHeaders: () => Promise<Readonly<Record<string, string>>>,
): HeadersValue {
  if (headers === undefined) return resolveBypassHeaders;

  return async () => {
    const [baseHeaders, bypassHeaders] = await Promise.all([
      resolveHeadersValue(headers),
      resolveBypassHeaders(),
    ]);
    return { ...baseHeaders, ...bypassHeaders };
  };
}

async function resolveHeadersValue(value: HeadersValue): Promise<Readonly<Record<string, string>>> {
  return typeof value === "function" ? await value() : value;
}
