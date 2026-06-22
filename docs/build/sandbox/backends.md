---
title: "Sandbox Backends"
description: "Choose a fixed sandbox backend or let eve select the best available runtime."
---

Most projects should let eve choose a sandbox backend while getting started. If you do not
configure one, `defaultBackend()` selects an available backend at first use. Pin a backend before
production when your agent depends on specific binaries, network controls, resources, or
persistence behavior.

> **Why this default:** Automatic selection keeps local development working without requiring
> Docker or a hosted sandbox. It is a portability convenience, not a production isolation policy.

| Factory            | Import                     | Runtime                        | Main constraint                                          |
| ------------------ | -------------------------- | ------------------------------ | -------------------------------------------------------- |
| `vercel()`         | `eve/sandbox/vercel`       | Vercel Sandbox                 | Requires Vercel credentials.                             |
| `docker()`         | `eve/sandbox/docker`       | Local Docker-compatible daemon | Domain allow-lists are not supported.                    |
| `microsandbox()`   | `eve/sandbox/microsandbox` | Local lightweight VM           | Requires Apple silicon macOS or glibc Linux with KVM.    |
| `justbash()`       | `eve/sandbox/just-bash`    | Pure JavaScript interpreter    | No real system binaries or network isolation.            |
| `defaultBackend()` | `eve/sandbox`              | First available backend        | Selection may differ between development and production. |

## Default selection

`defaultBackend()` tries, in order:

1. Vercel Sandbox when `VERCEL` is set.
2. Docker when a reachable Docker-compatible CLI is available.
3. microsandbox on a supported host.
4. just-bash as the dependency-free fallback.

The final just-bash fallback is useful for a portable development experience, but it cannot run
arbitrary system binaries and does not provide network isolation.

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

## Configure fallback candidates

Pass backend-specific options to `defaultBackend` without fixing the selected runtime:

```ts title="agent/sandbox.ts"
import { defaultBackend, defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend({
    vercel: { resources: { vcpus: 4 } },
    docker: { image: "ghcr.io/vercel/eve:latest" },
    microsandbox: { memoryMiB: 2048 },
  }),
});
```

## Backend behavior

### Vercel Sandbox

`vercel()` runs hosted VMs, including when called from local development. It supports domain-level egress rules and credential transforms. An idle VM can stop; eve reconnects using persisted sandbox state.

### Docker

`docker()` drives the `docker` CLI and defaults to `ghcr.io/vercel/eve:latest`. Set `EVE_DOCKER_PATH` to use a non-default compatible binary. It persists one long-lived container per durable session. Network policy supports only `"allow-all"` and `"deny-all"`.

### microsandbox

`microsandbox()` provides local VM isolation and domain-level egress controls. The npm package and VM runtime are optional; `eve dev` installs them when needed unless `setup: { autoInstall: false }` is configured. A production process fails instead of installing missing runtime components.

### just-bash

`justbash()` stores its virtual filesystem under `.eve/sandbox-cache/`. It can execute shell built-ins and JavaScript implementations supplied by `just-bash`, but it cannot run arbitrary host binaries such as `git`, `node`, or a package manager. It does not provide network isolation.

## Custom backends

Implement `SandboxBackend` from `eve/sandbox` to connect an internal VM or container service. A backend supplies `name`, `create`, and optional `prewarm` behavior and returns the `SandboxSession` operations eve uses. This is a low-level integration point; applications normally use a shipped factory.
