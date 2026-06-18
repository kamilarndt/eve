---
title: "Events"
description: "Consume DevTools Server-Sent Events for live runs, logs, debugger state, and observations."
---

DevTools exposes one authenticated Server-Sent Events stream:

```http
GET /api/v1/events
Authorization: Bearer <browserCapability>
```

The stream starts with:

```text
retry: 1000
```

Every event has a numeric `id`, an event name, and JSON data:

```text
id: 12
event: run.event
data: {"sessionId":"session-id","event":{"type":"session.waiting","data":{}},"run":{"sessionId":"session-id","status":"waiting"}}
```

Use the SSE `Last-Event-ID` header to reconnect from the last event id. If the cursor is too old or ahead of the current stream, DevTools sends a reset event:

```text
event: stream.reset
data: {"reason":"cursor_expired","refetch":true}
```

After a reset, refetch the snapshots you care about with `/api/v1/bootstrap`, `/api/v1/runs/:sessionId/events`, and `/api/v1/logs`.

## Event Names

| Event                 | Data                                                          |
| --------------------- | ------------------------------------------------------------- |
| `runtime.state`       | `{ "runtime": { ... } }`                                      |
| `run.registered`      | `{ "run": { ... } }`                                          |
| `run.updated`         | `{ "run": { ... } }`                                          |
| `run.event`           | `{ "sessionId": "...", "event": { ... }, "run": { ... } }`    |
| `run.stream-failed`   | `{ "sessionId": "...", "error": "...", "run": { ... } }`      |
| `log.entry`           | `{ "entry": { ... } }`                                        |
| `source.loaded`       | `{ "revision": "...", "sourceId": "...", "script": { ... } }` |
| `debugger.connection` | `{ "connected": true }`                                       |
| `debugger.controller` | `{ "attached": true }`                                        |
| `debugger.paused`     | `{ "pause": { ... } }`                                        |
| `debugger.resumed`    | `{}`                                                          |
| `observation.record`  | `{ "record": { ... } }`                                       |
| `stream.reset`        | `{ "reason": "cursor_expired", "refetch": true }`             |

Event payloads are intentionally aligned with the snapshot endpoints. For example, `run.event` includes the canonical Eve stream event plus the reduced run summary, while `log.entry` includes the same log entry shape returned by `/api/v1/logs`.

## JavaScript Example

Browser `EventSource` cannot set an `Authorization` header directly. Browser clients should either use a same-origin helper route or a small fetch-based SSE reader. Node scripts can use `fetch`:

```ts
const response = await fetch(new URL("/api/v1/events", baseUrl), { headers });
if (!response.ok || response.body === null) {
  throw new Error(`DevTools SSE failed: ${response.status}`);
}

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const event = Object.fromEntries(
      frame
        .split("\n")
        .filter((line) => line.includes(": "))
        .map((line) => {
          const index = line.indexOf(": ");
          return [line.slice(0, index), line.slice(index + 2)];
        }),
    );
    if (event.event !== undefined && event.data !== undefined) {
      console.log(event.event, JSON.parse(event.data));
    }
    boundary = buffer.indexOf("\n\n");
  }
}
```

## Replay Limits

The global event stream keeps a bounded replay buffer. Run events and logs also have their own bounded histories. Treat cursors as recovery aids, not durable storage.

For durable debugging views, start from `/api/v1/bootstrap`, then subscribe to `/api/v1/events`, and refetch a snapshot if you receive `stream.reset`.
