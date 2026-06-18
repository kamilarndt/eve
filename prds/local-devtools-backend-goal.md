Implement the Eve Local DevTools Milestone 1 backend as a persistent goal. Continue until the completion gate passes; endpoint scaffolding alone is not completion.

First read `AGENTS.md`, `prds/local-devtools-backend-implementation-brief.md`, and every document linked from that brief. Inspect `git status` and relevant existing dev CLI, Nitro, session, inspector, source-map, revision, TUI, and test code. Preserve unrelated changes.

Implement backend only: supervisor/runtime-child topology; versioned lifecycle and observation protocols; secure loopback host and discovery; health/bootstrap; Runs and SSE; Agent/revisions; Sources and authenticated CDP relay; Logs; pause/crash resilience; tests and docs. Do not build UI, create a separate package, implement later milestones, expose public authoring APIs, or make DevTools default-on. Preserve `--no-devtools`.

Enforce the brief's production boundary: activate only from the private `eve dev` composition root; add no runtime dependency; production must expose no DevTools listener, route, inspector, capability file, or active observer. Reuse canonical Eve protocols. Keep runtime additions to lifecycle/session/revision IPC, one private session stream, and bounded one-way observations that are never awaited and cannot affect execution.

Work through the brief's 8 slices in order. For every slice:

1. State its invariant and external exit condition.
2. Write the narrowest failing test at the correct tier.
3. Implement the smallest vertical change.
4. Run focused and relevant-tier tests.
5. Once the host exists, discover it through `.eve/devtools/current.json` and verify through HTTP/SSE/WebSocket as an external coding agent; private imports/stores do not count.
6. Exercise a relevant failure path.
7. Inspect the diff for production imports, public API, dependencies, secrets, backpressure, and unrelated edits.
8. Report tests, external dogfooding, risks, and the next slice. Do not proceed while red unless the failure is proven unrelated.

Use `anthropic/claude-haiku-4.5` when verification needs a real model turn. Reuse one representative existing fixture or one shared fixture, not one fixture per scenario. Keep unit/integration tests model-free and use existing harnesses for lifecycle/security/CDP cases. Assert stable protocol outcomes, not exact model prose. Minimize model calls. If credentials are unavailable, report the missing check rather than claiming success.

Follow `AGENTS.md`: request elevated execution for installs, tests, and typechecks; use repo-local Turbo and correct Vitest tier configs; never claim skipped checks passed. Do not commit, push, or open a PR unless asked.

Complete only when all scoped endpoints work through discovery/authentication; you have used the external API to inspect and control the fixture; the representative Haiku journey passes; pause/crash leave the host usable; observation failure cannot fail runs; concurrent projects do not collide; production isolation and `--no-devtools` parity are proven; no runtime dependency was added; typecheck, lint, format, build, unit, integration, relevant scenario, invariant, and fixture checks pass; and docs plus changeset are complete.

Finish with the endpoint/protocol inventory, key architecture files, discovery/auth flow, API dogfooding and Haiku evidence, exact verification results, production-isolation evidence, deferrals, and remaining risks.
