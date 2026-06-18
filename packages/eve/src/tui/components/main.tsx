/**
 * The root component: the entire dev TUI driven from `shared`. Composes the
 * committed header, the transcript, the interactive footer (prompt editor or a
 * modal), and the persistent status line. Every child reads its own slice via
 * `useShared`, so a status-line token tick can't re-render the transcript;
 * `<Main>` only threads `width` and maps the stored `AgentTUIAgentHeader` onto
 * `<Header>`'s props (dropping `serverUrl`, which the header does not show).
 *
 * The footer is mode-routed: the prompt editor owns the keyboard while idle or
 * streaming; an approval/question modal takes over when one is pending. Exactly
 * one footer surface renders at a time (see {@link TuiMode}).
 */
import { visibleBlocks } from "../log-filter.js";
import { useShared } from "../store.js";
import { ApprovalModal } from "./approval-modal.js";
import { FlowPanel } from "./flow-panel.js";
import { Header } from "./header.js";
import { InputBlock } from "./input-block.js";
import { Box } from "./primitives.js";
import { QuestionModal } from "./question-modal.js";
import { StatusBar } from "./status-bar.js";
import { Transcript, Warning } from "./transcript.js";

export function Main({ width }: { readonly width: number }) {
  const header = useShared((s) => s.header);
  const blocks = useShared((s) => s.blocks);
  const logs = useShared((s) => s.logs);
  const mode = useShared((s) => s.mode);
  const setupWarning = useShared((s) => s.setupWarning);
  const inFlow = useShared((s) => s.setupFlow !== undefined);

  // Split the transcript at the first still-live block: everything above it is
  // settled and commits to native scrollback; the live block(s) + footer are the
  // repaint region, marked with `liveBoundary` for the scrollback presenter. The
  // streaming tail is always last, so first-live-onward is the live region.
  const visible = visibleBlocks(blocks, logs);
  const firstLive = visible.findIndex((block) => block.live);
  const cut = firstLive === -1 ? visible.length : firstLive;
  const settled = visible.slice(0, cut);
  const live = visible.slice(cut);

  return (
    <Box flexDirection="column">
      {header ? (
        <Header name={header.name} info={header.info} tip={header.tip} width={width} />
      ) : null}

      <Transcript blocks={settled} />

      <Box flexDirection="column" liveBoundary>
        <Transcript blocks={live} />

        {/* Live footer: the clearable setup attention line sits just above the
            prompt, matching the terminal renderer's footer position. */}
        {setupWarning ? <Warning block={{ kind: "warning", body: setupWarning }} /> : null}

        {/* A running setup flow owns the footer (its own panel + reads); the
            prompt and modals are suppressed until it ends. */}
        {inFlow ? <FlowPanel /> : null}

        {!inFlow && (mode === "prompt" || mode === "streaming") ? (
          <InputBlock width={width} />
        ) : null}
        {!inFlow && mode === "approval" ? <ApprovalModal /> : null}
        {!inFlow && mode === "question" ? <QuestionModal /> : null}

        <StatusBar width={width} />
      </Box>
    </Box>
  );
}
