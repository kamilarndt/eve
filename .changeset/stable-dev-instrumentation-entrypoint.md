---
"eve": patch
---

`eve dev` now keeps its Nitro instrumentation entrypoint stable when authored instrumentation is added or removed. Instrumentation changes trigger a structural reload without leaving retained plugin paths that import deleted files.
