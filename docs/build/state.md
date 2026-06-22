---
title: "State"
description: "Durable per-session memory with defineState: get() and update(), persisted across step boundaries."
---

Use `defineState` for working memory that belongs to one conversation: a running budget, glossary,
checklist, or plan. It is a typed, named slot that survives workflow step boundaries, crashes,
redeploys, and days-long sessions. It is not the right store for account data or anything that must
be shared across sessions.

```ts
import { defineState } from "eve/context";

const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

Pass `defineState(name, initial)` a stable string `name` (namespace it to your agent) and an `initial` function that produces the starting value the first time the slot is read. You get back a `StateHandle<T>`:

- `get()`: read the current value. Returns `initial()` on first access within a context.
- `update(fn)`: replace the value with `fn(current)`.

Declare the handle once at module scope and import it wherever you read or write the slot. Use it from inside a tool, hook, or other framework-managed runtime code:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

export const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

```ts title="agent/tools/spend.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { budget } from "../lib/budget.js";
import { runQuery } from "../lib/warehouse.js";

export default defineTool({
  description: "Run a query, counting it against the session budget.",
  inputSchema: z.object({ sql: z.string() }),
  async execute({ sql }) {
    const { count, cap } = budget.get();
    if (count >= cap) throw new Error("Query budget exhausted for this session.");
    budget.update((s) => ({ ...s, count: s.count + 1 }));
    return runQuery(sql);
  },
});
```

`get()` and `update()` require an active eve context. Calling them outside tools, hooks, or framework-managed code throws.

## Reset state between turns

State is durable by default and does not reset between turns. If you want a clean slate every turn, overwrite it from a lifecycle [hook](./hooks) on `turn.started`:

```ts title="agent/hooks/reset-budget.ts"
import { defineHook } from "eve/hooks";
import { budget } from "../lib/budget.js";

export default defineHook({
  events: {
    async "turn.started"() {
      budget.update(() => ({ count: 0, cap: 25 }));
    },
  },
});
```

The hook imports the same module-scope `budget` handle as the tool, so both read and write the same slot.

## State is never shared with subagents

Every [subagent](./subagents) starts with its own fresh state, whether it's a built-in `agent` copy or a declared specialist. `defineState` values never cross the parent/child boundary, even when the child is a copy of the same agent.

## State vs. connection-side storage

`defineState` lives and dies with the session. We scope it this way so a session can resume without
turning eve's workflow store into an application database. Anything that must outlive the session,
be shared across sessions or users, or be queried independently of a turn belongs in an external
store, either a [connection](../connect/connections) or your own database.
