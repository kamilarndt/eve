---
"eve": patch
---

Task-mode (subagent) runs no longer fail permanently on transient model errors such as a mid-stream provider overload. The harness now rethrows non-terminal model-call failures so the durable workflow engine retries the step from the last committed session state, preserving completed work; the run only ends with a failed subagent result once retries are exhausted or the error is unrecoverable.
