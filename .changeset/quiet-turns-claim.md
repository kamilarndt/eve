---
"eve": patch
---

Prevent replayed turn workflow starts from surfacing duplicate prior-turn events by combining driver-side execution claims with replay-aware client stream cursors. Explicit eve session continuations now fail instead of silently starting a replacement session when delivery loses its active owner.
