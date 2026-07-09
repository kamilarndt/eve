---
"eve": patch
---

Emit `$eve.last_issue_source`, `$eve.last_issue_turn_id`, and `$eve.last_issue_tool_call_id` with issue summaries, including `remote_subagent` for remote agent failures, so observability clients can filter agent runs and deep link to the affected turn without replaying traces.
