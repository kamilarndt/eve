---
title: "Environment and Compatibility"
description: "Supported Node and framework versions, optional peers, credentials, filesystem paths, and runtime constraints."
---

## Runtime support

| Surface                  | Supported version or constraint            |
| ------------------------ | ------------------------------------------ |
| Node.js                  | `>=24`                                     |
| Package format           | ESM                                        |
| Next.js integration      | `next ^16` with React `^19`                |
| Nuxt integration         | `nuxt ^4` with Vue `^3.5`                  |
| SvelteKit integration    | `@sveltejs/kit ^2`, Svelte `^5`, Vite `^8` |
| OpenTelemetry API        | Optional `@opentelemetry/api ^1`           |
| Braintrust eval reporter | Optional `braintrust ^3`                   |

Node is the supported server runtime. Bun and Deno compatibility are not part of the current contract. A framework's own platform requirements also apply.

`ai` is a required peer of the published eve package. Framework, telemetry, eval-reporter, and local sandbox packages are optional peers used only by their corresponding entrypoints.

## Model credentials

| Model form in `agent.ts`     | Runtime requirement                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Gateway model ID string      | Vercel project OIDC or `AI_GATEWAY_API_KEY`                                                  |
| Direct AI SDK provider model | Provider package plus its provider credential, such as `@ai-sdk/openai` and `OPENAI_API_KEY` |
| Custom compatible model      | Installed provider/client code and often `modelContextWindowTokens`                          |

Provider package and model availability change independently from eve. Pin versions in the application lockfile and smoke-test the exact model route.

## Local files

| Path                  | Purpose                         | Persistence requirement                                     |
| --------------------- | ------------------------------- | ----------------------------------------------------------- |
| `.eve/`               | Compiler output and diagnostics | Rebuilt; do not edit.                                       |
| `.output/`            | Self-hosted Nitro build         | Rebuilt for deployment.                                     |
| `.vercel/output/`     | Hosted Vercel Build Output      | Rebuilt for deployment.                                     |
| `.workflow-data/`     | Default local workflow state    | Must persist to resume sessions.                            |
| `.eve/sandbox-cache/` | just-bash virtual filesystems   | Persist if local sessions must survive process replacement. |

## Sandbox compatibility

| Backend        | Host requirement                             | Network policy                              |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| Vercel Sandbox | Vercel credentials and network access        | Domain policies and transforms              |
| Docker         | Reachable Docker-compatible CLI and daemon   | Allow-all or deny-all                       |
| microsandbox   | Apple silicon macOS, or glibc Linux with KVM | Domain policies and transforms              |
| just-bash      | JavaScript runtime only                      | No isolation control; no arbitrary binaries |

Set `EVE_DOCKER_PATH` when the Docker-compatible binary is not named `docker` or is not on the default path.

## Hosting constraints

- Self-hosting needs persistent workflow storage, a stable public HTTPS origin for webhooks, and an explicit production sandbox.
- Horizontal scaling cannot safely share the default local workflow world through independent ephemeral disks.
- Vercel-specific sandbox prewarming, Cron wiring, deployment OIDC, and platform run views do not appear automatically on another host.
- `eve dev` defaults to port `2000` but can select another free port. `eve start` uses `--port` or `PORT`.
- Provider webhooks require the exact public URL used during signature verification; reverse proxies must preserve the relevant request URL and headers.

## Upgrade compatibility

eve is pre-1.0. Review the package changelog, regenerate a comparison scaffold when setup output changes, and follow [Upgrading](../operate/upgrading). Experimental exports and `agent.experimental` fields may change in any release.
