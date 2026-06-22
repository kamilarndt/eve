---
title: "Troubleshooting"
description: "Diagnose discovery, model, sandbox, stream, authentication, and deployment failures by symptom."
---

When eve fails, resist the urge to start by editing `.eve/` or a generated build. First confirm that
eve discovered the project you think it did. From the application root, record the exact command,
printed URL, and first error message, then run:

```bash
npx eve info --json
npx eve build
```

`eve info --json` reports every discovered capability and its diagnostics. `.eve/` contains
compiled manifests, module maps, and build diagnostics. We keep these artifacts inspectable so you
can trace a source file into the build, but they are output—not files to edit.

## “No agent found” or a missing tool

1. Confirm the current directory contains `agent/` or is itself the flat agent root.
2. Check the exact authored slot in [Project Structure](../build/project-structure).
3. Confirm the file is `.ts`, `.md`, or `.mdx` as supported by that slot.
4. Check path-derived identity and slug validity. Tool slugs must match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`.
5. Read discovery diagnostics from `eve info --json`.

A file imported as ordinary TypeScript is not automatically a discovered tool or skill; it must live in the corresponding agent tree.

## Model authentication or rate-limit failure

- A string model ID uses AI Gateway. Provide Vercel OIDC or `AI_GATEWAY_API_KEY`.
- A direct model object requires the provider package and that provider's key.
- Confirm the model ID exists and the credential may use it.
- A single user turn can make several model calls because tools, subagents, retries, and compaction add steps.
- Respect `retry-after` and provider rate-limit headers. Do not add unbounded application retries around eve.

See [Models and Providers](../build/models-and-providers).

## The server did not use port 2000

`eve dev` defaults to `2000` and selects another available port when necessary. Use the URL printed by the command. `eve start` uses its `--port` option or `PORT` environment variable.

## Sandbox command not found

Run `eve info --json` to identify the authored sandbox and check startup output for the selected backend. The just-bash fallback has no arbitrary host binaries. Pin Docker, microsandbox, or Vercel Sandbox when a tool requires `git`, `node`, Python, or a package manager.

Test bootstrap commands against the same backend used in production. Network policy failures are intentional; confirm the destination is allowed instead of weakening the whole policy.

## `401` or `403` on session routes

- `placeholderAuth()` returns a production `401` by design.
- `localDev()` accepts only loopback request hostnames and local `vercel dev`.
- Confirm the client sends credentials on stream reconnects as well as POST requests.
- Validate issuer, audience, subject, deployment environment, and clock skew for JWT/OIDC.
- A valid identity can still receive `403` from application authorization.

## A stream stopped or duplicated UI state

Persist `{ sessionId, continuationToken, streamIndex }` together. Reconnect from the last processed index and deduplicate by event index. A continuation token changes as the session advances; stale input responses and follow-ups are rejected.

Client `stop()` aborts the local HTTP operation. It does not guarantee already accepted server work or external side effects were cancelled. Design tools to be idempotent.

## A turn is waiting forever

Inspect the stream for `input.requested` or `authorization.required`, followed by `session.waiting`. Submit the response against the current continuation token. For OAuth, confirm the callback URL is public, matches the provider registration exactly, and reaches the same durable workflow storage.

## Deployment health passes but turns fail

The health route does not call the model or sandbox. Verify, in order:

1. Runtime model credential.
2. Durable workflow storage and write permission.
3. Sandbox backend availability.
4. Provider and connection egress.
5. Route auth on create, stream, and follow-up.
6. Provider webhook URL and signature secret.

Use an immutable deployment URL for the first smoke test. Compare the `.eve/` manifest from the deployed build with local discovery.

## Reporting a defect

Include the eve version, Node version, host platform, selected sandbox backend, exact error text, minimal authored file, and whether the failure reproduces after a clean build. Remove tokens, prompts containing private data, and user content from logs before sharing them.
