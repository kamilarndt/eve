# Inline Tool Auth Provider Plan

## Summary

Add an inline tool-auth API so an authored tool can resolve and re-challenge a token for a specific auth provider at the call site:

```ts
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";

const githubAuth = connect("github");
const linearAuth = connect("linear");

export default defineTool({
  description: "Sync GitHub context into Linear.",
  inputSchema: { type: "object" },
  async execute(_input, ctx) {
    const [{ token: githubToken }, { token: linearToken }] = await Promise.all([
      ctx.getToken(githubAuth),
      ctx.getToken(linearAuth),
    ]);

    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${githubToken}` },
    });

    if (res.status === 401) {
      ctx.requireAuth(githubAuth);
    }

    return createLinearIssue(linearToken, await res.json());
  },
});
```

This keeps the existing top-level `auth: connect(...)` tool API working, but makes it sugar over a more general provider-scoped primitive. The runtime should keep using the existing scoped authorization machinery: per-step token cache, principal resolution, Connect cache eviction, authorization signals, pending authorization state, callback completion, loop guard, and model-facing redaction.

## Why change it

The current per-tool API assumes one credential strategy per authored tool:

```ts
export default defineTool({
  auth: connect("okta"),
  inputSchema: { type: "object" },
  async execute(_input, ctx) {
    const { token } = await ctx.getToken();
  },
});
```

That works well for "this tool needs exactly one token", but it becomes awkward when:

- a tool calls multiple APIs;
- auth is conditional on input;
- helper functions want to own the auth provider they need;
- SDKs or raw HTTP clients need to map downstream `401` responses back into the same auth flow;
- future OpenAPI/SDK-style tools want auth to live closer to an operation than to the containing tool.

The desired mental model is:

- `connect("x")` is an auth provider.
- `ctx.getToken(provider)` resolves a token for that provider.
- `ctx.requireAuth(provider)` says "the token for this provider was rejected; evict and re-authorize it."
- The model never sees OAuth URLs or user codes; it sees the same opaque pending-auth result as today.

## Goals

- Allow a tool without top-level `auth` to call `ctx.getToken(connect("..."))`.
- Preserve existing `ctx.getToken()` and `ctx.requireAuth()` behavior for tools with top-level `auth`.
- Support multiple providers in one tool without adding multiple tool files or fake gate tools.
- Reuse `ScopedAuthorization` and the existing `AuthorizationSignal` flow.
- Keep downstream `401` handling explicit for authored raw HTTP/SDK tools through `ctx.requireAuth(provider)`.
- Keep callback URLs, cache keys, display names, and pending state stable and deterministic.
- Avoid leaking authorization URLs, device codes, or resume state into model-visible output.

## Non-goals

- Do not automatically inspect arbitrary `fetch()` responses in authored tools. Eve cannot know whether a `401` from user code means token revocation, missing scope, wrong endpoint, or expected API behavior.
- Do not make inline auth a replacement for MCP/OpenAPI connection definitions. Connections still own remote tool discovery and automatic auth attachment.
- Do not solve OpenAPI `401` reclassification in this change, except by reusing the same lower-level primitives if that separate fix follows.
- Do not persist bearer tokens durably. Keep the current per-step virtual cache behavior.

## Current architecture

Relevant files:

- `packages/eve/src/public/definitions/tool.ts`
  - `ToolContext.getToken()` and `ToolContext.requireAuth()` are defined as no-arg methods.
  - Top-level `ToolDefinition.auth` accepts the same shapes as connection auth.
- `packages/eve/src/execution/tool-auth.ts`
  - `createAuthorizedToolExecute()` wraps tools with top-level auth.
  - It builds a `ToolContext` whose no-arg token accessors are bound to the tool name.
  - It catches `ConnectionAuthorizationRequiredError`, evicts, starts auth, returns `AuthorizationSignal`, and loop-guards immediate post-callback rejection.
- `packages/eve/src/runtime/connections/scoped-authorization.ts`
  - Shared implementation for resolving, caching, evicting, starting, and completing scoped auth.
  - A scope is currently a connection name for connection tools or a tool name for top-level tool auth.
- `packages/eve/src/harness/authorization.ts`
  - Defines `AuthorizationSignal`, `requestAuthorization()`, callback URL construction, redaction, model-facing pending output, and pending state.
- `packages/eve/src/harness/tool-loop.ts`
  - Finds a returned `AuthorizationSignal`, emits `authorization.required`, stores pending challenges, and parks the turn.
- `packages/eve/src/runtime/connections/mcp-client.ts`
  - Maps MCP `401` into `ConnectionAuthorizationRequiredError`, evicts caches, closes the client, and lets the auth flow retry.

## Proposed public API

### Phase 1: provider argument overloads

Extend `ToolContext`:

```ts
export interface ToolAuthScopeOptions {
  /**
   * Stable authorization scope. Controls token cache keys, callback URLs,
   * pending authorization names, and authorization completion matching.
   */
  readonly scope?: string;

  /**
   * Human-readable provider name shown in sign-in UI. This should become
   * auth.displayName on the normalized auth definition for this resolution.
   */
  readonly displayName?: string;

  /**
   * Optional metadata handed to auth.getToken/startAuthorization.
   * For authored tools this defaults to { url: "" }, matching today's
   * top-level tool auth behavior.
   */
  readonly connection?: ConnectionAuthorizationContext;
}

export type ToolAuthProvider = ToolAuthDefinition;

export type ToolContext = SessionContext & {
  getToken(): Promise<TokenResult>;
  getToken(provider: ToolAuthProvider, options?: ToolAuthScopeOptions): Promise<TokenResult>;

  requireAuth(): never;
  requireAuth(provider: ToolAuthProvider, options?: ToolAuthScopeOptions): never;
};
```

Behavior:

- `ctx.getToken()` keeps using the tool's top-level `auth`.
- `ctx.requireAuth()` keeps requiring the tool's top-level `auth`.
- `ctx.getToken(provider)` resolves the passed provider using inline scope derivation.
- `ctx.requireAuth(provider)` throws a special auth-required signal for that provider/scope.
- Calling no-arg accessors without top-level `auth` still throws the existing "tool does not declare auth" error.
- Calling provider accessors works regardless of whether the tool has top-level `auth`.

### Deferred: handle API

Do not ship a handle API in the first implementation. If the direct overload feels repetitive after authors try it, add a small handle API over the same primitive later:

```ts
const github = ctx.auth(connect("github"));
const { token } = await github.getToken();
if (res.status === 401) github.requireAuth();
```

This is ergonomic when the same provider is used repeatedly. It is not required for phase 1.

### Deferred: multi-token aggregation

Direct `Promise.all([ctx.getToken(a), ctx.getToken(b)])` is author-friendly, but JavaScript only rejects `Promise.all` with the first rejection. If both providers need consent, the runtime may prompt for one, resume, then prompt for the next.

If one consolidated sign-in step matters, add:

```ts
const { github, linear } = await ctx.getTokens({
  github: connect("github"),
  linear: connect("linear"),
});
```

`getTokens()` can use `Promise.allSettled`, collect all `AuthorizationRequired` results, and throw one aggregate special-shape error carrying multiple scoped auth requests. This should be a follow-up unless product strongly wants multi-provider prompts in the first patch.

### Convenience API to defer

Do not lead with `ctx.fetch(provider, input, init)`. It is useful, but too narrow as the primitive because tools also use SDKs, GraphQL clients, CLIs, and sandbox network policy transforms. It can layer on top later:

```ts
const res = await ctx.fetch(connect("github"), "https://api.github.com/user");
```

## Scope semantics

The hardest design choice is scope. Scope controls:

- per-step token cache entries;
- callback URL path;
- `authorization.required.data.name`;
- pending authorization completion matching;
- model-facing pending auth names;
- loop-guard identity;
- cache eviction identity.

Top-level tool auth currently uses the tool name as scope. Connection tools use the connection name. Inline providers need a deterministic provider scope.

### Recommended derivation

Use a path-safe internal scope id, with a separate display label:

```ts
inlineScope = options.scope ?? deriveInlineAuthScope(toolName, authorization);
displayName = options.displayName ?? authorization.displayName ?? deriveDisplayName(authorization);
```

Default derivation:

1. If `authorization.vercelConnect?.connector` is present, derive from connector plus tool name:
   - raw connector: `oauth/linear`
   - path-safe suffix: `oauth_linear`
   - scope: `${toolName}__oauth_linear`
2. If the auth definition has no provider marker and the caller did not pass `scope`, default to `${toolName}__inline_auth` only if there is a single inline provider in that tool invocation.
3. If multiple anonymous inline auth providers are used without explicit scopes, throw a clear error asking for `ctx.getToken(auth, { scope: "..." })`.

This is conservative. It avoids putting slashes or opaque connector ids directly into callback route params, and it avoids accidental collisions with the existing tool-name scope.

### Why not use only the connector name

Using `github` or `oauth/linear` directly is attractive because sign-in UI looks natural and different tools share the same cache scope. But raw connector identifiers can contain `/`, `scl_...`, or other strings that are not suitable as path params or user-facing labels. Sharing the Eve per-step cache across tools is also only a minor win because Connect has its own lower cache. The safer default is tool-qualified scope plus display metadata.

### Explicit scope option

Allow authors to opt into shared scope:

```ts
const { token } = await ctx.getToken(connect("github"), {
  scope: "github",
  displayName: "GitHub",
});
```

`scope` must be validated as path-safe. Suggested rule: lowercase/uppercase ASCII letters, digits, `_`, `-`, `.`, and `:` are allowed; `/`, `?`, `#`, and whitespace are rejected.

## Runtime design

### New internal auth request error

Add an internal special-shape error rather than overloading `ConnectionAuthorizationRequiredError` with hidden fields:

```ts
interface ToolAuthorizationRequiredRequest {
  readonly scoped: ScopedAuthorization;
  readonly justAuthorized: boolean;
}

class ToolAuthorizationRequiredError extends Error {
  readonly name = "ToolAuthorizationRequiredError";
  readonly requests: readonly ToolAuthorizationRequiredRequest[];
}
```

This error is never public API. It is an execution-layer transport for "the tool needs these scoped auth flows to run before it can continue."

Why not only reuse `ConnectionAuthorizationRequiredError`:

- The existing public error carries a connection name, not the live auth strategy needed to start inline auth.
- Inline auth needs the normalized provider, scope, connection context, and loop-guard state.
- Keeping a separate internal error lets `isConnectionAuthorizationRequiredError()` stay stable.

The inline token helper can still accept public `ConnectionAuthorizationRequiredError` thrown by provider `getToken`; it converts that into the internal error with the corresponding scoped provider.

### Always build an auth-capable tool context

Today, `resolveAuthoredExecute()` chooses between:

- top-level auth wrapper: `createAuthorizedToolExecute(...)`;
- no-auth context: `buildUnauthorizedToolContext(...)`.

Refactor to always wrap authored tools in a context that can support inline providers:

```ts
createToolExecuteWithAuth({
  topLevelAuth: def.auth,
  execute,
  toolName: def.name,
});
```

The wrapper should:

1. Build `ToolContext` with both no-arg and provider overloads.
2. Run authored `execute`.
3. Catch `ToolAuthorizationRequiredError`.
4. For each requested scope:
   - if it was just authorized, throw `ConnectionAuthorizationFailedError` with `token_rejected_after_authorization`;
   - evict scoped token;
   - call `startScopedAuthorization(scoped)`;
   - collect returned challenges.
5. If at least one challenge exists, return `requestAuthorization(challenges)`.
6. If no challenge can be minted for an interactive strategy, throw classified `ConnectionAuthorizationFailedError` with `authorization_callback_unavailable`.
7. For non-interactive strategies, rethrow the original provider failure.

### Inline token resolution helper

Add a helper in `tool-auth.ts` or a new `tool-auth-scope.ts`:

```ts
async function resolveToolToken(input: {
  readonly toolName: string;
  readonly topLevelAuth?: AuthorizationDefinition;
  readonly provider?: ToolAuthProvider;
  readonly options?: ToolAuthScopeOptions;
}): Promise<TokenResult>;
```

For no-arg calls:

- require `topLevelAuth`;
- scope is `toolName`;
- preserve current behavior exactly.

For provider calls:

- normalize the provider with `normalizeAuthorizationSpec(provider, "ctx.getToken:")`;
- merge `displayName` from options if provided;
- derive scope;
- call `completeScopedAuthorization(scoped)` first;
- record `justAuthorized` in a virtual set keyed by scope;
- call `resolveScopedToken(scoped)`;
- if provider throws `ConnectionAuthorizationRequiredError`, throw `ToolAuthorizationRequiredError` carrying the scoped request and `justAuthorized`.

### `requireAuth(provider)` behavior

`ctx.requireAuth(provider)` should:

1. Build the same scoped auth object as `ctx.getToken(provider)`.
2. Read whether that scope was just authorized.
3. Throw `ToolAuthorizationRequiredError` with that scoped request.

This is what authored tools use for downstream `401`:

```ts
if (res.status === 401) ctx.requireAuth(githubAuth);
```

The wrapper catches this, evicts the rejected token from Eve's per-step cache and the provider's own cache via `authorization.evict`, then starts authorization again.

### Loop guard for inline auth

Current top-level auth computes `justAuthorized` once before execute. Inline auth cannot know all scopes before execute. Instead:

- when `completeScopedAuthorization(scoped)` returns true inside `ctx.getToken(provider)`, add the scope to a virtual `JustAuthorizedToolAuthScopesKey`;
- if the same scope later calls `ctx.requireAuth(provider)` or rethrows Required in the same invocation, the wrapper sees `justAuthorized: true` and fails terminally.

This preserves today's "do not prompt forever after a newly minted token is immediately rejected" behavior.

### Cache and eviction

Keep using `resolveScopedToken()` and `evictScopedToken()`.

Important details:

- Cache key stays `(scope, principalKey)`.
- Tokens stay in virtual context only.
- `evictScopedToken()` already calls `authorization.evict?.(...)`, which newer `@vercel/connect/eve` uses to clear its own in-process token cache.
- Provider-scoped `ctx.requireAuth(provider)` must be the recommended way to map downstream `401` responses back into this eviction path.

### Authorization signal aggregation

Phase 1 can return one challenge per thrown inline request. If direct `Promise.all` only exposes the first rejection, this still works, just possibly one provider at a time.

If implementing `ctx.getTokens()` in phase 3:

- resolve all providers concurrently;
- for successful providers, keep token results;
- for required providers, collect requests;
- if any required, throw one `ToolAuthorizationRequiredError` with all requests;
- wrapper turns them into one `AuthorizationSignal` with multiple challenges;
- `tool-loop.ts` already emits one `authorization.required` event per challenge in a signal.

## Type and API changes

Files likely touched:

- `packages/eve/src/public/definitions/tool.ts`
  - Add provider overloads and `ToolAuthScopeOptions`.
  - Document old no-arg behavior and new provider behavior.
- `packages/eve/src/execution/tool-auth.ts`
  - Replace or extend `createAuthorizedToolExecute`.
  - Add inline provider scope derivation, normalization, error conversion, and loop guard.
- `packages/eve/src/execution/node-step.ts`
  - Always use the new auth-capable wrapper for authored tools.
- `packages/eve/src/runtime/connections/scoped-authorization.ts`
  - Ideally unchanged. If needed, expose a tiny helper for display stamping or reuse existing exported functions.
- `packages/eve/src/runtime/connections/validate-authorization.ts`
  - Reuse existing normalization; no new behavior expected.
- `packages/eve/src/harness/authorization.ts`
  - Ideally unchanged. Scope validation may live elsewhere.

Potential exported types:

```ts
export interface ToolAuthScopeOptions { ... }
export type ToolAuthProvider = ToolAuthDefinition;
```

Avoid exporting internal request errors.

## Documentation updates

If implemented, update:

- `docs/reference/typescript-api.md`
  - `ctx.getToken(provider?)`
  - `ctx.requireAuth(provider?)`
- `docs/guides/auth-and-route-protection.md`
  - Add "Inline provider auth inside a tool".
  - Explain explicit downstream `401` mapping.
- `docs/connections.mdx`
  - Update the "Handling a revoked token mid-call" example to show both top-level and inline forms.

Mention that top-level `auth` remains useful for the simple one-provider case.

## Tests

### Unit tests

Add or update tests for pure helpers:

- scope derivation from `vercelConnect.connector`;
- path-safe scope validation;
- displayName override;
- normalization defaults `getToken`-only inline auth to `principalType: "app"`;
- anonymous inline provider without scope gives a useful error when ambiguous.

### Integration tests

Extend `packages/eve/src/execution/tool-auth.integration.test.ts`:

- plain tool without top-level `auth` can call `ctx.getToken(auth)`;
- inline `ctx.getToken(auth)` caches within the step;
- inline interactive auth parks with `authorization.required`;
- inline callback completion resumes and serves minted token;
- inline `ctx.requireAuth(auth)` after a simulated `401` evicts and parks;
- inline loop guard fails terminally when token is rejected immediately after callback;
- no-arg `ctx.getToken()` still throws on tools without top-level `auth`;
- no-arg top-level auth behavior remains unchanged;
- `displayName` option is stamped on challenge;
- explicit `scope` is used for pending authorization matching.

If adding `ctx.getTokens()`:

- two missing providers produce one `AuthorizationSignal` with two challenges;
- one success plus one missing provider parks only the missing provider;
- callback completion for each scope maps back to the right token.

### Harness/code-mode tests

Existing `AuthorizationSignal` plumbing should continue to work, but add coverage if implementation changes the signal shape:

- `harness/tool-loop.test.ts`: inline provider signal is stashed/redacted and parks.
- `harness/code-mode.test.ts` or existing code-mode auth tests: host tool inline auth becomes a code-mode connection-auth interrupt.

### MCP/OpenAPI tests

No required changes for phase 1. Consider a separate OpenAPI follow-up for classifying `401` responses into auth-required, mirroring MCP.

## Migration and compatibility

Keep all existing authored tools working:

```ts
auth: connect("okta"),
async execute(_input, ctx) {
  return ctx.getToken();
}
```

New inline style:

```ts
const okta = connect("okta");

export default defineTool({
  inputSchema: { type: "object" },
  async execute(_input, ctx) {
    return ctx.getToken(okta);
  },
});
```

Do not remove top-level `auth` in the same change. It remains the shortest expression for single-provider tools and keeps current docs/examples valid.

## Open questions

1. Should default inline scope be tool-qualified (`tool__provider`) or provider-only (`provider`)?
   - Recommendation: tool-qualified by default, explicit `scope` for sharing.

2. Should direct `Promise.all([ctx.getToken(a), ctx.getToken(b)])` aggregate missing auths?
   - Recommendation: not in phase 1; add `ctx.getTokens()` if consolidated prompts matter.

3. Should `ctx.requireAuth(provider)` evict only local caches or also revoke Connect grants?
   - Recommendation: local eviction only, matching current automatic `401` cascade. Grant revocation should remain an explicit disconnect action.

4. Should the provider argument accept a string key into a top-level map?
   - Possible later:
     ```ts
     auth: {
       github: connect("github");
     }
     await ctx.getToken("github");
     ```
   - Recommendation: defer. It preserves discoverability but reintroduces top-level ceremony.

5. Should `ctx.fetch(provider, ...)` ship with phase 1?
   - Recommendation: defer. Useful helper, wrong primitive.

## Suggested implementation sequence

1. Add `ToolAuthScopeOptions` and provider overloads to `ToolContext`.
2. Refactor tool execution to always use an auth-capable context for authored tools.
3. Add inline provider normalization and scope derivation.
4. Add internal `ToolAuthorizationRequiredError` carrying scoped requests.
5. Teach the wrapper to catch internal requests, evict, start auth, aggregate challenges, and preserve loop guard behavior.
6. Add integration tests for inline getToken/requireAuth, resume, eviction, and loop guard.
7. Update docs and examples.
8. Add a changeset for the public API addition.
9. Decide whether phase 3 `ctx.getTokens()` is necessary before release.

## Recommendation

Implement `ctx.getToken(provider)` and `ctx.requireAuth(provider)` as the first-class primitive. Keep top-level `auth` as sugar for the common one-provider case. Defer `ctx.auth(provider)` and `ctx.fetch(provider, ...)` until after the primitive lands and authors have tried it.

The main risk is not token resolution. The main risk is scope identity. Get scope derivation, callback matching, cache eviction, and loop guard semantics right first; the rest of the API can be layered cleanly.
