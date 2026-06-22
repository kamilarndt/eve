---
title: "Deploy on Vercel"
description: "Build, configure, deploy, and verify an eve application on Vercel."
---

We recommend Vercel for the shortest path to a production eve deployment. Hosted builds emit
Vercel Build Output, durable sessions use Vercel Workflow, schedules use Vercel Cron, and the
default backend selects Vercel Sandbox.

This does not remove application responsibilities: you still choose route auth, tool permissions,
model and provider policy, sandbox egress, and data handling.

## Prerequisites

- A Vercel project linked to the application.
- Model access through project OIDC or `AI_GATEWAY_API_KEY`, or a direct provider package and key.
- Production route authentication.
- Provider, channel, and connection secrets required by the application.

## Build behavior

When `VERCEL` is set, `eve build` writes `.vercel/output` in addition to `.eve/` artifacts. If `VERCEL_DEPLOYMENT_ID` is also available, the build prewarms sandbox templates that have bootstrap work or seeded workspace files.

Template prewarm failures fail the build. A build that warns about missing `VERCEL_DEPLOYMENT_ID` should not be reused with `vercel deploy --prebuilt`; let Vercel rebuild the source so templates are provisioned against the deployment.

## Configure the application

Gateway model IDs such as `openai/gpt-5.5` can authenticate through Vercel project OIDC. Direct provider models still require their provider package and environment variable. See [Models and Providers](../../build/models-and-providers).

The default backend selects Vercel Sandbox on Vercel. Pin it only when you need Vercel-specific options:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel({ networkPolicy: "deny-all" }),
});
```

Replace scaffolded `placeholderAuth()` before exposing a browser UI. `vercelOidc()` authenticates Vercel workloads and configured external subjects; it is not a general cookie-session solution.

## Deploy

From the application root:

```bash
vercel deploy
```

Git-connected deployments run the same build command in Vercel. Do not set runtime-only secrets in source or `.openai/hosting.json`; configure them on the project.

## Verify

Use the immutable deployment URL, not a mutable alias, for the initial smoke test:

```bash
curl --fail https://<deployment>/eve/v1/health
```

Then create and stream a real authenticated session using the [HTTP API](../../reference/http-api) or attach the development client:

```bash
npx eve dev https://<deployment>
```

If Deployment Protection is enabled, provide the documented bypass credential to your test client. Confirm the expected sandbox template appears in build logs and that a second turn resumes the first session.

## Vercel-specific behavior

- Vercel Cron triggers schedules.
- Hosted sandbox templates can prewarm during build.
- Deployment routing and platform run views are additive Vercel features.
- OpenTelemetry exporters configured in `agent/instrumentation.ts` remain the portable observability path.

Do not assume these features exist on a self-hosted process; see the [deployment comparison](./index).
