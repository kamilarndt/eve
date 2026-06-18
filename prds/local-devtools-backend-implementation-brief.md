# Eve Local DevTools Backend: Agent Implementation Brief

Status: Ready for implementation  
Related PRD: [`prds/local-devtools.md`](./local-devtools.md)  
Related architecture: [`prds/local-devtools-design.md`](./local-devtools-design.md)  
Related UX design: [`prds/local-devtools-ux-design.md`](./local-devtools-ux-design.md)  
Last updated: 2026-06-20

## Objective

Implement the backend for Eve Local DevTools Milestone 1 without implementing a browser UI. The result must expose a versioned local API usable by a future browser client and by the coding agent implementing it.

Keep DevTools experimental for this goal. Do not make it default-on until the complete backend journey passes and UI work is ready.

## Required preparation

Before editing:

1. Read `AGENTS.md` and all 3 related design documents above.
2. Inspect `git status` and preserve unrelated work.
3. Inspect the existing dev CLI, Nitro host, session client and events, inspector, source maps, revision handling, TUI logging, and framework integrations.
4. Produce a slice plan grounded in the current code rather than assuming the proposed module names already exist.

## Scope

Implement:

- Supervisor/runtime-child development topology.
- Versioned lifecycle and observation protocols.
- Secure loopback DevTools host and discovery metadata.
- Health, bootstrap, Runs, Agent, Sources/debugger, and Logs APIs.
- SSE with bounded replay and cursor recovery.
- CDP relay with a single controlling client lease.
- Runtime pause/crash behavior that leaves the host responsive.
- Unit, integration, scenario, and representative model-backed verification.
- API and experimental CLI documentation.

Do not implement:

- React, static UI placeholders, or other frontend code.
- A separate published package.
- Schedule/channel triggers or Milestones 2–5.
- Production/remote debugging or public authoring APIs.
- Default-on DevTools.

## Hard architecture boundaries

- Activate DevTools only from the private `eve dev` composition root, not from `NODE_ENV` alone.
- Keep implementation inside `packages/eve`, under internal and CLI development modules.
- Production must open no DevTools port or inspector, mount no DevTools route, write no capability file, and create no active observation sink.
- Add no published runtime dependency.
- Reuse canonical Eve clients, routes, events, and source-map behavior.
- Keep the runtime interface limited to lifecycle/session/revision IPC, one private session stream, and one-way supplementary observations.
- Observation is bounded, non-blocking, never awaited by agent work, never changes outcomes, and avoids constructing payloads when disabled.
- Bind to loopback on ephemeral ports. Use separate random browser/runtime capabilities, owner-only metadata, origin checks, protected WebSocket upgrades, short-lived debugger tickets, size limits, and centralized redaction.

## Backend surface

Use a versioned `/api/v1` namespace. Exact schemas may evolve during implementation but must be typed and documented.

- `GET /api/v1/health`
- `GET /api/v1/bootstrap`
- `GET /api/v1/runs`
- `GET /api/v1/runs/:sessionId`
- `GET /api/v1/runs/:sessionId/events?cursor=...`
- `POST /api/v1/runs`
- `POST /api/v1/runs/:sessionId/messages`
- `GET /api/v1/events` using SSE
- Agent data through bootstrap or a focused endpoint
- `GET /api/v1/sources`
- Source retrieval only where CDP is insufficient
- `WS /api/v1/debugger`
- `GET /api/v1/logs?cursor=...`

Discovery uses `.eve/dev-server.json` as the stable pointer and owner-readable `.eve/devtools/current.json` for the DevTools URL, capability, runtime instance, inspector compatibility data, and schema version. Never hard-code ports or tokens.

## Implementation slices

### 1. Architecture proof

- Spawn a Nitro self-runner child.
- Open the inspector on loopback port `0` and report it through IPC.
- Connect from the supervisor.
- Pause authored code while the supervisor remains responsive.
- Verify authored source maps and rebuild behavior.
- Prototype private session streaming by ID.

Do not proceed if these assumptions fail; amend the architecture first.

### 2. Protocol and lifecycle

- Add versioned IPC/observation envelopes, child entrypoint, lifecycle manager, lease separation, inspector flag forwarding, signal handling, and bounded observation transport.
- Cover startup, failure, graceful/forced shutdown, malformed versions, pipe closure, and overflow.

### 3. Host and discovery

- Add ephemeral loopback host, capabilities, owner-only metadata, health/bootstrap, authentication, origin/CSP rules, size limits, and cleanup.
- Do not serve a UI.
- Dogfood by discovering the URL/token from disk and calling the API externally, including an unauthorized request.

After this slice, use the external API during every later checkpoint.

### 4. Runs and live events

- Add session registration, private canonical streaming, current-process index, session create/continue, snapshots, cursors, SSE replay, de-duplication, and coarse status.
- Dogfood by creating a real session through the API, following it through SSE, and reconnecting from a cursor.

### 5. Agent and revisions

- Expose runtime-owned resolved definitions, provenance, diagnostics, source references, revisions, and rebuild state.
- Dogfood a successful and failed rebuild through bootstrap/SSE while preserving the previous valid revision.

### 6. Sources and debugger

- Add authored-first source catalog, normalized source maps, authenticated CDP relay, controller lease, breakpoints, stepping, stack/scopes, exceptions, execution correlation, rebuild rebinding, and stale-revision reporting.
- Dogfood a breakpoint in an authored tool. While paused, health/bootstrap must remain responsive; inspect a local scope, resume, and observe completion.

### 7. Logs

- Capture child stdout/stderr, CDP console/exceptions, rebuild/runtime failures, ordering, source links, and available run correlation.
- Expose snapshots and SSE; explicitly mark process-global records uncorrelated.
- Adapt the TUI to the supervisor log stream without changing its visible contract.

### 8. Hardening

Cover the complete backend journey, 2 concurrent projects, pause/crash behavior, observation failures, SSE cursors, debugger conflicts, `--no-devtools`, inspector flags, direct/headless launches, framework integration where practical, cleanup, production isolation, dependencies, and package size.

## Required working loop

For every slice:

1. State the invariant and externally observable exit condition.
2. Write the narrowest failing test at the correct tier.
3. Implement the smallest vertical change.
4. Run the focused test and then the relevant tier.
5. Dogfood through discovery plus HTTP/SSE/WebSocket once the host exists; do not substitute private imports or stores.
6. Exercise at least one relevant failure path.
7. Inspect the diff for public API, production import, dependency, secret, backpressure, and unrelated changes.
8. Report what passed, external verification performed, remaining risk, and the next slice.

Do not proceed while the slice is red unless the failure is proven unrelated and reported.

Follow `AGENTS.md`: request elevated execution for installs, tests, and typechecks; use repo-local Turbo; use the correct Vitest tier config; do not claim skipped checks passed. Do not commit, push, or open a PR unless asked.

## Model-backed verification

Use `anthropic/claude-haiku-4.5` when a check requires a real model turn.

- Reuse one representative existing fixture or one shared DevTools fixture; do not create a fixture per scenario.
- Keep unit/integration tests model-free and use existing harnesses for lifecycle, security, SSE, CDP, and failure scenarios.
- Assert stable protocol outcomes, not exact prose: session created, expected event families, correlated call IDs, terminal/waiting boundary, expected authored pause, and continuation after resume.
- Minimize model calls. Repeat the representative journey only when session execution, event ingestion, source correlation, debugger behavior, or revisions change.
- If credentials are unavailable, report the missing check and do not claim it passed.

## Completion gate

Do not complete the goal until:

- Every scoped endpoint works through discovery and capability authentication.
- The implementing agent has used the external API to inspect and control the fixture.
- The representative Haiku journey passes.
- Pause and crash leave the host usable.
- Observation/transport failures cannot fail agent execution.
- Concurrent projects do not collide.
- Production exposes no DevTools listener, route, inspector, capability, or active observer.
- `--no-devtools` preserves existing development behavior.
- No new published runtime dependency exists.
- Typecheck, lint, format, build, unit, integration, relevant scenario, invariant, and fixture checks pass.
- Documentation and the required changeset are complete.

The final report must list endpoints/protocols, key architecture files, discovery/auth flow, external dogfooding, Haiku verification, exact checks and outcomes, production-isolation evidence, deferrals, and remaining risks.
