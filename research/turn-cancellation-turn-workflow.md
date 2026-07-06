---
issue: https://github.com/vercel/eve/issues/483
status: complete
last_updated: "2026-07-06"
---

# Turn cancellation, layer 1: turn-workflow ownership

## Summary

Layer 0 (#494) made the harness honor an `AbortSignal` end to end but left
`TurnStepInput.abortSignal` unpopulated. Layer 1 makes the turn cancellable
in-process: the turn-owned `turnWorkflow` registers a durable per-turn cancel
hook and a durable `AbortController`, and resuming the hook mid-turn settles
the turn as `turn.cancelled` → `session.waiting` — never as a failure. No
HTTP route, client API, or channel surface exists yet (layer 2); the only
trigger is resuming the cancel hook, which tests do directly.

## Cancellation semantics (as shipped)

- **Trigger**: `resumeHook("${completionToken}:cancel", {})`. The completion
  token is already per-turn indexed (`{sessionId}:turn-control:{n}`), so the
  cancel token needs no new discovery machinery in this layer; layer 2 owns
  resolving it from a session id. The hook payload carries no caller-supplied
  reason: layer 1 uses one canonical cancellation reason (the layer-0
  `TurnCancelledError`), and caller reasons arrive with the trigger surface
  in layer 2.
- **Cancel during model/tool work**: the durable signal (threaded through
  `TurnStepInput.abortSignal`, the layer-0 seam) aborts the in-flight harness
  work in real time. The turn settles with `turn.cancelled` followed by
  `session.waiting` on the session stream (stream version 17), and the
  session accepts the next message normally.
- **Cancel is not failure.** A cancelled turn never emits `turn.failed`,
  `step.failed`, or `session.failed`, and the aborted `turnStep` is never
  retried as a failure. Pinned by tests; this is the invariant that leaked
  in #347.
- **Cancel during an in-line runtime-action wait** (subagent / dynamic
  workflow results): the wait stops and the turn settles cancelled the same
  way. The pending runtime-action batch and workflow interrupt are dropped
  at settle time (their tool-call exchange lives inside the batch and never
  reached history; replaying them would re-dispatch the actions).
  Descendants are _not_ cascaded to (layer 3); their late results land on
  the dead turn inbox and are dropped.
- **Cancel after the turn settled (or before it starts)**: benign no-op.
  Duplicate cancels _after_ the settle are no-ops. Same-instant duplicates
  are the trigger's concern: layer 2 must single-flight cancel resumes per
  turn (see "Runtime findings" below).
- **Partial content is kept.** Whatever the harness emitted before the abort
  stays on the stream, and durable history persists exactly what the harness
  had settled at abort time — no rollback, no synthesis.
- **Parked sessions cannot be cancelled** in this layer: parking terminates
  the turn workflow, so there is no turn to cancel. The session-scoped story
  stays in `research/channel-session-reset.md`.
- **The legacy (non-turn-inbox) workflow path is untouched.**

## Data flow (as shipped)

```text
test / (layer 2 route)          resumeHook(`${completionToken}:cancel`)
        │
turnWorkflow                    execution/turn-workflow.ts
  control = createTurnCancellationControl(completionToken)
        │  the hook-read continuation aborts the durable controller —
        │  replay-deterministic (keyed to the hook_received event), no
        │  promise race decides whether abort() runs
        ▼
  turnStep (awaited plainly)    execution/workflow-steps.ts
    harness aborts (layer 0) → TurnCancelledError
    → returns { action: "cancelled" }   pure marker, no side effects
        │
  cursor.finish(…, { cancelled: true, kind: "park" })
        │                       park arm reused: new NextDriverAction arms
        │                       break pinned drivers; optional fields don't
        ▼
workflowEntry driver            execution/workflow-entry.ts
  settleCancelledTurnStep       execution/settle-cancelled-turn-step.ts
    emits turn.cancelled → session.waiting, clears pending batch/interrupt,
    persists the between-turns session; in-process single-flight
  then the normal park playbook: rekey, await the next message
```

Within `waitForRuntimeActionResults`, the inbox read is raced against the
cancel-hook read; a cancel releases any raced public delivery back to the
driver (`turn-delivery-cancelled`) and loops into one final `turnStep`,
which observes the aborted signal at entry (before the park-resume stages,
which would otherwise re-park on the still-pending batch) and settles
through the same cancelled arm.

## Where the shipped design deviates from the proposal

Integration against the real runtime (vendored `@workflow/core`
5.0.0-beta.26) surfaced behaviors that reshaped the epilogue path:

1. **No workflow-side race; abort in the hook-read continuation.** Whether a
   `Promise.race` resolves `cancel`-first is not stable across replays, and
   the durable `abort()` writes a hook event — reaching it conditionally
   corrupts the event log (observed as `REPLAY_DIVERGENCE` →
   `CorruptedEventLogError`). The abort now fires in the `.then` of the
   cancel-hook read itself, keyed to the `hook_received` event.
2. **`turnStep`'s cancelled result is a pure marker.** The runtime can
   supersede an aborted step attempt and re-dispatch it under the same
   correlation id, with both attempts running to completion in-process
   (at-least-once inline execution). Any cancel-path side effect inside
   `turnStep` — including the epilogue — can therefore duplicate.
3. **The epilogue runs in the _driver_, not the turn run.** Queued
   cancel-payload and abort-hook wakes re-dispatch in-flight steps of the
   turn run; the driver's wake sources exclude the cancel hook. The driver
   recognizes `park` + `cancelled: true` and runs `settleCancelledTurnStep`
   before the normal park playbook. (Old pinned drivers ignore the marker
   and simply park — harmless, since no cancel trigger predates them.)
4. **Turn control hooks are disposed one turn late.** The turn run's final
   control send is at-least-once; a late duplicate resume on a _disposed_
   hook is accepted and logged by the world and then diverges the driver's
   replay. `dispatchAndAwaitTurn` now returns a deferred `dispose()` that
   the driver invokes when the _next_ turn settles (or the session ends),
   by which time the previous turn's run has completed and cannot re-send.
5. **The settle step is single-flighted in-process.** A wake landing while
   the settle step is in flight can re-dispatch it; racing attempts share
   the process, so a module-level single-flight keyed by
   `{sessionId}:turn-cancelled:{sequence}` collapses them. A distributed
   re-execution (crash recovery on another instance) can still duplicate
   the epilogue; see upstream notes.

## Runtime findings (candidate upstream issues)

Observed against `@workflow/world-local` during integration testing, all
reproducible via the layer-1 test suite before the mitigations above:

- **At-least-once inline step execution under wakes**: a workflow wake that
  lands while a step is in flight can re-dispatch the step under the same
  correlation id; both attempts run and both flush side effects (only one
  `step_completed` is recorded). Complement to workflow#2777/#2778.
- **Resume-after-dispose corrupts replay**: `resumeHook` on a disposed hook
  is accepted and journaled (`hook_received` after `hook_disposed`), and the
  owning run's next replay diverges (`REPLAY_DIVERGENCE`, escalating to
  `CorruptedEventLogError`).
- **Replay-conditional `abort()`**: durable `AbortController.abort()` must
  be reached deterministically on every replay; gating it on a race winner
  or on live `signal.aborted` state corrupts the event log or re-fires the
  abort hook.

Because of the first two, layer 2's cancel trigger must single-flight
cancel resumes per turn (resume the hook at most once; treat "already
resumed/disposed" as success).

## Invariants (pinned by tests)

1. An aborted `turnStep` settles by return value; no thrown cancellation
   crosses the step boundary — the turn workflow run records no
   `step_failed`/`step_retrying` events and at most one `step_completed`
   per correlation id.
2. `turn.cancelled` is emitted exactly once per cancelled turn, always
   followed by `session.waiting`; zero failure events on the cancelled path;
   the aborted tool executes exactly once; the cancelled turn streams
   exactly one `step.started`.
3. The cancel hook token is never reused: one hook per turn workflow run,
   derived from the already-indexed completion token.
4. A cancelled subagent wait is not re-dispatched: the next turn runs
   normally with no `subagent.called`.
5. With no cancel resumption, behavior is unchanged (all pre-existing unit
   and integration suites pass).

## Testing

- **Integration** (`execution/turn-cancellation.integration.test.ts`): real
  `workflowEntry` + `turnWorkflow` over world-local with a hanging
  `wait_for_cancel` tool; covers mid-tool cancel + follow-up turn, cancel
  during an in-flight subagent wait (via the mock model's
  `Delegate to a subagent: …` directive) + no re-dispatch, late/duplicate
  cancel no-ops, and the no-retry canary.
- **Unit**: cancelled-turn arm of `turnWorkflow` (park + `cancelled` marker,
  `canPark` bypass, signal threading), deferred control-hook disposal,
  `emitCancelledTurn` (event order, turn-id reconstruction, state advance),
  `createTurnCancelledEvent`, stream-version pin (17).
- **E2E stays shelved** until layer 2 provides an HTTP trigger.

## Out of scope

- `POST /eve/v1/session/:id/cancel`, cancel-token discovery from a session
  id, caller-supplied cancellation reasons, channel/client/eval APIs
  (layers 2 and 4).
- Descendant cascade — local subagent inbox propagation and remote cancel
  (layer 3). Layer 1 only discards their late results.
- Cancelling parked sessions or session-scoped cancellation
  (`research/channel-session-reset.md`).
- The legacy non-turn-inbox workflow path.

## Delivery

Shipped in one PR with a **patch** changeset (additive `turn.cancelled`
protocol event, stream version 16 → 17; no breaking public API). Scope
decisions settled at review: the runtime-action wait arm is **in**, and the
cancellation reason is canonical-only until layer 2.
