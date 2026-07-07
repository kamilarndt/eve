---
"eve": patch
---

Turns are now cancellable at the workflow layer: each turn registers a durable per-turn cancel hook, and resuming it mid-turn aborts the in-flight model, tool, and subagent-wait work in real time. A cancelled turn settles as a new `turn.cancelled` stream event followed by `session.waiting` — never as a failure — keeps whatever it streamed before the abort, discards pending subagent dispatch state, and leaves the session ready for the next message (stream version 18). No public trigger exists yet; the HTTP cancellation API ships in a following release.
