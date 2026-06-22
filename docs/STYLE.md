# eve documentation style

The docs serve humans on eve.dev and coding agents reading raw Markdown from the npm package.
Clarity must not come at the cost of technical precision.

## Page contract

- Give each page one job: tutorial, guide, concept, or reference.
- A tutorial is linear and ends in a verified working outcome.
- A guide states the task, prerequisites, working directory, steps, verification, and recovery.
- A concept explains a mental model and tradeoffs without duplicating wire schemas.
- A reference is complete, terse, and checked against source.
- Lead with the outcome or constraint.
- Include exact file paths, imports, commands, prerequisites, and verification.
- Use relative links so the installed package remains navigable.
- State limitations and failure modes near the affected decision.
- Keep examples complete when readers are expected to copy them. Label fragments explicitly.
- Use `eve` lowercase, including at the start of a sentence.

## Voice

Write in a candid team-maintainer voice. The docs should sound like people who made the design,
understand its tradeoffs, and want the reader to succeed with it.

- Use “we” for design intent, defaults, recommendations, tradeoffs, and current limitations.
- Use “you” for actions the reader takes and consequences they need to consider.
- Do not use first-person singular. The voice belongs to the project, not an individual author.
- Lead narrative pages with the reader's situation and the path we recommend. Do not make readers
  decode an abstract definition before learning whether the page is for them.
- Explain why surprising behavior exists. Filesystem-derived names, server-side tool execution,
  sequential turns, sandbox isolation, Gateway routing, durable pauses, and the one-root-agent rule
  all need rationale near the behavior.
- Say who should not use an advanced or operationally expensive feature. Name the simpler default
  before documenting direct providers, remote agents, experimental APIs, or self-hosting.
- Prefer plain language before a precise term. Words such as “boundary,” “surface,” “projection,”
  and “canonical contract” are useful only after the concrete behavior is clear.
- Allow an occasional natural aside when it clarifies a decision. Do not add jokes, enthusiasm, or
  personality for its own sake.
- Avoid marketing claims, fake excitement, canned transitions, and generic “What to read next”
  sections.

Reference pages are different. CLI, TypeScript API, HTTP, stream-event, compatibility, and glossary
pages should stay terse. Add voice there only to route readers honestly or state a limitation.

## Decision callouts

Use raw Markdown blockquotes for decisions that could change what the reader builds. They must
remain useful in the copy of these docs shipped inside the npm package.

```md
> **Recommendation:** Start with the managed backend unless you need a specific runtime.

> **Why this default:** The default avoids a second source of truth for names.

> **Current limitation:** This transport does not support persistent socket connections.

> **Security consequence:** The tool runs with the credentials of the eve server.
```

Use these sparingly. A callout should identify a real decision, reason, limitation, or consequence;
it should not decorate ordinary instructions.

## Review checklist

- [ ] The page has one identifiable audience and task.
- [ ] Its tutorial, guide, concept, or reference role is clear from the structure.
- [ ] Public names, defaults, and types were checked against source.
- [ ] The source files reviewed are named in the pull-request description.
- [ ] Commands state their working directory.
- [ ] Canonical examples were executed or typechecked.
- [ ] Required packages and environment variables appear before the example that needs them.
- [ ] Warnings name both the consequence and the remedy.
- [ ] Current limitations and host-specific behavior are stated.
- [ ] Narrative pages recommend a default where one exists and explain why.
- [ ] Advanced features name the simpler alternative and who should use the advanced path.
- [ ] Surprising behavior is explained in concrete language before precise terminology.
- [ ] “We” communicates project judgment and “you” communicates reader action; neither is forced
      into reference prose.
- [ ] Cross-doc links work from `node_modules/eve/docs`.
- [ ] The page does not repeat an explanation owned elsewhere.
- [ ] Repeated introductions, canned transitions, and generic closing links were removed.
- [ ] `pnpm docs:check` and the docs-site build pass.
