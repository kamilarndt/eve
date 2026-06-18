# Eve Local DevTools: UX Design (Name: Eve DevTools)

Status: Draft  
Related PRD: [`prds/local-devtools.md`](./local-devtools.md)  
Related technical design: [`prds/local-devtools-design.md`](./local-devtools-design.md)  
Last updated: 2026-06-19

## Summary

Eve Local DevTools should feel like a serious debugging instrument: dense without being cramped, calm under failure, fast from the keyboard, and legible during long debugging sessions. Its visual language combines Vercel's precision, restraint, typography, and high-contrast product design with the durable pane model and interaction conventions developers already understand from Chrome DevTools.

The result should not look like either a Vercel dashboard transplanted into a debugger or a reskinned copy of Chrome DevTools. Vercel supplies the design discipline; developer tools supply the operating model; Eve supplies the primary objects and workflows.

The first release has one UX promise:

> A developer can understand what the agent did, select the relevant run object, move into authored source, pause and inspect execution, and return to the same context without losing their place.

This document defines the product shell, information density, visual system, panel layouts, interaction grammar, states, accessibility requirements, and milestone-specific UX deliverables needed to make that promise coherent.

## Design synthesis

### What to take from Vercel

Vercel's public design guidance emphasizes simplicity, minimalism, speed, precision, clarity, and functionality. The Geist system adds a high-contrast color scale, developer-oriented typefaces and icons, deliberate alignment, restrained materials, and consistent interaction patterns.

For Eve, this means:

- Establish hierarchy through typography, alignment, spacing, and borders before using color or elevation.
- Prefer flat, purposeful surfaces over decorative cards.
- Make every label concise, specific, and action-oriented.
- Design all empty, loading, stale, paused, disconnected, and failure states.
- Keep every flow keyboard-operable with visible focus.
- Use URL-addressable state so a panel, selected run object, source, and filter survive refresh and can be shared.
- Spend motion only where it explains cause and effect.
- Optimize perceived and actual speed; a debugger that feels delayed is hard to trust.

### What to take from Chrome DevTools

Chrome DevTools has taught developers a durable interaction vocabulary:

- Top-level panels switch between major debugging domains.
- Resizable panes preserve context while details change.
- Trees use arrow keys and disclosure controls.
- Sources combines a navigator, editor, and debugger sidebar.
- Console works both as a full panel and a bottom drawer.
- Selected records reveal details without navigating away.
- Authored sources are separated from framework and generated noise.
- Command, file, and text search have distinct entry points.
- Breakpoints, paused state, scopes, and call stacks remain visible until execution resumes.

Eve should retain these conventions where they lower learning cost. It should diverge where agent debugging has different primitives: Runs replaces the web page as the center of gravity, Agent replaces the DOM as the resolved structure, and durable replay and waiting states must be visible rather than represented as ordinary log lines.

### What must be distinctly Eve

The design must make these concepts obvious without requiring knowledge of Eve internals:

- A session contains turns, steps, model calls, actions, waits, and checkpoints.
- A session may be live, replayed, resumed, parked, or pinned to an older revision.
- A trigger can be a user message, schedule, channel delivery, or parent agent.
- A subagent is another session with a parent/child relationship.
- Source execution, console output, and durable events can refer to the same action.
- The Node runtime and sandbox are separate execution boundaries.
- The agent definition shown in DevTools is the resolved runtime graph, not merely a folder listing.

### Experience qualities

Every design decision should reinforce 6 qualities:

1. **Precise.** Values, identifiers, timestamps, states, and source locations are exact and copyable.
2. **Calm.** Failures are visible without turning the whole interface red. Live updates do not cause layout churn.
3. **Dense.** A laptop viewport can show a session tree, useful timeline, and details simultaneously.
4. **Fast.** Common actions take one shortcut or one obvious control.
5. **Correlated.** Selecting an object keeps its related events, source, logs, and definition within reach.
6. **Honest.** Stale data, replay, missing correlation, dropped records, redaction, and runtime boundaries are never disguised.

## Design principles

### 1. One selected object

At any moment DevTools has one primary selection: a session, turn, step, model call, action, source frame, log record, or agent definition. The selection is globally addressable and supplies context to other panels.

Examples:

- Select an action in Runs; Sources offers its authored location and Console filters to its output.
- Select a paused frame in Sources; Runs highlights the executing action and Console adopts its runtime coordinates.
- Select a tool in Agent; Runs can filter to recent uses and Sources can reveal its definition.

Cross-panel navigation changes the active panel, not the selected object's identity.

### 2. Progressive density

The default view should answer “what happened?” at a glance. Exact payloads, stack frames, raw events, and protocol data are one disclosure away. Do not render every field in the timeline or hide essential state inside a tooltip.

Use 3 levels:

- **Scan:** label, state, duration, and one-line summary.
- **Inspect:** structured detail in the right pane.
- **Verify:** raw JSON, full input/output, source, or protocol representation.

### 3. Stable geometry

Streaming must append content without moving the user's target. Selected rows remain anchored. Pane sizes, expanded sections, filters, scroll positions, and open files persist locally. New live activity shows a “Jump to latest” affordance when the user has scrolled away; it never steals scroll position.

### 4. Borders before boxes

The workspace is a continuous instrument divided by crisp 1 px rules. Avoid a dashboard made of rounded cards. Use filled or elevated surfaces only for menus, popovers, dialogs, transient status, and selected detail blocks that require separation.

### 5. Semantic color is evidence

Color communicates state, not decoration. Every semantic use also includes an icon, label, shape, or position so color is never the only cue.

### 6. Familiar where it matters

Sources, Console, trees, split panes, search, and debugger controls should follow established developer-tool behavior. Eve-specific invention belongs in Runs, Agent, correlation, revision, and durable-state representation.

### 7. Local first, automation equal

Every visible entity exposes stable identifiers and a copy action. Every state-changing UI control maps to the local API. The command menu should expose “Copy API Request” for triggers and selected resources so coding agents can discover the same capability without reverse-engineering the UI.

## Information architecture

The main panels stay fixed through all milestones:

1. **Runs** — sessions, interaction, durable execution, model calls, actions, state, and failures.
2. **Agent** — resolved definitions, runtime revision, source ownership, and diagnostics.
3. **Sources** — authored Node.js source debugging.
4. **Console** — logs, exceptions, evaluation, and rebuild output.
5. **Sandbox** — isolated filesystem, commands, and sandbox lifecycle in Milestone 4.
6. **Network** — correlated protocol activity and timing in Milestone 5.

These are sibling views of one local runtime, so they use a top-level tablist and preserve independent internal navigation state. Tabs are URL-addressable.

The first 4 panels are always visible. Sandbox and Network appear when implemented; before then, they should be absent rather than disabled promises.

## Application shell

### Desktop layout

The target is a standalone browser tab or window. The design is desktop-first, optimized for 1280 × 800 and useful down to 960 × 600.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Eve / weather-agent     Runs  Agent  Sources  Console       ● Ready   ⌘K    │ 40
├──────────────────────────────────────────────────────────────────────────────┤
│ Panel toolbar: context, filters, search, debugger or trigger actions          │ 36
├───────────────┬──────────────────────────────────────┬───────────────────────┤
│ Navigator     │ Primary workspace                    │ Inspector             │
│               │                                      │                       │
│               │                                      │                       │
│               │                                      │                       │
├───────────────┴──────────────────────────────────────┴───────────────────────┤
│ Console drawer                                                            ▲ │ variable
├──────────────────────────────────────────────────────────────────────────────┤
│ Local · revision a81f2c · runtime :4310 · inspector connected · 12 records  │ 24
└──────────────────────────────────────────────────────────────────────────────┘
```

The shell has 5 persistent regions:

- **Global bar, 40 px:** agent identity, panel navigation, connection state, and command menu.
- **Panel toolbar, 36 px:** controls specific to the active panel.
- **Workspace:** resizable navigator, primary content, and inspector panes.
- **Console drawer:** global, resizable, and optional; toggled with `Escape` when the workspace has focus or `Control` + `` ` `` from anywhere.
- **Status bar, 24 px:** local runtime, revision, inspector ownership, recording health, and selected coordinates.

The global bar and status bar do not scroll. Each pane owns its scroll container. Pane resize handles are 1 px visually and at least 8 px as hit targets.

### Global bar

Left to right:

1. Eve mark and resolved agent name.
2. Main panel tabs.
3. Flexible space.
4. Persistent runtime state: `Starting`, `Ready`, `Paused`, `Rebuilding`, `Disconnected`, or `Crashed`.
5. Compact command-menu trigger showing the platform shortcut.
6. Overflow menu for theme, settings, discovery metadata, help, and feedback.

Do not put session actions or debugger stepping controls in the global bar; those belong to the active panel toolbar. Keep the global bar stable as panels change.

### Status bar

The status bar is an evidence strip, not a second navigation bar. It displays short, inspectable facts:

- `Local`
- runtime revision and stale/pinned status
- runtime port
- inspector connection and controller ownership
- observation health or dropped-record count
- selected `session / turn / step / action` coordinates when available

Each segment is keyboard-focusable only when it has an action or detail popover. No decorative icon-only segments.

### Responsive behavior

At 1200 px and above, show the standard 3-pane layout.

Between 960 and 1199 px:

- Keep the navigator visible at its minimum width.
- Convert the right inspector to an overlay sheet opened by selection.
- Preserve the Console drawer.

Below 960 px:

- Use one pane at a time with a breadcrumb back path.
- Keep session interaction and log reading functional.
- Explain that source debugging works best in a wider window; never block access solely because of viewport width.

The product does not require a dedicated mobile layout for Milestone 1, but it must remain semantically navigable and must not render controls off-screen.

## Visual system

### Theme

Ship light and dark themes together. Default to the operating-system preference and persist an explicit override. Neither theme is secondary; debugging often happens for hours and developers have strong environment preferences.

The dark theme should use Geist's background and gray scales rather than undifferentiated pure black. The light theme should avoid large gray card fields. In both themes, use Background 1 for the workspace and Background 2 sparingly for toolbars, selected groups, and inactive editor areas.

Set the browser `color-scheme` and `theme-color` to match the active theme so scrollbars and browser chrome do not clash.

### Color roles

Use Geist's role-based scales rather than hard-coded brand hex values:

| Role                  | Treatment                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| Primary text          | Gray 10                                                                   |
| Secondary text        | Gray 9                                                                    |
| Default border        | Gray 4                                                                    |
| Hover border          | Gray 5                                                                    |
| Active border         | Gray 6                                                                    |
| Hover background      | Gray 2                                                                    |
| Selected background   | Blue 2 with Blue 6 edge and Blue 10 text where contrast permits           |
| Focus ring            | Blue 8, 2 px outer ring                                                   |
| Success / complete    | Green 9 text or icon; low-contrast Green 2 background only when necessary |
| Running / information | Blue 9 text or icon                                                       |
| Waiting / paused      | Amber 9 text or icon                                                      |
| Failure               | Red 9 text or icon; Red 2 background for the affected row or message      |
| Subagent relation     | Purple 9 icon or connector, always paired with a `Subagent` label         |
| Uncorrelated / stale  | Gray 9 with dashed edge or explicit `Uncorrelated` / `Stale` label        |

Reserve red for a failed object, exception, destructive action, or broken connection. A failed action should not tint its entire parent session red if later recovery succeeded.

### Typography

Self-host the fonts in the bundled UI; the local debugger must make no font request to the network.

- **Geist Sans:** navigation, labels, buttons, descriptions, filters, empty states, and prose.
- **Geist Mono:** source code, console output, identifiers, timestamps, durations, ports, coordinates, shortcuts, raw payloads, and tabular values.
- **Geist Pixel:** do not use in the debugger. Its expressive role would compete with dense diagnostic content.

Recommended type recipes:

| Use                       | Face       | Size / line height | Weight | Notes                                   |
| ------------------------- | ---------- | ------------------ | ------ | --------------------------------------- |
| Global navigation         | Geist Sans | 13 / 20 px         | 500    | Active panel uses text and underline    |
| Pane and section heading  | Geist Sans | 13 / 20 px         | 600    | Title Case                              |
| Standard UI and row label | Geist Sans | 13 / 18 px         | 400    | Default interface size                  |
| Secondary metadata        | Geist Mono | 11 / 16 px         | 400    | Tabular numbers                         |
| Code and console          | Geist Mono | 12 / 18 px         | 400    | User setting may increase to 13 / 20 px |
| Empty-state title         | Geist Sans | 16 / 24 px         | 600    | No marketing-scale headings             |
| Empty-state body          | Geist Sans | 13 / 20 px         | 400    | Maximum readable width 52 characters    |

Disable coding ligatures in source and console views by default because exact glyph distinction matters while debugging. A user preference may enable them later.

### Spacing and sizing

Use a 4 px base grid with optical 1 px adjustments where needed.

- Standard dense row: 28 px.
- Comfortable compound row: 36 px.
- Toolbar and input: 32 px visual height.
- Small icon: 14 or 16 px inside at least a 24 px hit target.
- Standard desktop control hit target: 28 × 28 px or larger.
- Tree indentation: 16 px per level.
- Pane padding: 8 px for dense lists; 12–16 px for structured details.
- Section gap: 16 px.
- Inline gap: 4 or 8 px.
- Control radius: 6 px.
- Popover and dialog radius: 8 px.
- Timeline and workspace pane radius: 0 px.

### Borders, elevation, and materials

- Use crisp 1 px borders to define toolbars, panes, rows, inputs, and selected regions.
- Use the lowest useful elevation.
- Menus, tooltips, command palette, sheets, and dialogs may use layered shadow plus border.
- Do not add shadows to fixed toolbars or ordinary detail sections.
- Nested radii must remain concentric; avoid stacking rounded surfaces.
- No glass blur, gradients, glows, or ornamental grid backgrounds in the working interface.

### Icons

Use the Geist icon set because it is designed for developer tools. Standardize on one 16 px canvas and consistent stroke weight.

Icons supplement labels; they do not replace unfamiliar actions. Icon-only controls are acceptable for universal debugger actions such as resume and step only when they include accessible names and delayed tooltips with shortcuts.

Use domain-specific icons consistently:

- speech bubble: message
- sparkle or model glyph: model call
- wrench: action
- pause circle: waiting or paused
- branch: subagent
- clock: schedule
- terminal: console or command
- file code: source
- box: sandbox boundary
- warning triangle: diagnostic

Do not assign different icons to the same primitive across panels.

### Motion

Most changes should be instantaneous. Use 100–160 ms opacity or background-color transitions for selection, hover, sheets, and popovers. Never animate pane resize, streaming row insertion, debugger stepping, or timeline reordering.

Use motion only to clarify:

- A new event may briefly fade from its semantic low-contrast background to the normal row background.
- Opening the right inspector sheet may use a short transform and opacity transition.
- The active running indicator may pulse subtly, but the label `Running` remains visible.

Honor `prefers-reduced-motion`. Animations must be interruptible and must never delay interaction.

## Interaction grammar

### Selection and navigation

- Single click selects a row or tree node.
- Double click pins a detail as a tab only where tabs exist, such as source files.
- `Enter` opens or activates the selected object.
- `Space` expands an inline preview where the selected component supports it.
- Arrow keys traverse trees, tablists, timelines, and structured values according to their native pattern.
- `Escape` closes the topmost transient surface; otherwise it toggles the Console drawer.
- Browser Back and Forward restore panel, selection, filters, and detail tabs.

Selections use both a background and a 2 px leading edge. Keyboard focus has a separate visible ring and is never inferred from selection.

### Search model

Keep 4 search modes distinct:

- `Command` / `Control` + `K`: Eve command menu for actions and destinations.
- `Command` / `Control` + `P`: open authored source by file name.
- `Command` / `Control` + `F`: find within the active pane or source file.
- `Command` / `Control` + `Shift` + `F`: search across runs, definitions, logs, and authored sources with typed result categories.

The command menu includes panel navigation, trigger actions, debugger settings, theme, copied identifiers, and “Copy API Request.” It displays platform-correct shortcut symbols and supports fuzzy matching.

### Resizable panes

- Persist widths by panel and viewport class.
- Double click a resize handle to restore its default.
- Keyboard users can focus the separator and resize with arrow keys.
- Enforce minimum widths before collapsing a pane.
- Never let a saved width make the primary workspace disappear after a viewport change.

### Filters

Filters use compact tokens in the panel toolbar. The toolbar shows active filter count and a single “Clear” action. Common toggles such as `Authored only`, `Errors`, and `Current session` may remain directly visible; advanced fields belong in a filter popover.

All filters are reflected in the URL. Zero-result states explain which filters are active and offer “Clear Filters.”

### Context menus

Right-click menus provide secondary operations, never the only path to a core action. Standard resource actions:

- Copy display value
- Copy stable id
- Copy local API URL
- Copy API request when applicable
- Reveal in Runs / Agent / Sources / Console
- Filter to this value
- Open raw record

### Destructive and mutating actions

Sending a message, triggering a schedule, responding to input, and resuming execution are immediate but clearly labeled. Retrying or creating a fresh session must say which one it does.

State mutation, session deletion, or arbitrary evaluation requires confirmation or an undo path. Destructive buttons use explicit labels such as `Delete Session`, not `Continue` or `Confirm`.

## Runs panel

Runs is the default panel and the visual identity of Eve DevTools.

### Layout

```text
┌──────────────────────┬─────────────────────────────────┬──────────────────────┐
│ Sessions             │ Run timeline                    │ Details              │
│ + New Session        │ weather / turn 3                │ Action               │
│                      │                                 │ get_forecast         │
│ ● session-8d2        │ 10:42:11  User message          │                      │
│   ├─ turn 1 ✓        │     “Weather in Berlin?”        │ Input                │
│   └─ turn 2 ●        │                                 │ { city: "Berlin" }   │
│      └─ subagent ✓   │ 10:42:12  Model call       1.2s │                      │
│ ○ session-519        │     2 actions · 1,842 tokens    │ Execution            │
│                      │                                 │ tools/weather.ts:42  │
│                      │ 10:42:13  Action           48ms │                      │
│                      │     get_forecast                │ Result               │
│                      │                                 │ 18 °C, cloudy        │
│                      │ 10:42:13  Checkpoint saved      │                      │
├──────────────────────┴─────────────────────────────────┴──────────────────────┤
│ Message this session…                                             Send  ⌘↵  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Default widths at 1280 px:

- Session navigator: 240 px, resizable from 200–360 px.
- Timeline: remaining width, minimum 420 px.
- Details inspector: 340 px, resizable from 280–520 px.

### Session navigator

The navigator combines recent sessions and parent/child session structure. Each row shows:

- short stable id or developer-assigned label
- trigger icon
- coarse status with redundant icon and text in the accessible name
- relative activity time
- child disclosure when applicable
- revision warning when pinned to an older revision

Use a compact status dot only as a supplementary scan cue. The selected session header and detail pane always spell out the status.

The header contains `New Session` as the primary action and a trigger menu for messages, schedules, and channels available in the current milestone. Search and filters sit below the header when active.

### Timeline

The timeline is an ordered journal, not a chat transcript. Messages are important records but do not dominate the entire visual model.

Each event row has 5 aligned columns:

1. durable sequence or connector rail
2. event icon and title
3. one-line summary
4. duration or waiting time
5. outcome/state

Collapsed rows are 28–36 px. Selected or explicitly expanded rows may show an inline preview, but full details remain in the inspector. Use a quiet vertical rail to show order and nested indentation for events owned by a step or model call.

Event treatments:

| Primitive       | Scan label example                        | Visual behavior                                   |
| --------------- | ----------------------------------------- | ------------------------------------------------- |
| Trigger         | `User Message`, `Schedule: morning-brief` | Starts a run group                                |
| Message         | `User`, `Assistant`, `Channel Delivery`   | One-line content preview                          |
| Model call      | `Model Call · openai/gpt-5.5`             | Shows duration, usage, and action count           |
| Action          | `Action · get_forecast`                   | Shows duration and terminal state                 |
| Wait            | `Waiting for Input`, `Authorization`      | Amber marker and elapsed waiting time             |
| Checkpoint      | `Checkpoint Saved`, `State Changed`       | Thin boundary row; inspectable but visually quiet |
| Subagent        | `Subagent · researcher`                   | Purple connector to child session                 |
| Compaction      | `Context Compacted`                       | Neutral system row                                |
| Failure         | `Action Failed`, `Turn Failed`            | Red icon/label on affected row, recovery offered  |
| Replay / resume | `Replayed`, `Resumed from Checkpoint`     | Dashed rail segment and explicit provenance       |

Do not use chat bubbles. They consume horizontal space and visually demote model/action/state events to chat metadata. Messages use the same journal grid with content previews and author labels.

### Live behavior

When following the latest event:

- Append rows in sequence.
- Keep a subtle `Live` label in the timeline header.
- Show indeterminate progress only on the currently running primitive.
- Update duration in place no more than once per second.

When the user scrolls or selects older history:

- Stop auto-follow.
- Show a sticky `Jump to Latest` button with the unseen record count.
- Do not clear the selection when the run completes.

Reconnected history uses a `Replayed` provenance marker until the live boundary. It must not animate as newly executed work.

### Details inspector

The inspector adapts to the selected primitive while keeping a stable section grammar:

1. identity and status
2. summary
3. primary input
4. primary output
5. execution and source
6. timing and usage
7. correlation coordinates
8. raw record

Sections with no data are omitted. Structured objects use an accessible tree with copy-path and copy-value actions. Large or redacted values show their byte size, truncation, and redaction state explicitly.

Model-call details use internal tabs:

- **Overview** — model, timing, usage, finish reason, resulting actions.
- **Input** — effective instructions, history, tools, and dynamic capabilities.
- **Output** — response content and action requests.
- **Raw** — captured protocol-neutral record.

State checkpoint details use **Diff**, **Before**, **After**, and **Raw**. Diff is the default when available.

### Composer and trigger controls

The footer composer appears only when the selected session can accept a message or pending input.

- Placeholder: `Message this session…` or the specific pending-input prompt.
- `Command` / `Control` + `Enter` sends.
- Enter inserts a newline.
- While sending, keep the label visible and add a spinner.
- On failure, preserve the draft and show an inline recovery action.
- When a session cannot continue, replace the composer with a concise explanation and `Start New Session`.

Schedule and channel trigger forms use a compact dialog with exact payload preview, identity fields, validation beside the affected field, and `Trigger Schedule` or `Deliver Message` as the action label.

## Agent panel

Agent is Eve's resolved-structure inspector: closer to the Elements panel than a file explorer.

### Layout

- **Left, 280 px:** resolved definition tree.
- **Center:** selected definition overview and configuration.
- **Right, 320 px:** source, diagnostics, runtime provenance, and related activity.

Tree roots use Eve concepts rather than filesystem directories:

- Instructions
- Model & Routing
- Tools
- Skills
- Connections
- Channels
- Schedules
- Hooks
- Subagents
- Sandbox
- Workspace

Definitions display authored, framework, replaced, or disabled provenance with a label and subdued icon. Path-derived names are primary; source paths are secondary metadata.

### Definition details

The center pane should answer:

- What is this definition?
- What configuration is active?
- Where did it come from?
- Was it changed, replaced, or disabled during resolution?
- Which runtime revision contains it?

Use description lists for compact metadata and structured viewers for schemas or configuration. Provide `Reveal in Sources` as the primary source action and `Show Recent Runs` when activity exists.

### Diagnostics

Diagnostics appear beside the affected node and in the details pane. Selecting a diagnostic reveals:

- concise problem statement
- affected definition and source location
- why Eve interpreted it this way
- concrete recovery action
- raw diagnostic only behind disclosure

Rebuild failure keeps the last valid agent graph visible and adds a persistent amber or red revision banner explaining that the runtime is using the previous valid revision.

## Sources panel

Sources should be immediately legible to Chrome DevTools users while reducing non-authored noise.

### Layout

```text
┌──────────────────┬────────────────────────────────────┬──────────────────────┐
│ Authored         │ tools/weather.ts                   │ Debugger             │
│ ▾ agent          │  40  export default defineTool({   │ PAUSED ON BREAKPOINT │
│   ▾ tools        │  41    execute: async ({ city }) =>│                      │
│     weather.ts   │● 42      client.fetch(city)        │ Call Stack           │
│   hooks.ts       │  43  })                            │ weather.execute      │
│                  │                                    │ runAction             │
│ Framework        │ city = "Berlin"                    │                      │
│ Generated        │                                    │ Scope                │
│ Dependencies     │                                    │ Local                │
│                  │                                    │  city  "Berlin"      │
│                  │                                    │ Eve Context          │
│                  │                                    │  action get_forecast │
└──────────────────┴────────────────────────────────────┴──────────────────────┘
```

Default widths:

- Source navigator: 240 px.
- Editor: remaining width, minimum 480 px.
- Debugger sidebar: 300 px.

### Source navigator

Group sources by ownership, in this order:

1. Authored
2. Framework
3. Generated
4. Dependencies
5. Node Internals

Only Authored is expanded by default. Framework, generated, dependency, and Node sources remain searchable but hidden from routine browsing. Source-mapped authored paths are canonical; immutable snapshot paths appear as provenance in details.

### Editor

- Use CodeMirror with read-only files in Milestone 1.
- Show line numbers, breakpoint gutter, execution line, inline exception, and current-frame value previews.
- Keep tabs compact; preview tabs become pinned on double click or modification when editing is introduced later.
- Show revision in the tab only when it differs from the current runtime.
- Distinguish current execution line from selected line and breakpoint line.
- Preserve file, cursor, scroll, and fold state across panel changes.

The editor should not imitate an IDE project environment. No file creation, refactoring, or extension marketplace. Opening the file in the user's editor may be offered through a configured local command later.

### Paused state

When execution pauses, show a persistent amber pause strip below the panel toolbar containing:

- pause reason
- current authored function and source location
- `session / turn / step / action` coordinates
- revision mismatch warning when applicable
- resume and step controls

The debugger sidebar orders sections by immediate usefulness:

1. Call Stack
2. Scope
3. Eve Context
4. Watch
5. Breakpoints

`Eve Context` is an Eve-owned synthetic view containing only available correlation metadata. It must not imply that these values are JavaScript locals.

If the runtime is paused on generated or framework code, select the nearest authored frame when safe and make the actual top frame explicit. Never silently rewrite the call stack.

### Debugger controls

Use conventional icons and shortcut tooltips for:

- Resume / pause
- Step over
- Step into
- Step out
- Deactivate breakpoints
- Pause on exceptions

Controls remain in a stable order. Disabled controls preserve their position and explain why they are unavailable.

### Revision mismatch

When a paused frame belongs to an older immutable revision:

- Keep the correct historical source visible.
- Add an `Older Revision` badge to the source tab.
- Show both execution and current revision ids in the pause strip.
- Offer `View Current Source` without replacing the historical frame.

Never map old execution onto new source merely because the path matches.

## Console

Console is a full panel and a bottom drawer. Both are views over the same records, filters, history, and selected execution context.

### Record layout

Each record uses aligned columns:

- severity
- timestamp
- message
- source location
- correlation coordinates

At narrow widths, source and correlation move to a second metadata line. Repeated records may collapse with a count, but the original sequence remains inspectable.

Use Geist Mono for emitted text. Render structured arguments as expandable values without converting them into lossy strings. Preserve stdout/stderr raw text and mark records that could not be parsed or correlated.

### Context and filtering

The Console toolbar includes:

- context selector: all runtime, selected session, selected action, or paused frame
- severity toggles
- text filter
- namespace filter
- clear visual records

“Clear” changes the local view; it does not delete persisted run records. State this in the tooltip and command description.

Selecting a source link opens Sources at the exact revision and line. Selecting coordinates opens the matching Runs object. When correlation is unknown, show `Process` rather than leaving a misleading blank.

### Evaluation

While paused, the Console may evaluate expressions in the selected call frame through CDP. Outside a pause, it evaluates in the runtime's default context only when safe and explicitly enabled.

The prompt must always display its evaluation context, for example:

```text
weather.execute @ tools/weather.ts:42  ›
```

History is local to the project. Multiline input uses `Shift` + `Enter`; Enter evaluates. Potentially mutating evaluation shows a one-time explanation in preview releases, not a confirmation on every command.

## Sandbox panel

Sandbox arrives in Milestone 4 and must look related to Sources without pretending to be the same runtime.

Use a persistent boundary banner: `Sandbox · isolated execution`. The panel owns:

- sandbox instances and lifecycle
- filesystem tree and file preview
- command executions and output
- resource limits and termination reason
- links to the action and run that requested the operation

Node debugger controls never appear here. A sandbox command uses terminal conventions and its own process state. Cross-boundary links connect the requesting Node action to sandbox execution.

## Network panel

Network arrives in Milestone 5. It should follow the familiar request-table and detail-inspector pattern, augmented with Eve correlation.

Columns should prioritize:

- method or protocol operation
- destination
- status
- duration
- initiator
- session / action correlation

Details include overview, headers/metadata, payload, response, timing, and raw protocol data. Credentials remain redacted. Model calls stay in Runs even if their transport also appears in Network; the two views link to each other rather than duplicating ownership.

## Cross-panel correlation

Correlation is the product's main differentiator and needs a consistent visual language.

### Coordinates

Display coordinates as compact, independently copyable segments:

```text
session 8d2 · turn 3 · step 1 · action call_7 · rev a81f2c
```

Use short ids for scanning and full ids in tooltips, copy actions, and raw details. Never truncate two ids into the same visible value within one list; lengthen them until unique.

### Reveal actions

Every reveal action uses the same labels:

- `Reveal in Runs`
- `Reveal in Agent`
- `Reveal in Sources`
- `Reveal in Console`
- `Reveal in Sandbox`
- `Reveal in Network`

After navigation, briefly emphasize the target without losing its standard selected treatment. Back returns to the prior panel and scroll position.

### Correlation confidence

When records are correlated by an exact runtime coordinate, show no extra badge. When correlation is inferred, show `Inferred`. When no reliable correlation exists, show `Uncorrelated` and keep the record in the process-global view.

The UI must never present timestamp proximity as exact causation.

## State design

### Runtime states

| State        | Global treatment                                        | Primary action                    |
| ------------ | ------------------------------------------------------- | --------------------------------- |
| Starting     | Neutral progress label; preserve last known UI          | None                              |
| Ready        | Green status icon + `Ready`                             | Create or select session          |
| Running      | Blue status icon + active run summary                   | Pause where supported             |
| Paused       | Amber global state and Sources pause strip              | Resume                            |
| Rebuilding   | Neutral progress; current valid revision stays visible  | View Rebuild Output               |
| Disconnected | Amber banner; cached data remains readable              | Reconnect                         |
| Crashed      | Red banner; last records and exception remain available | Restart Runtime / Open Crash Logs |

Use delayed progress indicators to avoid flicker for fast startup and rebuilds. Keep the original label visible while an action is in flight.

### Empty states

Every empty state has a cause, explanation, and next step.

- No sessions: “Run your agent” + `New Session`.
- No selected session: “Select a session to inspect its timeline.”
- No console records: “No output for the current filters.” + `Clear Filters` when relevant.
- No authored sources loaded: explain whether the runtime has not executed them or source mapping failed.
- No diagnostics: compact success text; no celebratory illustration.
- No search results: repeat the query and offer to clear category or filter constraints.

Avoid mascots, oversized icons, or marketing copy. This is a working tool.

### Loading states

- Keep the shell interactive during data loading.
- Use stable skeleton geometry only when loading exceeds 200 ms.
- Prefer existing cached content with a small `Refreshing` indicator.
- Virtualized lists should reserve row height to prevent jumps.
- Never replace the full workspace with a spinner for a pane-local request.

### Error messages

Errors state what failed, what remains usable, and what the developer can do next.

Preferred pattern:

> Could not reconnect to the runtime. Existing runs remain available. Restart the runtime or retry the connection.

Avoid blame, unexplained codes, or dead ends. Include raw error details behind disclosure and preserve relevant identifiers for issue reports.

### Redaction and truncation

Use explicit inline tokens:

- `[Redacted: credential]`
- `[Truncated: 84 KB of 120 KB shown]`
- `[Unavailable: capture disabled]`

These states use neutral or amber treatment, never the same styling as an empty value. Copying a displayed redacted value copies the marker, not hidden data.

## Accessibility

Milestone 1 must meet these requirements:

- All flows work from the keyboard.
- Main panels use an accessible tablist; internal view tabs use independent tablists.
- Trees, grids, splitters, menus, dialogs, and comboboxes follow WAI-ARIA Authoring Practices.
- Every focusable element has a visible `:focus-visible` ring.
- Selection and focus remain visually distinct.
- Icons have accessible names; decorative icons are hidden from assistive technology.
- Status is never conveyed by color alone.
- Dynamic run updates use a polite live region that summarizes meaningful transitions without announcing every token or duration tick.
- Debugger pause, runtime crash, and new pending input are announced once.
- Row virtualizing preserves correct list position and count semantics.
- Source gutter controls are keyboard reachable through a dedicated breakpoint list even if the visual gutter itself is not in normal tab order.
- Minimum text and icon contrast follows Geist's accessible text roles and is verified with APCA plus WCAG AA as a compatibility floor.
- Zoom to 200% preserves all operations without horizontal page overflow; pane-local horizontal scroll is allowed for code and tables.
- Reduced motion removes nonessential transitions and pulsing.

Screen-reader users need a non-visual timeline summary. Provide a mode that reads each event as `sequence, type, label, status, duration, nesting level` and exposes its details through a labeled relationship.

## Content design

Follow Vercel's product copy conventions:

- Use active voice.
- Use Title Case for headings, buttons, menu items, and tabs; use sentence case for descriptions and messages.
- Prefer `&` in short UI labels where it remains clear.
- Keep nouns stable: `session`, `turn`, `step`, `model call`, `action`, `checkpoint`, `runtime revision`.
- Use explicit verb + noun actions: `New Session`, `Trigger Schedule`, `Copy Session ID`, `Restart Runtime`.
- Use numerals for counts and spaces between numbers and units: `12 records`, `48 ms`, `1.2 s`.
- Use the ellipsis character for actions requiring more input: `Open File…`, `Trigger Channel Message…`.
- Do not use “job,” “trace,” “request,” and “run” as interchangeable names for a session or turn.

Identifiers, file names, code tokens, model names, and literal status strings use `translate="no"`.

## Performance and perceived speed

The UI must remain responsive while the agent is busy or paused.

- A click, keypress, selection, or panel switch produces visible response within 100 ms.
- Existing data renders immediately on panel return; background refresh must not blank it.
- Timeline and Console use windowing after 500 rendered rows.
- Append batches are scheduled to avoid more than one visual commit per animation frame.
- Duration ticks update at most once per second.
- Structured JSON parsing and expensive search move off the main thread when payload size justifies it.
- Do not syntax-highlight off-screen source or payload content eagerly.
- Pane resizing must track the pointer without React state round trips on every pixel.
- Fonts and all core icons are local, preloaded, and subset only if the subset still covers source and console needs.

The UI displays dropped or delayed observation records rather than silently smoothing gaps.

## Component inventory

Build a small Eve-owned component layer on semantic HTML and design tokens. Required Milestone 1 components:

- application shell
- main panel tabs
- panel toolbar
- status bar
- resizable split pane and separator
- tree and tree row
- virtualized event list
- event row and connector rail
- status badge
- coordinates strip
- details inspector and disclosure section
- description list
- structured value tree
- source link
- code editor wrapper
- debugger control group
- Console record and prompt
- filter bar and filter popover
- command menu
- menu, popover, tooltip, dialog, and desktop sheet
- inline banner
- empty, loading, stale, and error states
- toast for low-priority confirmation only

Do not expose third-party component APIs outside the UI package. Components should consume Eve-owned tokens and state types so the underlying library can change.

## Frontend implementation recommendations

### Tokens

Define semantic CSS custom properties rather than importing a dashboard theme wholesale:

```css
:root {
  --surface-primary: /* Geist Background 1 */;
  --surface-secondary: /* Geist Background 2 */;
  --surface-hover: /* Geist Gray 2 */;
  --border-default: /* Geist Gray 4 */;
  --border-hover: /* Geist Gray 5 */;
  --text-primary: /* Geist Gray 10 */;
  --text-secondary: /* Geist Gray 9 */;
  --status-info: /* Geist Blue 9 */;
  --status-success: /* Geist Green 9 */;
  --status-warning: /* Geist Amber 9 */;
  --status-error: /* Geist Red 9 */;
}
```

Maintain light and dark mappings in one token module. Components reference roles, never numbered colors directly. A small number of source-editor syntax tokens may be separate because they serve code semantics rather than product state.

### Layout and state

- Use CSS Grid for the major pane layout and intrinsic sizing; avoid measuring layout in JavaScript.
- Store pane sizes, theme, expanded groups, open source files, and preferred filters per project.
- Store panel, selection, search, and shareable filters in the URL.
- Keep transient hover, menu, draft, and in-progress interaction state local.
- Keep normalized runtime data keyed by stable ids; avoid panel-specific copies that can drift.

### Source and Console rendering

- Wrap CodeMirror behind an Eve-owned source-view interface.
- Share one structured-value renderer between Runs, Sources scopes, and Console.
- Share source-link and coordinates components across all panels.
- Use source maps and runtime revision as required inputs to every source navigation action.
- Keep syntax colors lower contrast than breakpoints, current execution, selection, and exceptions.

### Design-system strategy

Use Geist foundations—font, icons, color roles, copy, focus, interaction, and material principles—without coupling the published `eve` runtime to a large React component dependency. Bundle the static UI and its build-time dependencies as specified in the technical design.

Where an existing Geist component exactly matches the behavior, its implementation can guide or supply the UI build. Eve still owns the public component wrapper and debugging-specific variants.

## Milestone UX plan

### Milestone 1: Core debug loop

Ship a visually complete product with:

- full shell, light and dark themes, global status, and command menu
- Runs session navigator, timeline, event details, and message composer
- Agent resolved tree, definition details, diagnostics, and revision state
- Sources authored-first navigator, editor, debugger sidebar, and pause strip
- Console panel and drawer with source and run correlation
- all primary empty, loading, paused, replayed, stale, disconnected, rebuild, crash, redaction, and error states
- keyboard navigation and screen-reader semantics for the core journey
- responsive inspector-sheet behavior for laptop widths

Do not release Milestone 1 with placeholder panels, generic component-library styling, or only a happy-path light theme.

UX acceptance journey:

1. Start `eve dev` and open DevTools.
2. Identify the agent, runtime state, and current revision in under 5 seconds.
3. Create a session and send a message without documentation.
4. Follow the turn and identify its model call and action.
5. Reveal the action source and set a breakpoint.
6. Trigger another turn and understand why execution paused.
7. Inspect a local value and evaluate an expression.
8. Open correlated Console output in the drawer.
9. Resume and observe the action and turn complete.
10. Navigate Back and return to the prior timeline selection and scroll position.

### Milestone 2: Durable agent semantics

Add UX for:

- effective model input and output
- state checkpoint diff/before/after
- pending input and authorization response
- replay, retry, and resume provenance
- subagent session edges and child navigation
- compaction and usage details

Validate that these fit the Runs timeline and detail grammar. Do not create new main panels for Context, State, Actions, or Subagents.

### Milestone 3: Channels and identity

Add:

- channel-message trigger dialog
- normalized delivery preview
- identity and thread metadata
- channel-to-session correlation
- authentication and connection state with redacted provenance

### Milestone 4: Sandbox

Add the Sandbox panel, explicit execution-boundary treatment, filesystem preview, command timeline, resources, and Node-to-sandbox correlation.

### Milestone 5: Network and performance

Add Network and aggregated timing views. Keep performance data attached to Runs primitives first; introduce charts only when they answer comparisons that rows and durations cannot.

## Design and validation workflow

### Before implementation

Produce a high-fidelity prototype for 4 states at 1280 × 800 in both themes:

1. empty/ready Runs
2. streaming action in Runs
3. paused authored breakpoint with Console drawer
4. runtime crash with cached run data

Also produce a 1024 px laptop-width version of Runs and Sources to validate pane collapse.

### During implementation

- Build the shell and primitives in an isolated component harness with realistic long identifiers, large payloads, and dense histories.
- Review sparse, average, and stress datasets—not only curated examples.
- Capture visual regressions in light and dark themes at 960, 1280, and 1920 px widths.
- Test with scrollbars always visible.
- Test keyboard-only navigation on macOS, Windows, and Linux conventions.
- Test browser zoom at 100%, 150%, and 200%.
- Test reduced motion and high-contrast preferences.
- Profile a 10,000-record Console and 2,000-event timeline.

### Usability validation

Run task-based sessions with 5–8 agent developers before default-on release. Measure:

- time to first session
- time to identify a failed action
- time to reveal and pause authored source
- success rate correlating a Console exception to its action
- ability to distinguish replayed from live work
- recovery from a revision mismatch or runtime crash
- command-menu and shortcut discoverability

Prioritize observed navigation failures and incorrect mental models over subjective styling preference.

## UX release criteria

Milestone 1 is visually and interactively ready when:

- The core acceptance journey succeeds in both themes at 960 × 600 and 1280 × 800.
- Every main panel has designed empty, loading, populated, stale, and error states.
- Runtime pause and crash leave the UI usable and explanatory.
- A developer can complete the core journey using only the keyboard.
- Cross-panel reveal preserves selection, revision, and Back navigation.
- Long identifiers, deep trees, multiline messages, large JSON, and dense logs do not break layout.
- Status never depends on color alone.
- All network-loaded UI assets are absent; the tool works offline after the local server starts.
- Visual regression and accessibility checks pass for the supported viewport matrix.
- The UI remains responsive at the defined stress volumes.

## Explicit design non-goals

- Reproduce the full Chrome DevTools frontend.
- Make the debugger visually resemble a chat application.
- Add marketing illustration, gradients, glass effects, or decorative dashboard cards.
- Turn DevTools into a general code editor.
- Put every inspectable primitive in its own main panel.
- Hide runtime complexity behind optimistic states that can misrepresent durable execution.
- Make dark mode the only polished theme.
- Optimize source debugging for phone-sized screens.

## Open UX questions

1. Should a new browser tab acquire debugger control automatically, or require an explicit `Take Control` action when another tab owns CDP?
2. Should the Console drawer default to closed, or remember its last state per project from the first release?
3. How much model input can be rendered by default before the detail pane switches to a virtualized document view?
4. Should session labels be automatically derived from the first user message, or remain stable short ids until the agent supplies a title?
5. Which schedule and channel trigger fields are universal enough for a shared dialog, and which require definition-provided schemas?
6. Should source tabs persist across runtime restarts, and how should missing historical revisions be represented?
7. Is expression evaluation outside a paused frame safe enough for Milestone 1, or should the first Console be record-only except while paused?

## Reference basis

This design applies these public foundations:

- [Vercel Design](https://vercel.com/design) — care, craft, and systemized design.
- [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) — keyboard operation, visible focus, URL state, stable layouts, complete states, performance, accessibility, and Vercel copy conventions.
- [Geist Design System](https://vercel.com/geist/stack) — foundations and developer-tool components.
- [Geist Colors](https://vercel.com/geist/colors) — role-based backgrounds, component states, borders, high-contrast surfaces, text, and icon colors.
- [Geist Font](https://vercel.com/font) — simplicity, minimalism, speed, precision, clarity, and developer-oriented Sans and Mono typefaces.
- [Geist Icons](https://vercel.com/geist/icons) — iconography tailored for developer tools.
- [Geist Tabs](https://vercel.com/geist/tabs) and [Material](https://vercel.com/geist/material) — sibling navigation, URL state, accessible behavior, and restrained elevation.
- [Chrome DevTools overview](https://developer.chrome.com/docs/devtools/overview/), [Sources](https://developer.chrome.com/docs/devtools/sources/), [Console](https://developer.chrome.com/docs/devtools/console), and [customization](https://developer.chrome.com/docs/devtools/customize/) — established developer-tool panel, source, drawer, filtering, and layout conventions.
