---
title: "Authentication"
description: "Authenticate inbound eve HTTP routes with cookies, bearer tokens, or Vercel OIDC."
---

Authenticate every production route before the model or a tool does work. For a same-origin browser
app, reuse the application's signed cookie session. For service clients, verify a bearer token. Use
Vercel OIDC only for callers that actually run as Vercel workloads.

Route authentication decides who may create, continue, and stream an eve session. It runs on:

- `POST /eve/v1/session`
- `POST /eve/v1/session/:sessionId`
- `GET /eve/v1/session/:sessionId/stream`

`GET /eve/v1/health` remains public for health checks. Outbound credentials for MCP and OpenAPI tools are separate; see [Connection Authentication](../connect/connections/authentication).

## Auth walk

Set `auth` on `agent/channels/eve.ts` to one `AuthFn<Request>` or an ordered array:

```ts title="agent/channels/eve.ts" check
import { localDev, placeholderAuth } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [localDev(), placeholderAuth()],
});
```

Each function can:

- return a `SessionAuthContext` to accept the request;
- return `null` or `undefined` to try the next function;
- throw `UnauthenticatedError` or `ForbiddenError` for an explicit `401` or `403`.

If the walk ends without a principal, eve returns `401`. `auth: []` rejects every request. Anonymous access requires an explicit final `none()`.

> **Why this default:** `placeholderAuth()` deliberately returns a production `401` so a scaffold
> cannot become an anonymous production API by accident. Replace it before serving a production
> browser UI. `localDev()` accepts loopback requests; it is a development convenience, not
> production identity.

## Same-origin cookie session

Use a custom `AuthFn` when your web application already owns a signed cookie session. The following complete eve adapter assumes `verifyAppSession(request)` is your application's existing server-side verifier:

```ts title="agent/channels/eve.ts"
import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { verifyAppSession } from "../../src/server/auth.js";

const appSession: AuthFn<Request> = async (request) => {
  const session = await verifyAppSession(request);
  if (!session) return null;

  return {
    authenticator: "app-cookie",
    principalId: session.userId,
    principalType: "user",
    attributes: {
      tenantId: session.tenantId,
      roles: session.roles,
    },
  };
};

export default eveChannel({
  auth: [appSession, localDev()],
});
```

Run this route on the same origin as the application so normal secure-cookie rules apply. Validate CSRF assumptions for state-changing cross-origin requests, and do not trust an unsigned user ID from the request body.

## Bearer clients

For an OIDC issuer, verify bearer tokens directly:

```ts title="agent/channels/eve.ts"
import { localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    localDev(),
    oidc({
      issuer: "https://identity.example.com",
      audiences: ["eve-api"],
      subjects: ["user:*", "service:reporter"],
    }),
  ],
});
```

The client sends `Authorization: Bearer <token>`. `oidc()` validates issuer metadata, signature, time claims, audience, and optional subject or claim matchers. `jwtHmac()` and `jwtEcdsa()` are available when you control the token format; `httpBasic()` is suitable for narrow operator or service access.

```ts
import { Client } from "eve/client";

const client = new Client({
  host: "https://agent.example.com",
  auth: { bearer: async () => await getAccessToken() },
  redirect: "error",
});
```

Resolve rotating credentials through a function. Use `redirect: "manual"` or `"error"` so a redirect cannot forward custom authorization headers to another origin.

## Vercel-to-Vercel OIDC

Use `vercelOidc()` when the caller receives a Vercel OIDC token and the agent runs on Vercel:

```ts title="agent/channels/eve.ts"
import { localDev, vercelOidc, vercelSubject } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    localDev(),
    vercelOidc({
      subjects: [
        vercelSubject({
          teamSlug: "acme",
          projectName: "reporting-service",
          environment: "production",
        }),
      ],
    }),
  ],
});
```

The calling Vercel workload passes its `VERCEL_OIDC_TOKEN` as a bearer token. `vercelSubject` builds the exact subject pattern and defaults the environment to production when omitted. Use slugs, not `team_…` or `prj_…` IDs.

## Runtime identity and authorization

Accepted identity appears in `ctx.session.auth`:

- `current` is the caller for this turn.
- `initiator` is the caller that created the session.

> **Security consequence:** A later caller can reach a known session if your route policy accepts
> them. Route authentication does **not** add a per-session ownership ACL. Enforce tenant and
> resource authorization in your auth adapter, tools, and upstream services. A session ID is an
> identifier, not authorization.

## Custom channels

Call `routeAuth(request, auth)` from a `defineChannel` route to reuse the same ordered behavior. Low-level exports include `extractBearerToken`, `verifyHttpBasic`, `verifyJwtHmac`, `verifyJwtEcdsa`, `verifyOidc`, `verifyVercelOidc`, `createUnauthorizedResponse`, and IP allow-list helpers.

Verify platform webhook signatures over the raw request body before deriving identity. Built-in provider channels do this inside their adapters; custom channels must implement it.

## Verification checklist

Before production, test all four cases against the deployed URL:

1. No credential returns `401`.
2. A malformed or expired credential returns `401`.
3. A valid but unauthorized principal returns `403` where appropriate.
4. A valid caller can create, stream, and continue one session.

Keep route secrets in the deployment environment. They are evaluated by authored server code and should not be placed in source, client bundles, prompts, or sandbox files.
