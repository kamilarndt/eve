---
title: "Self-host eve"
description: "Run the built Nitro service on your own Node infrastructure and own its durable dependencies."
---

Self-hosting is supported, but it is not the hands-off path. eve serves the same public HTTP API on
your Node infrastructure; you own persistence, scheduling, sandbox capacity, TLS, scaling, and
process supervision.

> **Recommendation:** Deploy on Vercel unless you need to control the runtime, data location, or
> infrastructure integrations. Self-host when those requirements are worth operating every durable
> dependency yourself.

## Build and start

Run from the application root:

```bash
npx eve build
PORT=3000 npx eve start --host 0.0.0.0
```

`eve build` writes Nitro output under `.output/`. `eve start` serves that build and accepts `--host` and `--port`; `PORT` is the environment fallback. Put the process behind a TLS-terminating reverse proxy or load balancer.

## Persistence

The default local workflow world stores state under `.workflow-data`. We keep this default useful
for a single process, but it is not a distributed production store. Mount the path on durable
storage and make it available after restarts. Ephemeral container filesystems lose the ability to
resume existing sessions.

> **Current limitation:** A local filesystem cannot coordinate horizontally scaled or multi-region
> deployments. For those topologies, configure an installed Workflow world package through the
> experimental root-agent option:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.5",
  experimental: {
    workflow: { world: "@acme/eve-workflow-world" },
  },
});
```

The package must export a default factory or `createWorld`. Treat this API as experimental and test upgrade compatibility.

## Model routing

Gateway strings work outside Vercel with `AI_GATEWAY_API_KEY`. To bypass Gateway, install the provider's AI SDK package, pass its model object, and configure the provider key:

```bash
npm install @ai-sdk/openai
```

```ts title="agent/agent.ts"
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

export default defineAgent({
  model: openai("gpt-5.5"),
});
```

Set `OPENAI_API_KEY` in the runtime environment.

## Sandbox

Most self-hosted deployments should pin the sandbox backend rather than let local environment
detection choose it. Do not pin `vercel()` unless the service should create Vercel-hosted
sandboxes. Pin Docker or microsandbox when your production requirements depend on that runtime:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

export default defineSandbox({
  backend: docker({
    image: "ghcr.io/vercel/eve:latest",
    networkPolicy: "deny-all",
  }),
});
```

Capacity planning must include one persistent sandbox per active durable session. just-bash is a fallback interpreter, not a replacement for a container or VM when agents require real binaries or network isolation.

## Schedules

The standard `eve start` path runs Nitro scheduled tasks. If your platform strips scheduled-task support or scales every instance independently, trigger the required schedule route from one external scheduler and prevent duplicate dispatch. Test the exact production topology.

## Authentication and networking

Replace `vercelOidc()` unless your callers actually present Vercel OIDC tokens. Use cookie, Basic, JWT, generic OIDC, or custom route auth. Preserve the original request URL and trusted proxy headers required by your auth and webhook signature checks.

Expose all provider webhook routes over stable public HTTPS. Configure firewall egress for model providers, connections, callbacks, telemetry, and the selected sandbox backend.

## Health and shutdown

Probe `GET /eve/v1/health`. Configure the process manager to restart failures and allow active requests to drain on shutdown. A passing health endpoint proves the HTTP process is reachable; it does not prove the model credential, workflow storage, sandbox, or provider webhooks work. Run a real authenticated session after each deployment.

## Operator checklist

- Persist `.workflow-data` or configure a production workflow world.
- Pin and capacity-plan the sandbox backend.
- Run exactly one intended schedule dispatch path.
- Configure production auth and trusted-proxy behavior.
- Store secrets in the runtime secret manager.
- Collect application logs and OpenTelemetry.
- Back up and test deletion for workflow and application data.
- Exercise create, stream, follow-up, wait/resume, and restart recovery.
