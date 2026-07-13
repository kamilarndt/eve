---
"eve": patch
---

`eve dev` now coordinates authored-source rebuilds without Rolldown racing deleted or renamed modules, and pruning preserves the active runtime snapshot across aliased filesystem roots. Production builds use invocation-owned compiler, host, Nitro, workflow, and output workspaces, so `eve build` can run alongside a live development server without corrupting it.
