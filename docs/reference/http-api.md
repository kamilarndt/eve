---
title: "HTTP API"
description: "Complete request, response, authentication, and streaming contract for the built-in eve channel."
---

The built-in eve channel serves JSON session routes and an NDJSON event stream under `/eve/v1`. Examples below assume local `eve dev` at `http://127.0.0.1:2000`; use the URL printed by the command when it selects another port.

Except for health, routes use the `auth` policy in `agent/channels/eve.ts`. Send its required cookie or `Authorization` header on the create request, every follow-up, and every stream connection or reconnect.

## Routes

| Method | Path                                | Success | Purpose                                       |
| ------ | ----------------------------------- | ------- | --------------------------------------------- |
| `GET`  | `/eve/v1/health`                    | `200`   | Public process health.                        |
| `GET`  | `/eve/v1/info`                      | `200`   | Authenticated agent inspection.               |
| `POST` | `/eve/v1/session`                   | `202`   | Create a session and dispatch its first turn. |
| `POST` | `/eve/v1/session/:sessionId`        | `200`   | Send a follow-up or input response.           |
| `GET`  | `/eve/v1/session/:sessionId/stream` | `200`   | Read or replay session events.                |

Provider channels and framework-owned callbacks add other routes; their guides document those contracts.

## Health

```bash
curl --fail http://127.0.0.1:2000/eve/v1/health
```

```json
{
  "ok": true,
  "status": "ready",
  "workflowId": "..."
}
```

Health does not test a model credential, workflow write, sandbox, connection, or tool.

## Inspect the running agent

`GET /eve/v1/info` returns the model routing decision and discovered instructions, tools, skills, connections, channels, schedules, hooks, sandbox, subagents, and diagnostics used by the running build. The schema is exported as `AgentInfoResult` from `eve/client`.

Local loopback requests are accepted by the default inspection policy. A deployment requires its configured authentication, including Vercel OIDC where used.

## Create a session

```bash
curl --fail-with-body \
  --request POST http://127.0.0.1:2000/eve/v1/session \
  --header 'content-type: application/json' \
  --data '{"message":"Summarize the sample orders."}'
```

Success is `202 Accepted`:

```json
{
  "ok": true,
  "sessionId": "<session-id>",
  "continuationToken": "<continuation-token>"
}
```

The response also sends `x-eve-session-id` and `cache-control: no-store`.

### Create body

| Field           | Required | Type                                           | Behavior                                                                     |
| --------------- | -------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `message`       | Yes      | non-empty string or text/file part array       | First user message.                                                          |
| `clientContext` | No       | string, non-empty string array, or JSON object | Ephemeral context for the next model call; not durable conversation history. |
| `outputSchema`  | No       | JSON-serializable object                       | JSON Schema for structured task output.                                      |
| `mode`          | No       | `"conversation"` or `"task"`                   | Runtime mode. Most interactive clients omit it.                              |
| `callback`      | No       | callback metadata object                       | Framework remote-agent callback; applications normally omit it.              |

A message part is one of:

```ts
type TextPart = { type: "text"; text: string };

type FilePart = {
  type: "file";
  data: string; // base64, data URL, or URL
  mediaType: string;
  filename?: string;
};
```

The channel rejects framework-internal reference schemes supplied by a client. Upload policy can reject a file with `413` or `415` before a turn starts.

## Stream events

Open the stream after session creation:

```bash
curl --no-buffer \
  http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream
```

The response is `application/x-ndjson; charset=utf-8`, one event object per line. It includes:

```text
x-eve-session-id: <sessionId>
x-eve-stream-format: ndjson
x-eve-stream-version: 16
cache-control: no-store, no-transform
x-accel-buffering: no
```

Check the format and version headers rather than assuming an arbitrary JSON stream. The event union and current version constants are exported through `eve/client`. See [Stream Events](./stream-events) for every event payload.

### Reconnect

`startIndex` is the number of events already consumed. It must be a non-negative safe integer.

```bash
curl --no-buffer \
  'http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=12'
```

The server replays from that event offset. Persist the offset only after your client has processed the event.

## Send a follow-up

Wait for `session.waiting`, then post to the same `sessionId`:

```bash
curl --fail-with-body \
  --request POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  --header 'content-type: application/json' \
  --data '{
    "continuationToken":"<continuation-token>",
    "message":"Now give me the short version."
  }'
```

Success is:

```json
{ "ok": true, "sessionId": "<session-id>" }
```

The follow-up body requires `continuationToken` and at least one of `message` or a non-empty `inputResponses` array. It may also carry `clientContext` and `outputSchema`.

Do not treat the continuation token as a general queue address. Send one turn at a time for deterministic ordering.

## Respond to human input

Read request objects from `input.requested.data.requests`, then submit responses:

```json
{
  "continuationToken": "<continuation-token>",
  "inputResponses": [{ "requestId": "<request-id>", "optionId": "approve" }]
}
```

An input response has `requestId` plus optional `optionId` and optional freeform `text`. Match the request's options and `allowFreeform` contract. Multiple pending requests may be answered in one array.

## Structured output

Pass a JSON Schema object in `outputSchema`. A successful structured result arrives as `result.completed.data.result`. The server is authoritative for schema validation. The TypeScript client accepts Standard Schema implementations and lowers them to JSON Schema before sending.

## Errors

JSON failures use an `error` string and `ok: false`; some include `code`, `errorId`, `details`, or upload `violations`.

| Status | Typical cause                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid JSON, missing message or continuation token, invalid part, schema, response, callback, mode, or `startIndex`. |
| `401`  | No auth strategy accepted the request.                                                                                |
| `403`  | Authenticated caller is forbidden by the route policy.                                                                |
| `404`  | Session ID is unknown to the active workflow store.                                                                   |
| `413`  | An upload exceeds policy size.                                                                                        |
| `415`  | An upload media type is not allowed.                                                                                  |
| `500`  | Authored `onMessage` or runtime processing failed. Record the returned error ID.                                      |

`204 No Content` means an authored `onMessage` handler intentionally accepted but did not dispatch the message.
