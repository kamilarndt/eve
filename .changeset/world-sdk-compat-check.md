---
"eve": patch
---

Self-hosted deployments that configure a custom Workflow world now get an actionable error at startup when the installed world package requires a different `@workflow/world` major than the one bundled by eve. Previously, the mismatch surfaced later as an unrelated `ZodError` during the first workflow run. The docs for `experimental.workflow.world` now show how to pin a compatible world package version.
