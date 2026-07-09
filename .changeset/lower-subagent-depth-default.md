---
"eve": patch
---

Lower the default `maxSubagentDepth` from `3` to `1`. Agents that need deeper delegation trees can restore the previous behavior with `defineAgent({ limits: { maxSubagentDepth: 3 } })`.
