---
title: "DevTools"
description: "Inspect runs, agent definitions, authored sources, and console output from eve dev."
---

DevTools is Eve's local browser debugger. It combines session-aware Runs and Agent inspection with authored TypeScript breakpoints, call frames, scopes, expression evaluation, and correlated Console output. Coding agents use the same versioned local API as the browser.

Start Eve normally:

```bash
eve dev
```

For scripts and coding agents, `--no-ui` is often easier:

```bash
eve dev --no-ui --host 127.0.0.1 --port 0
```

After an interactive local runtime is ready, Eve opens the capability-bearing DevTools URL in your default browser. It also prints the URL and writes it to `.eve/devtools/current.json`. Headless launches from `--no-ui`, non-TTY terminals, and framework integrations keep the host available without opening a browser. Use `--no-devtools` when you explicitly want the lower-overhead legacy development path.

## What DevTools Exposes

- A loopback HTTP API under `/api/v1`.
- A bundled browser app with Runs, Agent, Sources, and Console panels.
- A discovery file with the DevTools URL, capability token, runtime instance id, and runtime URL.
- A live Server-Sent Events stream for runtime, run, debugger, source, observation, and log updates.
- Run creation and continuation through Eve's canonical session protocol.
- Agent snapshot data from the runtime info route.
- Authored source listing, bounded source retrieval, and source-map location resolution.
- A Chrome DevTools Protocol WebSocket relay protected by short-lived tickets.
- Bounded stdout, stderr, system, console, and exception logs.

The browser and coding agents are peers: both authenticate with the same local capability and consume the same API, SSE stream, source catalog, and debugger relay.

## Browser Workflow

1. Run `eve dev` and use the DevTools browser tab that opens after the runtime is ready. For a headless launch, open the printed URL manually.
2. Use **Agent** to confirm the resolved model, tools, instructions, diagnostics, and source provenance.
3. In **Runs**, enter a message to create the first session and start its turn. Chat shows your message immediately, then streams assistant text, reasoning, and tool calls. Switch to **Timeline** to select and inspect individual durable events. Use **New** when you want to prepare another empty session explicitly.
4. Reveal the action in **Sources**, then click the gutter beside an executable TypeScript line to add a breakpoint.
5. Send the next message from Runs. When the runtime pauses, inspect the authored call stack and local scope in Sources.
6. Open the **Console** drawer with Escape, filter by the selected session, or evaluate an expression in the paused frame.
7. Resume with the Sources toolbar or F8 and return to Runs to observe completion.

Only one browser tab or coding agent can control the debugger at a time. Read-only API, source, log, and event access remains available to other clients.

## Process Model

With DevTools enabled, `eve dev` starts a supervisor and an inspected runtime child. The runtime child owns Nitro, the Workflow local world, authored agent code, and the Node inspector. The supervisor owns the DevTools API, discovery metadata, logs, run index, event replay, and debugger relay.

This split matters because a Node breakpoint pauses the runtime child, but the DevTools API can still answer health, bootstrap, log, and debugger requests from the supervisor.

## Safety Model

DevTools is a trusted local development surface. It binds to loopback, writes owner-readable metadata, and protects all sensitive endpoints with a per-process capability token. The debugger relay can execute arbitrary code in the local runtime through CDP, so treat access to `.eve/devtools/current.json` as equivalent to local code execution in the agent process.

DevTools is not mounted in production and does not add a public remote debugging API.

## Read Next

- [Discovery and auth](./discovery-and-auth): find the backend and authenticate requests.
- [Endpoints](./endpoints): complete `/api/v1` HTTP reference.
- [Events](./events): consume the live SSE stream.
- [Debugger](./debugger): connect to the CDP relay.
- [CLI reference](../../reference/cli): all `eve dev` flags.
