# Eve DevTools: Milestone Implementation Status

Status: Milestone 1 complete

Related PRD: [`prds/local-devtools.md`](./local-devtools.md)

Related architecture: [`prds/local-devtools-design.md`](./local-devtools-design.md)

Related UX design: [`prds/local-devtools-ux-design.md`](./local-devtools-ux-design.md)

Last updated: 2026-06-20

## Summary

The Milestone 1 product is implemented in the working tree. Local `eve dev` now starts a separately hosted, package-owned browser DevTools by default while `--no-devtools` preserves the previous development path. The browser and coding agents share the capability-protected `/api/v1` HTTP, SSE, source-map, and CDP interfaces.

The approved Runs, Agent, Sources, and Console frontend is connected to the real backend. It can create and continue sessions, follow canonical run events, inspect resolved definitions, open authored files, bind authored TypeScript breakpoints, inspect pause state and scopes, evaluate expressions, filter correlated logs, and resume execution.

The required repository gates and the real model-backed browser journey have passed. Milestone 1 is complete and ready for normal review and shipping work.

## Milestone Position

| Milestone                    | Status      | Product outcome                                                                 |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------- |
| 1 — Core debug loop          | Complete    | Runs, Agent, Sources, and Console against one local runtime                     |
| 2 — Durable semantics        | Not started | Model context, state diffs, persisted runs, HITL, revisions, and subagent edges |
| 3 — Channels and identity    | Not started | Channel simulation, delivery transactions, identity, and auth inspection        |
| 4 — Sandbox                  | Not started | Sandbox lifecycle, files, commands, resources, and policy                       |
| 5 — Protocol and performance | Not started | Network, concurrency, latency, profiling, and cost diagnostics                  |

## Implemented in Milestone 1

### Default local topology

- `eve dev` starts a supervisor, an inspected runtime child, and a loopback DevTools host.
- `--no-devtools` keeps the legacy in-process development path.
- Remote `eve dev --url` and production `eve start` do not start DevTools.
- The inspector uses an ephemeral loopback port and its default Node status banner is suppressed.
- The browser app is built into `packages/eve/dist/devtools-ui/` with no new published runtime dependency.
- Root `pnpm dev` builds the frontend before starting the Eve watcher and weather fixture.

### Shared secure interface

- Discovery metadata is written to `.eve/devtools/current.json`; `.eve/dev-server.json` remains compatible with existing local tooling.
- The capability stays in the printed browser URL fragment and is sent to APIs through `Authorization: Bearer`.
- Host and Origin are restricted to the exact loopback DevTools origin.
- Static assets use a restrictive Content Security Policy and require no network-loaded resources.
- Debugger WebSocket access uses a short-lived, single-use ticket and a single-controller lease.
- Health remains unauthenticated and exposes only coarse runtime status.

### Browser product

- Runs: current-process session list, server-derived first-message titles, search, timeline, details, and message composer.
- Agent: resolved definition tree, search, configuration, provenance, revision, source reveal, and runtime/discovery diagnostics.
- Sources: authored JavaScript, TypeScript, JSON, Markdown, and YAML catalog; source display; breakpoint intent; pause/step controls; call stack; scopes; and source reveal.
- Console: panel and drawer, runtime/session/action selectors, text and level filters, source/session links, and local expression evaluation.
- Shell: light and dark themes, runtime/connection state, command menu, keyboard panel navigation, debugger shortcuts, responsive panes, transient toasts, and Escape-to-toggle Console behavior.
- Fixture mode remains available to develop visual states independently through Vite or `?prototype`.

### Authored debugging loop

- The trusted host reads inline and local-file source maps with size bounds.
- `GET /api/v1/sources/:sourceId/locations?line=` maps a one-based authored line to generated CDP locations.
- `GET /api/v1/sources/resolve?scriptId=&line=&column=` maps a generated pause location back to authored source.
- The live controller obtains a debugger ticket, connects over CDP, binds breakpoint intent, hydrates stack frames and scope properties, evaluates in the selected frame, and handles pause/resume events.
- The Milestone 1 scenario now binds in `agent/tools/get_weather.ts`, starts a real run, pauses inside the tool, evaluates `input.city`, confirms the host remains responsive, resumes, and waits for canonical action completion.

### Backend organization

- Host composition: `packages/eve/src/internal/devtools/host.ts`
- HTTP lifecycle, routing, assets, auth, and errors: `packages/eve/src/internal/devtools/host/`
- Runtime, Runs, Debugger, Sources, and Logs domains: `packages/eve/src/internal/devtools/domains/`
- Global sequencing and SSE replay: `packages/eve/src/internal/devtools/event-hub.ts`
- Browser controller and projections: `packages/eve/devtools-ui/src/controllers/live/`

## API Surface

- `GET /`, `/index.html`, and `/assets/:assetName`
- `GET /api/v1/health`
- `GET /api/v1/bootstrap`
- `GET /api/v1/events`
- `GET /api/v1/runs`
- `POST /api/v1/runs`
- `GET /api/v1/runs/:sessionId`
- `GET /api/v1/runs/:sessionId/events?cursor=<cursor>`
- `POST /api/v1/runs/:sessionId/messages`
- `GET /api/v1/agent`
- `GET /api/v1/sources`
- `GET /api/v1/sources/:sourceId`
- `GET /api/v1/sources/:sourceId/locations?line=<line>`
- `GET /api/v1/sources/resolve?scriptId=&line=&column=`
- `GET /api/v1/debugger/state`
- `POST /api/v1/debugger/tickets`
- `GET /api/v1/debugger?ticket=<ticket>`
- `GET /api/v1/logs?cursor=<cursor>`

See [`docs/guides/devtools/endpoints.md`](../docs/guides/devtools/endpoints.md) for request and response examples.

## Verification Status

Passed on 2026-06-20 against the current working tree:

- Full package build, Eve and DevTools UI typecheck, Oxlint, Oxfmt, documentation validation, mechanical invariant guard, and Git whitespace validation.
- Unit: 379 Eve files and 3,692 tests, plus 6 catalog tests.
- Integration: 48 files and 330 tests, including host auth/assets, SSE, run, log, and debugger relay coverage.
- Scenario: 44 files, 255 passed and 15 skipped, including the real authored-breakpoint core journey and packaged UI asset checks.
- A real weather fixture run using `anthropic/claude-haiku-4.5` through the browser DevTools.
- Browser automation of create session → send message → authored TypeScript breakpoint → pause → inspect stack and scope → evaluate `input.city` as `"Berlin"` → resume → completed tool and assistant turn.
- The browser journey also confirmed server-derived session titles, Console session identifiers and selectors, Escape drawer toggling, light/dark rendering, and no browser errors.

## Intended Milestone 1 Boundaries

These are deliberate boundaries, not release blockers:

- Run and log retention is in-memory and current-process only.
- Raw child stdout/stderr may remain runtime-level when Eve coordinates are unavailable; correlated records show the full session id in a dedicated Console column.
- Breakpoints persist for the lifetime of the browser controller and rebind to newly loaded scripts, but are not stored across `eve dev` processes.
- Automatic runtime restart, durable revision history, effective model input, state diffs, HITL controls, schedule/channel triggers, and subagent session trees start in later milestones.

## Completion Gate

Milestone 1 passed its completion gate. Future changes to this surface should preserve the automated authored-breakpoint scenario and repeat the model-backed browser journey when they alter the core debug loop.
