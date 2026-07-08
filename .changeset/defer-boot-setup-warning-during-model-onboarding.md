---
"eve": patch
---

Fix a startup flash where the dev TUI briefly showed a "model provider not linked" warning before the `/model` onboarding flow that `eve init` triggers had a chance to resolve it. The warning now waits for that onboarding to settle before it can render.
