---
title: "Deployment"
description: "Choose between Vercel's managed adapters and a self-hosted Node service."
---

We recommend Vercel when you want eve's managed workflow and sandbox path. Self-host when control
over infrastructure, data location, or provider integrations matters enough to operate workflow
storage, sandbox capacity, schedules, scaling, and process health yourself.

`eve build` compiles the same agent definitions for either target. The HTTP and TypeScript client
contracts stay the same; the durable dependencies and operator responsibilities differ.

| Concern                      | Vercel                                     | Self-hosted Node                                       |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| HTTP output                  | Vercel Build Output                        | Nitro `.output/` served by `eve start`                 |
| Durable workflow             | Vercel Workflow                            | Local workflow world by default, or a configured world |
| Workflow storage             | Managed                                    | Persist `.workflow-data` or provide another world      |
| Default sandbox              | Vercel Sandbox                             | Docker, microsandbox, then just-bash fallback          |
| Template prewarm             | Hosted build integration                   | Operator-owned                                         |
| Schedules                    | Vercel Cron integration                    | Nitro scheduled tasks or operator scheduler            |
| Browser identity             | Application auth; Vercel OIDC available    | Application auth or identity provider                  |
| Observability                | OpenTelemetry plus optional platform views | OpenTelemetry and host logs                            |
| TLS, scaling, process health | Platform-managed                           | Operator-owned                                         |

The table is a responsibility map, not only a feature comparison. A check that Vercel performs for
you becomes a runbook, capacity plan, and failure mode on the self-hosted side.

## Common production requirements

Both targets need:

- Node.js 24 or newer at build time.
- A model credential and reachable model endpoint.
- Production [route authentication](../authentication).
- A deliberate [sandbox backend and egress policy](../../build/sandbox).
- Secrets in the runtime environment, not compiled source.
- A successful `eve build` and a real session smoke test.
- Persistent workflow state appropriate to the target.

Run from the application root:

```bash
npx eve build
```

Inspect `.eve/` diagnostics when compilation or discovery differs from local development. See [Troubleshooting](../troubleshooting).
