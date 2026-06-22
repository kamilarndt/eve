---
"eve": patch
---

Add inline tool auth provider overloads so tools can call `ctx.getToken(provider, options?)` and `ctx.requireAuth(provider, options?)` without declaring a single top-level `auth`. Vercel Connect providers can be authored inline with `connect("service/agent")` or `connect({ connector, tokenParams })`; the existing top-level tool `auth` field and no-argument tool auth accessors remain supported for compatibility, but are now deprecated in favor of inline providers.
