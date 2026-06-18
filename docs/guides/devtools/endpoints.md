---
title: "Endpoints"
description: "Reference for the DevTools /api/v1 HTTP endpoints."
---

All endpoints are rooted at the DevTools origin discovered from `.eve/devtools/current.json`. Except for health, add the browser capability:

```text
Authorization: Bearer <browserCapability>
```

Every JSON response includes `schemaVersion: 1`.

## Endpoint Summary

| Method | Path                                              | Description                                                 |
| ------ | ------------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/api/v1/health`                                  | Unauthenticated coarse host and runtime status              |
| `GET`  | `/api/v1/bootstrap`                               | Agent snapshot, runtime state, debugger state, and run list |
| `GET`  | `/api/v1/agent`                                   | Agent snapshot and runtime state                            |
| `GET`  | `/api/v1/events`                                  | Live Server-Sent Events stream                              |
| `GET`  | `/api/v1/runs`                                    | Current-process run summaries                               |
| `POST` | `/api/v1/runs`                                    | Create a new run with a user message                        |
| `GET`  | `/api/v1/runs/:sessionId`                         | One run summary                                             |
| `GET`  | `/api/v1/runs/:sessionId/events?cursor=<cursor>`  | Replay retained events for one run                          |
| `POST` | `/api/v1/runs/:sessionId/messages`                | Continue a waiting run                                      |
| `GET`  | `/api/v1/sources`                                 | Authored source catalog                                     |
| `GET`  | `/api/v1/sources/:sourceId`                       | Bounded authored source content                             |
| `GET`  | `/api/v1/sources/:sourceId/locations?line=<line>` | Generated CDP locations for an authored line                |
| `GET`  | `/api/v1/sources/resolve?scriptId=&line=&column=` | Authored location for a generated CDP location              |
| `GET`  | `/api/v1/debugger/state`                          | Debugger observer, controller, and pause state              |
| `POST` | `/api/v1/debugger/tickets`                        | Mint a short-lived debugger WebSocket ticket                |
| `GET`  | `/api/v1/debugger?ticket=<ticket>`                | CDP WebSocket relay                                         |
| `GET`  | `/api/v1/logs?cursor=<cursor>`                    | Bounded log replay                                          |

## Health

```http
GET /api/v1/health
```

Health does not require authentication and intentionally exposes no ports, process ids, tokens, inspector URLs, or agent data.

```json
{
  "ok": true,
  "runtime": {
    "status": "ready"
  },
  "schemaVersion": 1
}
```

`runtime.status` is one of `starting`, `ready`, `paused`, `crashed`, or `stopped`.

## Bootstrap

```http
GET /api/v1/bootstrap
```

Bootstrap is the first authenticated call a UI or agent should make.

```json
{
  "agent": {},
  "debugger": {
    "connected": true,
    "controllerAttached": false
  },
  "runs": [],
  "runtime": {
    "revision": "rev-1",
    "runtimeInstanceId": "runtime-1",
    "runtimePid": 12345,
    "runtimeUrl": "http://127.0.0.1:58459/",
    "status": "ready"
  },
  "schemaVersion": 1
}
```

`agent` is the runtime's resolved Eve info payload. When the runtime is paused, crashed, or temporarily unreachable, DevTools returns the last cached agent snapshot when available and adds `diagnostics`.

The public runtime object never includes the raw `inspectorUrl`. Use debugger tickets for CDP access.

## Agent

```http
GET /api/v1/agent
```

Returns the same agent snapshot and public runtime state used by bootstrap:

```json
{
  "agent": {},
  "runtime": {
    "runtimeInstanceId": "runtime-1",
    "status": "ready"
  },
  "schemaVersion": 1
}
```

Use this endpoint when you need to refresh agent metadata without also fetching runs and debugger state.

## Runs

Run summaries are process-local in this milestone. They include runs created through the DevTools API during the current `eve dev` process.

```http
GET /api/v1/runs
```

```json
{
  "runs": [
    {
      "createdAt": "2026-06-20T00:00:00.000Z",
      "eventCount": 12,
      "retainedEventCount": 12,
      "sessionId": "session-id",
      "status": "waiting",
      "title": "What is the weather in Berlin?",
      "updatedAt": "2026-06-20T00:00:01.000Z"
    }
  ],
  "schemaVersion": 1
}
```

`status` is one of `running`, `waiting`, `completed`, or `failed`.

### Create a Run

```http
POST /api/v1/runs
Content-Type: application/json
```

```json
{
  "message": "What is the weather in Berlin?"
}
```

Response:

```json
{
  "run": {
    "createdAt": "2026-06-20T00:00:00.000Z",
    "eventCount": 0,
    "retainedEventCount": 0,
    "sessionId": "session-id",
    "status": "running",
    "title": "What is the weather in Berlin?",
    "updatedAt": "2026-06-20T00:00:00.000Z"
  },
  "schemaVersion": 1
}
```

DevTools returns `202 Accepted` after creating the canonical Eve session and starts pumping session stream events in the background.

### Get a Run

```http
GET /api/v1/runs/:sessionId
```

Returns one run summary:

```json
{
  "run": {
    "createdAt": "2026-06-20T00:00:00.000Z",
    "eventCount": 12,
    "retainedEventCount": 12,
    "sessionId": "session-id",
    "status": "waiting",
    "title": "What is the weather in Berlin?",
    "updatedAt": "2026-06-20T00:00:01.000Z"
  },
  "schemaVersion": 1
}
```

### Replay Run Events

```http
GET /api/v1/runs/:sessionId/events?cursor=0
```

Response:

```json
{
  "events": [
    {
      "cursor": "1",
      "event": {
        "type": "session.started",
        "data": {}
      },
      "sessionId": "session-id"
    }
  ],
  "nextCursor": "12",
  "run": {
    "createdAt": "2026-06-20T00:00:00.000Z",
    "eventCount": 12,
    "retainedEventCount": 12,
    "sessionId": "session-id",
    "status": "waiting",
    "updatedAt": "2026-06-20T00:00:01.000Z"
  },
  "schemaVersion": 1
}
```

Pass the last `nextCursor` value on the next poll. A stale cursor returns `409` with `code: "cursor_expired"`.

### Continue a Run

```http
POST /api/v1/runs/:sessionId/messages
Content-Type: application/json
```

```json
{
  "message": "Use Celsius."
}
```

The run must be at a `waiting` boundary. If it is still `running`, DevTools returns `409` with `code: "run_not_waiting"`.

## Sources

```http
GET /api/v1/sources
```

Returns authored files under the app root, excluding build output, `.eve`, dependencies, workflow data, and other generated directories.

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "id": "agent/tools/get_weather.ts",
      "kind": "authored",
      "loaded": true,
      "path": "agent/tools/get_weather.ts",
      "revision": "rev-1",
      "scripts": [
        {
          "scriptId": "42",
          "sourceMapUrl": "file:///...",
          "url": "file:///path/to/agent/tools/get_weather.ts"
        }
      ]
    }
  ]
}
```

`loaded` means the debugger observer has seen a CDP `Debugger.scriptParsed` event for that source.

### Get Source Content

```http
GET /api/v1/sources/:sourceId
```

`sourceId` is the source path encoded as one path segment. Use `encodeURIComponent`, including for slashes:

```ts
const sourceId = encodeURIComponent("agent/tools/get_weather.ts");
const response = await fetch(new URL(`/api/v1/sources/${sourceId}`, baseUrl), { headers });
```

Response:

```json
{
  "content": "export async function getWeather() { ... }\n",
  "schemaVersion": 1,
  "source": {
    "id": "agent/tools/get_weather.ts",
    "kind": "authored",
    "loaded": true,
    "path": "agent/tools/get_weather.ts",
    "revision": "rev-1",
    "scripts": []
  }
}
```

Only authored JavaScript, TypeScript, JSON, Markdown, and YAML files can be read. Files outside the app root and files over 2 MiB are rejected.

### Resolve a Breakpoint Location

```http
GET /api/v1/sources/:sourceId/locations?line=21
```

The line is one-based and refers to the authored source. DevTools reads the runtime's source maps on the trusted host and returns the generated CDP locations that a debugger controller can pass to `Debugger.setBreakpoint`:

```json
{
  "locations": [
    {
      "columnNumber": 4,
      "lineNumber": 112,
      "scriptId": "42"
    }
  ],
  "schemaVersion": 1
}
```

This keeps local `file://` source maps on the trusted side while allowing the browser and coding agents to bind identical authored breakpoints.

For pause frames, `/api/v1/sources/resolve` performs the inverse mapping. Its `line` and `column` query values are zero-based CDP coordinates; the returned authored `line` and `column` are one-based for display.

## Logs

```http
GET /api/v1/logs?cursor=0
```

Response:

```json
{
  "entries": [
    {
      "cursor": "7",
      "level": "info",
      "message": "from authored tool",
      "source": {
        "line": 12,
        "url": "file:///path/to/agent/tools/get_weather.ts"
      },
      "stream": "console",
      "timestamp": "2026-06-20T00:00:00.000Z"
    }
  ],
  "nextCursor": "7",
  "schemaVersion": 1
}
```

`stream` is one of `stdout`, `stderr`, `system`, or `console`. Log fields are depth-limited, size-limited, and redact keys that look like credentials.

## Debugger State and Tickets

```http
GET /api/v1/debugger/state
```

```json
{
  "debugger": {
    "connected": true,
    "controllerAttached": false,
    "pause": {
      "reason": "other"
    }
  },
  "schemaVersion": 1
}
```

Mint a WebSocket ticket:

```http
POST /api/v1/debugger/tickets
```

```json
{
  "expiresInMs": 30000,
  "schemaVersion": 1,
  "ticket": "single-use-ticket"
}
```

Then connect to:

```text
ws://127.0.0.1:<port>/api/v1/debugger?ticket=<single-use-ticket>
```

See [Debugger](./debugger) for the CDP relay workflow.
