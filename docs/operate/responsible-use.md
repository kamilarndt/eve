---
title: "Responsible Use"
description: "Baseline safeguards for identity, data, side effects, communications, telemetry, and human oversight."
---

We provide execution, durability, and isolation primitives. We cannot decide whether your
application, data use, or external action is appropriate. The team that deploys the agent remains
responsible for its behavior, users, data handling, and connected services.

Before production:

- Authenticate inbound routes and enforce tenant and resource authorization.
- Scope tool and connection credentials to the minimum required access.
- Require approval or a stronger policy for irreversible, financial, legal, safety-impacting, employment, housing, healthcare, or external communication actions.
- Make external side effects idempotent. Durable retries can repeat an interrupted step.
- Configure sandbox egress and avoid putting secrets in prompts, tool results, or `/workspace`.
- Review what user content, model traffic, tool data, and identifiers reach model providers, telemetry exporters, eval services, and channel providers.
- Define retention, deletion, incident response, and access-audit procedures for durable sessions and external stores.
- Test failure and abuse cases, not only successful prompts.

For user-facing communications, determine whether law or policy requires disclosure that an automated system is involved. Telephony and messaging applications may also require consent, opt-out handling, quiet hours, carrier registration, or recording/transcription notice. Provider guides retain specific constraints where the transport changes the implementation.

Human approval is a control, not proof of correctness. Present enough context for an informed decision, identify the exact action and target, reject stale responses, and preserve an audit record appropriate to the risk.

Never treat model output, retrieved content, uploaded files, remote tool descriptions, or webhook bodies as trusted instructions to the server. Validate structured inputs, escape output for its destination, verify signatures before identity, and keep authorization checks outside the model.
