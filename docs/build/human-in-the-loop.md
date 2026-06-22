---
title: "Human-in-the-loop"
description: "Pause a durable turn for tool approval or an answer, then resume from the same step."
---

Use human-in-the-loop (HITL) when the agent needs a person's intent before it can continue. eve
parks the turn durably rather than holding an HTTP request or process open, so the session can wait
through a restart and resume from the same step when the person responds.

There are two forms:

- A tool requests approval before it executes.
- The built-in `ask_question` tool asks for information or a choice.

## Require tool approval

Use the callbacks from `eve/tools/approval`:

```ts title="agent/tools/refund_charge.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({
    chargeId: z.string(),
    amount: z.number().positive(),
  }),
  needsApproval: always(),
  async execute(input) {
    return refundCharge(input);
  },
});
```

| Helper     | Behavior                                                          |
| ---------- | ----------------------------------------------------------------- |
| `never()`  | Do not ask. This is the behavior when `needsApproval` is omitted. |
| `once()`   | Ask until this tool has been approved once in the session.        |
| `always()` | Ask before every call.                                            |

Use a predicate when the input determines the risk:

```ts
needsApproval: ({ toolInput }) => (toolInput?.amount ?? 0) > 1_000,
```

The predicate receives `toolName`, `toolInput`, and the session's `approvedTools` record. It runs
before `execute`.

> **Security consequence:** Approval records a person's intent; it is not an idempotency key. The
> external API must still reject duplicate charges, messages, or other side effects if an
> interrupted step runs again.

## Ask a question

`ask_question` is available without authored code. The model calls it with:

```ts
{
  prompt: string;
  options?: Array<{ id: string; label: string }>;
  allowFreeform?: boolean;
}
```

Channels translate this request into their native controls when supported. A plain HTTP client reads
the pending request from `input.requested` and submits an `inputResponses` array.

## Protocol

Both forms use the same sequence:

1. eve emits `input.requested` with one or more request IDs.
2. The turn reaches `session.waiting`.
3. A client or channel submits `inputResponses` with the current `continuationToken`.
4. The durable turn resumes at the parked step.

The exact request and response schemas are in the [HTTP API](../reference/http-api); event payloads
are in [Stream Events](../reference/stream-events). Frontend bindings expose pending requests through
their reduced message state.

Require approval or an equivalent policy for sensitive, irreversible, regulated, financial,
healthcare, employment, housing, legal, safety-impacting, or external side-effecting actions.
