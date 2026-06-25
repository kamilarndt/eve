---
issue: https://github.com/vercel/eve/issues/216
last_updated: "2026-06-25"
status: proposed
---

# Channel session reset and scoped cancellation

## Summary

Telegram private chats and Twilio conversations reuse a stable continuation identity, so one durable
session can accumulate history and state forever. eve should recognize `/new` on those channels and
terminate the current session before the identity is reused.

Cancellation has two explicit scopes:

- **turn:** stop the active turn and its descendants; keep the entry session resumable;
- **session:** stop the entry session and its complete execution tree; the next message starts with
  empty history and authored state.

Slash commands are one consumer of a general cancellation API. The same semantics must be available
to the eve HTTP channel, TypeScript client, custom channels, higher-level channel handlers, session
callbacks, and evals.

## Implementation guardrails

- A raced hook may exist only inside a workflow that is guaranteed to terminate. Workflow replay
  does not reliably support a hook race in a non-terminating workflow, so `workflowEntry` must not
  own the cancellation hook or race. The terminating root `turnWorkflow` owns both.
- The channel `continuationToken` is not fresh per turn. It is the channel-owned session resume
  identity and may remain unchanged across every turn. Its cancellation hook token is a
  deterministic channel-owned variation, such as `${continuationToken}:cancel`, so channels such as
  Twilio can target cancellation without first receiving a token from an eve response.
- A later root turn may reclaim the same deterministic cancellation hook token only after the prior
  turn's hook disposal has completed. If Workflow does not make that dispose-before-reclaim ordering
  deterministic, eve must upstream the required guarantee rather than replace the channel-owned
  token with a workflow-generated identity.
- Only the root `turnWorkflow` in a cancellation tree creates and owns an `AbortController`, races
  its cancellation hook, and passes the controller's serializable `AbortSignal` through the full
  turn execution. A `turnWorkflow` entered through a subagent or recursive agent call accepts the
  inherited signal, creates no controller, and races no cancellation hook of its own.

## Authoring API

### eve HTTP channel

Expose one authenticated route:

`POST /eve/v1/session/:sessionId/cancel`

The body is a strict union with no default scope:

```json
{ "scope": "turn", "cancelToken": "<active-turn capability>" }
```

```json
{ "scope": "session", "continuationToken": "<current session capability>" }
```

The route authenticates first, then verifies that the capability belongs to `:sessionId`. Invalid
bodies return `400`; stale or mismatched capabilities return a non-disclosing `409`; accepted
cancellation returns `202`.

Every request that starts a turn returns the deterministic `cancelToken` alongside `sessionId` and
the current `continuationToken`. The token addresses whichever turn currently owns the derived hook
for that continuation; it does not cancel the entry session.

### TypeScript client

- `MessageResponse.cancel()` cancels the currently active turn for that response's continuation.
- `ClientSession.cancel()` cancels the current entry session.
- Both use the client's normal auth, headers, redirects, and error handling.
- Session cancellation clears the client's resumable cursor so a later send cannot accidentally
  target the cancelled entry.
- Aborting a request or stream with `AbortSignal` remains local transport cancellation; it does not
  request server-side cancellation.

### Channel authors

Custom `defineChannel` route handlers receive separate operations to:

- cancel the active turn using its session id and channel-local continuation token, with the
  operation deriving the deterministic cancel token;
- cancel a session using its channel-local continuation token;
- restart a session with replacement input after the old session releases its identity.

The operations own token namespacing and ordering. Authors do not call workflow APIs or manually
compose “cancel, then hope delivery starts fresh.”

Higher-level channel handlers can return a `reset-session` decision with auth, optional context, and
optional replacement content. This lets a Slack mention or direct-message handler request the same
behavior without receiving low-level route operations.

In-session callbacks and event subscribers use an explicit cancellation operation with a required
`turn` or `session` scope. Requesting cancellation exits normal authored execution; code after the
request must not continue.

### Evals

Evals expose first-class controls for cancelling an active turn and its entry session. An eval can
retain a cancellable handle while work is active, request cancellation, and continue observing the
resulting event boundary. Expected cancellation is assertable behavior, not an automatic eval
failure.

Eval cancellation uses the TypeScript client and public channel APIs. It must work for sessions
created by custom channels as well as the built-in eve channel.

## Semantics

### Turn cancellation

The cancel token is derived deterministically from the channel continuation token. While a root turn
is active, its cancellation hook binds that token to `(sessionId, turnId)`.

```text
TURN START

ClientSession.send()
`-- POST message
    `-- eve channel / runtime
        |-- resume entry session S1 through continuation C1
        |-- start turn T7
        |-- derive cancel token KC from C1
        |-- bind cancel hook KC -> (S1, T7)
        `-- return { sessionId: S1, continuationToken: C1, cancelToken: KC }
            `-- MessageResponse stores KC

TURN CANCEL

MessageResponse.cancel()
`-- POST /eve/v1/session/S1/cancel
    `-- { scope: "turn", cancelToken: KC }
        `-- eve channel / runtime
            |-- authenticate the request
            |-- resolve KC -> (S1, T7)
            |-- verify the URL session is S1
            |-- durably accept cancellation and return 202
            |-- cancel T7 and its descendants
            |-- dispose KC when T7 settles
            `-- keep C1 -> S1 and emit session.waiting
```

When T7 completes, fails, or is cancelled, its KC hook is disposed. A later turn for C1 may reclaim
KC only after that disposal is deterministic. KC therefore means “cancel the active turn for C1,”
not “cancel only T7”; holders must not treat it as an immutable historical-turn capability.

### Session cancellation

Session cancellation binds the current continuation token to the session id in the request. The
runtime releases the continuation before tearing down the tree; that release is the reset
linearization point.

```text
SESSION CANCEL

ClientSession.cancel() or authenticated /new handler
`-- request session cancellation for (S1, C1)
    `-- channel / runtime
        |-- verify C1 currently belongs to S1
        |-- mark S1 as closing
        |-- release C1 from S1  [reset linearization point]
        |-- acknowledge accepted cancellation
        |-- cancel the complete S1 tree
        |   `-- active turn
        |       |-- model and tools
        |       `-- local and remote delegates
        |-- wait for every branch to settle
        `-- emit session.cancelled and close S1

IDENTITY REUSE

Stable Telegram / Twilio identity R
`-- channel continuation C1
    |-- before reset: C1 -> S1
    |-- after release: C1 -> no active session
    `-- next message: C1 -> new session S2 with empty history and state

Old cleanup remains bound to S1.
`-- a stale request naming S1 cannot cancel S2, even though S2 reuses C1
```

For bare `/new`, the flow ends after S1 is cancelled. For `/new <message>` or `/new` with an
attachment, restart waits for the release barrier and creates S2 with that replacement content.

### Runtime guarantees

- Cancellation follows ownership from entry session → turn → tools and delegated agents, including
  remote descendants.
- A cancelling session cannot accept input, launch work, or reclaim its continuation.
- Cooperative abort reaches models, tools, sandboxes, and delegates; the runtime remains responsible
  for terminating work that does not cooperate.
- Late descendant results cannot resume a cancelled ancestor or mutate a replacement session.
- Turn cancellation emits `turn.cancelled` and then ends at `session.waiting`; session cancellation
  ends at `session.cancelled`.
- Cancellation is intentional control flow and does not trigger generic user-facing failure output.
- Completed external side effects remain recorded and are not rolled back.

## `/new` behavior

Telegram and Twilio expose:

```ts
resetCommands?: false | readonly string[];
```

- omitted: `['new']`;
- `false`: disabled;
- array: replace the default names.

Inbound handling verifies the provider request and runs authored gating/auth before matching the
command. A `null` authored result drops the input without cancellation.

- Bare `/new` silently cancels the session and creates no empty workflow.
- `/new <message>` starts a fresh session with the stripped message.
- Telegram attachments on `/new` belong to the fresh session.
- `/new@botname` matches only the configured Telegram bot.
- Prefixes such as `/newspaper`, unknown commands, and disabled commands remain normal model input.
- The command itself is never added to history and successful reset sends no confirmation.
- Slack has no default reset command; authors opt in through their inbound handler.

## Delivery and verification

Implementation must cover the HTTP contract, cancellation outcomes and events, ownership-tree
propagation, TypeScript client, eval driver, custom-channel operations, Telegram and Twilio `/new`,
docs, and a patch changeset.

Add a new `e2e/fixtures/agent-cancellation` fixture. Its custom `defineChannel` must use only public
channel APIs—no runtime/workflow imports and no proxy through the built-in eve cancellation route.
The fixture includes independent evals for:

- **turn cancellation:** cancel active work, observe the turn boundary and `session.waiting`, then
  prove a follow-up resumes the same session and context;
- **session cancellation:** cancel active work, observe `session.cancelled`, reuse the same channel
  identity, then prove the new session id, history, and authored state are fresh.

The evals use the new eval cancellation controls, assert events and identities directly, work
locally and against deployed targets, and require no external service beyond model credentials.

Also cover malformed/scoped HTTP requests, auth before capability inspection, stale tokens, command
parsing, attachments, duplicate cancellation, delivery/completion races, nested local and remote
delegates, client cursor updates, and the distinction between `AbortSignal` and server cancellation.

Run the repository's required unit, integration, scenario, typecheck, lint, format, invariant, docs,
and build checks, plus:

```sh
cd e2e/fixtures/agent-cancellation
pnpm exec eve eval --strict
```
