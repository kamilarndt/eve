# Eve Local DevTools

Status: Draft  
Owner: Eve  
Related UX design: [`prds/local-devtools-ux-design.md`](./local-devtools-ux-design.md)

Last updated: 2026-06-19

## Summary

Eve Local DevTools is a browser-based debugging environment for agents running under `eve dev`. It combines Eve-native inspection—agent structure, sessions, durable turns, model calls, actions, state, triggers, subagents, and sandboxes—with Node.js source debugging through the Chrome DevTools Protocol.

The product is not a generic chat UI with a debugger attached. Its central value is correlation: a developer can move from a model decision to the tool call it produced, the authored source that executed, the logs and state changes caused by that execution, and the durable runtime events that recorded the outcome.

The first milestone must be a shippable core product, not an infrastructure preview. A developer should be able to start Eve, discover the resolved agent, create a session, send a message, follow the turn, pause inside authored TypeScript, inspect runtime values, and correlate console output without leaving DevTools.

## Background

Eve agents run across boundaries that generic Node debugging does not explain:

- Nitro serves framework and channel routes.
- A durable session driver owns the conversation and its event stream.
- Each turn runs as a child workflow.
- Each model/tool step is a durable checkpoint.
- Human input, connection authorization, and subagents can park a turn without holding compute.
- Local edits publish immutable runtime snapshots; in-flight sessions can stay pinned to an older revision while new sessions use the latest one.
- Authored tools, hooks, channel handlers, model calls, connections, and state run in the trusted Node.js app runtime.
- Shell and file operations proxy into a separate sandbox runtime that Node inspection cannot see.

Eve already exposes useful pieces of the debugging contract:

- `GET /eve/v1/info` and `eve info --json` describe the resolved agent.
- Session routes create and continue conversations.
- A replayable NDJSON stream exposes session, turn, step, action, input, authorization, compaction, subagent, and failure events.
- A dev-only schedule route triggers authored schedules once.
- `.eve` artifacts preserve discovery diagnostics, manifests, module maps, and compiled metadata.
- `eve dev --inspect*` enables Node inspection.
- Development source maps map immutable snapshot/cache modules back to live authored files.

The current pieces remain fragmented. The TUI knows only sessions it creates, the public event stream does not expose the complete effective model input or state snapshots, logs are not consistently correlated to concurrent sessions, and the inspected process also hosts local HTTP/TUI work, so a breakpoint pauses the surfaces needed to explain the pause.

## Problem

Agent authors cannot answer common local debugging questions from one coherent runtime model:

- What agent definition did Eve actually discover and load?
- What exact instructions, history, tools, and dynamic capabilities did this model call receive?
- Why did the model choose this action?
- Did an action fail because of its input, schema, approval, authorization, authored code, sandbox, or external service?
- Which session, turn, step, action, and code revision produced this log or exception?
- Is the session running, replaying, waiting for input, waiting for a child, or terminally failed?
- Is a breakpoint executing current code or an older immutable session snapshot?
- What state changed at the last durable checkpoint?
- How can a developer or coding agent trigger a schedule or channel input and follow the resulting sessions?

Chrome DevTools can inspect Node execution, but it does not understand Eve sessions or durable workflow semantics. Eve’s TUI understands the event stream, but it is not a source debugger and is difficult for coding agents to discover or automate. Using both independently loses the correlation that makes either useful.

## Product principles

1. **Model Eve primitives before designing panels.** Sessions, turns, steps, model calls, actions, triggers, state snapshots, runtime revisions, source executions, logs, and sandbox resources are product objects. Panels are views over them.

2. **The run is the center of debugging.** Model context, actions, state, HITL, subagents, usage, and failures belong to a selected run rather than separate global destinations.

3. **Authored source comes first.** Live workspace files are prominent. Eve, Nitro, generated, and dependency sources remain available but are hidden by default.

4. **Durability must be visible.** Live, replayed, retried, resumed, parked, and skipped work must not look identical.

5. **Execution boundaries must remain honest.** Node source debugging and sandbox inspection are separate capabilities. DevTools must never imply that a Node breakpoint can pause an isolated sandbox process.

6. **The UI and coding agents share one contract.** Every inspection and trigger capability must have a stable, versioned, machine-readable local API. The browser application is a client of that API, not the exclusive implementation.

7. **Debugging must not change agent outcomes.** Inspection recording is best-effort and cannot fail a run. Enabling DevTools should preserve local runtime semantics apart from the intentional debugger pause.

8. **Secrets remain on the trusted side.** DevTools can expose credential presence, strategy, scope, and redacted provenance, but never connection tokens, bearer credentials, brokered secrets, or unrestricted environment values.

9. **The first milestone is useful on its own.** Infrastructure work is included inside a complete vertical slice and is not shipped as an empty shell.

## Goals

- Provide a default-on, loopback-only DevTools service for every local Eve server.
- Make the resolved agent and active runtime revision immediately understandable.
- Let developers create and continue sessions from DevTools.
- Present durable session, turn, step, model, action, and failure activity as one correlated timeline.
- Support authored TypeScript breakpoints, call stacks, scopes, stepping, and exceptions.
- Keep DevTools responsive while the Eve runtime is paused.
- Correlate source execution and logs with Eve runtime coordinates.
- Support headless servers spawned by Next.js, Nuxt, and SvelteKit.
- Give coding agents feature parity through a local API and discovery metadata.
- Add deeper agent-specific inspection incrementally without changing the top-level information architecture.

## Non-goals

- Forking or reproducing every Chromium DevTools panel.
- Building a general-purpose IDE or code editor.
- Replacing the existing TUI in the first release.
- Debugging production or remote deployments in the first release.
- Exposing or mutating arbitrary durable state by default.
- Stepping into Docker, microsandbox, Vercel Sandbox, or just-bash execution with Node’s debugger.
- Simulating Vercel infrastructure when Eve already has a production-equivalent local runtime boundary.
- Turning local DevTools recording into an external telemetry exporter.

## Users

### Agent author

Builds and iterates on instructions, tools, connections, channels, schedules, hooks, dynamic capabilities, subagents, and sandboxes. Needs a fast explanation for behavioral and code-level failures.

### Eve framework contributor

Needs to reveal generated, Nitro, workflow, and Eve runtime sources after ruling out authored code.

### Coding agent

Edits the same files and needs to discover the running server, resolved agent, sessions, events, source locations, and trigger operations without interacting with a visual UI or TTY.

## Core user journey

1. The developer runs `pnpm dev` or `eve dev`.
2. Eve starts the local runtime and a loopback DevTools host on available ports.
3. The terminal reports the DevTools URL and writes machine-readable discovery metadata.
4. The developer opens DevTools and lands on **Runs**.
5. They create a session and send a message.
6. The timeline shows the message, model step, action request, and tool execution.
7. They reveal the tool’s authored TypeScript in **Sources** and set a breakpoint.
8. They retry from a fresh session or send another turn.
9. The runtime pauses at the breakpoint while the DevTools host remains responsive.
10. DevTools shows call stack, scopes, session/turn/step/action identity, code revision, and correlated console output.
11. The developer resumes execution and sees the action result and turn completion appear on the same run timeline.

Completing this journey is the release criterion for the first milestone.

## Main panels

| Product priority | Panel   | First usable milestone | Reason for placement                                                                                 |
| ---------------- | ------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| 1                | Runs    | Milestone 1            | The primary debugging loop and home for interaction, model activity, actions, and durable execution. |
| 2                | Agent   | Milestone 1            | Establishes what Eve actually loaded and is largely supported by existing inspection data.           |
| 3                | Sources | Milestone 1            | Validates the defining promise of an Eve-aware Node debugger.                                        |
| 4                | Console | Milestone 1            | Makes exceptions and logs actionable when correlated with Runs and Sources.                          |
| 5                | Sandbox | Milestone 4            | Important but requires a separate cross-backend inspection contract.                                 |
| 6                | Network | Milestone 5            | Valuable for advanced transport diagnosis after semantic runtime inspection works.                   |

### 1. Runs

Runs is the default panel and primary product surface.

It owns these primitives:

- Triggers and normalized deliveries
- Sessions and parent/child invocation edges
- Turns and steps
- Model calls
- Actions and results
- Pending input and authorization
- State snapshots
- Durable event journal

Recommended layout:

- **Left:** session list and parent/child session tree.
- **Center:** ordered turn/step timeline.
- **Right:** details for the selected trigger, event, model call, action, state boundary, or failure.
- **Header:** create/trigger controls and runtime revision status.
- **Footer:** message or pending-input response composer when the selected session can continue.

Runs should absorb concepts that would otherwise fragment the product:

- Model context is a model-call detail view, not a top-level panel.
- Actions are timeline items, not a global tool-call panel.
- State is inspected at a selected durable boundary.
- Subagents are session-tree children.
- HITL and authorization are pending run states.
- Performance and token usage are attributes of turns, model calls, actions, and waits.

#### Required capabilities

- Create a clean session and send text.
- Continue a waiting session.
- Display session id separately from continuation state.
- Render session, turn, step, message, action, input, subagent, compaction, and failure events.
- Correlate events by turn id, sequence, step index, call id, parent/root session, and revision.
- Inspect raw event JSON.
- Link actions and failures to authored source.
- Link source pauses and console records back to the selected run.
- Distinguish live events from replayed/reconnected history.

### 2. Agent

Agent is Eve’s equivalent of an Elements panel: it shows the resolved structure the runtime is operating on, rather than merely mirroring the source tree.

It owns:

- Resolved agent definition graph
- Authored/framework/replaced/disabled status
- Source references
- Discovery diagnostics
- Runtime revision and rebuild state

#### Required capabilities

- Show root and declared subagent hierarchy.
- Show model and routing configuration.
- Show instructions, dynamic resolvers, tools, skills, connections, channels, schedules, hooks, sandbox, and workspace metadata.
- Show path-derived names and runtime identity.
- Show source file, source kind, and export when available.
- Reveal the definition in Sources.
- Show diagnostics adjacent to the affected definition.
- Show whether the running revision contains the latest authored edit.
- Refresh after a successful rebuild without reloading DevTools.

### 3. Sources

Sources provides the Node.js source-debugging primitives needed for Eve-authored code.

It owns:

- Source files and ownership
- Breakpoints
- Paused execution
- Call stacks and async stacks
- Scopes and values
- Exceptions
- Runtime revision associated with loaded code

#### Required capabilities

- Prioritize authored workspace files.
- Resolve immutable development snapshots and content-addressed cache modules back to live authored files.
- Hide `eve://runtime`, `eve://nitro`, generated, Node internal, and dependency sources by default.
- Set, remove, enable, and disable line breakpoints.
- Pause/resume and step over/into/out.
- Show call stack and local/closure/global scopes.
- Pause on uncaught exceptions; caught-exception support may follow.
- Reveal the owning Eve definition.
- Reveal the active session, turn, step, and action in Runs.
- Display a visible warning when the paused execution belongs to an older revision than the current runtime pointer.

The first version should use the Chrome DevTools Protocol directly. It should not embed or fork the entire Chromium DevTools frontend.

### 4. Console

Console is both a main panel and a globally available bottom drawer.

It owns:

- Authored `console.*` output
- Runtime stdout/stderr
- Eve framework logs
- Uncaught exceptions and promise rejections
- Rebuild errors
- Sandbox lifecycle logs

#### Required capabilities

- Preserve ordering across captured sources.
- Filter by severity, stream, namespace, session, turn, step, action, and revision when correlation exists.
- Link stack frames to Sources.
- Link correlated output to Runs.
- Collapse repeated failure cascades sharing the same Eve error id.
- Clearly mark uncorrelated process-global output.
- Preserve raw text and structured fields.

A Node evaluation prompt is useful but not required for the first milestone. When added, it must be visibly marked as arbitrary code execution in the trusted app runtime.

### 5. Sandbox

Sandbox is separate because it represents a different execution environment and security boundary.

It owns:

- Sandbox backend and selection reason
- Template/bootstrap/session lifecycle
- Per-session sandbox ownership
- `/workspace` filesystem
- Commands and processes
- Network policy
- Persistence and parent/child sharing rules

#### Required capabilities

- Show selected backend and authored configuration.
- Show which session and agent node own the sandbox.
- Show whether a built-in child shares the parent sandbox or a declared child owns another.
- Browse `/workspace` and inspect text files.
- Show command invocations, exit status, stdout, and stderr.
- Show bootstrap, prewarm, template reuse, create, restore, and cleanup activity.
- Show network policy and credential-transform presence without exposing credentials.
- Link sandbox tool actions back to Runs.

### 6. Network

Network is a later panel for protocol-level diagnosis.

It owns:

- Eve and channel HTTP requests
- WebSocket connections and messages
- NDJSON subscriptions and cursors
- Reconnects and buffering
- Route matching and response metadata

It is intentionally later because most developers need the Eve semantic timeline before raw transport details.

## Explicit information-architecture decisions

- There is no separate Playground panel. Interaction starts from Runs.
- There is no separate Triggers panel. Message, schedule, channel, and response triggers are entry points into Runs.
- There is no separate Context panel. Effective context belongs to a model call.
- There is no separate State panel. State belongs to a session at a durable boundary.
- There is no separate Actions panel. Actions belong to the model step that requested them.
- There is no separate Subagents panel. Runtime child sessions belong in Runs; declared subagent definitions belong in Agent.
- There is no separate Diagnostics panel. Discovery/rebuild diagnostics belong in Agent and runtime failures belong in Runs.
- Performance is initially an overlay on existing primitives, not a top-level panel.

## Functional requirements

### Startup and discovery

- `eve dev` starts the DevTools host by default on loopback and an available port.
- Headless Eve servers started by Next.js, Nuxt, or SvelteKit also start or register a DevTools host without opening a browser.
- Direct interactive `eve dev` opens the DevTools URL in the default browser after the runtime is ready, prints the clickable URL, and surfaces it in the TUI.
- A `--no-devtools` option disables the DevTools host and restores the lowest-overhead current development topology.
- Eve writes a machine-readable record containing app root, runtime URL, DevTools URL, process ids, active revision, inspector endpoint/proxy information, and update time.
- Multiple local Eve servers cannot conflict on HTTP or inspector ports.

### Interaction

- Create a conversation-mode session.
- Send follow-up messages only when continuation is valid.
- Submit structured HITL input responses.
- Trigger authored schedules once and follow every returned session.
- Later milestones can supply channel-specific or raw HTTP/WebSocket ingress.
- Every state-changing operation returns stable ids immediately.

### Recording and correlation

- Every observable object uses stable ids or coordinates already present in Eve where possible.
- The minimum correlation tuple is revision, agent node, session id, turn id/sequence, step index, and call id when applicable.
- Inspection recording cannot throw into agent execution.
- Event ordering preserves the durable session stream’s order.
- Replayed/reconnected events retain their original timestamp and are marked as historical delivery rather than new execution.
- Data needed only for local inspection stays local and is never sent to telemetry providers implicitly.

### Coding-agent access

- DevTools exposes a versioned JSON API and streaming transport.
- The API can list current and recent sessions.
- The API can retrieve agent definitions, revisions, events, logs, and source references.
- The API can create sessions, send messages, answer pending input, and trigger schedules subject to the same local authorization as the visual UI.
- API responses never require interpreting rendered HTML.
- The discovery metadata path and schema are documented.

## Implementation recommendations

### 1. Separate the DevTools host from the inspected runtime

Recommended process topology:

```text
eve dev supervisor
├── DevTools host
│   ├── browser UI and local API
│   ├── run index and inspection store
│   └── Chrome DevTools Protocol proxy/client
└── Eve runtime child
    ├── Nitro self runner
    ├── Workflow local world
    └── authored agent execution
```

Today the inspector attaches to the same process that owns the server and TUI. A breakpoint therefore freezes HTTP handling, rebuilds, and UI streaming. Making the CLI a supervisor and moving the inspected Eve runtime into a child process lets the DevTools host remain responsive and explicitly report that the runtime is paused.

The supervisor can also capture child stdout/stderr without monkeypatching its own output, own port discovery, restart the runtime when necessary, and coordinate TUI and browser clients.

This topology is a milestone-one requirement because retrofitting it after building Sources would change the debugger, logging, startup, and transport contracts.

### 2. Use an ephemeral loopback inspector endpoint

- Start the runtime child with Node inspection bound to `127.0.0.1` and port `0`.
- Record the resolved endpoint through IPC rather than parsing terminal text.
- Do not use fixed port `9229` by default; multiple agents and framework-spawned servers make collisions normal.
- Keep the inspector off non-loopback interfaces unless the developer opts into an explicitly unsafe configuration.
- Proxy or mediate CDP through the DevTools host so the browser UI does not need raw inspector discovery.
- Continue selecting Nitro’s `self` runner before startup so authored breakpoints execute in the inspected process.

### 3. Build an Eve-owned UI over selected CDP domains

Use the protocol domains required by the product:

- `Debugger` for sources, breakpoints, pause state, stacks, scopes, and stepping.
- `Runtime` for execution contexts, object properties, console events, exceptions, and later evaluation.
- `Profiler` and heap domains only when a later performance milestone requires them.

Do not fork the full Chromium DevTools frontend. It would introduce a large, fast-moving UI surface while still failing to understand Eve primitives. A focused Eve UI can use CodeMirror for source display and bundle it into static assets at package build time so the published `eve` runtime does not gain a new runtime dependency.

### 4. Add a dev-only runtime observation sink

Introduce an Eve-owned internal observer that is installed only for local development and is a no-op otherwise. It should receive best-effort records for:

- Session creation and terminal state
- Normalized deliveries
- Turn and step boundaries
- Effective model input/configuration immediately before a model call
- Action request/result lifecycle
- Pending input and authorization
- State snapshot metadata at durable boundaries
- Runtime revision selection
- Rebuild lifecycle

The sink should publish to the supervisor over IPC or a private loopback channel. It must catch and swallow all transport failures so DevTools can never fail the agent.

The public NDJSON session stream remains the canonical user-visible event journal. The observation sink supplements it with local-only inspection records that should not become public protocol events solely for DevTools.

### 5. Persist only a small Eve-owned run index

The Workflow local world already owns durable streams and execution state. DevTools should not parse undocumented `.workflow-data` internals or duplicate entire event streams.

Persist an append-only, filesystem-first index under `.eve/devtools/` containing:

- Session id
- Parent/root lineage
- Trigger summary
- Channel and agent node
- Runtime revision
- Created/updated timestamps
- Current coarse status

Retrieve detailed events from the existing session stream when possible. Local-only supplementary inspection records can be stored per session with bounded retention. Use JSON/JSONL and atomic file operations initially; avoid adding a database runtime dependency before scale demonstrates a need.

### 6. Capture effective model calls at the assembly boundary

The authored instrumentation callback already receives final `modelInput` at `step.started`. Add the internal dev observer adjacent to this model-call assembly path so DevTools sees:

- Final instructions and messages
- Active static and dynamic tools with schemas
- Active skills/instructions
- Output schema
- Model reference and provider options
- Runtime/channel/session coordinates
- Usage, finish reason, retry count, cache path, and compaction context after completion

Do not reconstruct this later from authored manifests; dynamic capabilities, channel context, history, and compaction make reconstruction inaccurate.

### 7. Record state at existing durable boundaries

`DurableSessionState` already carries versioned session snapshots through workflow step results. Emit a local inspection projection after a step commits rather than observing arbitrary in-memory mutations.

State should be grouped by ownership:

- Model-visible history
- Authored `defineState`
- Channel adapter state and projected metadata
- Eve harness bookkeeping
- Sandbox state handle

The UI should default to diffs and summaries. Raw state requires explicit expansion and redaction rules. Connection tokens are already excluded from durable state and must remain excluded.

### 8. Add structured log correlation in development

Capturing child stdout/stderr provides ordering but not reliable correlation under concurrent sessions. Add a dev-only structured console/log transport that reads Eve’s active async runtime context and emits optional session, turn, step, action, source, namespace, and error-id fields to the supervisor.

Unstructured process writes remain supported and are marked uncorrelated. Existing terminal rendering can consume the same supervisor log stream, replacing the need for separate monkeypatch-based capture paths over time.

### 9. Reuse existing route contracts for triggers

- Use the Eve client and canonical session routes for messages and continuations.
- Use the existing dev schedule dispatch route for schedules.
- Subscribe to returned session ids through the existing stream route.
- Add generic channel simulation only after defining a narrow dev-only trigger contract. Do not invent per-channel UI behavior inside the DevTools frontend.

### 10. Keep runtime revisions explicit

Extend development metadata so the supervisor can associate:

- Current runtime pointer
- Rebuild transaction
- Source/compile snapshot
- Session-pinned revision
- CDP script/source revision

Creating an ordinary prompt after a successful rebuild should default to a new session, matching current TUI behavior. Answering a pending input request must resume the original pinned session and visibly explain why it is using older code.

## Proposed local API shape

Exact paths are implementation details, but the first version should expose equivalent versioned resources:

- DevTools metadata and health
- Resolved agent graph
- Runtime revisions and rebuild events
- Session/run index
- Session event stream and supplementary inspection records
- Logs stream
- Message and pending-input triggers
- Schedule trigger
- Source/debugger WebSocket

The API should use ordinary JSON for snapshots and a single streaming mechanism—Server-Sent Events or WebSocket—for live updates. Prefer SSE for append-only run/log feeds unless bidirectional debugger transport requires WebSocket. CDP remains WebSocket-based behind the DevTools host.

## Security and privacy

- Bind the DevTools host and inspector to loopback by default.
- Generate a per-process capability token for state-changing DevTools API calls and debugger access.
- Store the token only in owner-readable local metadata and include it in the printed DevTools URL.
- Validate browser origins and protect WebSocket upgrades.
- Never embed secrets in page source, logs, events, or persisted inspection data.
- Redact authorization headers, cookies, environment values, connection tokens, and brokered credentials.
- Mark model input/output and reasoning as potentially sensitive local data.
- Provide bounded retention and a clear local-data deletion path.
- Treat Node evaluation and debugger attachment as arbitrary trusted-runtime code execution.

## Performance and reliability requirements

- DevTools-disabled production builds contain no active observation sink.
- A disconnected or crashed DevTools host does not fail or block the runtime child.
- Observation transport uses bounded buffers and drops low-priority records rather than applying unbounded backpressure to agent execution.
- The Agent panel renders from local data within one second after opening on a healthy server.
- A new run appears in the Runs list before its first model step completes.
- Existing session events remain replayable after a DevTools browser refresh.
- Pausing the runtime does not freeze the DevTools shell, session history, source UI, or console history.
- Source-map resolution continues to point at live authored files across rebuilds.
- Multiple Eve projects can run concurrently without port or metadata collisions.

## Accessibility and interaction requirements

- Every panel and primary action is keyboard accessible.
- Timeline items, tree nodes, tabs, and breakpoint controls expose semantic labels.
- Status is never represented by color alone.
- Raw JSON and source text remain selectable and copyable.
- Dense views provide filtering without hiding the selected object’s identity.
- The paused-runtime state is announced clearly and persistently.

## Milestones

Each milestone is independently shippable. Milestone 1 includes its necessary architecture and is the first public core product.

### Milestone 1: Core debug loop

**Outcome:** A developer can discover an agent, interact with it, follow one live run, pause in authored TypeScript, inspect runtime values, and correlate console output.

#### Scope

- Supervisor/runtime-child topology.
- Default-on loopback DevTools host with discovery metadata.
- Ephemeral loopback Node inspector and CDP proxy.
- Browser application shell with Runs, Agent, Sources, and Console.
- Runs:
  - Create a clean session.
  - Send and continue text messages.
  - Track sessions created through DevTools during the current process lifetime.
  - Render existing session/turn/step/message/action/failure events.
  - Inspect action input/result and raw events.
- Agent:
  - Render `/eve/v1/info` as a navigable definition tree.
  - Show model, instructions, tools, skills, channels, schedules, connections, hooks, subagents, sandbox, and diagnostics.
  - Reveal authored sources.
- Sources:
  - Authored source tree.
  - Breakpoints, pause/resume, step controls, call stack, and scopes.
  - Existing live-workspace source-map behavior.
  - Reveal selected run/action when correlation is known.
- Console:
  - CDP console events, child stdout/stderr, exceptions, and rebuild errors.
  - Source links and basic filtering.
- Machine-readable API parity for every supported inspection and interaction.
- TUI remains available and displays the DevTools URL.

#### Deliberate limitations

- Only sessions observed in the current server process are listed.
- Effective model input and state snapshots are not yet available.
- Schedule and channel triggers are not yet exposed in the UI.
- Subagent events render, but the complete child tree may require manual session navigation.
- Sandbox has only a definition summary in Agent.
- Headless and framework-owned launches do not automatically open a browser.

#### Acceptance criteria

- Starting interactive `eve dev` opens a working DevTools URL without requiring `--inspect`.
- A developer can send a message and see the live turn reach a boundary.
- A tool request and result appear with their call id and source definition.
- A breakpoint in an authored tool binds to the live TypeScript file and pauses when the tool executes.
- While paused, DevTools remains responsive and shows scopes and the owning session/action.
- Console output before and during the tool execution remains available after resume.
- A coding agent can perform the same session creation and event inspection through the local API.
- Running two Eve projects concurrently creates no port collision.
- `--no-devtools` retains a working current-style local server.

### Milestone 2: Durable agent semantics

**Outcome:** DevTools explains why the agent behaved as it did across turns, checkpoints, revisions, HITL, and subagents.

#### Scope

- Persisted local run index and recent-session history across DevTools refresh/restart.
- Effective model-call records:
  - Final instructions/messages.
  - Active tools and schemas.
  - Dynamic capability provenance.
  - Model routing/configuration.
  - Usage, finish reason, retry, cache, and compaction metadata.
- Durable state snapshots and diffs grouped by ownership.
- Runtime revision history and session-pinning indicators.
- Rebuild transactions linked to affected definitions and sessions.
- HITL approval/question response controls.
- Connection authorization lifecycle display.
- Parent/child subagent session tree and child-stream attachment.
- One-shot schedule triggering from Runs.
- Live/replay/retry/resume provenance.

#### Acceptance criteria

- A developer can select a model step and inspect the exact effective input used for that call.
- A state change is visible as a diff at the durable step that committed it.
- A session pinned to an older revision is visibly distinguishable from the current runtime.
- A developer can answer a pending approval/question and follow the resumed turn.
- A developer can trigger any discovered schedule and follow all resulting sessions.
- A parent run automatically exposes delegated child sessions and their status.

### Milestone 3: Channel and identity debugging

**Outcome:** Developers can reproduce real ingress, auth, tenant, and dynamic-capability behavior without bypassing channel code.

#### Scope

- Channel route catalog derived from the resolved agent.
- Raw HTTP request builder for authored and built-in channel routes.
- WebSocket channel support where feasible.
- Saved, local-only request fixtures with secret redaction.
- Route matching, verification/auth outcome, dispatch/drop/inline handling, and response inspection.
- Current/initiator auth and channel metadata inspection.
- Safe local test-principal and attribute profiles.
- Dynamic resolver execution records showing event, input context, and produced capability definitions.
- Continuation-token derivation and re-key timeline.

#### Acceptance criteria

- A developer can send a realistic custom-channel HTTP request and see whether it was rejected, dropped, handled inline, or dispatched.
- The resulting session is linked to the channel transaction automatically.
- Auth and metadata-dependent dynamic capabilities can be compared between two local test principals without exposing credentials.

### Milestone 4: Sandbox debugging

**Outcome:** DevTools explains isolated agent-operated execution and its persistence separately from Node execution.

#### Scope

- Sandbox panel.
- Backend selection and lifecycle timeline.
- Session/subagent ownership and sharing boundaries.
- `/workspace` file browser and text viewer.
- Command/process history with output and exit state.
- Network-policy and credential-brokering presence.
- Bootstrap/prewarm/template reuse/session restore information.
- Links between sandbox actions and Runs.

#### Acceptance criteria

- A developer can identify the active backend and why it was selected.
- A failed sandbox command links to its run action and exposes command, output, policy, and relevant filesystem state.
- Parent/shared and declared-subagent/isolated sandbox behavior is represented accurately.

### Milestone 5: Protocol and performance diagnostics

**Outcome:** Advanced developers can diagnose transports, concurrency, replay, latency, and resource cost.

#### Scope

- Network panel for HTTP, WebSocket, and NDJSON activity.
- Stream cursor, reconnect, buffering, and duplicate/replay inspection.
- Controlled concurrent-delivery tools and delivery/turn causality timeline.
- Turn/model/action/subagent/wait duration breakdown.
- Token, retry, cache, and compaction aggregation.
- Optional CPU/heap profiling through additional CDP domains.
- Framework/generated source visibility controls for Eve contributors.

#### Acceptance criteria

- A developer can distinguish a runtime failure from a buffered or disconnected stream.
- Concurrent deliveries show whether they were buffered, coalesced, routed to a child, dropped after re-keying, or rejected.
- The largest latency and token contributors are identifiable without constructing a separate trace manually.

## Testing strategy

### Unit

- Protocol record parsing and normalization.
- Timeline and tree reducers.
- Redaction.
- Revision and correlation logic.
- CDP event adaptation.
- Source ownership and ignore-list behavior.

### Integration

- Supervisor/runtime IPC.
- Run index persistence.
- Dev observer failure isolation.
- Model-call/state capture at workflow boundaries.
- Log correlation under concurrent async contexts.
- Trigger APIs.

### Scenario

- Start `eve dev`, discover DevTools, send a message, bind a breakpoint, pause, inspect, resume, and complete.
- Rebuild authored source and verify revision/source mapping.
- Park and resume HITL.
- Trigger a schedule and attach to returned sessions.
- Start concurrent projects with ephemeral ports.
- Verify DevTools remains responsive while the runtime child is paused.

### End-to-end

- Exercise representative agent-tools, subagent, channel, schedule, and sandbox fixtures.
- Keep deterministic inspection scenarios independent of external services where possible.
- Use real model evals only for behavior that cannot be represented with a deterministic model/test harness.

## Success measures

Initial qualitative and operational measures:

- A new Eve author can identify the running model, instructions, and available tools without using `eve info` separately.
- A developer can reach the cause of an authored tool failure from the run timeline in under two source-navigation actions.
- The core debug journey succeeds without manually copying session ids or inspector WebSocket URLs.
- Coding agents can discover the same server and primitives without a TTY.
- DevTools recording causes no agent-visible failures in scenario coverage.
- Runtime pause leaves DevTools responsive in all supported local launch modes.

Later telemetry, if added, must be opt-in and privacy-reviewed. Useful aggregate signals would include panel usage, time from failure to source reveal, breakpoint-binding success, and frequency of revision mismatch warnings.

## Risks and mitigations

### DevTools changes local execution topology

Running Nitro in-process inside an inspected child differs from today’s default worker runner.

Mitigation: make parity a milestone-one scenario requirement, retain `--no-devtools`, and measure startup/turn performance before removing the fallback.

### Inspection capture leaks sensitive model or state data

Mitigation: local-only transport, bounded retention, explicit redaction, no implicit telemetry export, clear sensitive-data messaging, and tests for credential-bearing fields.

### Debugger pauses disrupt workflow timeouts or external calls

Mitigation: show the global paused state prominently, document that external clocks continue, and avoid pretending pause is side-effect-free. A future debug mode can relax local-only timeouts where the workflow runtime safely allows it.

### Source maps drift across immutable revisions

Mitigation: preserve revision-specific CDP scripts, keep authored-file mapping tests, show revision mismatch, and avoid silently moving a bound breakpoint between incompatible scripts.

### Event volume overwhelms the browser or runtime

Mitigation: bounded observation buffers, append-only pagination, summary-first state/model views, virtualized lists, and dropping low-priority supplementary records rather than canonical session events.

### Building too many panels before validating correlation

Mitigation: milestone one ships only the core Agent → Runs → Sources → Console loop. Sandbox and Network wait until the correlation model proves useful.

## Open questions

- Should direct interactive `eve dev` eventually open DevTools automatically, or remain URL/command driven?
- What retention limit should apply to local model inputs, state snapshots, and logs?
- Should recent run indexes survive deletion of Workflow local-world data, or be pruned together?
- Which state fields require framework-owned redaction beyond generic key matching?
- Can the runtime child preserve all current TUI setup flows, environment watching, and sandbox prewarm behavior without additional IPC surfaces?
- Should channel simulation begin as raw HTTP only, or define an Eve-owned adapter fixture contract?
- When should the Console enable arbitrary Node evaluation?
- Is SSE sufficient for all non-CDP live feeds, or does one multiplexed DevTools WebSocket materially simplify the implementation?

## Research basis

This PRD is based on the current local-server and runtime behavior in:

- `packages/eve/src/cli/run.ts` and `packages/eve/src/cli/dev/inspector.ts`
- `packages/eve/src/internal/nitro/host/start-development-server.ts`
- `packages/eve/src/internal/nitro/dev-runtime-artifacts.ts`
- `packages/eve/src/internal/nitro/host/dev-source-map-normalize-plugin.ts`
- `packages/eve/src/internal/authored-module-source-map.ts`
- `packages/eve/src/internal/nitro/host/configure-nitro-routes.ts`
- `packages/eve/src/public/channels/eve.ts`
- `packages/eve/src/protocol/message.ts`
- `packages/eve/src/client/session.ts`
- `packages/eve/src/execution/workflow-entry.ts`
- `packages/eve/src/execution/turn-workflow.ts`
- `packages/eve/src/execution/workflow-steps.ts`
- `packages/eve/src/execution/durable-session-store.ts`
- `packages/eve/src/harness/tool-loop.ts`
- `packages/eve/src/internal/nitro/routes/info.ts`
- `packages/eve/src/internal/nitro/routes/dev-schedule-dispatch.ts`
- `packages/eve/src/cli/dev/tui/`
- `packages/eve/src/public/next/`, `nuxt/`, and `sveltekit/`
- The execution, sessions, TUI, dynamic capabilities, state, sandbox, subagent, channel, schedule, and security documentation under `docs/`
