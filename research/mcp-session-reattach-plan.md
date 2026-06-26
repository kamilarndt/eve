---
last_updated: "2026-06-25"
status: proposed
---

# MCP session reattach for Streamable HTTP connections

## Summary

Some Streamable HTTP MCP servers keep working state in the MCP session. A common pattern is a setup
tool that selects or configures a working context, followed by later tools that read that context
from the MCP session.

eve currently rebuilds connection clients at workflow/model step boundaries. That is correct for
durable execution because live MCP clients, HTTP streams, timers, and sockets are not serializable.
However, rebuilding the `@ai-sdk/mcp` client starts a fresh MCP session, so stateful servers can
lose session-local setup between steps.

The implementation shape should keep the live connection registry virtual, but persist small
reconnect metadata in eve's durable context:

```ts
export const McpSessionStateKey = new ContextKey<Record<string, DurableMcpSessionState>>(
  "eve.mcpSessionState",
);

interface DurableMcpSessionState {
  readonly sessionId: string;
  readonly initializeResult: InitializeResult;
  readonly generation: number;
}
```

This state is serialized by eve's existing `serializeContext(ctx)` path as
`serializedContext["eve.mcpSessionState"]`. It is not part of the model transcript, channel request
body, or user-visible messages.

## Verified upstream behavior

Representative Streamable HTTP MCP server implementations:

- create a new `Mcp-Session-Id` for `initialize`;
- require subsequent non-initialize requests to carry that session id;
- return 404 when a request references a terminated session;
- treat DELETE as session termination rather than local client detachment.

This means eve cannot preserve session-scoped setup by sending an old session id on a fresh
`initialize`. eve needs to reattach to the existing MCP session without running a new initialize,
and it must not DELETE the remote session when it only wants to detach locally between workflow
steps.

## Dependency

AI SDK draft PR: `vercel/ai#16399`.

The planned eve implementation assumes `@ai-sdk/mcp` exposes:

- `transport.initialSessionId`
- `transport.initialProtocolVersion`
- `transport.onSessionIdChange`
- `transport.onSessionExpired`
- `transport.terminateSessionOnClose`
- `createMCPClient({ initialInitializeResult })`
- `MCPClient.initializeResult`

If that PR changes shape, adapt this plan to the final AI SDK API before implementation.

## Developer-facing behavior

The first version should be automatic for existing Streamable HTTP MCP connections. App authors keep
defining MCP connections with `defineMcpClientConnection`; they do not pass, persist, or inspect MCP
session ids.

```ts title="agent/connections/workspace.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://service.example/mcp",
  description:
    "Workspace service. Use its setup tools before follow-up tools that depend on selected state.",
  auth: connect({ connector: "workspace/my-agent", principalType: "user" }),
});
```

During one eve session, the expected behavior is:

1. The model discovers remote tools through `connection_search`.
2. A remote setup tool stores working context in the upstream MCP session.
3. The turn parks or crosses a workflow/model step boundary.
4. eve rebuilds the live MCP client, reattaches with framework-owned context metadata, and later
   remote tools observe the same upstream MCP session.

Example tool trace:

```text
connection_search("workspace")
workspace__set_selected_state({ id: "..." })
...durable step boundary...
workspace__get_selected_state({})
```

`workspace__get_selected_state` should see the state selected earlier because eve reused the same
upstream MCP session. This is session continuity, not a new durable app-state API: the selected
state still belongs to the MCP server, and eve only stores the protocol metadata required to
reattach.

For legacy SSE MCP servers, app behavior is unchanged because there is no `MCP-Session-Id` reattach
mechanism. For expired upstream sessions, the first implementation should clear the stale protocol
metadata and surface the failure or retry only safe metadata operations; the MCP server should expose
enough setup tools and descriptions for the model to establish state again. A future replay layer can
add an authored hook or connection option for re-establishing setup after expiry, but valid-session
reattach should not require new app code.

## Where state is saved

Use durable context, not the workflow body as an authored input shape and not external storage.

Current eve flow:

1. `createWorkflowRuntime().run()` builds a context and calls `serializeContext(ctx)`.
2. `turnStep()` deserializes `input.serializedContext`.
3. runtime code mutates durable context values with `ctx.set(...)`.
4. `turnStep()` returns `serializeContext(ctx)` for the next durable step or turn.

`McpSessionStateKey` should follow that same pattern. The workflow payload carries it because the
payload carries all serialized context, but the data is framework-owned context metadata.

Why this location:

- It is already scoped to the eve session.
- It survives workflow step boundaries and parks.
- It avoids an external database migration for reconnect metadata.
- It remains invisible to the LLM and channel adapters unless framework code reads it.
- It keeps live `MCPClient` instances out of durable state.

## State keying

Inside `McpSessionStateKey`, key by connection and principal:

```ts
const cacheKey = `${connection.connectionName}:${principalKey(principal)}`;
```

The serialized context is already per eve session, so the eve session id does not need to be in the
inner map key. If this state is moved to an external KV or database later, include the eve session
id in the external key:

```text
eveSessionId + connectionName + principalKey
```

Keep app-scoped MCP sessions per eve session. Even if the bearer token is shared, state such as a
selected workspace is conversational working context and must not leak across sessions.

## Runtime integration

`ConnectionRegistryKey` remains virtual and step-local.

`ConnectionRegistryImpl` continues constructing `McpConnectionClient`, but the client reads and
writes `McpSessionStateKey` from the active context when creating an HTTP MCP client.

Sketch:

```ts
const ctx = loadContext();
const principal = resolveConnectionPrincipal(connection.connectionName, authorization, ctx);
const cacheKey = `${connection.connectionName}:${principalKey(principal)}`;
const state = ctx.get(McpSessionStateKey) ?? {};
const saved = state[cacheKey];

let currentSessionId = saved?.sessionId;

const client = await createMCPClient({
  transport: {
    type: "http",
    url,
    headers,
    initialSessionId: saved?.sessionId,
    initialProtocolVersion: saved?.initializeResult.protocolVersion,
    terminateSessionOnClose: false,
    onSessionIdChange(sessionId) {
      currentSessionId = sessionId;
    },
    onSessionExpired(sessionId) {
      ctx.set(McpSessionStateKey, (prev = {}) => {
        if (prev[cacheKey]?.sessionId !== sessionId) return prev;
        const { [cacheKey]: _expired, ...rest } = prev;
        return rest;
      });
      currentSessionId = undefined;
    },
  },
  initialInitializeResult: saved?.initializeResult,
});

if (currentSessionId) {
  ctx.set(McpSessionStateKey, (prev = {}) => ({
    ...prev,
    [cacheKey]: {
      sessionId: currentSessionId,
      initializeResult: client.initializeResult,
      generation: (saved?.generation ?? 0) + 1,
    },
  }));
}
```

`generation` is a stale-write guard. If a future implementation has overlapping connection clients
for the same key, only allow a callback or save to replace state when it is based on the current
generation.

## HTTP and SSE fallback

Keep the current Streamable HTTP first, SSE fallback behavior.

Only Streamable HTTP uses `McpSessionStateKey`. Legacy SSE does not have an equivalent
`MCP-Session-Id` reattach mechanism, so it should ignore and not update this state.

If HTTP creation fails with a fallback-eligible compatibility error before a session is established,
fall back to SSE as today. If HTTP fails because a stored session expired, clear the stored state and
retry HTTP fresh once before considering SSE fallback.

## Close behavior

When the runtime disposes the virtual `ConnectionRegistryImpl` at a step boundary, `client.close()`
must only detach the local client. It must not terminate the remote MCP session that eve intends to
reuse next step.

Use:

```ts
terminateSessionOnClose: false
```

Later, if eve gets an explicit terminal-session cleanup hook where no future reattach is possible,
it can optionally terminate stored MCP sessions with DELETE. That is an optimization, not required
for correctness.

## Expiry behavior

When a request carrying a stored session id receives 404:

1. `onSessionExpired` clears `McpSessionStateKey[cacheKey]`.
2. The current request still fails with the transport error.
3. For safe metadata operations, reconnect fresh and retry once.
4. For arbitrary tool execution, do not blindly retry if the runtime cannot prove the server did
   not process the call.

Safe to retry automatically:

- `listTools`
- other read-only setup/metadata calls if the runtime owns them

Not safe to retry automatically:

- model-requested tool calls with possible side effects

For session-scoped setup, expiry means the setup may need to happen again. The normal non-expired
case should preserve setup without server-specific replay code.

## Optional replay layer

The first implementation should focus on preserving valid MCP sessions.

A later generic replay layer can help when an MCP server expires state or after a deployment loses
in-memory upstream sessions. That layer should be connection-authored and JSON-serializable, for
example "when a setup tool succeeds, remember the selected state and replay it after a fresh MCP
session initializes."

Do not bake server-specific replay into the generic MCP client.

## Files likely to change

- `packages/eve/src/context/keys.ts`
  - add `McpSessionStateKey` and durable state types.
- `packages/eve/src/runtime/connections/mcp-client.ts`
  - read/write durable MCP session state;
  - pass AI SDK reattach options;
  - clear state on session expiry;
  - use `terminateSessionOnClose: false`.
- `packages/eve/src/runtime/connections/mcp-client.test.ts`
  - unit coverage for create, persist, reattach, expiry, and fallback.
- Possibly `packages/eve/src/runtime/connections/types.ts`
  - only if a small internal state helper type is better colocated there.

## Test plan

Add unit tests for:

- captures `MCPClient.initializeResult` and `sessionId` after first HTTP client creation;
- serializes MCP session state through `serializeContext(ctx)`;
- rehydrates from `serializedContext` and passes `initialSessionId`, `initialProtocolVersion`, and
  `initialInitializeResult` on the next client creation;
- sets `terminateSessionOnClose: false` for HTTP transports;
- scopes state by connection name and resolved principal key;
- does not share app-scoped MCP session state across eve sessions;
- clears only the matching stored session id on `onSessionExpired`;
- does not apply Streamable HTTP session state to SSE fallback;
- retries fresh once for safe metadata operations after expiry;
- does not blindly retry arbitrary mutating tool calls after expiry.

Optional integration test:

- fake Streamable HTTP MCP server stores `selectedState` by `MCP-Session-Id`;
- first step calls `set_selected_state`;
- next durable continuation step calls `get_selected_state`;
- test passes only if eve reattaches to the same MCP session.

## Rollout notes

- Gate implementation on an AI SDK version that includes `vercel/ai#16399` or equivalent API.
- If the upstream API is delayed, implement an internal transport adapter with the same semantics,
  then delete it once AI SDK support lands.
- Document that this fixes normal step-to-step continuity for stateful Streamable HTTP MCP servers,
  but server-side session expiry can still require user/model recovery unless a replay layer exists.
