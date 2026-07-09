---
"eve": patch
---

Add SSRF protection to outbound requests whose host comes from author, tenant, or model input. A new safe-fetch wrapper resolves the target host and refuses to connect to private, loopback (when hardened), link-local, or cloud-metadata addresses (e.g. `169.254.169.254`), pins the transport to https (loopback http allowed for local dev), re-validates every redirect hop, and drops credentials on cross-origin redirects. It now guards the OpenAPI spec and operation calls, the `web_fetch` tool, remote-agent dispatch, OIDC discovery and JWKS, MCP connections, and session callbacks. Session callbacks and non-loopback OpenAPI/callback URLs now require https.
