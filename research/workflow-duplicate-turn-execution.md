---
issue: https://github.com/vercel/eve/pull/358
last_updated: "2026-06-26"
status: observed
---

# Duplicate turn execution after completed workflow turn

## Summary

An eve workflow stress run executed the same logical turn twice. The first execution emitted
`turn.completed` and `session.waiting`; 1.1 seconds later, another physical Workflow step emitted
the same turn from the same stale session snapshot. The next client request consequently received
the previous turn's result.

This does not by itself show an unstable Workflow step ID. It shows two physical child-step
invocations for one logical delivery, each with a different step ID. The suspected platform issue
is duplicate child workflow start or delivery after the first child completed.

## Environment

- `@workflow/core`: `5.0.0-beta.24`
- `@workflow/world`: `5.0.0-beta.13`
- eve version: `0.15.5`
- root workflow run: `wrun_01KW2RNM8WKSCFY9WFZV39H8Z6`
- commit: `3b08420109483ee7ada57d4f87292cecf70d2b2a`
- [GitHub Actions job](https://github.com/vercel/eve/actions/runs/28262355433/job/83740747912)
- [eval artifacts](https://github.com/vercel/eve/actions/runs/28262355433/artifacts/7915332114)

The fixture uses eve's deterministic mock model, so the repeated reply was not model-provider
nondeterminism.

## Observed timeline

The first execution of logical turn 30 completed normally:

```text
20:07:46.793  turn.started      sequence=29 turnId=turn_29
20:07:46.793  message.received  sequential-turn-030
20:07:46.991  message.completed stress-ack:30:sequential-turn-030
20:07:47.211  turn.completed    sequence=29 turnId=turn_29
20:07:47.212  session.waiting
```

After that terminal boundary, the same logical turn executed again:

```text
20:07:48.345  turn.started      sequence=29 turnId=turn_29
20:07:48.346  message.received  sequential-turn-030
20:07:48.553  message.completed stress-ack:30:sequential-turn-030
20:07:48.731  turn.completed    sequence=29 turnId=turn_29
20:07:48.734  session.waiting
```

The eval captured 31 `turn.started`, 31 `message.received`, and 31 `session.waiting` events, but
only 30 unique logical turns. `turn_29` with input `sequential-turn-030` was the only duplicate.
When the client sent turn 31, it received:

```text
expected: stress-ack:31:sequential-turn-031
actual:   stress-ack:30:sequential-turn-030
```

## Evidence of separate child-step invocations

At the time, eve computed each event ID as:

```text
SHA256(turnStep stepId + canonical event payload + payload occurrence)
```

Corresponding events had identical payloads and occurrence numbers but different IDs. For example:

```text
first turn.started:  evt_Jq3tKXxg_O1-FGhjWxsxfelX2kVR29_Mn28J0ov9OEY
second turn.started: evt_WyeGsRsURNmepYlNxYfyyWOlwUnrep0OVegqq8PCIGQ
```

Given that construction, the child `turnStep` step IDs must have differed. This is consistent with
Workflow's documented guarantee: a step invocation keeps its ID across attempts, while separate
invocations receive separate IDs. It does not establish whether the parent `dispatchTurnStep` ID
was stable or changed.

## Execution boundary

```text
workflowEntry (long-lived root run)
  -> dispatchTurnStep (Workflow step)
    -> start(turnWorkflow, serialized turn input)
      -> turnStep (Workflow step)
        -> writes turn events to the root durable stream
```

The duplicate event blocks indicate that `turnStep` ran twice with the same serialized session
state and delivery. One plausible failure mode is that `dispatchTurnStep` or its `start()` side
effect was replayed after an ambiguous completion, creating two child workflow runs. The second
execution began only after the first child had emitted `session.waiting`; a completion-token hook
that prevents concurrent ownership may already have been disposed by then.

The artifacts do not expose the child workflow run IDs, so duplicate child starts versus another
source of duplicate invocation remains an inference. The Workflow service logs should be checked
for child starts under the root run around `20:07:46–20:07:49Z`.

## Questions for the Workflow team

1. Is `start()` idempotent across retries or replays of the containing step?
2. Can a successful step be delivered again after its child start commits but before its result is
   durably acknowledged?
3. Can one hook payload produce two workflow-body invocations with the same serialized input?
4. Is there a stable child-start idempotency key that survives separate physical step invocations?
5. Can observability expose the parent step ID, child run IDs, and start correlation for this root
   run so the duplicate boundary can be identified precisely?

## eve mitigation

PR #358 now derives stream event IDs from eve's logical session ID and turn sequence rather than
the physical Workflow step ID. The TypeScript client suppresses repeated logical IDs while still
advancing its durable stream cursor. This prevents consumers from observing the duplicate but does
not prevent duplicated model calls, tool execution, or child workflow work at the platform layer.
