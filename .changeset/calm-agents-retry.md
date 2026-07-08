---
"eve": patch
---

Transient provider errors delivered inside a model stream, including Anthropic overload events, now retry the current model call with backoff. Subagents preserve completed earlier work across those attempts, and partial failed output or unexecuted local tool proposals are cleared before a retry.
