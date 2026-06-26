---
issue: https://github.com/vercel/workflow/issues/2376
last_updated: "2026-06-26"
status: implemented
---

# Replay-resilient client streams

## Summary

Workflow provides at-least-once step execution. A concurrent or late replay can append another copy
of a step's events to eve's durable session stream. eve keeps that physical append log for durability
and diagnostics, while the TypeScript client exposes each stable event ID once.

This is an observable-delivery guarantee. Tools, hooks, callbacks, and other external effects can
still execute more than once and retain their domain idempotency requirements.

## Failure model

`startIndex` is a physical append offset. Treating the next session boundary as the current turn's
boundary lets a late replayed `session.waiting` terminate a later `send()`. Payload hashes and turn
watermarks are unsafe substitutes for identity: payloads can legitimately match, and delayed events
can intentionally refer to an earlier turn.

```text
physical stream                         logical client stream

step A / event 0 ---------------------> expose
step A / event 1 ---------------------> expose
step A / event 0 (replay) ------------> drop: exact ID already seen
step A / event 1 (replay) ------------> drop: exact ID already seen
step B / event 0 ---------------------> expose
```

## Event identity

Every event-producing `"use step"` reads Workflow's `getStepMetadata().stepId`. A local ordinal starts
at zero for that step execution and advances once per emitted event:

```text
eventId = workflowRunId + stepId + eventOrdinal
```

Workflow reuses `stepId` when it re-executes the same durable step; only `attempt` changes. The
workflow run ID namespaces steps because eve executes turns in child workflow runs. The same emission
order therefore reproduces the same event IDs, while a distinct run, step, or event ordinal cannot
collide. The ordinal is step-local and never enters durable session state.

Turn coordinates already carried by individual event payloads are not part of duplicate detection.
Two events with different IDs are distinct even when their payloads and turn coordinates are
identical.

## Client semantics

`ClientSession` owns one set of exposed event IDs. For every physical event it:

1. advances `streamIndex`;
2. exposes the event when `meta.eventId` is absent;
3. exposes and records a previously unseen `meta.eventId`;
4. hides an ID already in the set.

No event type, payload, timestamp, boundary, sequence, or turn ID can cause an unseen event to be
hidden. `MessageResponse`, attached streams, evals, and frontend stores all inherit this behavior from
`ClientSession`.

The serializable `SessionState.seenEventIds` retains the ID set across reconnects and process
restarts. A state without `seenEventIds` starts with an empty set rather than inferring identity from
events before its physical cursor. Retaining IDs grows with the session, which is the cost of
recognizing an arbitrarily late replay without probabilistic filtering or false positives.

## Invariants

- Every physical event advances the physical cursor exactly once.
- The same stable event ID is exposed at most once per restored client cursor.
- Every previously unseen ID is exposed.
- Events without IDs are always exposed.
- Identical payloads with different IDs are preserved.
- Filtering never makes external side effects exactly once.

## Verification

Unit coverage exercises same-step replay, distinct step IDs, step-local ordinals, concurrent duplicate
copies, late full-turn replay, reconnect restoration, missing prior state, conflicting data under one
ID, and mismatched turn coordinates under distinct IDs. The existing sequential, concurrent,
subagent, and HITL Workflow evals exercise the behavior end to end in CI.
