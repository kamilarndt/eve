---
"eve": patch
---

Restrict eve-rendered Slack human-in-the-loop controls to the user who initiated the current turn. Other users receive an ephemeral explanation and their interactions are ignored, while legacy controls retain their existing behavior and turns without a Slack caller render a non-actionable prompt.
