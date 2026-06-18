# TUI renderer

## North star

The TUI renderer is a deterministic, instance-scoped, incremental projection
from a typed interaction state machine into viewport-bounded, terminal-safe
output.

That statement assigns one job to each layer:

- The runner translates sessions and server events into semantic renderer
  actions. It does not manage terminal state.
- One renderer instance owns one interaction state machine and one input
  arbiter. Prompt, streaming, approval, question, and setup modes are explicit
  states, not independent optional fields.
- React projects renderer state into a host tree. Components do not own terminal
  lifecycle or mutate shared process state.
- The host adapter owns every React-to-Yoga mutation, including attach, move,
  detach, clear, dirty marking, and disposal.
- The text layer sanitizes controls and converts Unicode text into terminal
  display cells before Yoga measurement and wrapping.
- The presenter appends settled rows once and repaints only the live rows that
  fit in the current viewport.
- The published package guarantees that every dependency needed by `eve dev`
  is installed or bundled.

## Required invariants

### State and input

- Mutable renderer state is instance-local. Starting or stopping one renderer
  cannot affect another renderer.
- The interaction state type makes conflicting input owners unrepresentable.
- A lone Escape resolves after a bounded timeout. Ctrl-C aborts the active
  operation and cannot leak into the next prompt.
- Buffered input has a fixed bound and an explicit policy for each interaction
  state.

### React and Yoga

- A host element owns exactly one Yoga node while mounted.
- Moving a child detaches it from its current Yoga parent before insertion.
- Removal, container clearing, reset, and unmount keep the host tree and Yoga
  tree identical and release detached Yoga nodes.
- Host hooks stay type-checked against the installed `react-reconciler`
  version.
- Text measurement respects Yoga's width constraint and uses terminal display
  columns rather than JavaScript string length.

### Terminal text and presentation

- User, model, tool, log, and setup text cannot emit terminal control sequences.
- Wide characters, combining marks, emoji sequences, tabs, and zero-width code
  points occupy the same columns in measurement, wrapping, and rasterization.
- Settled transcript rows never re-enter the per-frame layout path.
- The live region never exceeds the terminal viewport. Resize recomputes layout
  before the next paint.
- Shutdown restores raw mode and cursor visibility without clearing committed
  scrollback.

## Sole-renderer gate

The implementation can become Eve's sole renderer only after all of these are
true:

- A fresh packed install launches `eve dev` without workspace dependency
  hoisting.
- Every behavior covered by the previous PTY suite has an equivalent test for
  the replacement.
- Permanent tests cover Escape, Ctrl-C during streaming, keyed reordering,
  resize, disabled choices, renderer isolation, control-sequence injection,
  and shutdown.
- A long-transcript benchmark has a recorded time and memory budget and proves
  that settled history does not increase per-frame work.
- Typecheck, build, formatting, unit, integration, scenario, and TUI smoke tests
  all pass from a clean checkout.

Keep the previous renderer as a test oracle until the replacement satisfies
this gate. Delete the old implementation and the temporary selection path in
the same final change.
