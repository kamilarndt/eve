---
"eve": patch
---

Make the TypeScript client suppress exact re-deliveries from Workflow while preserving the physical reconnect cursor. Stream event IDs now derive from Workflow's stable run and step IDs plus a step-local ordinal, and every previously unseen ID remains visible to consumers.
