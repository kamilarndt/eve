---
title: "Dynamic Workflows"
description: "Run model-authored subagent programs as one durable step or an app-owned recurring workflow."
---

The experimental `Workflow` tool lets the model write JavaScript that coordinates the agent's own subagents as a single durable step. A configured `ExperimentalWorkflow` can run the same kind of saved program repeatedly from application-owned state. Programs can run subagents in sequence, feed one result into the next, fan out over a list, and combine the results.

A single turn can already call several subagents, and parallel tool calls dispatch concurrently. What a workflow adds is _programmatic_ coordination. The program decides how many subagents to run based on an earlier result, which output feeds which call, and how to combine everything. That is logic the model cannot express as a few one-off calls.

## Enable the Workflow tool

Re-export the opt-in marker as the default export of `agent/tools/workflow.ts`. The marker name carries the "experimental" warning, but the tool the model actually sees is named `Workflow`.

```ts title="agent/tools/workflow.ts"
export { ExperimentalWorkflow as default } from "eve/tools";
```

Without that file, the `Workflow` tool stays off. It earns its keep only when the agent has subagents (or the built-in `agent`) worth coordinating:

```ts title="agent/subagents/analyst/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Analyzes one metric: queries, computes, writes a short finding.",
  model: "anthropic/claude-opus-4.8",
});
```

## Run app-owned persistent workflows

The same opt-in is callable when the application needs to persist a model-authored program and cadence in its own store. The application supplies a schema for its opaque execution reference plus the two background operations the durable runner needs: load the current generation and atomically advance its iteration.

```ts title="agent/lib/prompt-loop-workflow.ts"
import { ExperimentalWorkflow } from "eve/tools";
import { z } from "zod";

export const promptLoopWorkflow = ExperimentalWorkflow({
  referenceSchema: z.object({
    generation: z.string().uuid(),
    workflowId: z.string().uuid(),
  }),

  async load(reference) {
    return workflowStore.loadCurrent(reference);
  },

  async advance(input) {
    return workflowStore.advanceIfCurrent(input);
  },
});
```

Re-export that configured definition from `agent/tools/workflow.ts` so eve discovers it:

```ts title="agent/tools/workflow.ts"
export { promptLoopWorkflow as default } from "../lib/prompt-loop-workflow";
```

`load()` is a read boundary, not a mutation boundary. `start()` may call it
synchronously in the caller deployment to bind readiness to the current cursor,
and the durable controller loads again before execution. Step replay can repeat
either read, so `load()` must be side-effect-free and replay-safe.

An ordinary authenticated tool owns the application record and starts its durable controller. `start()` is idempotent for the configured definition plus canonical reference: concurrent calls converge on one active owner and return that owner's stable run ID.

```ts title="agent/tools/create_loop.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { promptLoopWorkflow } from "../lib/prompt-loop-workflow";

export default defineTool({
  description: "Create and start a recurring prompt loop.",
  inputSchema: z.object({ prompt: z.string() }),
  async execute(input, ctx) {
    const loop = await loopStore.createOwned(input, ctx.session.auth.current);
    const controller = await promptLoopWorkflow.start(
      { workflowId: loop.id, generation: loop.generation },
      ctx,
    );
    return { loop, controller };
  },
});
```

The returned snapshot carries one JavaScript program, one cadence, its next due time, the current iteration, and optional JSON state. These three cadences express the recurring loops directly:

```ts
const tenSecondsAfterCompletion = {
  kind: "after-completion",
  delaySeconds: 10,
} as const;

const everyEightHoursOnTheAnchor = {
  kind: "fixed-rate",
  anchorAt: "2026-07-10T00:00:00.000Z",
  intervalSeconds: 8 * 60 * 60,
  missed: "skip",
} as const;

const fourAndEightPmInNewYork = {
  kind: "daily-times",
  timeZone: "America/New_York",
  times: ["16:00", "20:00"],
  missed: "skip",
} as const;
```

`after-completion` waits from the preceding iteration's terminal time, so iterations cannot overlap. `fixed-rate` remains anchored and skips elapsed slots. `daily-times` uses local wall-clock time in the named IANA time zone: nonexistent daylight-saving times are skipped, and a repeated time runs at its first occurrence only.

The durable controller waits until the stored `dueAt`, then starts a bounded iteration on the latest production deployment. That iteration reloads the record before executing, so a controller already waiting adopts compatible authored-definition and subagent changes on its next run. Preview and local runs stay pinned to their own deployment. Each iteration gets one initial attempt plus three fresh retries. If all four attempts fail, `advance()` receives a `failed` outcome; returning the next snapshot continues the cadence, while returning `null` stops it.

`advance()` is also a replay boundary. If its transition commits but the response is lost, the workflow engine may call it again with the exact same input. The adapter must return the same successor snapshot (or the same terminal `null`) for that exact replay rather than treating the already-applied compare-and-set as a fresh mismatch.

Fresh retries are at-least-once at external side-effect boundaries. If an agent completes an external write but its attempt fails before the result is durably recorded, a later attempt can repeat that write. A lost durable step response can likewise repeat a child dispatch after the first child has already finished; active children are adopted by their stable continuation hook, but completed children have no active hook to adopt. Put a stable application reference and iteration in the snapshot input, and make externally visible operations idempotent when their target supports an idempotency key or can be checked before writing. Exactly-once delivery across an arbitrary external API requires that API to participate in the same transaction; the workflow runner cannot infer it from JavaScript alone.

This configuration deliberately does not create, list, edit, or delete application records. Those remain ordinary app-owned tools where authenticated ownership and product-specific fields can be enforced. Returning `null` from `load` or `advance` tells the runner that the referenced generation is missing, disabled, deleted, or stale.

For an edit, stop and await the old generation before replacing the record and starting the new generation. For a delete, stop and await the current generation before removing its record. `stop()` interrupts an active saved program and its local subagents as well as a pending cadence wait. Persistent saved programs intentionally expose only local subagents, including the built-in `agent`; remote agents cannot provide the same recursive cancellation guarantee.

Persistent background programs must also be non-interactive. If a child requests human input or authorization, that attempt fails because no live channel turn owns the request; the bounded retry policy applies, and `advance()` eventually receives a failed outcome if every attempt does the same. Put any required approval in the tool that creates or edits the application record, before `start()`.

When asked for a weekly business review, the model picks the metrics, runs one `analyst` per metric in parallel, and combines the findings. The program below is the kind of JavaScript the model authors. It fans `analyst` out over a runtime-decided list of metrics and merges the results:

```js
const metrics = ["revenue", "signups", "churn"];
const findings = await Promise.all(
  metrics.map((metric) => tools.analyst({ message: `Summarize last week's ${metric}.` })),
);
return findings.join("\n\n");
```

Each `tools.analyst(...)` call dispatches a child subagent, so the parent stream records one `subagent.called` per metric and one `subagent.completed` as each finishes:

```json
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_1", "childSessionId": "ses_a1", "sequence": 0 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_2", "childSessionId": "ses_a2", "sequence": 1 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_3", "childSessionId": "ses_a3", "sequence": 2 } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_1", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_2", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_3", "output": "..." } }
```

## What a workflow can orchestrate

A workflow reaches only this agent's own agents: the built-in `agent` (a copy of itself), declared [subagents](../subagents), and [remote agents](./remote-agents). That is the whole list. No files, network, shell, skills, or connections. A workflow is a coordination layer over subagents, not a place to do other work. Each call can still request structured output via `outputSchema`, exactly like a direct subagent delegation.

## Caps on workflow-spawned subagents

Workflow orchestration is capped in two independent ways.

**Per-program call budget.** One Workflow program may dispatch at most `limits.maxSubagents` subagent calls in total, counted across the whole program — sequential and parallel calls alike. The default is 100. Calls beyond the budget do not start a child session; they resolve inside the program with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error result, and the budget is stated in the tool's description so the model sizes its fan-out to fit.

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  limits: {
    maxSubagents: 4,
  },
});
```

**Root-only, one level of orchestration.** Only the root session ever sees the `Workflow` tool. The subagents a workflow spawns are ordinary delegated child sessions: they never receive the `Workflow` tool themselves, so a workflow cannot recursively spawn more workflows. Direct (non-workflow) delegation by those children stays subject to the usual `limits.maxSubagentDepth` cap (see [Subagents](../subagents)).

## Where the JavaScript runs

The orchestration code never touches the agent's process. The runtime hands the program text to a small isolated JavaScript engine (a QuickJS sandbox) and runs it there. Nothing from the host realm crosses in, so there is no `process`, no `globalThis` from the agent, and no `import`/`require`. The program can reach exactly two things, the agent functions bridged in as `tools.<name>` and the ordinary language built-ins.

That is an allowlist, not a denylist. The sandbox cannot read files, open a socket, or see an environment variable because those are not present, not because each one is blocked in turn. When the program calls an agent function, that call bridges back out to the runtime, which dispatches it exactly like a direct delegation. The orchestration glue stays inside the sandbox.

## Durability, approvals, and observability

- **Durable.** The whole orchestration counts as one step. Subagents dispatched together run concurrently, and if a run parks (suspends durably without holding compute; see [Execution model & durability](../concepts/execution-model-and-durability)) on a long-running or human-gated child, it resumes where it left off after a restart.
- **Approval-safe for interactive Workflow calls.** A subagent that needs human approval (HITL, human-in-the-loop) during the current user turn surfaces its request and resumes once answered. App-owned persistent programs run without a live turn and therefore require non-interactive children, as described above.
- **Observable.** Every orchestrated subagent emits the usual `subagent.called` / `subagent.completed` events on the parent stream and gets its own child session and stream. The telemetry matches direct delegation, so existing dashboards and cost attribution keep working.

## What to read next

- Declare the subagents a workflow orchestrates → [Subagents](../subagents)
- Call another deployment as one of those agents → [Remote agents](./remote-agents)
- The `agent/tools/` opt-in mechanism → [Default harness](../concepts/default-harness)
