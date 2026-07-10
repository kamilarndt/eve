---
"eve": patch
---

The Slack channel's default `actions.requested` typing indicator now uses capitalized action names with framework-selected arguments, groups repeated action names (`5 Bash sh -c script/foo.sh`), and preserves `+N more` for mixed batches. The exported label helpers avoid arbitrary authored-tool input and redact credential-bearing built-in command and URL details.
