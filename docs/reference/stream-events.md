---
title: "Stream Events"
description: "Complete event vocabulary emitted by eve session streams."
---

The session stream is NDJSON. Every line is a `HandleMessageStreamEvent` exported from `eve/client`. Events can include `meta.at`, the original ISO timestamp recorded with the durable event.

Fields shared by turn work have stable meanings:

- `turnId` identifies one turn within the session.
- `sequence` is the turn sequence number.
- `stepIndex` identifies a model step within the turn.
- `callId` identifies one tool or subagent call.

## Session and turn lifecycle

| Event               | `data` fields                                       | Meaning                                                                     |
| ------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `session.started`   | `runtime?`, `invocation?`                           | Durable session created. Child sessions include parent invocation metadata. |
| `turn.started`      | `turnId`, `sequence`                                | Turn began.                                                                 |
| `message.received`  | `message`, `turnId`, `sequence`                     | Normalized user message accepted. File parts appear as text placeholders.   |
| `turn.completed`    | `turnId`, `sequence`                                | Turn ended successfully.                                                    |
| `turn.failed`       | `code`, `message`, `details?`, `turnId`, `sequence` | Turn failed.                                                                |
| `session.waiting`   | `wait: "next-user-message"`                         | Session parked for a follow-up or pending input.                            |
| `session.completed` | none                                                | Session reached a successful terminal boundary.                             |
| `session.failed`    | `sessionId`, `code`, `message`, `details?`          | Session reached a terminal failure.                                         |

Client turn aggregation stops at `session.waiting`, `session.completed`, or `session.failed`.

## Model steps and content

| Event                 | `data` fields                                            | Meaning                                                                |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `step.started`        | `turnId`, `sequence`, `stepIndex`                        | Model call started.                                                    |
| `message.appended`    | `messageDelta`, `messageSoFar`, turn and step fields     | Incremental assistant text.                                            |
| `message.completed`   | `message`, `finishReason`, turn and step fields          | One assistant text block completed. May occur more than once per turn. |
| `reasoning.appended`  | `reasoningDelta`, `reasoningSoFar`, turn and step fields | Incremental reasoning content when provided.                           |
| `reasoning.completed` | `reasoning`, turn and step fields                        | Reasoning block completed.                                             |
| `result.completed`    | `result`, turn and step fields                           | Structured output satisfying the requested schema.                     |
| `step.completed`      | `finishReason`, `usage?`, turn and step fields           | Model step completed.                                                  |
| `step.failed`         | `code`, `message`, `details?`, turn and step fields      | Model step failed.                                                     |

`finishReason` is `content-filter`, `error`, `length`, `other`, `stop`, or `tool-calls`. `tool-calls` is the non-terminal model-loop outcome. Usage may include `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`.

Reasoning content can contain sensitive or provider-specific information. Decide explicitly whether to render, store, export, or redact it.

## Tools and human input

| Event               | `data` fields                                      | Meaning                                                                         |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `actions.requested` | `actions`, turn and step fields                    | Model requested one or more tool actions. Multiple actions may run in parallel. |
| `action.result`     | `result`, `status`, `error?`, turn and step fields | One action completed, failed, or was rejected.                                  |
| `input.requested`   | `requests`, turn and step fields                   | Tool approval or `ask_question` needs user input.                               |

`action.result.data.status` is `completed`, `failed`, or `rejected`. Rejected means policy or a user denied the call; the tool did not execute.

Each input request contains:

```ts
interface InputRequest {
  requestId: string;
  prompt: string;
  action: RuntimeToolCallActionRequest;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
    style?: "primary" | "danger" | "default";
  }>;
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
}
```

Submit `{ requestId, optionId?, text? }` through the follow-up route with the current continuation token.

## Subagents

| Event                | `data` fields                                                                                              | Meaning                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `subagent.called`    | `callId`, `childSessionId`, `sessionId`, `name`, `toolName`, `turnId`, `sequence`, `workflowId`, `remote?` | Parent created a durable child session. |
| `subagent.started`   | `callId`, `subagentName`                                                                                   | Inline subagent execution started.      |
| `subagent.event`     | `callId`, `subagentName`, `event`                                                                          | Wraps one inline child event.           |
| `subagent.completed` | `callId`, `subagentName`, `output`                                                                         | Inline subagent completed.              |

For a durable child, subscribe to `childSessionId` to see its complete stream. Do not infer the child ID from an internal workflow ID.

## Compaction

| Event                  | `data` fields                                                    | Meaning                              |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `compaction.requested` | `modelId`, `sessionId`, `turnId`, `sequence`, `usageInputTokens` | Context compaction started.          |
| `compaction.completed` | `modelId`, `sessionId`, `turnId`, `sequence`                     | Compact history checkpoint recorded. |

Compaction can add a model call to a user turn.

## Connection authorization

| Event                     | `data` fields                                                                | Meaning                                |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| `authorization.required`  | `name`, `description`, `authorization?`, `webhookUrl?`, turn and step fields | A connection needs user authorization. |
| `authorization.completed` | `name`, `outcome`, `reason?`, `authorization?`, turn and step fields         | Authorization resolved.                |

An authorization challenge can include `url`, `userCode`, `expiresAt`, `instructions`, and `displayName`. Outcome is `authorized`, `declined`, `failed`, or `timed-out`.

## Consumer rules

- Preserve event order.
- Deduplicate replayed events by stream index, not timestamp.
- Treat unknown future event types as ignorable unless your application requires strict version matching.
- Use `message.completed.data.finishReason` before treating an assistant block as the final reply.
- Surface `step.failed`, `turn.failed`, and `session.failed` distinctly in diagnostics.
- Reconnect with the number of events already processed.
