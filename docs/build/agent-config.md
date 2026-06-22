---
title: "agent.ts"
description: "Complete reference for the model, compaction, output, build, and experimental fields in agent.ts."
---

You do not need `agent/agent.ts` until you want to change the root agent's model or runtime config.
When the file is absent, eve uses its defaults. When it is present, default-export
`defineAgent(...)`. A declared subagent must provide its own `agent.ts` because its description and
model belong to that child.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
```

Identity comes from the filesystem and package. We keep it there as the single source of truth, so
`AgentDefinition` has no `name` or `id` field.

## Fields

| Field                      | Required             | Purpose                                                               |
| -------------------------- | -------------------- | --------------------------------------------------------------------- |
| `description`              | Subagents only       | Model-visible description the parent uses to decide when to delegate. |
| `model`                    | When the file exists | Gateway model ID or AI SDK `LanguageModel`.                           |
| `modelContextWindowTokens` | No                   | Context size override for an unlisted or custom model.                |
| `modelOptions`             | No                   | Provider options forwarded to the model call.                         |
| `compaction`               | No                   | Long-session compaction model, context size, and threshold.           |
| `outputSchema`             | No                   | Default structured result for task-mode execution.                    |
| `build`                    | No                   | Hosted bundling controls.                                             |
| `experimental`             | No                   | Unstable code-mode and workflow-world options.                        |

## Models

String model IDs use Vercel AI Gateway. Provider-created model objects call the provider directly.
Installation, credentials, routing, and custom context sizes are covered in
[Models and Providers](./models-and-providers).

## Compaction

Compaction summarizes older session history before it exceeds the model's context window. It is on
by default at `thresholdPercent: 0.9`.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  compaction: {
    thresholdPercent: 0.75,
  },
});
```

To use a different summary model, provide `compaction.model`. Set
`compaction.modelContextWindowTokens` when that model is not in the Gateway catalog.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  compaction: {
    model: "anthropic/claude-haiku-4.5",
    thresholdPercent: 0.8,
  },
});
```

## Structured task output

`outputSchema` sets the default result shape when the agent runs in task mode, including delegation
as a subagent. Interactive conversation turns ignore it unless the client supplies a per-turn
schema.

```ts title="agent/subagents/reviewer/agent.ts"
import { defineAgent } from "eve";
import { z } from "zod";

export default defineAgent({
  description: "Review a proposed change and return a verdict.",
  model: "anthropic/claude-sonnet-4.6",
  outputSchema: z.object({
    approved: z.boolean(),
    reason: z.string(),
  }),
});
```

## Build controls

`build.externalDependencies` keeps packages external while eve bundles authored modules. Use it for
packages that cannot be bundled safely and must ship in the hosted output.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  build: {
    externalDependencies: ["native-database-driver"],
  },
});
```

This is a packaging control, not permission to call the package's external services.

## Workflow world

Local development and `eve start` use the Workflow SDK local world by default. Vercel deployments
use Vercel Workflow. A self-hosted application can select another installed world package:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

The package must default-export a factory or export `createWorld()`. Put connection settings in
runtime environment variables. `experimental.workflow` and `experimental.codeMode` are unstable and
may change in any release.

Authentication belongs on [channels](../connect/channels), sandbox policy belongs in
[`agent/sandbox/`](./sandbox), and telemetry belongs in
[`agent/instrumentation.ts`](../operate/observability).
