import type { TokenValue } from "#client/types.js";
import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import {
  type DevelopmentOidcTokenFailure,
  type DevelopmentOidcTokenResolution,
  VERCEL_PROTECTION_BYPASS_HEADER,
} from "./request-headers.js";

export interface DevelopmentCredentialGrant {
  readonly target: VerifiedVercelTarget;
  readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution | string>;
}

export interface DevelopmentCredentialGateOptions {
  /** Explicit generic OIDC token for non-Vercel remote dev targets. */
  readonly oidcToken?: TokenValue;
}

/** Per-client authority for resolving and emitting remote development credentials. */
export interface DevelopmentCredentialGate {
  /** The origin this gate is permanently bound to. */
  readonly serverOrigin: string;
  /**
   * Installs authority after Vercel verifies the exact origin.
   * Returns a rollback that restores the prior grant if this grant is still current.
   */
  authorize(grant: DevelopmentCredentialGrant): () => void;
  /** The active OIDC token for one request, or "" when unavailable. */
  resolveToken(): Promise<string>;
  /** Vercel protection-bypass headers for a Vercel-authenticated target, or {}. */
  resolveBypassHeaders(): Promise<Readonly<Record<string, string>>>;
  /** Token failure from the most recent {@link resolveToken}, or `undefined` if it resolved one. */
  lastTokenFailure(): DevelopmentOidcTokenFailure | undefined;
}

type DevelopmentCredentialGateState =
  | { readonly kind: "anonymous" }
  | { readonly kind: "oidc"; readonly token: TokenValue }
  | {
      readonly kind: "vercel";
      readonly resolveToken: () => Promise<DevelopmentOidcTokenResolution | string>;
    };

/** Creates a credential gate bound to one client origin. */
export function createDevelopmentCredentialGate(
  serverUrl: string,
  options: DevelopmentCredentialGateOptions = {},
): DevelopmentCredentialGate {
  const serverOrigin = new URL(serverUrl).origin;
  let state: DevelopmentCredentialGateState =
    options.oidcToken === undefined
      ? { kind: "anonymous" }
      : { kind: "oidc", token: options.oidcToken };
  let tokenFailure: DevelopmentOidcTokenFailure | undefined;

  const authorize = (grant: DevelopmentCredentialGrant): (() => void) => {
    if (grant.target.origin !== serverOrigin) {
      throw new Error(
        `Verified Vercel origin ${grant.target.origin} does not match client origin ${serverOrigin}.`,
      );
    }
    const previous = state;
    const previousTokenFailure = tokenFailure;
    const next = {
      kind: "vercel",
      resolveToken: grant.resolveToken,
    } as const;
    state = next;
    tokenFailure = undefined;
    return () => {
      if (state === next) {
        state = previous;
        tokenFailure = previousTokenFailure;
      }
    };
  };

  const resolveToken = async (): Promise<string> => {
    const authorized = state;
    if (authorized.kind === "anonymous") return "";
    if (authorized.kind === "oidc") return (await resolveTokenValue(authorized.token)).trim();

    const resolution = await authorized.resolveToken();
    const failure =
      typeof resolution === "string" || resolution.kind === "resolved" ? undefined : resolution;
    if (state === authorized) tokenFailure = failure;
    if (typeof resolution === "string") {
      return resolution.trim();
    }

    return resolution.kind === "resolved" ? resolution.token.trim() : "";
  };

  const resolveBypassHeaders = async (): Promise<Readonly<Record<string, string>>> => {
    const authorized = state;
    if (authorized.kind !== "vercel") return {};
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    return bypassSecret ? { [VERCEL_PROTECTION_BYPASS_HEADER]: bypassSecret } : {};
  };

  return {
    authorize,
    lastTokenFailure: () => tokenFailure,
    resolveBypassHeaders,
    resolveToken,
    serverOrigin,
  };
}

async function resolveTokenValue(value: TokenValue): Promise<string> {
  return typeof value === "function" ? await value() : value;
}
