---
title: "Sandbox Lifecycle and Network"
description: "Bootstrap sandbox templates, initialize durable sessions, and control egress."
---

Put shared, non-secret setup in `bootstrap`; put caller-specific setup in `onSession`. Keeping those
phases separate lets eve reuse a prepared template without copying one user's data or credentials
into another session.

Sandbox setup has two phases:

| Hook        | Runs                           | Use it for                                                 |
| ----------- | ------------------------------ | ---------------------------------------------------------- |
| `bootstrap` | Once per reusable template     | Installing dependencies or cloning public baseline files.  |
| `onSession` | Once per durable agent session | Per-user files, credentials policy, resources, and egress. |

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel(),
  revalidationKey: () => "analysis-tools-v2",

  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "npm install --global prettier@3" });
  },

  async onSession({ use, ctx }) {
    const sandbox = await use({
      networkPolicy: { allow: ["api.example.com"] },
    });

    const principal = ctx.session.auth.current?.principalId ?? "anonymous";
    await sandbox.writeTextFile({
      path: "SESSION_PRINCIPAL.txt",
      content: `${principal}\n`,
    });
  },
});
```

`bootstrap` receives no session identity. Do not put user credentials or user-specific data into a template. `onSession` receives the active session context and can derive per-session configuration.

Set `revalidationKey` when an input outside the authored sandbox source and seeded files changes the template output. Changing the returned string causes eve to build a new template.

## Persistence

`/workspace` persists between turns in the same durable session. The backend may stop or replace its underlying process between turns; do not keep correctness-critical state only in memory. Write durable working files to `/workspace` or use [session state](../state).

Each subagent owns a separate sandbox. Files are not implicitly shared between parent and child agents.

## Network policy

Egress defaults to `"allow-all"`. Treat that as development behavior, not a production policy.

> **Security consequence:** Pin an egress policy before giving a production agent network-capable
> shell or code tools. Allow only the hosts the workload needs, and keep credentials scoped to the
> operations available on those hosts.

```ts
networkPolicy: "allow-all";
networkPolicy: "deny-all";
networkPolicy: {
  allow: ["api.example.com", "*.github.com"],
  subnets: { deny: ["10.0.0.0/8"] },
};
```

Put a policy on the backend factory to apply it before authored bootstrap. Pass a policy to `onSession`'s `use()` to set it for a session. A live handle can call `sandbox.setNetworkPolicy(...)` when a turn needs a temporary change.

Vercel Sandbox and microsandbox support domain policies and credential transforms. Docker supports only allow-all and deny-all. just-bash does not implement network isolation and rejects runtime policy changes.

## Credential transforms

On supported backends, a transform can add an outbound header at the network boundary without placing its value in a sandbox file or process environment:

```ts
async onSession({ use }) {
  await use({
    networkPolicy: {
      allow: {
        "api.example.com": [
          {
            transform: [
              { headers: { authorization: `Bearer ${process.env.EXAMPLE_TOKEN}` } },
            ],
          },
        ],
      },
    },
  });
}
```

The secret remains in the eve server process. The model can still cause requests to the allowed host, so scope credentials and host permissions to the minimum required operation.

## Failure recovery

- A bootstrap command failure prevents the template from being used. Run the same command against the selected backend and inspect its `stderr`.
- A missing optional local backend is installed only by `eve dev` when auto-install is enabled. Production startup fails with an actionable error.
- A policy unsupported by the selected backend fails instead of silently weakening isolation.
- Use `eve info --json` to confirm which sandbox definition the compiler discovered. Inspect `.eve/` diagnostics after `eve build` when the authored module does not load.
