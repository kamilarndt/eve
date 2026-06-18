---
title: "Debugger"
description: "Connect to the DevTools Chrome DevTools Protocol relay with short-lived tickets."
---

DevTools relays Chrome DevTools Protocol messages to the Node inspector running in the inspected Eve runtime child.

Use the relay instead of connecting to the raw `inspectorUrl` from discovery. The relay keeps debugger access behind the same loopback, origin, and capability model as the rest of DevTools, and it lets the supervisor observe pause, resume, script, console, and exception state.

## Controller Lease

The backend supports one controlling debugger WebSocket at a time. Additional tabs or agents can still read snapshots, logs, sources, and SSE events, but only one client owns CDP control.

When a controller is connected, `/api/v1/debugger/state` reports:

```json
{
  "debugger": {
    "connected": true,
    "controllerAttached": true
  },
  "schemaVersion": 1
}
```

A second WebSocket upgrade receives `409 Conflict` until the first controller disconnects.

## Connect

Mint a ticket through the authenticated HTTP API:

```ts
const ticketResponse = await fetch(new URL("/api/v1/debugger/tickets", baseUrl), {
  headers,
  method: "POST",
});

const { ticket } = (await ticketResponse.json()) as { ticket: string };
```

Tickets expire after 30 seconds and are single-use. Open the WebSocket with the ticket:

```ts
const debuggerUrl = new URL(`/api/v1/debugger?ticket=${ticket}`, baseUrl);
debuggerUrl.protocol = "ws:";

const socket = new WebSocket(debuggerUrl);
```

After the socket opens, send CDP messages as JSON text frames:

```ts
let nextId = 1;

function command(method: string, params?: unknown): void {
  socket.send(JSON.stringify({ id: nextId++, method, params }));
}

socket.addEventListener("open", () => {
  command("Runtime.enable");
  command("Debugger.enable");
});
```

## Useful CDP Domains

The first DevTools backend is designed around these CDP domains:

| Domain     | Use                                                            |
| ---------- | -------------------------------------------------------------- |
| `Runtime`  | Console events, evaluation, exception records                  |
| `Debugger` | Script parsing, breakpoints, pause/resume, call frames, scopes |

The relay is a transport. It does not wrap every CDP command into a separate Eve endpoint. Use standard CDP commands such as `Debugger.enable`, `Debugger.setBreakpoint`, `Debugger.resume`, and `Debugger.evaluateOnCallFrame`.

## Pause Behavior

When the runtime pauses, the runtime child is stopped at the JavaScript breakpoint. The DevTools host remains responsive because it runs in the supervisor.

While paused:

- `GET /api/v1/health` reports `runtime.status: "paused"`.
- `GET /api/v1/bootstrap` remains available.
- `GET /api/v1/debugger/state` includes the latest `pause` payload.
- `GET /api/v1/logs` and `/api/v1/events` remain available.
- New run interaction may fail with `runtime_unavailable` until the runtime resumes.

When CDP sends `Debugger.resumed`, the runtime status returns to `ready` if it was paused.

## Source Binding

Use `/api/v1/sources` to list authored files and loaded scripts. A source entry becomes `loaded: true` after the debugger observer associates a parsed generated script with the authored file through its source map.

To bind an authored TypeScript breakpoint, request `/api/v1/sources/:sourceId/locations?line=<one-based-line>`, then pass each returned location to `Debugger.setBreakpoint`. Source-map files are resolved by the supervisor because browser JavaScript cannot read local `file://` maps.

When paused, pass a frame's generated `scriptId`, `lineNumber`, and `columnNumber` to `/api/v1/sources/resolve` to display its authored file and position.

## Console and Exceptions

The supervisor observes:

- `Runtime.consoleAPICalled`
- `Runtime.exceptionThrown`
- `Debugger.paused`
- `Debugger.resumed`
- `Debugger.scriptParsed`

Console and exception records appear in `/api/v1/logs` and the `log.entry` SSE stream with `stream: "console"`.
