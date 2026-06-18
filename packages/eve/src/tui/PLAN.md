# eve TUI — React-authored cell renderer

A declarative React (JSX) TUI for `eve dev`, rendered by a hand-rolled, pure-TypeScript
cell compositor on Node — no Bun, no native renderer dependency. Components author with
`<Box>`/`<Text tone>`; the renderer lays them out with Yoga and diffs cells to ANSI. This is
the Claude Code combination (React authoring + custom cell renderer), chosen because opentui's
compositor is Zig-via-`bun:ffi` and eve ships as a Node CLI.

This work was ported from the `eve-simple` checkout into this repo (`vercel/eve`) on the
`tui-react-renderer` branch.

## Status

| Phase | What it delivers                                                                | Status                 |
| ----- | ------------------------------------------------------------------------------- | ---------------------- |
| P0    | React -> reconciler -> nodes -> Yoga layout -> cells -> diff -> ANSI, on Node   | done                   |
| P1    | `shared` store + input (`onKey`) + StatusBar reading the store                  | done                   |
| P2    | Transcript / input / header / markdown — **ported to components**               | done                   |
| P3    | `ReactRenderer implements AgentTUIRenderer`, cut over behind `EVE_TUI=react`    | done + dist-validated  |
| P4    | Scrollback + live-region presenter (alt-screen dropped) — **done**              | done                   |
| P5    | ~~Drawer overlay (dimmed transcript)~~ → **dropped** (decided 2026-06)          | descoped               |
| P6    | Flip default → React **and** delete `TerminalRenderer` — **done**               | done                   |

**Scope decision (2026-06): the dimmed-history drawer is dropped.** It was the only feature
forcing an alternate-screen compositor; without it the renderer stays in native scrollback
(keeps copy/paste + transcript-after-exit, matches the Claude Code model and today's
`live-region.ts`). P4's alt-screen viewport and P5's overlay are cut. What remains of "P4" is a
scrollback + live-region presenter pass (commit settled blocks to scrollback, repaint only the
live tail) replacing the current full-screen clear+redraw — a presenter change, not a new mode.

### P6 (done) — React is the default and the only renderer

**Flip + delete — done.** The React/cell renderer is now the **only** TUI renderer for `eve dev`:

- `tui.ts` always constructs `ReactRenderer` (lazily — React/Yoga stay off the import path until
  `eve dev` runs); `createRenderer` now *requires* an injected renderer (production provides React;
  tests inject a fake/real one) and throws otherwise — no `TerminalRenderer` default.
- Deleted: `terminal-renderer.ts` (~3k lines), `terminal-renderer.test.ts`, the `TerminalRenderer`
  exports from the test barrel (`test/index.ts`) + `lib/tui.ts`, and the 14 `TerminalRenderer`-based
  `test/tui-client` smokes.
- **Prerequisite that made this clean:** the shared IO contracts (`TerminalInput`/`TerminalOutput`)
  were first extracted to `terminal-io.ts`, so `src/tui/` never depended on `terminal-renderer.ts`.

**Verified green after the delete:** `tsgo` 0 errors, 374 unit tests pass (the −84 vs the prior 458
are `terminal-renderer.test.ts`'s tests for the deleted renderer; the 100 `src/tui` tests are intact),
dist rebuilds clean, and the 3 React dist smokes pass (`tui-react-renderer`, `tui-react-loglevel`,
`tui-react-transport-error`). Two real bugs were found+fixed via dist smokes en route: the
`react-reconciler` CJS-in-ESM build crash, and dropped pre-arm keystrokes (key queue: `#routeKey`
buffers, `#armConsumer` drains).

**Honest consequence / follow-up (CI):** deleting the old smokes removed the *end-to-end* coverage of
the flows they exercised. The React renderer keeps **unit** coverage for all of them (stream fold,
subagent/connection-auth upserts, setup-flow reads, log filter, status bar), plus 3 e2e React smokes.
The remaining flows — `slash-commands`, `status-line`, `server-logs`, `rebuild-status`, `log-modes`,
`packed-install-model` (serverless) and `connection-auth` / `questions` / `subagents` (server-backed)
— need React e2e smoke variants added in CI (the server-backed ones require a fixture server). This is
the documented trade made to land the delete: a recoverable feature branch with React as the sole
renderer, full unit + typecheck + build green, and the e2e smoke suite to be rebuilt against React.

### P4 (done) — scrollback + live-region presenter

Built per the design below and validated: **100 src/tui tests** (incl. 6 new `react.scrollback.test.ts`
asserting commit-once / repaint-tail / replay-on-retroactive), the `react.mock-screen` test driving
the new runtime through the smoke emulator, and the **dist smoke passing** end-to-end with the new
presenter. Files: `cells/scrollback.ts` (new — `createScrollbackPresenter` + `lineToAnsi`),
`render.ts` (`renderToLines` with content-auto height + `liveBoundary` detection; `renderToBuffer`
kept for the test harness), `runtime.ts` (commit via the scrollback presenter, no screen clear),
`components/main.tsx` (splits the transcript at the first `live` block, wraps the live region in a
`liveBoundary` box), `primitives.tsx` + `jsx.d.ts` (forward the `liveBoundary` marker prop).

### P4 design (as executed)

The current pipeline is fixed-grid + absolute-CUP + screen-clear (`present.ts`, `runtime.ts`). The
naive "commit the frame-to-frame common prefix" heuristic is **wrong** — when idle, the common
prefix is the whole frame, so it commits the footer; the next keystroke then re-prints the footer
_below_ the committed copy (duplicate in scrollback). A correct scrollback presenter therefore needs
an explicit **live-region boundary**, threaded through the tree:

1. **Boundary marker.** `<Main>` splits the transcript at the first `live` block:
   `cut = blocks.findIndex(b => b.live)` (or `blocks.length`). Render `<Transcript blocks={settled}>`,
   then a boundary wrapper (`<Box>` carrying a `liveBoundary` marker prop — needs `primitives.Box` to
   forward it and `render.ts` to detect it), then `<Transcript blocks={live}>` + the footer
   (warning / input / modals / flow-panel / status). Everything **above** the marker is settled and
   commit-eligible; the marker down is the repaint region. (First-live-onward = the streaming tail in
   practice, so this is safe; being conservative just repaints more.)
2. **`render.ts` → lines.** Add `renderToLines(root, width): { lines, liveY }`: lay out at content
   height (`setHeightAuto` / unconstrained height), rasterize to a content-height buffer, slice into
   per-row styled-cell lines, and record `liveY` = computed top of the `liveBoundary` node. Keep
   `renderToBuffer` untouched so `testing.ts` + the 90+ existing golden tests stay green.
3. **Line presenter (`runtime.ts`).** Track `flushed: string[]` (lines already written to scrollback).
   Each frame: (a) if `flushed` is no longer a prefix of `lines[0..liveY)` → **retroactive change**
   (e.g. `/loglevel` re-showing hidden blocks): clear the live region + reset `flushed = []` and
   reprint (the `#replayTranscript` analogue). (b) Else commit `lines[flushed.length .. liveY)` by
   printing them (newline-terminated → they scroll into native history), then repaint the live region
   `lines[liveY..]` with **relative** cursor ops: cursor-up by previous live height, erase-to-end,
   reprint. No `\x1b[2J`, no absolute CUP, no `HIDE/CLEAR` on mount.
4. **Validation.** `MockScreen` emulates exactly these ops (CPL/CNL + line/screen erases — see its
   own docstring), so `react.mock-screen.test.ts` + a new scrollback test + the `tui-react-renderer`
   dist smoke validate it headlessly, the same way the `TerminalRenderer` smokes validate
   `live-region.ts` today. Touches `main.tsx`, `primitives.tsx`, `render.ts`, `runtime.ts`
   (+ maybe `present.ts` helper); `testing.ts` stays as-is. Estimate ~200–300 lines.

All P0–P2 + P3-core work is green: **73 src/tui vitest tests pass, the full 431-test
src/tui + src/cli/dev/tui suite is green, and `tsgo` typechecks clean** under the package's
strict settings. A live demo runs with `pnpm --filter eve run tui:example`.

### P3 (core done — full dogfood parity pending)

The integrative seam is built, wired, and verified headlessly:

- **`store.ts`** grows `mode` / `header` / `blocks` / `approval` / `question` (the single UI
  source of truth; `TuiMode` routes the keyboard to exactly one footer surface).
- **`stream-fold.ts`** — the pure `AgentTUIStreamEvent` → `Block[]` reducer, a faithful
  transcription of `TerminalRenderer`'s `#applyStreamEvent` + `#upsertBlock` (delta
  accumulation in fold-state, upsert-by-id shallow merge, empty-content skip, child-tool
  suppression, finalize pass). 15 unit tests assert the mapping table.
- **`components/main.tsx`** + `approval-modal.tsx` + `question-modal.tsx` compose the whole
  UI from the store. 3 tests.
- **`react-renderer.ts`** — `ReactRenderer implements AgentTUIRenderer`: `renderStream` folds
  into the store and paints; `readPrompt`/`readToolApproval`/`readInputQuestion` resolve via a
  single `#consumeKey` rendezvous (mirroring the terminal renderer); header/notice/sandbox/
  vercel/reset/shutdown are store writes. 5 integration tests drive the full rendezvous with a
  fake stdin/stdout (no PTY).
- **Cutover**: `tui.ts` lazily `import()`s the renderer only under `EVE_TUI=react` and sets
  `options.renderer`, so the existing `createRenderer` early-return uses it — **no runner edit,
  and the default path never imports React/Yoga** (yoga-layout compiles WASM at import).

**Parity batch 1 (done, +4 tests → 9 adapter tests; 77 src/tui, 435 total green):**
`upsertSubagentStep`/`upsertSubagentTool` (+ one header per dispatch, `subagentToolStatus`
mapping, child-tool suppression via `markChildToolCallId`), `upsertConnectionAuth` +
`setConnectionAuthPendingCount` (connection-auth block lifecycle + the yellow "waiting for
authorization" status hint), status `tokens` from stream usage (`formatTokenFlow` folded from
`step-finish`/`finish`), `renderSetupWarning`/`clearSetupWarning` (clearable attention line via a
`setupWarning` slice + `<Warning>` footer), and `renderCommandResult` → `result` block (new
`<Result>` ⎿-elbow view). `StreamFold` grew a public `upsertBlock`; `TuiState` grew
`connectionAuthPending`/`setupWarning`/`logs`.

**Parity batch 2 (done; 86 src/tui, 444 total green):**

- **Log modes** — `logDisplayMode`/`setLogDisplayMode` + a `logs` slice; `log-filter.ts`
  (`isLogHidden`/`visibleBlocks`, the `#shouldRenderLog`/`#isHiddenLog` port) filters `log`/
  `sandbox` blocks in `<Main>`'s read path (retroactive, no re-buffer); `parseSandboxLogLine`
  filter in `renderSandboxLog`. 6 filter tests + 1 renderer test.
- **Status-bar width degradation** — `<StatusBar>` measures and drops project→model to fit
  `width` (keeps tokens + yellow hints), the measure-and-pick port of `buildStatusLine`'s cascade.
- **Smoke substrate proven** — `react.mock-screen.test.ts` drives `ReactRenderer` through the
  smoke suite's own `MockScreen`/`MockUserInput`: the cell presenter's ANSI (DEC 2026 sync, CUP,
  SGR) is a subset the mock terminal parses, and `type`/`waitForText`/`enter` work. The biggest
  cutover risk (presenter ↔ emulator compatibility) is retired with evidence.

**Parity batch 3 (done; 91 src/tui, 449 total green):**

- **Setup flow** — `setupFlow` (`SetupFlowRenderer`) fully wired: a `setupFlow` store slice +
  `<FlowPanel>` (title / toned progress lines / transient preview / status spinner / the open
  question), the non-interactive surface (`begin`/`end`/`renderLine`/`renderOutput`/`setStatus`)
  with the evidence-ring + commit-on-`end` diagnostics via the fold, and all interactive reads
  (`readSelect` incl. multi-select, `readText` with mask + validate re-prompt, `readAcknowledge`,
  `readChoice` with idempotent `close()`, `waitForInterrupt`) on the `#consumeKey` rendezvous.
  `<Main>` gives the running flow the footer (prompt/modals suppressed). 5 tests.
  - _One documented simplification:_ `readEditableSelect`'s inline-edit affordance falls back to
    preset selection (returns `{kind:"selected"}`); the type-to-edit path is not yet ported.

**Parity batch 4 (done; 93 src/tui, 451 total green):**

- **Full log capture** — `#installLogCapture`-style `process.stdout`/`stderr.write` patching →
  `log`/`sandbox` blocks (line-buffered, `parseSandboxLogLine` routing). The production
  frame-vs-foreign conflict is solved by construction: the cell runtime paints through a frame
  sink backed by the **saved-original** `process.stdout.write`, so frames bypass the capture and
  only the dev server's output is captured. Off by default (unit tests don't patch the globals);
  `tui.ts` turns it on. 2 tests validate the exact path against `MockScreen` (capture →
  blocks → grid, partial-line buffering, and `shutdown` restoring the globals).

**Parity batch 5 — dist smoke PASSES + a real shipping blocker fixed:**

- **`test/tui-client/tui-react-renderer.ts`** runs `ReactRenderer` from the built `dist` against
  the smoke harness's `MockScreen`/`MockUserInput` (serverless, like `tui-loglevel`): mount → prompt
  paint → foreign-output capture into the grid → typed input echo → clean Ctrl-C exit. **Verified.**
- **Build bug found & fixed (the dist smoke caught what source tests can't):** vitest/tsx run from
  _source_, so the rolldown-built artifact had never executed. It crashed at startup —
  `react-reconciler`'s CJS bundled into the ESM dist → `require is not defined`. Root cause: `react`
  is in `build-rolldown.mjs`'s `EXTERNAL_PACKAGES` (resolved from `node_modules` at runtime, CJS
  interop intact) but `react-reconciler`/`yoga-layout` were not, so rolldown inlined them. Fix:
  add both to `EXTERNAL_PACKAGES` (they're lazily imported behind the flag; the default path still
  never loads them).
  - **Decision to surface:** externalized deps must resolve at runtime, so for a _published_ eve
    `react-reconciler` + `yoga-layout` should move from `devDependencies` to **`optionalDependencies`**
    (the renderer is opt-in via `EVE_TUI=react`). In this dev checkout they resolve as devDeps, which
    is why the smoke passes here. This is the one AGENTS.md "minimal runtime deps" tradeoff worth a nod.

**Parity batch 6 (done):** `readEditableSelect` fully ported — the cell select model has no
per-row inline editor, so it's a two-phase select→edit flow that keeps the result grammar exact
(preset / unchanged-default → `selected`; an edited value → `edited`). 6 setup-flow tests. The
deps are now optional `peerDependencies` (mirroring `react`). **P3 parity is functionally complete.**

**Remaining (P3 done; these are P4/P6 + a mechanical sweep):**

- **`flushDelayedDevBuildErrors`** — genuinely a no-op: nothing feeds delayed build errors to the
  React renderer, so the omitted optional method is correct as-is.
- **Full `test/tui-client` sweep** against the React renderer (one smoke proven end-to-end from
  `dist`; the rest are mechanical variants).
- **"P4" scrollback presenter** — replace `runtime.ts`'s full-screen clear+redraw with a scrollback
  - live-region discipline (commit settled rows to native scrollback, repaint only the live tail)
    so native scroll / copy-paste / transcript-after-exit work.
- **P6** — flip the default + delete `TerminalRenderer` (irreversible/outward-facing; needs sign-off).

## Key decision: port formatters to JSX, do not wrap their ANSI

The earlier plan reused eve's string formatters (`buildStatusLine`, `renderBlockLines`,
`renderMarkdown`, `tool-format`) as opaque ANSI placed inside a `<Text>`. **That is rejected.**
Wrapping a formatter's string keeps composition, layout, and width-degradation inside an
imperative builder — JSX in name only. Instead:

- Composition, layout, and styling live in the **component tree**. Layout is Yoga; a leaf's
  color is a `tone` prop on `<Text>` mapped to eve's theme palette (not embedded ANSI).
- The status bar is already ported this way (see `components/status-bar.tsx`): segments are
  conditional `<Text tone="dim">`/`<Text tone="yellow">`, separators and the row are JSX.
- **P2 is a full port** (decided): markdown (headings, lists, bold, inline code) and
  tool-call rendering become component trees too — zero ANSI string-building anywhere. This is
  larger than a wrap, and it unlocks future selection / links / reflow.

Open gap from the port so far: the old `buildStatusLine` degraded segments to fit narrow
widths (drop team -> project -> model). That responsive behavior is **not yet ported** —
restore it declaratively (Yoga `flexShrink` + truncation) before the P3 cutover.

### P2 (done)

Components, all in `src/tui/components/`, zero ANSI string-building in the component layer:

- `cells/wrap.ts` — word-aware, style-preserving wrapping; `<eve-text>` measures wrapped.
- `StyledSegment`s on `<eve-text>` + `<Text>` (structured styled runs, not ANSI strings).
- `<Markdown>` — headings/lists/quotes/paragraphs, inline bold/italic/code as segments,
  **GFM tables** (aligned column Boxes) and **URL emphasis-shielding**.
- `<Transcript>` dispatcher → `<Message>` (user/assistant/reasoning), `<ToolCall>`,
  `<ErrorBlock>`, `<Notice>`, plus flow / command / question / connection-auth / sandbox /
  log (with same-source label suppression) / subagent header, and a **depth-aware orange
  nesting rule** for subagent output. `<Gutter>` is the shared hanging-indent layout.
- `<InputBlock>` — prompt glyph + draft text + caret (reuses `line-editor`'s `visibleLine`);
  reads `shared.input` ({ text, cursor }, added to `TuiState`).
- `<Header>` — port of `buildAgentHeader` (brand/name, public-preview, diagnostics, tip).

**50 unit tests pass; `tsgo` typecheck clean (after `build:compiled`); oxlint + oxfmt clean.**
Built in parallel via a Workflow (4 disjoint-file agents) then integration-verified.

Deferred polish (small, before/with P3): status-bar width-degradation; `agent-header` kind
raw-row passthrough; `<ToolCall>` expanded `toolInput`/`toolOutput` view and `<ErrorBlock>`
`detail` dump; slash-command blue painting inside warning/attention lines; caret blink + the
slash-command/ghost-hint states on `<InputBlock>` (these belong with P3 input wiring).

## Layout (`src/tui/`)

```
host/nodes.ts        host node model; each element owns a Yoga node; eve-text is a Yoga leaf
host/reconciler.ts   react-reconciler@0.33 HostConfig; resetAfterCommit -> container.onCommit
layout/yoga.ts       wrapper over yoga-layout (style -> Yoga, calculateLayout)
cells/style.ts       Style type + parseAnsi (ANSI string -> styled cells)
cells/buffer.ts      cell grid {char, style}; writeText / writeAnsi; toString (plain)
cells/present.ts     diff two buffers -> minimal ANSI (style transitions, DEC 2026 sync)
render.ts            host tree -> layout -> rasterize to cells
runtime.ts           render(element, {stdout}) -> mount; per-commit diff + write
store.ts             shared store + useShared(selector) (useSyncExternalStore) + useLocal
input.ts             stdin -> nextKey (reused) -> onKey(type, handler) registry
components/           primitives.tsx (Box, Text, glyph), status-bar.tsx
testing.ts           mountForTest -> captureCharFrame / update / flush (no terminal)
example.tsx          live demo (pnpm --filter eve run tui:example)
jsx.d.ts             JSX.IntrinsicElements for <eve-box> / <eve-text>
```

Data flows one way: input/stream -> writer -> `shared` store -> components read via selector
-> reconcile -> commit -> `resetAfterCommit` -> layout -> rasterize -> diff -> ANSI.

## Integration seam (P3)

The runner talks to an `AgentTUIRenderer` interface (`cli/dev/tui/runner.ts`); only
`renderStream` is required. A `ReactRenderer implements AgentTUIRenderer` will adapt the
runner's imperative calls to store writes + promises (`renderStream` pumps
`eveEventsToTUIStream` into the store; `readPrompt`/`readToolApproval`/`readInputQuestion`
resolve from components). Gate with `EVE_TUI=react` so the old `TerminalRenderer` and the new
one coexist during migration; `runner.ts` / `tui.ts` are otherwise untouched.

## Dependencies added (`packages/eve/package.json`)

- `react-reconciler@0.33.0` + `@types/react-reconciler@0.33.0` (peer `react ^19.2.0`; eve is 19.2.6)
- `yoga-layout@3.2.1` (pure WASM, Node-safe)
- React 19 was already present. `tsconfig.json` gained `jsx: react-jsx` + `jsxImportSource: react`
  and `src/**/*.tsx` in `include`.

## Hard-won facts (so they are not relearned)

- **react-reconciler 0.33 host config** needs the 0.31+ additions or it throws at runtime:
  `resolveUpdatePriority` / `getCurrentUpdatePriority` / `setCurrentUpdatePriority`,
  `HostTransitionContext` (a `createContext`), `maySuspendCommit`, `resolveEventTimeStamp`,
  `shouldAttemptEagerTransition`, `trackSchedulerEvent`, etc. See `host/reconciler.ts`.
- **`commitUpdate` signature** is `(instance, type, prevProps, nextProps, internalHandle)` —
  the last arg is the fiber handle, NOT props. Using the wrong arg silently dropped layout
  props on re-render (boxes reverted to column). Use the named `nextProps`.
- **Synchronous commit** uses `updateContainerSync` + `flushSyncWork` (not `flushSync`, which
  0.33 does not expose on the instance).
- **Yoga**: `yoga-layout@3.x` default import loads its WASM at import time; nodes are usable
  synchronously thereafter. `eve-text` is a Yoga leaf with a `setMeasureFunc` over
  `visibleLength` (ANSI-stripped width); `markDirty` it on text change so it re-measures.
- **Presenter**: blank cells are not emitted; inter-word spaces appear as separate cursor
  moves (not a bug). Styles never bleed because each run is prefixed with a reset.

## Running

- **Renderer demo (no agent/creds):** `pnpm --filter eve run tui:example` — live render;
  `EVE_TUI_EXAMPLE_MS=1500` self-exits.
- **Full TUI against the weather fixture:** `pnpm dev --v1` (alias `--tui`) — runs the fixture's
  `eve dev` with the React TUI attached and sole terminal control (the default `pnpm dev` stays the
  multiplexed watch + headless `--no-ui` server). `eve dev` auto-builds the CLI via `tsgo` on start —
  note this path uses the per-file tsgo build, not the rolldown bundle, so `react-reconciler` resolves
  from `node_modules` (no CJS-in-ESM issue). Needs model-provider credentials for live turns.
- **Headless dist smokes:** after `pnpm --filter eve build:js`, run
  `node test/tui-client/tui-react-{renderer,loglevel,transport-error}.ts` (exit 0 = pass).

## Cleanup the model unlocked (done: safe deletions)

With `TerminalRenderer` gone, its imperative ANSI formatters were orphaned. Deleted the two with
zero importers: **`live-region.ts`** (→ `cells/scrollback.ts`) and **`status-line.ts`**
(`buildStatusLine` → `status-bar.tsx`), plus their colocated tests. Remaining dead-but-entangled
prunes (left for a separate careful pass): the imperative `renderBlockLines` (`blocks.ts`),
`renderMarkdown` (`markdown.ts`), and `renderFlowPanel` (`setup-panel.ts`) have no live caller — only
their shared *types* are still used (the React side consumes `Block`, `SetupPanelOption`, etc.).

## Verify

- `pnpm --filter eve exec vitest run --config vitest.unit.config.ts src/tui/` — 100 tests.
- Typecheck: `tsgo --noEmit -p tsconfig.json` (0 src errors expected).
