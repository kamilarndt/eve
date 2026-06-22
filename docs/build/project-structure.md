---
title: "Project Structure"
description: "Authored slots under agent/ and the path-derived naming rule."
---

The filesystem is eve's authoring API. Put a file in `agent/tools/` and it becomes a tool; put one
in `agent/channels/` and it becomes a channel. The directory a file lands in tells eve how to load
it, and the path gives the capability its identity.

## Naming rule

Identity comes from the path. You never write a `name` or `id` field on a `define*` call. We chose
one source of truth deliberately: renaming the file renames the capability, and discovery output
always points back to the authored file.

| Path                                  | Resolves to           |
| ------------------------------------- | --------------------- |
| `agent/tools/get_weather.ts`          | tool `get_weather`    |
| `agent/connections/linear.ts`         | connection `linear`   |
| `agent/skills/summarize.md`           | skill `summarize`     |
| `agent/subagents/researcher/agent.ts` | subagent `researcher` |

The root agent takes its name from the enclosing `package.json` `name`, falling back to the app-root directory name when `package.json` has no `name`. A subagent takes its name from its directory.

## Recommended layout

```text
my-agent/
├── package.json
├── tsconfig.json
├── agent/
│   ├── agent.ts
│   ├── instructions.md
│   ├── instrumentation.ts
│   ├── channels/
│   ├── connections/
│   ├── hooks/
│   ├── skills/
│   ├── lib/
│   ├── sandbox/
│   ├── tools/
│   ├── schedules/
│   └── subagents/
└── evals/
```

Evals live in `evals/` at the app root, a sibling of `agent/`, not inside it. See [Evals](../operate/evals).

## Slot table

The Subagents column states whether a local subagent (`subagents/<id>/`) can author the slot. A declared subagent inherits nothing from the root; it discovers its own slots. See [Subagents](./subagents).

| Path                                                    | Description                                 | Subagents | Notes                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.ts`                                              | Runtime config                              | Yes       | Model, modelOptions, compaction, build, experimental. See [`agent.ts`](./agent-config).                                                                                                                               |
| `instructions.md` / `instructions.ts` / `instructions/` | Base system prompt                          | Optional  | A flat file, or a directory of `.md` and `.ts` files. Static sources compose at build time. Dynamic sources (`defineDynamic` + `defineInstructions`) resolve at runtime. Required on the root, optional on subagents. |
| `instrumentation.ts`                                    | Telemetry config                            | No        | OTel exporter and AI SDK span settings, auto-discovered and run before agent code. Root-only.                                                                                                                         |
| `channels/`                                             | HTTP / messaging entrypoints                | No        | Root-only.                                                                                                                                                                                                            |
| `connections/`                                          | External service connections (MCP, OpenAPI) | Yes       | One connection per file; name derived from filename.                                                                                                                                                                  |
| `hooks/`                                                | Lifecycle and stream-event subscribers      | Yes       | Module-backed only. Recursive directories supported.                                                                                                                                                                  |
| `skills/`                                               | On-demand procedures and capability packs   | Yes       | Flat markdown, module-backed skills, or packaged skills. Seeded into `/workspace/skills/...`.                                                                                                                         |
| `lib/`                                                  | Shared authored helper code                 | Yes       | Import-only; not mounted into the workspace.                                                                                                                                                                          |
| `sandbox.ts` or `sandbox/sandbox.ts`                    | The agent's single sandbox                  | Yes       | Use top-level `sandbox.ts` for a definition-only override; use `sandbox/sandbox.ts` + `sandbox/workspace/**` to also seed files. Framework default applies when neither is authored.                                  |
| `sandbox/workspace/**`                                  | Files seeded into the sandbox               | Yes       | Mirrored into `/workspace/...` at session bootstrap.                                                                                                                                                                  |
| `tools/`                                                | Typed executable integrations               | Yes       | Module-backed only.                                                                                                                                                                                                   |
| `schedules/`                                            | Recurring jobs                              | No        | Each schedule is `<name>.ts` (default-exported `defineSchedule`) or `<name>.md` (frontmatter `cron:` + prompt body). Recursive nesting supported. Root-only.                                                          |
| `subagents/`                                            | Specialist child agents                     | Yes       | Each child is its own local package under `subagents/<id>/`. Nested subagents are supported.                                                                                                                          |

## What reaches the runtime workspace

eve does not mount the whole tree. Only two sources land in the sandbox workspace:

- `skills/` files → `/workspace/skills/...`
- `agent/sandbox/workspace/**` → `/workspace/...` at session bootstrap

Everything in `lib/` stays import-only source code and never reaches the workspace.

## Local subagent layout

A local subagent lives under `subagents/<id>/` and uses the same `agent.ts` shape as the root.

```text
agent/subagents/researcher/
├── agent.ts
├── instructions.md
├── connections/
├── hooks/
├── skills/
├── lib/
├── sandbox/
├── tools/
└── subagents/
```

Rules:

- `agent.ts` is required, and must declare a `description`. The parent reads it on the lowered subagent tool to decide when to delegate.
- `instructions.md` / `instructions.ts` is optional (unlike the root agent, where it is required).
- `connections/`, `hooks/`, `skills/`, `lib/`, `sandbox/`, and `tools/` are all supported, discovered from the subagent's own directory.
- `channels/` and `schedules/` are not supported inside local subagents.
- Nested subagents are supported.

## Flat layout

Supported when the app root is also the agent root:

```text
my-agent/
├── package.json
├── agent.ts
├── instructions.md
├── tools/
└── skills/
```

We recommend the nested layout. It keeps application files separate from the agent definition and
makes the authored tree obvious to people and coding agents. The flat layout is useful for a small
package whose only job is to host one agent.

## Applications and shared code

An eve application has one root agent. We keep that rule simple because the root owns the HTTP
entrypoints, schedules, and durable session lifecycle. Put independent applications in separate
workspace packages when they need separate root agents, deployments, channels, or session stores:

```text
workspace/
├── apps/
│   ├── support-agent/
│   │   └── agent/
│   └── finance-agent/
│       └── agent/
└── packages/
    └── shared-agent-code/
```

Share ordinary TypeScript through a workspace package or each application's `agent/lib/`. Keep
tool, skill, connection, and channel declarations local and thin. Their filesystem paths determine
runtime identity, discovery, approvals, and diagnostics. That is why importing one authored
definition into two agent trees is not a substitute for declaring it in both places.

```ts title="apps/finance-agent/agent/tools/format_currency.ts"
import { formatCurrency } from "@workspace/shared-agent-code";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Format integer cents as US dollars.",
  inputSchema: z.object({ amountCents: z.number().int() }),
  async execute({ amountCents }) {
    return { formatted: formatCurrency(amountCents) };
  },
});
```

## Why didn't eve discover my file?

Run `eve info --json`. It lists every discovered capability and diagnostic. Check that the file sits
in the expected slot and in the correct root or subagent tree. After a build, inspect `.eve/`
artifacts as described in [Troubleshooting](../operate/troubleshooting). See the
[CLI reference](../reference/cli) for command behavior.
