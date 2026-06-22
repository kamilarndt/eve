---
title: "Sessions, Turns, and Steps"
description: "The three durable scopes in eve and the identifiers used at their boundaries."
---

Three scopes explain nearly every runtime behavior in eve. A session is the durable conversation, a
turn is one inbound message and its work, and a step is the checkpoint eve can safely replay or
resume around.

| Scope   | Lifetime                                                   | Contains                                                 |
| ------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Session | A durable conversation or task, often across many requests | Turns, session state, sandbox state, and history         |
| Turn    | One inbound message and the work it triggers               | Model steps, tool calls, subagent calls, and input waits |
| Step    | One durable unit inside a turn                             | A model call or framework-managed execution boundary     |

The public protocol identifies the durable conversation with `sessionId`. Internal workflow implementations may use their own run identifiers; do not expose those as substitutes for `sessionId` in clients or application APIs.

## Session handles

An HTTP client normally carries three values:

- `sessionId` selects the durable session and its event stream.
- `continuationToken` proves the client is responding to the session's current wait point.
- `streamIndex` records the last consumed event for reconnection.

The continuation token advances with the session. A stale token is rejected so an old approval, question response, or follow-up cannot resume the wrong wait point. Persist the three values together when a client must survive reloads.

## Turns are sequential by contract

For deterministic chat behavior, send one turn and wait for the next `session.waiting` boundary
before sending another message to that session. We keep turns sequential because model and tool
outputs from one turn become history for the next. The continuation mechanism is not a general
durable FIFO queue for bursts of user messages. A channel that accepts concurrent messages should
queue them in its own application layer.

Different sessions can run independently.

## Steps and side effects

Completed steps are recorded and replayed. A step interrupted before completion may run again. Any external side effect—payment, email, mutation, or message—must therefore be idempotent. Human approval controls intent but does not replace an idempotency key at the destination.

One turn often uses several model calls: the first call may choose tools, later calls read their results, a subagent may run its own model, and context compaction may use another call. Plan provider limits and cost around steps, not message count alone.

## Waiting and resumption

Approval, `ask_question`, and interactive authorization can park a turn. The workflow holds no active request while waiting. A client later submits the requested input with the current continuation token, and the turn resumes at the parked step.

For wire formats and complete event payloads, use the [HTTP API](../reference/http-api) and [Stream Events](../reference/stream-events) references. For storage and retry behavior, continue with [Execution and Durability](./execution-and-durability).
