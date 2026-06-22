---
title: "TypeScript API"
description: "Public package subpaths, their primary exports, and the authored files where they belong."
---

This page is the public export map and a routing index, not generated symbol documentation. TypeScript declarations shipped with `eve` are authoritative for complete signatures. If an import is not in the package export map below, treat it as internal even when a file exists in the installed package.

## Agent definitions

| Import                | Primary exports                                                                                     | Typical authored location                          |
| --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `eve`                 | `defineAgent`, `defineRemoteAgent`; agent, compaction, model, workflow, and remote-agent types      | `agent/agent.ts`, `agent/subagents/**`             |
| `eve/instructions`    | `defineInstructions`, `defineDynamic`; instruction and dynamic resolver types                       | `agent/instructions.ts`, `agent/instructions/*.ts` |
| `eve/skills`          | `defineSkill`, `defineDynamic`; `SkillHandle`, skill package types                                  | `agent/skills/*.ts`                                |
| `eve/context`         | `defineState`; `StateHandle`, `SessionContext`, session/auth/turn types                             | shared modules used by callbacks                   |
| `eve/hooks`           | `defineHook`; hook context and event map types                                                      | `agent/hooks/*.ts`                                 |
| `eve/schedules`       | `defineSchedule`; schedule handler and typed receive-target types                                   | `agent/schedules/*.ts`                             |
| `eve/instrumentation` | `defineInstrumentation`, `isChannel`; instrumentation event, channel, session, turn, and step types | `agent/instrumentation.ts`                         |

`defineRemoteAgent`, dynamic definitions, custom workflow worlds, and the code-mode fields under `agent.experimental` are advanced or experimental surfaces. Read their page openings before adopting them.

## Tools and approval

| Import               | Primary exports                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve/tools`          | `defineTool`, `defineDynamic`, `disableTool`, `toolResultFrom`, `defineBashTool`, `defineReadFileTool`, `defineWriteFileTool`, `defineGlobTool`, `defineGrepTool`; tool/context/result types |
| `eve/tools/approval` | `never`, `once`, `always`, `NeedsApprovalContext`                                                                                                                                            |
| `eve/tools/defaults` | Default definitions `bash`, `readFile`, `writeFile`, `glob`, `grep`, `webFetch`, `webSearch`, `todo`, `loadSkill`                                                                            |

`ExperimentalWorkflow` from `eve/tools` is opt-in and experimental. Re-exporting it from `agent/tools/workflow.ts` enables the model-authored `Workflow` tool.

The wrapper factories keep eve-owned schemas and execution behavior while allowing configuration. Spreading a value from `eve/tools/defaults` is useful when replacing a built-in by the same path-derived slug.

## Connections and outbound agent auth

| Import            | Primary exports                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve/connections` | `defineMcpClientConnection`, `defineOpenAPIConnection`, `defineInteractiveAuthorization`; authorization error classes and guards; connection, token, header, and filter types |
| `eve/agents/auth` | `vercelOidc`, `bearer`, `basic`; `OutboundAuthFn`                                                                                                                             |

`eve/agents/auth` is for an eve agent calling another agent. Inbound route authentication is exported from `eve/channels/auth`.

## Sandbox

| Import                     | Primary exports                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eve/sandbox`              | `defineSandbox`, `defaultBackend`, `SandboxTemplateNotProvisionedError`; session, process, backend, network-policy, lifecycle, file, and command types |
| `eve/sandbox/vercel`       | `vercel`; Vercel create/bootstrap/session option types                                                                                                 |
| `eve/sandbox/docker`       | `docker`; Docker create, pull-policy, and network-policy types                                                                                         |
| `eve/sandbox/microsandbox` | `microsandbox`; microsandbox create/bootstrap/session option types                                                                                     |
| `eve/sandbox/just-bash`    | `justbash`; `JustBashSandboxCreateOptions`                                                                                                             |

Backend imports are deliberately separate so an application depends only on the runtime it selects.

## Channels and route authentication

| Import                  | Primary exports                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve/channels`          | `defineChannel`, `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `WS`, `createWebSocketUpgradeServer`; channel, route, send, session, and WebSocket types                                            |
| `eve/channels/eve`      | `eveChannel`, `defaultEveAuth`; eve channel, upload-policy, event, and message context types                                                                                                  |
| `eve/channels/auth`     | `localDev`, `placeholderAuth`, `none`, `vercelOidc`, `vercelSubject`, `httpBasic`, `jwtHmac`, `jwtEcdsa`, `oidc`, `routeAuth`; verifier, failure, bearer, response, and IP allow-list helpers |
| `eve/channels/slack`    | `slackChannel`, Slack defaults, blocks, API and callback types                                                                                                                                |
| `eve/channels/discord`  | `discordChannel`, Discord API and callback types                                                                                                                                              |
| `eve/channels/teams`    | `teamsChannel`, Teams API and callback types                                                                                                                                                  |
| `eve/channels/telegram` | `telegramChannel`, Telegram API and callback types                                                                                                                                            |
| `eve/channels/twilio`   | `twilioChannel`, Twilio API and callback types                                                                                                                                                |
| `eve/channels/github`   | `githubChannel`, `defaultGitHubAuth`, GitHub API, checkout, and callback types                                                                                                                |
| `eve/channels/linear`   | `linearChannel`, Linear API, activity, and callback types                                                                                                                                     |

Provider callback types are exported from the same provider subpath as the factory. Import them instead of recreating partial event shapes.

## Client and UI state

| Import       | Primary exports                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve/client` | `Client`, `ClientSession`, `MessageResponse`, `ClientError`, `EveAgentStore`, `defaultMessageReducer`, file-part helpers; client, session, reducer, message, input, inspection, and complete stream-event types |
| `eve/react`  | React `useEveAgent`; reducer, message, options, helper, snapshot, and status types                                                                                                                              |
| `eve/vue`    | Vue `useEveAgent`; reducer, message, options, return, snapshot, and status types                                                                                                                                |
| `eve/svelte` | Svelte `useEveAgent`; reducer, message, options, return, snapshot, and status types                                                                                                                             |

Use `eve/client` for scripts and custom state machines. The framework hooks expose the shared [client-state contract](../connect/frontend/client-state).

## Host-framework integrations

| Import          | Primary exports                                                             |
| --------------- | --------------------------------------------------------------------------- |
| `eve/next`      | `withEve`, `WithEveOptions`, Next config and rewrite types                  |
| `eve/nuxt`      | Default Nuxt module, `EVE_NUXT_SERVICE_PREFIX`, `EveNuxtModuleOptions`      |
| `eve/sveltekit` | `eveSvelteKit`, `EVE_SVELTEKIT_SERVICE_PREFIX`, `EveSvelteKitPluginOptions` |

Install the matching framework peers. Importing one integration does not make its framework a runtime dependency of every eve app.

## Evals

| Import                | Primary exports                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `eve/evals`           | `defineEval`, `defineEvalConfig`, `EveEvalTurnFailedError`; eval context, session, result, target, assertion, judge, and match types |
| `eve/evals/expect`    | `includes`, `equals`, `matches`, `similarity`; assertion types                                                                       |
| `eve/evals/loaders`   | `loadJson`, `loadYaml`                                                                                                               |
| `eve/evals/reporters` | `Braintrust`, `JUnit`; reporter and configuration types                                                                              |

Braintrust is an optional peer used only by its reporter.

## Setup APIs

| Import               | Primary exports                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `eve/setup`          | Setup runner, prompts, state, project resolution, Vercel linking, package-manager, Slackbot, and connector setup helpers |
| `eve/setup/scaffold` | Base-project scaffolding, channel and connection mutation, catalog, and file-conflict helpers                            |

These are public programmatic setup surfaces used by tooling. They are not runtime agent authoring APIs, and their types follow CLI/scaffold behavior more closely than the durable protocol.

## Metadata

`eve/package.json` exports the installed package manifest. Use it only for metadata such as the exact installed version; do not build runtime behavior by reading internal file paths.

## Runtime callback context

Tools receive `SessionContext` as their second argument:

```ts
import { defineTool, type SessionContext } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return the current public session identifier.",
  inputSchema: z.object({}),
  async execute(_input, ctx: SessionContext) {
    return { sessionId: ctx.session.id };
  },
});
```

`ctx.session` exposes caller, initiator, turn, and parent metadata. `ctx.getSandbox()` is asynchronous. `ctx.getSkill(id)` is synchronous and returns a lazy file handle. Context access is valid only inside framework-managed callbacks.

Use the task guides for behavior: [`agent.ts`](../build/agent-config), [Tools](../build/tools), [Connections](../connect/connections), [Channels](../connect/channels), [Sandbox](../build/sandbox), and [TypeScript Client](../connect/typescript-client).
