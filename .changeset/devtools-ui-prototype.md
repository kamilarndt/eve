---
"eve": patch
---

Add the package-owned Eve DevTools browser debugger with Runs, Agent, Sources, and Console panels. Local `eve dev` now serves DevTools by default with authenticated live updates, authored TypeScript breakpoints, stack and scope inspection, expression evaluation, and `--no-devtools` opt-out. Interactive launches open DevTools in the default browser after runtime readiness, while headless launches remain browser-free.

The Sources panel now organizes authored files into collapsible folders while preserving path-based search and loaded-file status.

The Runs composer can create a session from its first message, and retained event replay no longer disconnects DevTools when the local SSE response applies backpressure.

Runs now defaults to a streaming Chat view with optimistic user messages, assistant markdown, reasoning, and tool-call lifecycles, while the detailed event Timeline remains available from the view switcher.

Multi-turn DevTools sessions now preserve continuation state when later runtime responses omit an unchanged continuation token, and runtime request failures surface their original message.

Nested pnpm projects outside an ancestor workspace are now detected from pnpm's recursive workspace set, avoiding accidental execution of an unrelated ancestor workspace's lifecycle scripts.

DevTools now keeps revision and timeline geometry compact, orders its panels as Runs, Console, Agent, and Sources, groups Agent primitives by authored and framework provenance, simplifies empty states and session rows with accurate working and pending-action states, opens Runs at the latest event with its composer focused, removes duplicate Console records, labels correlated Console output with session titles, maps console links back to authored source files, supports clearing the local Console view, navigates execution coordinates, opens Sources for breakpoint pauses, resolves authored paused frames more reliably, and uses a one-pane workflow below 960 px.
