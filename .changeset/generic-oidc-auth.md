---
"eve": minor
---

Removed the client-only `auth: { vercelOidc: { token } }` shape in favor of generic OpenID Connect client auth through `auth: { oidc: token }`, `oidc()`, or `vercelOidcAuth()`. Remote `eve dev <url>` can now use `EVE_DEV_OIDC_TOKEN` for generic OIDC route auth, or repeated `--header "Name: value"` flags for static self-hosted route headers.
