---
title: "Upgrading"
description: "Upgrade eve deliberately, review pre-1.0 changes, rebuild artifacts, and smoke-test durable paths."
---

eve is pre-1.0, and we still make intentional breaking changes when they leave the framework
cleaner or safer. An upgrade can change authored APIs, defaults, generated files, or deployment
behavior. Read the changelog for every version you cross; a minor-looking range is not necessarily
operationally inert.

> **Recommendation:** Upgrade one application first, rebuild from a clean checkout, and exercise a
> session that was created before the deployment when workflow or sandbox behavior changed.

## Upgrade one application

Run from the application root with the package manager used by the project:

```bash
npm install eve@latest
npx eve info --json
npx eve build
```

Commit the lockfile change. If the application uses a direct AI SDK provider, update its provider package only after checking compatibility with the `ai` peer version resolved by eve.

For a pnpm workspace:

```bash
pnpm --filter <application-package> add eve@latest
pnpm --filter <application-package> exec eve info --json
pnpm --filter <application-package> exec eve build
```

## Review authored and generated files

Compare release notes against:

- imports from every `eve/*` subpath;
- `agent.ts` model and compaction fields;
- tool, connection, channel, sandbox, and schedule definitions;
- HTTP payloads and stream event consumers;
- generated framework integration files;
- deployment environment variables and runtime constraints.

Do not copy old generated files into a new scaffold blindly. Generate a temporary project with the new CLI and diff the relevant framework configuration when a release changes scaffolding.

## Verify behavior

At minimum:

1. Typecheck the application.
2. Run `eve info --json` and inspect discovery differences.
3. Build from a clean checkout.
4. Run deterministic evals.
5. Create a local session, call one authored tool, and send a follow-up.
6. Exercise approval or authorization if the application uses waiting turns.
7. Build the production target and smoke-test its immutable URL.

When changing workflow storage or sandbox backends, test an in-progress session created before the deployment. If cross-version resume is not explicitly supported by the release, drain or intentionally invalidate old sessions rather than discovering incompatibility in production.

Current runtime and peer-package requirements are in [Environment and Compatibility](../reference/environment-and-compatibility).
