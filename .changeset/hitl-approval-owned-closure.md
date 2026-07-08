---
"eve": patch
---

Approval-gated tools now execute during the resume itself: eve runs the approved tool and records its result before the next model call, and every outbound model request is checked so a tool call can never replay without a result. This fixes approve-resume failing with provider 400s (Anthropic `tool_use` without `tool_result`, OpenAI `No tool output found for function call`) — including when a channel attaches context to the approving prompt — and heals sessions whose history already carries a dangling tool call. A message sent together with an approval response now lands in the same model call instead of a deferred follow-up step.
