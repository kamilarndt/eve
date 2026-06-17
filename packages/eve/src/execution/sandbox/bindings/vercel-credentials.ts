import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { createLogger } from "#internal/logging.js";
import type { SandboxCredentialMap } from "#public/sandbox/credentials.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import {
  resolveScopedToken,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  supportsInteractiveAuthorization,
  type AuthorizationDefinition,
  type TokenResult,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

const logger = createLogger("sandbox.vercel-credentials");

export function getVercelSandboxFetch(createOptions: VercelCreateOptions): typeof globalThis.fetch {
  const fetchOverride = (createOptions as { readonly fetch?: typeof globalThis.fetch }).fetch;
  return fetchOverride ?? globalThis.fetch;
}

export async function getVercelSandboxCredentials(
  createOptions: VercelCreateOptions,
): Promise<VercelSandboxCredentials> {
  const teamId =
    readNonEmptyString(createOptions, "teamId") ??
    readNonEmptyEnvironmentVariable("VERCEL_TEAM_ID") ??
    readNonEmptyEnvironmentVariable("VERCEL_ORG_ID");
  const projectId =
    readNonEmptyString(createOptions, "projectId") ??
    readNonEmptyEnvironmentVariable("VERCEL_PROJECT_ID");
  const envToken =
    readNonEmptyString(createOptions, "token") ??
    readNonEmptyEnvironmentVariable("VERCEL_OIDC_TOKEN") ??
    readNonEmptyEnvironmentVariable("VERCEL_TOKEN");

  if (envToken && teamId && projectId) {
    return { projectId, teamId, token: envToken };
  }

  const oidcToken = await getVercelOidcToken({
    project: projectId,
    team: teamId,
  });
  return getVercelSandboxCredentialsFromOidcToken(oidcToken);
}

export interface VercelCredentialBrokering {
  readonly buildPolicy: (credentials: Record<string, TokenResult>) => SandboxNetworkPolicy;
  readonly credentials: Readonly<Record<string, Readonly<AuthorizationDefinition>>>;
  readonly emptyPolicy: SandboxNetworkPolicy;
}

export function extractVercelCredentialBrokering<C extends SandboxCredentialMap>(
  options: VercelSandboxCreateOptions<C> | undefined,
): {
  readonly brokering: VercelCredentialBrokering | undefined;
  readonly createOptions: VercelCreateOptions;
} {
  const { credentials, networkPolicy, ...createOptions } = options ?? {};
  const labels = Object.keys(credentials ?? {});

  if (typeof networkPolicy !== "function") {
    if (labels.length > 0) {
      throw new Error(
        "vercel(): `credentials` requires `networkPolicy` to be a function of the resolved credentials.",
      );
    }
    return {
      brokering: undefined,
      createOptions:
        networkPolicy === undefined ? createOptions : { ...createOptions, networkPolicy },
    };
  }

  if (labels.length === 0) {
    throw new Error(
      "vercel(): a function-form `networkPolicy` requires at least one entry in `credentials`.",
    );
  }

  const normalized: Record<string, AuthorizationDefinition> = {};
  for (const [label, auth] of Object.entries(credentials ?? {})) {
    const authorization = normalizeAuthorizationSpec(auth, `vercel() credential "${label}":`);
    if (supportsInteractiveAuthorization(authorization)) {
      throw new Error(
        `vercel() credential "${label}": interactive authorization is not supported. ` +
          "Use a non-interactive getToken strategy.",
      );
    }
    normalized[label] = authorization;
  }

  const buildPolicy = networkPolicy as VercelCredentialBrokering["buildPolicy"];
  return {
    brokering: {
      buildPolicy,
      credentials: normalized,
      emptyPolicy: buildPolicy(createEmptyCredentials(labels)),
    },
    createOptions,
  };
}

export async function resolveVercelCredentialPolicy(
  brokering: VercelCredentialBrokering,
  sandboxScope: string,
): Promise<SandboxNetworkPolicy> {
  const entries = await Promise.all(
    Object.entries(brokering.credentials).map(async ([label, authorization]) => {
      try {
        const token = await resolveScopedToken(
          createScopedCredential(sandboxScope, label, authorization),
        );
        return [label, token] as const;
      } catch (error) {
        logger.warn("sandbox credential unavailable; applying empty token", {
          credential: label,
          error,
        });
        return [label, { token: "" }] as const;
      }
    }),
  );

  return brokering.buildPolicy(Object.fromEntries(entries));
}

function createScopedCredential(
  sandboxScope: string,
  label: string,
  authorization: Readonly<AuthorizationDefinition>,
): ScopedAuthorization {
  return {
    authorization,
    connection: { url: "" },
    scope: `sandbox:${sandboxScope}:${label}`,
  };
}

function createEmptyCredentials(labels: readonly string[]): Record<string, TokenResult> {
  return Object.fromEntries(labels.map((label) => [label, { token: "" }]));
}

function readNonEmptyString(object: object, key: string): string | undefined {
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmptyEnvironmentVariable(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getVercelSandboxCredentialsFromOidcToken(token: string): VercelSandboxCredentials {
  const payloadSegment = token.split(".")[1];
  if (payloadSegment === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing payload.");
  }

  const payload = JSON.parse(
    Buffer.from(base64UrlToBase64(payloadSegment), "base64").toString("utf8"),
  ) as { owner_id?: unknown; project_id?: unknown };
  const teamId = typeof payload.owner_id === "string" ? payload.owner_id : undefined;
  const projectId = typeof payload.project_id === "string" ? payload.project_id : undefined;

  if (teamId === undefined || projectId === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing owner_id or project_id.");
  }

  return { projectId, teamId, token };
}

function base64UrlToBase64(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

export interface VercelSandboxCredentials {
  readonly projectId: string;
  readonly teamId: string;
  readonly token: string;
}
