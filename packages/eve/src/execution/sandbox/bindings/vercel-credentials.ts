import type { NetworkPolicyRule } from "#compiled/@vercel/sandbox/index.js";
import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { SandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { type AuthorizationSignal, requestAuthorization } from "#harness/authorization.js";
import { createLogger } from "#internal/logging.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type {
  VercelSandboxAuthNetworkPolicyRule,
  VercelSandboxCreateOptions,
  VercelSandboxCredentialResolution,
  VercelSandboxNetworkPolicy,
} from "#public/sandbox/vercel-sandbox.js";
import {
  completeScopedAuthorization,
  evictScopedToken,
  resolveScopedToken,
  startScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  type AuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

const logger = createLogger("sandbox.vercel-credentials");

type ResolvedCredentialEntry =
  | {
      readonly kind: "authorization";
      readonly label: string;
      readonly signal: AuthorizationSignal;
    }
  | {
      readonly kind: "token";
      readonly label: string;
      readonly token: TokenResult;
    };

export function getVercelSandboxFetch(
  createOptions: VercelCreateOptions,
): typeof globalThis.fetch {
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
  readonly callbackBaseUrl?: string;
  readonly buildPolicy: (
    credentials: ReadonlyMap<string, TokenResult>,
    sandboxName?: string,
  ) => SandboxNetworkPolicy;
  readonly clearedPolicy: SandboxNetworkPolicy;
  readonly eagerRuleIds: readonly string[];
  readonly rules: ReadonlyMap<string, VercelManagedAuthRule>;
}

export interface VercelManagedAuthRule {
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly credentialResolution: VercelSandboxCredentialResolution;
  readonly id: string;
}

export function extractVercelCredentialBrokering(options: VercelSandboxCreateOptions | undefined): {
  readonly brokering: VercelCredentialBrokering | undefined;
  readonly createOptions: VercelCreateOptions;
} {
  if (options !== undefined && "credentials" in options) {
    throw new Error(
      "vercel(): the separate `credentials` map was removed; attach `auth` to each network policy rule.",
    );
  }
  const { authProxyBaseUrl, credentialResolution, networkPolicy, ...createOptions } = options ?? {};
  assertCredentialResolution(credentialResolution, "vercel():");
  if (typeof networkPolicy === "function") {
    throw new Error(
      "vercel(): function-form `networkPolicy` was removed; attach `auth` and `transform` to individual rules.",
    );
  }
  const authoredPolicy = networkPolicy as VercelSandboxNetworkPolicy | undefined;
  const discovered = discoverManagedRules(authoredPolicy, credentialResolution);
  if (discovered.length === 0) {
    return {
      brokering: undefined,
      createOptions:
        authoredPolicy === undefined
          ? (createOptions as VercelCreateOptions)
          : ({ ...createOptions, networkPolicy: authoredPolicy } as VercelCreateOptions),
    };
  }
  if (credentialResolution === undefined) {
    throw new Error(
      "vercel(): `credentialResolution` is required when `networkPolicy` contains an `auth` rule.",
    );
  }
  rejectAuthoredForwardUrls(authoredPolicy);
  const proxyBaseUrl = resolveAuthProxyBaseUrl(authProxyBaseUrl, discovered);
  const rules = new Map(discovered.map((rule) => [rule.id, rule]));
  const buildPolicy = (
    credentials: ReadonlyMap<string, TokenResult>,
    sandboxName?: string,
  ): SandboxNetworkPolicy =>
    buildManagedPolicy(authoredPolicy, discovered, credentials, proxyBaseUrl, sandboxName);
  return {
    brokering: {
      callbackBaseUrl: proxyBaseUrl,
      buildPolicy,
      clearedPolicy: buildPolicy(new Map()),
      eagerRuleIds: discovered
        .filter((rule) => rule.credentialResolution === "eager")
        .map((rule) => rule.id),
      rules,
    },
    createOptions: createOptions as VercelCreateOptions,
  };
}

export async function resolveVercelCredentialPolicy(
  brokering: VercelCredentialBrokering,
  sandboxScope: string,
  ruleIds: readonly string[] = brokering.eagerRuleIds,
  sandboxName?: string,
): Promise<{
  readonly credentials: ReadonlyMap<string, TokenResult>;
  readonly policy: SandboxNetworkPolicy;
  readonly unresolvedRuleIds: readonly string[];
}> {
  const entries: ResolvedCredentialEntry[] = await Promise.all(
    ruleIds.map(async (ruleId) => {
      const rule = brokering.rules.get(ruleId);
      if (rule === undefined) {
        throw new Error(`Unknown managed sandbox egress rule "${ruleId}".`);
      }
      const scoped = createScopedCredential(sandboxScope, ruleId, rule.authorization);
      const justAuthorized = await completeScopedAuthorization(scoped);

      try {
        return {
          kind: "token",
          label: ruleId,
          token: await resolveScopedToken(scoped),
        } as const;
      } catch (error) {
        if (isConnectionAuthorizationFailedError(error)) {
          throw error;
        }
        if (isConnectionAuthorizationRequiredError(error)) {
          if (justAuthorized) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox egress rule "${ruleId}" rejected the token immediately after ` +
                "authorization.",
              reason: "token_rejected_after_authorization",
              retryable: false,
            });
          }

          await evictScopedToken(scoped);
          const signal = await startScopedAuthorization(scoped, brokering.callbackBaseUrl);
          if (signal !== undefined) {
            return { kind: "authorization", label: ruleId, signal } as const;
          }
          if (supportsInteractiveAuthorization(rule.authorization)) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox egress rule "${ruleId}" requires sign-in, but no authorization ` +
                "callback URL could be minted for this run (missing session context).",
              reason: "authorization_callback_unavailable",
              retryable: false,
            });
          }
        }

        logger.warn("sandbox credential unavailable; leaving route closed", {
          ruleId,
          error,
        });
        return { kind: "token", label: ruleId, token: { token: "" } } as const;
      }
    }),
  );

  const challenges = entries.flatMap((entry) =>
    entry.kind === "authorization" ? entry.signal.challenges : [],
  );
  if (challenges.length > 0) {
    throw new SandboxAuthorizationInterrupt(requestAuthorization(challenges));
  }

  const credentials = new Map(
    entries
      .filter(
        (entry): entry is Extract<ResolvedCredentialEntry, { readonly kind: "token" }> =>
          entry.kind === "token" && entry.token.token.length > 0,
      )
      .map((entry) => [entry.label, entry.token] as const),
  );
  const unresolvedRuleIds = entries
    .filter(
      (entry): entry is Extract<ResolvedCredentialEntry, { readonly kind: "token" }> =>
        entry.kind === "token" && entry.token.token.length === 0,
    )
    .map((entry) => entry.label);
  return {
    credentials,
    policy: brokering.buildPolicy(credentials, sandboxName),
    unresolvedRuleIds,
  };
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

function discoverManagedRules(
  policy: VercelSandboxNetworkPolicy | undefined,
  defaultResolution: VercelSandboxCredentialResolution | undefined,
): Array<VercelManagedAuthRule & { readonly domain: string; readonly index: number }> {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) return [];
  const rules: Array<VercelManagedAuthRule & { readonly domain: string; readonly index: number }> =
    [];
  let domainIndex = 0;
  for (const [domain, domainRules] of Object.entries(policy.allow ?? {})) {
    for (const [index, rule] of domainRules.entries()) {
      if (!isAuthRule(rule)) continue;
      const id = `r${domainIndex}-${index}`;
      if (typeof rule.transform !== "function") {
        throw new Error(
          `vercel(): egress rule "${domain}"[${index}] must define a transform function.`,
        );
      }
      assertCredentialResolution(
        rule.credentialResolution,
        `vercel(): egress rule "${domain}"[${index}]:`,
      );
      rules.push({
        authorization: normalizeAuthorizationSpec(
          rule.auth,
          `vercel() egress rule "${domain}"[${index}]:`,
        ),
        credentialResolution: rule.credentialResolution ?? defaultResolution ?? "eager",
        domain,
        id,
        index,
      });
    }
    domainIndex += 1;
  }
  return rules;
}

function isAuthRule(rule: unknown): rule is VercelSandboxAuthNetworkPolicyRule {
  return typeof rule === "object" && rule !== null && "auth" in rule;
}

function rejectAuthoredForwardUrls(policy: VercelSandboxNetworkPolicy | undefined): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) return;
  for (const rules of Object.values(policy.allow ?? {})) {
    if (rules.some((rule) => "forwardURL" in rule && rule.forwardURL !== undefined)) {
      throw new Error(
        "vercel(): authored `forwardURL` rules cannot be combined with Eve-managed `auth` rules.",
      );
    }
  }
}

function assertCredentialResolution(
  value: unknown,
  prefix: string,
): asserts value is VercelSandboxCredentialResolution | undefined {
  if (value !== undefined && value !== "eager" && value !== "on-request") {
    throw new Error(`${prefix} invalid credential resolution mode "${String(value)}".`);
  }
}

function resolveAuthProxyBaseUrl(
  authored: string | undefined,
  rules: readonly VercelManagedAuthRule[],
): string | undefined {
  if (!rules.some((rule) => rule.credentialResolution === "on-request")) return undefined;
  const candidate = authored ?? process.env.VERCEL_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new Error(
      "vercel(): `authProxyBaseUrl` is required for on-request credential resolution outside a Vercel deployment.",
    );
  }
  const withScheme = candidate.includes("://") ? candidate : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("vercel(): `authProxyBaseUrl` must be a public HTTPS URL.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function buildManagedPolicy(
  policy: VercelSandboxNetworkPolicy | undefined,
  managedRules: ReadonlyArray<
    VercelManagedAuthRule & { readonly domain: string; readonly index: number }
  >,
  credentials: ReadonlyMap<string, TokenResult>,
  proxyBaseUrl: string | undefined,
  sandboxName: string | undefined,
): SandboxNetworkPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) {
    throw new Error("vercel(): managed `auth` rules require record-form `networkPolicy.allow`.");
  }
  const managedByLocation = new Map(
    managedRules.map((rule) => [`${rule.domain}:${rule.index}`, rule]),
  );
  const allow: Record<string, NetworkPolicyRule[]> = {};
  for (const [domain, domainRules] of Object.entries(policy.allow ?? {})) {
    const compiled = domainRules.flatMap((authoredRule, index): NetworkPolicyRule[] => {
      if (!isAuthRule(authoredRule)) return [authoredRule];
      const managed = managedByLocation.get(`${domain}:${index}`)!;
      const token = credentials.get(managed.id);
      if (token !== undefined) {
        const compiledRule: NetworkPolicyRule = {
          transform: authoredRule.transform(token),
        };
        if (authoredRule.match !== undefined) compiledRule.match = authoredRule.match;
        return [compiledRule];
      }
      if (managed.credentialResolution === "on-request" && sandboxName !== undefined) {
        const compiledRule: NetworkPolicyRule = {
          forwardURL:
            `${proxyBaseUrl}/eve/v1/sandbox/egress/${managed.id}/` +
            encodeURIComponent(sandboxName),
        };
        if (authoredRule.match !== undefined) compiledRule.match = authoredRule.match;
        return [compiledRule];
      }
      return [];
    });
    if (compiled.length > 0 || domainRules.length === 0) allow[domain] = compiled;
  }
  return { allow, subnets: policy.subnets };
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
