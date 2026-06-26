---
"eve": patch
---

Prevent workflow step replays from surfacing duplicate stream events to TypeScript client consumers. Durable events now carry stable IDs, and client cursors advance past replayed records without yielding them.
