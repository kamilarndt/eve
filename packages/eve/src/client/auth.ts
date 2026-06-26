import type { ClientAuth, TokenValue } from "#client/types.js";

type OidcClientAuth = Extract<ClientAuth, { readonly oidc: TokenValue }>;

/**
 * eve-owned mirror of the `@vercel/oidc` token lookup options forwarded by
 * {@link vercelOidcAuth}.
 */
export interface VercelOidcAuthOptions {
  /** Buffer in milliseconds before token expiry that triggers a refresh. */
  readonly expirationBufferMs?: number;
  /** Project ID (`prj_*`) or slug to use for token refresh. */
  readonly project?: string;
  /** Team ID (`team_*`) or slug to use for token refresh. */
  readonly team?: string;
}

/**
 * Returns client auth that sends an OpenID Connect token. `token` can be a
 * static string or a per-request resolver.
 */
export function oidc(token: TokenValue): OidcClientAuth {
  return { oidc: token };
}

/**
 * Returns client auth that sends Vercel OIDC. The token is resolved before
 * each request through `@vercel/oidc`.
 */
export function vercelOidcAuth(options: VercelOidcAuthOptions = {}): OidcClientAuth {
  return oidc(async () => {
    const { getVercelOidcToken } = await import("#compiled/@vercel/oidc/index.js");
    return await getVercelOidcToken(options);
  });
}
