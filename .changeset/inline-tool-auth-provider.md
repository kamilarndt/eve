---
"eve": patch
---

Add inline tool auth provider overloads so tools can call `ctx.getToken(provider)` and `ctx.requireAuth(provider)` without declaring a single top-level `auth`.
