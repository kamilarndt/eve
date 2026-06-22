---
title: "Execution and Durability"
description: "How an eve session runs. Durable conversations, turns that checkpoint at steps, and parked work that resumes later."
---

Agents spend much of their time waiting: for a model, a tool, a person, an OAuth callback, or a
subagent. We make the conversation durable so none of those waits requires one server process to
stay alive. With workflow storage available, a session can run for days and resume after a crash or
redeploy.

## Sessions, turns, and steps

Work nests in three levels:

- **session**: the whole durable conversation or task. It's long-lived and can span many requests over days or weeks without losing context.
- **turn**: one user message and all the work it triggers (model calls, tool calls, reasoning) until the agent produces its response.
- **step**: a durable checkpoint inside a turn (one model call and the tool calls it makes).

Every turn runs as a durable workflow, built on the open-source [Workflow SDK](https://workflow-sdk.dev/) (Vercel Workflow when you deploy on Vercel). eve checkpoints progress and serializes durable state at each step boundary. Your code runs inside a managed step, so tools, the sandbox, and subagents feel synchronous even though the session underneath them is durable.

The Workflow SDK is not inherently tied to Vercel. In local development and in a self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists workflow runs on disk, normally under `.workflow-data`, and dispatches through the same Nitro-hosted workflow routes. On Vercel, the same workflow code runs against Vercel Workflow instead, which adds platform features such as latest production deployment routing and dashboard run metadata.

Nitro hosts the HTTP routes and workflow entrypoints. It does not supply the workflow state store or the sandbox runtime. Those are separate adapters: Workflow uses the active world implementation, and Sandbox uses the backend from `agent/sandbox` or `defaultBackend()`.

For advanced self-hosted deployments, the root `agent.ts` can select the installed Workflow world package to use with `experimental.workflow.world`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

The world package backs workflow state, queues, hooks, and streams. Keep secrets and deployment-specific options in runtime environment variables read by that package, not in `agent.ts`. See [`agent.ts`](../build/agent-config#workflow-world) and [Workflow Worlds](https://workflow-sdk.dev/worlds).

## Resuming after a crash

Crash the process, hit a timeout, or redeploy mid-turn, and the run picks up from the last completed
step rather than replaying the whole turn. We replay recorded results so completed work does not run
again. A step interrupted mid-execution does re-run, so make side effects such as charges or emails
idempotent and gate sensitive ones with approval.

There's nothing to configure. eve owns the workflow lifecycle, and sessions are durable by default.

You don't write workflow code directly. Workflow primitives are an implementation detail of eve's runtime layer. Authored callbacks read metadata through `ctx.session`, and [`defineState`](../build/state) reads or writes session-scoped durable state. See [Runtime Context](../build/runtime-context) for the exact API.

## Parked work

Some work has to wait, including a human approving a [tool](../build/tools), an interactive OAuth sign-in for a [connection](../connect/connections), or a child [subagent](../build/subagents). At those points the turn parks durably. The workflow suspends and holds no compute until the awaited input arrives.

## Message delivery and queueing

eve does not maintain a durable FIFO queue of user messages for a session. The `continuationToken` is a resume handle for the session's current workflow hook, not a general message-queue address.

When a session is waiting, a delivery to the current continuation token wakes the session and starts the next turn. When a turn is already active, the hook may accept additional deliveries, but the runtime only drains them at specific workflow boundaries. If more than one delivery is ready when the driver checks, eve may fold them into the next turn; that drain is best-effort and depends on workflow and transport timing.

> **Current limitation:** Concurrent sends to one session do not behave like a durable ordered chat
> queue. For deterministic behavior, send one turn at a time and wait for `session.waiting`. If your
> channel accepts bursts, keep a per-session queue in the channel or application layer, then deliver
> the next message after the session parks again. Separate sessions still run independently.

## Subagents

A turn can hand work off to a [subagent](../build/subagents). Each subagent gets its own context and durable child session; a declared subagent also gets its own sandbox, skills, and state. Nothing crosses the boundary implicitly.

## How eve orders session history

Conversation history within a session is append-only. Turns land in order, and the tool calls inside a turn (plus their results) keep their order too. Read a session back and you see events in the order they happened.
