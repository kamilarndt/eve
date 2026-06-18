---
title: "Discovery and Auth"
description: "Find the DevTools backend, read the capability token, and make authenticated requests."
---

DevTools writes discovery metadata under the app root:

```text
.eve/devtools/current.json
```

The file is owner-readable (`0600`) and is removed when the DevTools host shuts down cleanly. It is the stable entry point for coding agents, browser launchers, and local scripts.

## Discovery File

The file has schema version `1`:

```json
{
  "appRoot": "/path/to/agent",
  "browserCapability": "64-character-token",
  "devtoolsUrl": "http://127.0.0.1:58456/#token=64-character-token",
  "inspectorUrl": "ws://127.0.0.1:58457/session",
  "runtimeInstanceId": "runtime-id",
  "runtimePid": 12345,
  "runtimeUrl": "http://127.0.0.1:58459/",
  "schemaVersion": 1,
  "updatedAt": "2026-06-20T00:00:00.000Z"
}
```

`inspectorUrl`, `runtimePid`, and `runtimeUrl` are present only after the runtime reports them. Use the DevTools API rather than reading the raw inspector URL unless you specifically need compatibility with another CDP client.

## Base URL and Token

The `devtoolsUrl` contains the token in the URL fragment. Fragments are not sent to the server, so API clients must send the token in the `Authorization` header.

```ts
import { readFile } from "node:fs/promises";

const discovery = JSON.parse(await readFile(".eve/devtools/current.json", "utf8")) as {
  browserCapability: string;
  devtoolsUrl: string;
};

const baseUrl = new URL(discovery.devtoolsUrl);
baseUrl.hash = "";

const headers = {
  authorization: `Bearer ${discovery.browserCapability}`,
};

const response = await fetch(new URL("/api/v1/bootstrap", baseUrl), { headers });
console.log(await response.json());
```

## Authentication Rules

All `/api/v1/*` endpoints require `Authorization: Bearer <browserCapability>` except:

- `GET /api/v1/health`

Requests must also use the exact loopback host and port of the DevTools server. If an `Origin` header is present, it must match that same loopback origin.

The debugger WebSocket does not accept the bearer token directly. Mint a short-lived ticket with `POST /api/v1/debugger/tickets`, then connect to `/api/v1/debugger?ticket=<ticket>`.

## Request Bodies

JSON request bodies must use:

```text
Content-Type: application/json
```

The current body size limit is 1 MiB. Empty JSON bodies are accepted only by endpoints that do not need a payload. Run creation and continuation require a non-empty `message` string.

## Error Shape

HTTP errors use this JSON shape:

```json
{
  "code": "unauthorized",
  "error": "Missing or invalid DevTools capability.",
  "ok": false
}
```

Common statuses:

| Status | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| `400`  | Invalid JSON or invalid request payload                  |
| `401`  | Missing or invalid capability                            |
| `403`  | Host or Origin is not allowed                            |
| `404`  | Route, run, or source was not found                      |
| `409`  | Runtime state or cursor state cannot satisfy the request |
| `413`  | Request body or source file is too large                 |
| `415`  | Expected `application/json`                              |
| `503`  | Runtime, debugger, or run capacity is unavailable        |

## Stable Runtime Pointer

DevTools also adds metadata to `.eve/dev-server.json`, while preserving the existing `url`, `pid`, and `updatedAt` fields used by other local tools. Use `.eve/devtools/current.json` for DevTools credentials because it is owner-readable and includes the capability token.
